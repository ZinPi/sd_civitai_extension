"""Giao diện local cho bốn bước tạo prompt.

Chạy: python app.py
Mở: http://127.0.0.1:8765
"""

from __future__ import annotations

import io
import json
import os
import zipfile
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from engine import OUTPUT_FILES, RULE_FILES, RULE_LABELS, JobError, atomic_write
from llm import PROVIDERS, HttpLlm, LlmError
from runner import AlreadyRunning, Job

ROOT = Path(__file__).resolve().parent
DEFAULT_RULES = Path(os.environ.get("QUY_TAC_DIR", ROOT.parent / "quy-tac-tool"))
DEFAULT_DATA = Path(os.environ.get("TOOL_DATA_DIR", ROOT / "data"))
STATIC = ROOT / "static"

NEED_KEY = "API không hợp lệ"
NEED_NETWORK = "Không nối được API."
NEED_MODEL = "Chọn model."

DEFAULT_SETTINGS = {
    "provider": "teamsoclo",
    "base_url": PROVIDERS["teamsoclo"]["base"],
    "model": "",
    "models": [],
    "api_style": PROVIDERS["teamsoclo"]["style"],
    "max_input_tokens": 120_000,
    "max_output_tokens": 8192,
    "request_timeout_seconds": 180,
}


class SettingsBody(BaseModel):
    provider: str = "teamsoclo"
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    api_style: str = "responses"
    max_input_tokens: int = 120_000
    max_output_tokens: int = 8192
    request_timeout_seconds: int = Field(default=180, ge=30, le=600)


class JobBody(BaseModel):
    source_text: str = ""
    prior_text: str = ""
    mode: str = "all"


def read_config(path: Path) -> dict:
    provider = "teamsoclo"
    api_key = ""
    if path.is_file():
        try:
            raw = json.loads(path.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError:
            raw = {}
        if isinstance(raw, dict):
            provider = str(raw.get("provider") or provider).strip() or provider
            api_key = str(raw.get("api_key") or "").strip()
    if provider not in PROVIDERS:
        provider = "teamsoclo"
    spec = PROVIDERS[provider]
    return {
        "provider": provider,
        "base_url": spec["base"],
        "api_style": spec["style"],
        "api_key": api_key,
    }


def probe_message(exc: LlmError) -> tuple[str, str]:
    if exc.kind == "auth":
        return "invalid", NEED_KEY
    if exc.kind in {"network", "timeout", "bad", "empty"}:
        return "network", NEED_NETWORK
    return "network", NEED_NETWORK


def load_settings(path: Path) -> dict:
    settings = dict(DEFAULT_SETTINGS)
    if path.is_file():
        try:
            saved = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            saved = {}
        if isinstance(saved, dict):
            for key in DEFAULT_SETTINGS:
                if key not in saved:
                    continue
                if key == "models" and not isinstance(saved[key], list):
                    continue
                settings[key] = saved[key]
    provider = str(settings.get("provider") or "teamsoclo")
    if provider not in PROVIDERS:
        provider = "teamsoclo"
    settings["provider"] = provider
    settings["base_url"] = PROVIDERS[provider]["base"]
    settings["api_style"] = PROVIDERS[provider]["style"]
    return settings


def public_settings(settings: dict, probe: dict) -> dict:
    visible = {
        name: value
        for name, value in settings.items()
        if name not in {"api_key", "base_url", "provider", "api_style"}
    }
    models = probe.get("models") if probe.get("state") == "ok" else []
    if not isinstance(models, list):
        models = []
    visible["models"] = [str(item).strip() for item in models if str(item).strip()]
    model = str(settings.get("model") or "")
    if model not in visible["models"]:
        model = ""
    visible["model"] = model
    visible["api_state"] = probe.get("state") or "invalid"
    visible["message"] = "" if visible["api_state"] == "ok" else str(probe.get("message") or NEED_KEY)
    return visible


def valid_base_url(value: str) -> bool:
    parsed = urlparse(value.strip())
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc) and " " not in value


