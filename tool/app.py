"""Giao diện local cho bốn bước tạo prompt.

Chạy: python app.py
Mở: http://127.0.0.1:8765
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from engine import OUTPUT_FILES, RULE_FILES, RULE_LABELS, JobError, atomic_write
from llm import HttpLlm, LlmError
from runner import AlreadyRunning, Job

ROOT = Path(__file__).resolve().parent
DEFAULT_RULES = Path(os.environ.get("QUY_TAC_DIR", ROOT.parent / "quy-tac-tool"))
DEFAULT_DATA = Path(os.environ.get("TOOL_DATA_DIR", ROOT / "data"))
STATIC = ROOT / "static"

OPENAI_BASE = "https://api.openai.com/v1"
OPENROUTER_BASE = "https://openrouter.ai/api/v1"
NEED_KEY = "Dán API rồi bấm Kiểm tra."
NEED_MODEL = "Bấm Kiểm tra, rồi chọn model."

DEFAULT_SETTINGS = {
    "base_url": "",
    "api_key": "",
    "model": "",
    "models": [],
    "api_style": "chat",
    "max_input_tokens": 120_000,
    "max_output_tokens": 8192,
    "request_timeout_seconds": 180,
}


class SettingsBody(BaseModel):
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    api_style: str = "chat"
    max_input_tokens: int = 120_000
    max_output_tokens: int = 8192
    request_timeout_seconds: int = Field(default=180, ge=30, le=600)


class JobBody(BaseModel):
    source_text: str = ""
    mode: str = "all"


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
    return settings


def public_settings(settings: dict) -> dict:
    key = str(settings.get("api_key") or "")
    visible = {name: value for name, value in settings.items() if name not in {"api_key", "base_url"}}
    raw_models = visible.get("models")
    if not isinstance(raw_models, list):
        raw_models = []
    visible["models"] = [str(item).strip() for item in raw_models if str(item).strip()]
    visible["has_key"] = bool(key)
    visible["key_hint"] = ("••••" + key[-4:]) if len(key) >= 4 else ("••••" if key else "")
    return visible


def split_pasted_api(text: str) -> tuple[str, str]:
    url = ""
    key = ""
    for part in text.replace("\n", " ").replace(",", " ").split():
        if part.startswith(("http://", "https://")):
            url = part.rstrip("/")
        elif not key:
            key = part
    return url, key


def host_for_key(key: str) -> str:
    if key.startswith("sk-or-"):
        return OPENROUTER_BASE
    return OPENAI_BASE


def valid_base_url(value: str) -> bool:
    parsed = urlparse(value.strip())
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc) and " " not in value


def create_app(rules_dir: Path | None = None, data_dir: Path | None = None) -> FastAPI:
    rules_path = Path(rules_dir or DEFAULT_RULES)
    data = Path(data_dir or DEFAULT_DATA)
    data.mkdir(parents=True, exist_ok=True)
    settings_path = data / "settings.json"
    job = Job(rules_path, data)
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

    def merged(body: SettingsBody, *, pasted_key: bool = False) -> dict:
        current = read_saved()
        pasted_url, pasted = split_pasted_api(body.api_key)
        if pasted_key and pasted_url:
            base = pasted_url
        elif body.base_url.strip():
            base = body.base_url.strip().rstrip("/")
        elif pasted_key:
            base = host_for_key(pasted or str(current.get("api_key") or ""))
        else:
            base = str(current.get("base_url") or "").rstrip("/") or host_for_key(str(current.get("api_key") or ""))
        saved_models = current.get("models") if isinstance(current.get("models"), list) else []
        settings = {
            "base_url": base,
            "api_key": pasted or str(current.get("api_key") or ""),
            "model": body.model.strip(),
            "models": [str(item).strip() for item in saved_models if str(item).strip()],
            "api_style": body.api_style or "chat",
            "max_input_tokens": body.max_input_tokens,
            "max_output_tokens": body.max_output_tokens,
            "request_timeout_seconds": body.request_timeout_seconds,
        }
        if settings["api_style"] not in {"chat", "responses"}:
            raise HTTPException(status_code=400, detail="API không dùng được.")
        if not 1024 <= settings["max_input_tokens"] <= 2_000_000:
            raise HTTPException(status_code=400, detail="Token đầu vào cần từ 1024 đến 2000000.")
        if not 256 <= settings["max_output_tokens"] <= 200_000:
            raise HTTPException(status_code=400, detail="Token đầu ra cần từ 256 đến 200000.")
        if not valid_base_url(settings["base_url"]):
            raise HTTPException(status_code=400, detail="API không dùng được.")
        return settings

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
        return public_settings(read_saved())

    @app.put("/api/settings")
    def put_settings(body: SettingsBody):
        settings = merged(body, pasted_key=bool(body.api_key.strip()))
        store(settings)
        return public_settings(settings)

    @app.post("/api/settings/test")
    def test_settings(body: SettingsBody):
        settings = merged(body, pasted_key=bool(body.api_key.strip()))
        if not settings["api_key"] and not split_pasted_api(body.api_key)[0]:
            raise HTTPException(status_code=400, detail=NEED_KEY)
        client = HttpLlm(settings)
        try:
            models = client.list_models()
        except LlmError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        finally:
            client.close()
        if settings["model"] not in models:
            settings["model"] = ""
        settings["models"] = models
        store(settings)
        return {"ok": True, "message": "Chọn model.", "models": models, "model": settings["model"]}

    @app.get("/api/job")
    def get_job(source: int = 0):
        return job.snapshot(include_source=bool(source))

    @app.post("/api/job")
    def start_job(body: JobBody):
        settings = read_saved()
        if not settings.get("api_key") or not valid_base_url(str(settings.get("base_url") or "")):
            raise HTTPException(status_code=400, detail=NEED_KEY)
        if not settings.get("model"):
            raise HTTPException(status_code=400, detail=NEED_MODEL)
        try:
            job.begin(body.source_text, settings, body.mode)
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
