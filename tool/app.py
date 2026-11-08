"""Giao diện cho bốn bước tạo prompt.

Chạy local: python app.py
Mở: http://127.0.0.1:8765

Trên Cursor, cổng lấy từ PORT và khóa API lấy từ PROMPT_API_KEY.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import threading
import time
import zipfile
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from engine import OUTPUT_FILES, RULE_FILES, RULE_LABELS, JobError, atomic_write
from llm import PROVIDERS, HttpLlm, LlmError
from runner import AlreadyRunning, Job

ROOT = Path(__file__).resolve().parent
DEFAULT_DATA = Path(os.environ.get("TOOL_DATA_DIR", ROOT / "data"))
STATIC = ROOT / "static"
_IDENTITY_CACHE: dict[str, tuple[float, dict]] = {}
_IDENTITY_LOCK = threading.Lock()


def default_rules_dir() -> Path:
    chosen = os.environ.get("QUY_TAC_DIR", "").strip()
    if chosen:
        return Path(chosen)
    parent = ROOT.parent / "quy-tac-tool"
    bundled = ROOT / "quy-tac"
    marker = "01_TRICH_NHAN_VAT_VA_BOI_CANH.txt"
    if (parent / marker).is_file():
        return parent
    return bundled

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
    env_provider = os.environ.get("PROMPT_PROVIDER", "").strip()
    env_key = os.environ.get("PROMPT_API_KEY", "").strip()
    if env_provider:
        provider = env_provider
    if env_key:
        api_key = env_key
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


def identify(headers: dict[str, str]) -> dict:
    """Người đang mở app. Local thì một người dùng giả. Trên Cursor thì hỏi helper ký tên."""
    if not os.environ.get("CURSOR_APP_ID"):
        return {"verified": True, "sub": "local", "kind": "person"}
    token = headers.get("x-cursor-identity-v2") or headers.get("x-cursor-identity") or ""
    if not token:
        return {"verified": False, "reason": "missing_header"}
    cache_key = hashlib.sha256(token.encode("utf-8")).hexdigest()
    now = time.time()
    with _IDENTITY_LOCK:
        cached = _IDENTITY_CACHE.get(cache_key)
        if cached and cached[0] > now:
            return dict(cached[1])
    script = ROOT / "cursor" / "who.mjs"
    try:
        result = subprocess.run(
            ["node", str(script)],
            input=json.dumps({"x-cursor-identity-v2": headers.get("x-cursor-identity-v2", ""), "x-cursor-identity": headers.get("x-cursor-identity", "")}),
            text=True,
            capture_output=True,
            timeout=15,
            check=False,
            cwd=str(ROOT),
        )
    except (OSError, subprocess.TimeoutExpired):
        return {"verified": False, "reason": "verifier_unavailable"}
    if result.returncode != 0:
        return {"verified": False, "reason": "verifier_failed"}
    line = ""
    for candidate in reversed(result.stdout.splitlines()):
        if candidate.strip().startswith("{"):
            line = candidate.strip()
            break
    try:
        data = json.loads(line or result.stdout or "{}")
    except json.JSONDecodeError:
        return {"verified": False, "reason": "verifier_failed"}
    if not data.get("verified") or not data.get("sub"):
        return {"verified": False, "reason": str(data.get("reason") or "missing_header")}
    safe = {"verified": True, "sub": str(data["sub"]), "kind": str(data.get("kind") or "person")}
    if len(safe["sub"]) > 512:
        return {"verified": False, "reason": "invalid_claims"}
    with _IDENTITY_LOCK:
        _IDENTITY_CACHE[cache_key] = (now + 60, safe)
        if len(_IDENTITY_CACHE) > 200:
            _IDENTITY_CACHE.clear()
            _IDENTITY_CACHE[cache_key] = (now + 60, safe)
    return dict(safe)


def create_app(
    rules_dir: Path | None = None,
    data_dir: Path | None = None,
    config_path: Path | None = None,
) -> FastAPI:
    rules_path = Path(rules_dir or default_rules_dir())
    data = Path(data_dir or DEFAULT_DATA)
    data.mkdir(parents=True, exist_ok=True)
    secret_path = Path(config_path) if config_path is not None else ROOT / "config.json"
    jobs: dict[str, Job] = {}
    jobs_lock = threading.Lock()
    probe = {"state": "invalid", "message": NEED_KEY, "models": []}
    app = FastAPI(title="Tạo prompt ảnh", docs_url=None, redoc_url=None, openapi_url=None)
    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    def folder_for(sub: str) -> Path:
        if os.environ.get("CURSOR_APP_ID"):
            digest = hashlib.sha256(sub.encode("utf-8")).hexdigest()[:32]
            folder = data / digest
        else:
            folder = data
        folder.mkdir(parents=True, exist_ok=True)
        return folder

    def job_for(sub: str) -> Job:
        folder = folder_for(sub)
        key = str(folder.resolve())
        with jobs_lock:
            found = jobs.get(key)
            if found is None:
                found = Job(rules_path, folder)
                jobs[key] = found
            return found

    def viewer_of(request: Request) -> str:
        sub = getattr(request.state, "viewer", "") or "local"
        return str(sub)

    def read_saved(folder: Path) -> dict:
        return load_settings(folder / "settings.json")

    def store(folder: Path, settings: dict) -> None:
        settings_path = folder / "settings.json"
        atomic_write(settings_path, json.dumps(settings, ensure_ascii=False, indent=2))
        try:
            settings_path.chmod(0o600)
        except OSError:
            pass

    def ensure_probe(folder: Path | None = None) -> dict:
        secret = read_config(secret_path)
        if not secret["api_key"]:
            probe["state"] = "invalid"
            probe["message"] = NEED_KEY
            probe["models"] = []
            return probe
        current = read_saved(folder or data)
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

    def runtime_settings(folder: Path, body: SettingsBody | None = None) -> dict:
        current = read_saved(folder)
        secret = read_config(secret_path)
        checked = ensure_probe(folder)
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

    def store_public(folder: Path, settings: dict) -> None:
        stored = {key: value for key, value in settings.items() if key != "api_key"}
        store(folder, stored)

    @app.middleware("http")
    async def cursor_gate(request: Request, call_next):
        request.state.viewer = "local"
        if request.url.path.startswith("/api") and os.environ.get("CURSOR_APP_ID"):
            picked = {}
            for name in ("x-cursor-identity-v2", "x-cursor-identity"):
                value = request.headers.get(name)
                if value:
                    picked[name] = value[:20000]
            ident = identify(picked)
            sub = str(ident.get("sub") or "")
            if not ident.get("verified") or not sub or len(sub) > 512:
                return JSONResponse(
                    {"detail": "Cần đăng nhập Cursor."},
                    status_code=401,
                    headers={"Cache-Control": "private, no-store"},
                )
            if request.method not in {"GET", "HEAD", "OPTIONS"} and request.headers.get("x-prompt-request") != "1":
                return JSONResponse(
                    {"detail": "Thiếu tiêu đề của trang."},
                    status_code=403,
                    headers={"Cache-Control": "private, no-store"},
                )
            request.state.viewer = sub
        response = await call_next(request)
        if request.url.path.startswith("/api"):
            response.headers["Cache-Control"] = "private, no-store"
        return response

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
        shown = "quy-tac" if os.environ.get("CURSOR_APP_ID") else str(rules_path)
        return {"directory": shown, "files": files}

    @app.get("/api/settings")
    def get_settings(request: Request):
        folder = folder_for(viewer_of(request))
        ensure_probe(folder)
        return public_settings(read_saved(folder), probe)

    @app.put("/api/settings")
    def put_settings(body: SettingsBody, request: Request):
        folder = folder_for(viewer_of(request))
        settings = runtime_settings(folder, body)
        store_public(folder, settings)
        return public_settings(settings, probe)

    @app.get("/api/job")
    def get_job(request: Request, source: int = 0):
        return job_for(viewer_of(request)).snapshot(include_source=bool(source))

    @app.post("/api/job")
    def start_job(body: JobBody, request: Request):
        folder = folder_for(viewer_of(request))
        settings = runtime_settings(folder)
        checked = ensure_probe(folder)
        if checked["state"] == "network":
            raise HTTPException(status_code=400, detail=NEED_NETWORK)
        if checked["state"] != "ok" or not settings.get("api_key"):
            raise HTTPException(status_code=400, detail=NEED_KEY)
        if not settings.get("model"):
            raise HTTPException(status_code=400, detail=NEED_MODEL)
        job = job_for(viewer_of(request))
        try:
            job.begin(body.source_text, settings, body.mode, body.prior_text)
        except AlreadyRunning as exc:
            raise HTTPException(status_code=409, detail="Đang chạy một lượt.") from exc
        except JobError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return job.snapshot()

    @app.post("/api/job/stop")
    def stop_job(request: Request):
        job = job_for(viewer_of(request))
        job.request_stop()
        return job.snapshot()

    @app.post("/api/job/clear")
    def clear_job(request: Request):
        job = job_for(viewer_of(request))
        try:
            job.clear()
        except AlreadyRunning as exc:
            raise HTTPException(status_code=409, detail="Đang chạy một lượt.") from exc
        return job.snapshot(include_source=True)

    @app.get("/api/file/tat-ca")
    def download_all(request: Request):
        names = [
            "DANH_SACH_CHAR_BG.txt",
            "PROMPT_CHAR.txt",
            "PROMPT_BG.txt",
            "PROMPT_THEO_DONG.txt",
            "FILE_TONG_HOP.txt",
            "NHAT_KY.txt",
        ]
        folder = job_for(viewer_of(request)).data_dir
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name in names:
                path = folder / name
                if path.is_file() and path.stat().st_size > 0:
                    archive.write(path, name)
            if not archive.namelist():
                raise HTTPException(status_code=404, detail="Chưa có file để tải.")
        return Response(
            content=buffer.getvalue(),
            media_type="application/zip",
            headers={
                "Content-Disposition": 'attachment; filename="TAT_CA_FILE.zip"',
                "Cache-Control": "private, no-store",
            },
        )

    @app.get("/api/file/{key}")
    def download(key: str, request: Request, preview: int = 0):
        filename = OUTPUT_FILES.get(key)
        if not filename:
            raise HTTPException(status_code=404, detail="Không có file này.")
        path = job_for(viewer_of(request)).output_path(filename)
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
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Cache-Control": "private, no-store",
            },
        )

    return app


app = create_app()


def serve() -> None:
    import uvicorn

    port = int(os.environ.get("PORT") or os.environ.get("TOOL_PORT") or "8765")
    host = "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1"
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    serve()