def create_app(
    rules_dir: Path | None = None,
    data_dir: Path | None = None,
    config_path: Path | None = None,
) -> FastAPI:
    rules_path = Path(rules_dir or DEFAULT_RULES)
    data = Path(data_dir or DEFAULT_DATA)
    data.mkdir(parents=True, exist_ok=True)
    settings_path = data / "settings.json"
    secret_path = Path(config_path) if config_path is not None else ROOT / "config.json"
    job = Job(rules_path, data)
    probe = {"state": "invalid", "message": NEED_KEY, "models": []}
    app = FastAPI(title="Tạo prompt ảnh")
    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    def read_saved() -> dict:
        return load_settings(settings_path)

    def store(settings: dict) -> None:
        atomic_write(settings_path, json.dumps(settings, ensure_ascii=False, indent=2))
        try:
            settings_path.chmod(0o600)
        except OSError:
            pass

    def ensure_probe() -> dict:
        secret = read_config(secret_path)
        if not secret["api_key"]:
            probe["state"] = "invalid"
            probe["message"] = NEED_KEY
            probe["models"] = []
            return probe
        current = read_saved()
        client = HttpLlm({**current, **secret, "model": current.get("model") or "probe"})
        try:
            models = client.list_models()
        except LlmError as exc:
            state, message = probe_message(exc)
            probe["state"] = state
            probe["message"] = message
            probe["models"] = []
        else:
            probe["state"] = "ok"
            probe["message"] = ""
            probe["models"] = models
        finally:
            client.close()
        return probe

    def runtime_settings(body: SettingsBody | None = None) -> dict:
        current = read_saved()
        secret = read_config(secret_path)
        checked = ensure_probe()
        models = list(checked["models"]) if checked["state"] == "ok" else []
        model = body.model.strip() if body is not None else str(current.get("model") or "")
        if model not in models:
            model = ""
        max_input = body.max_input_tokens if body is not None else int(current["max_input_tokens"])
        max_output = body.max_output_tokens if body is not None else int(current["max_output_tokens"])
        timeout = body.request_timeout_seconds if body is not None else int(current["request_timeout_seconds"])
        if not 1024 <= max_input <= 2_000_000:
            raise HTTPException(status_code=400, detail="Token đầu vào cần từ 1024 đến 2000000.")
        if not 256 <= max_output <= 200_000:
            raise HTTPException(status_code=400, detail="Token đầu ra cần từ 256 đến 200000.")
        return {
            "provider": secret["provider"],
            "base_url": secret["base_url"],
            "api_key": secret["api_key"],
            "model": model,
            "models": models,
            "api_style": secret["api_style"],
            "max_input_tokens": max_input,
            "max_output_tokens": max_output,
            "request_timeout_seconds": timeout,
        }

    def store_public(settings: dict) -> None:
        stored = {key: value for key, value in settings.items() if key != "api_key"}
        store(stored)

    @app.get("/")
    def index():
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})

    @app.get("/api/rules")
    def list_rules():
        files = []
        for name in RULE_FILES:
            path = rules_path / name
            files.append(
                {
                    "name": name,
                    "label": RULE_LABELS[name],
                    "bytes": path.stat().st_size if path.is_file() else 0,
                    "missing": not path.is_file(),
                }
            )
        return {"directory": str(rules_path), "files": files}

    @app.get("/api/settings")
    def get_settings():
        ensure_probe()
        return public_settings(read_saved(), probe)

    @app.put("/api/settings")
    def put_settings(body: SettingsBody):
        settings = runtime_settings(body)
        store_public(settings)
        return public_settings(settings, probe)

    @app.get("/api/job")
    def get_job(source: int = 0):
        return job.snapshot(include_source=bool(source))

    @app.post("/api/job")
    def start_job(body: JobBody):
        settings = runtime_settings()
        checked = ensure_probe()
        if checked["state"] == "network":
            raise HTTPException(status_code=400, detail=NEED_NETWORK)
        if checked["state"] != "ok" or not settings.get("api_key"):
            raise HTTPException(status_code=400, detail=NEED_KEY)
        if not settings.get("model"):
            raise HTTPException(status_code=400, detail=NEED_MODEL)
        try:
            job.begin(body.source_text, settings, body.mode, body.prior_text)
        except AlreadyRunning as exc:
            raise HTTPException(status_code=409, detail="Đang chạy một lượt.") from exc
        except JobError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return job.snapshot()

    @app.post("/api/job/stop")
    def stop_job():
        job.request_stop()
        return job.snapshot()

    @app.post("/api/job/clear")
    def clear_job():
        try:
            job.clear()
        except AlreadyRunning as exc:
            raise HTTPException(status_code=409, detail="Đang chạy một lượt.") from exc
        return job.snapshot(include_source=True)

    @app.get("/api/file/tat-ca")
    def download_all():
        names = [
            "DANH_SACH_CHAR_BG.txt",
            "PROMPT_CHAR.txt",
            "PROMPT_BG.txt",
            "PROMPT_THEO_DONG.txt",
            "FILE_TONG_HOP.txt",
            "NHAT_KY.txt",
        ]
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name in names:
                path = data / name
                if path.is_file() and path.stat().st_size > 0:
                    archive.write(path, name)
            if not archive.namelist():
                raise HTTPException(status_code=404, detail="Chưa có file để tải.")
        return Response(
            content=buffer.getvalue(),
            media_type="application/zip",
            headers={"Content-Disposition": 'attachment; filename="TAT_CA_FILE.zip"'},
        )

    @app.get("/api/file/{key}")
    def download(key: str, preview: int = 0):
        filename = OUTPUT_FILES.get(key)
        if not filename:
            raise HTTPException(status_code=404, detail="Không có file này.")
        path = job.output_path(filename)
        if not path.is_file():
            raise HTTPException(status_code=404, detail="Chưa có file này.")
        text = path.read_text(encoding="utf-8")
        if preview:
            lines = text.splitlines()
            limit = min(max(preview, 1), 500)
            return {
                "text": "\n".join(lines[:limit]),
                "lines": len(lines),
                "truncated": len(lines) > limit,
                "filename": filename,
            }
        return Response(
            content=text,
            media_type="text/plain; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("TOOL_PORT", "8765")))
