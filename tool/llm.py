"""Gọi API kiểu Chat hoặc Responses. Không tự gửi lại khi hết giờ chờ."""

from __future__ import annotations

import time
from dataclasses import dataclass

import httpx


# Cùng bốn chỗ gọi chữ với AI Film Studio. Không hiện địa chỉ web trên màn hình.
PROVIDERS = {
    "teamsoclo": {
        "label": "TeamSocLo",
        "base": "https://gpt.teamsoclo.site/v1",
        "style": "responses",
    },
    "tuansu": {
        "label": "TuanSu",
        "base": "https://tuansuapi.store/v1",
        "style": "chat",
    },
    "openai": {
        "label": "OpenAI",
        "base": "https://api.openai.com/v1",
        "style": "responses",
    },
    "claude": {
        "label": "Claude",
        "base": "https://api.anthropic.com",
        "style": "claude",
    },
}

_SKIP_MODEL = (
    "embedding",
    "tts",
    "audio",
    "video",
    "image",
    "whisper",
    "moderation",
    "realtime",
    "speech",
    "transcription",
    "dall-e",
    "sora",
    "chatgpt",
    "instruct",
    "codex",
    "computer-use",
    "deep-research",
    "search-preview",
    "transcribe",
)


class LlmError(Exception):
    def __init__(self, message: str, kind: str = "other"):
        super().__init__(message)
        self.kind = kind


@dataclass
class Completion:
    text: str
    finish: str


def text_model_ids(model_ids: list[str], provider: str = "") -> list[str]:
    """Giữ model chữ. Bỏ model ảnh, tiếng nói và các loại không dùng để viết prompt."""
    kept: list[str] = []
    seen: set[str] = set()
    for model_id in model_ids:
        lowered = model_id.lower()
        if any(word in lowered for word in _SKIP_MODEL):
            continue
        if provider == "openai" and not lowered.startswith(("gpt-", "o1", "o3", "o4", "o5", "o6")):
            continue
        if provider == "claude" and not lowered.startswith("claude-"):
            continue
        if model_id not in seen:
            seen.add(model_id)
            kept.append(model_id)
    return sorted(kept, key=str.casefold, reverse=provider == "openai")


def parse_model_ids(data: dict) -> list[str]:
    """Lấy mã model để chọn. Không lấy tên hiển thị hay tên web."""
    rows = []
    if isinstance(data, dict):
        for key in ("data", "models"):
            if isinstance(data.get(key), list):
                rows = data[key]
                break
    found: list[str] = []
    seen: set[str] = set()
    for row in rows:
        if isinstance(row, str):
            model_id = row.strip()
        elif isinstance(row, dict):
            model_id = str(row.get("id") or row.get("name") or "").strip()
        else:
            continue
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        found.append(model_id)
    found.sort(key=str.lower)
    return found


def extract_completion(data: dict) -> tuple[str, str]:
    if isinstance(data.get("stop_reason"), str) and isinstance(data.get("content"), list):
        pieces = []
        for block in data["content"]:
            if isinstance(block, dict) and block.get("type") == "text":
                pieces.append(str(block.get("text") or ""))
        finish = "stop" if data["stop_reason"] in {"end_turn", "stop_sequence"} else "length"
        return "\n".join(pieces), finish

    if isinstance(data.get("error"), dict) and not data.get("choices") and not data.get("output"):
        message = data["error"].get("message") or "API trả lỗi."
        raise LlmError(str(message), "bad")

    choices = data.get("choices")
    if isinstance(choices, list) and choices:
        choice = choices[0] if isinstance(choices[0], dict) else {}
        message = choice.get("message") or {}
        content = message.get("content", "")
        if isinstance(content, list):
            pieces = []
            for part in content:
                if isinstance(part, dict):
                    pieces.append(str(part.get("text") or ""))
                elif isinstance(part, str):
                    pieces.append(part)
            content = "\n".join(pieces)
        if not isinstance(content, str):
            content = str(content or "")
        finish = choice.get("finish_reason") or "stop"
        if finish in {"length", "max_tokens"}:
            finish = "length"
        else:
            finish = "stop"
        return content, finish

    pieces = []
    if isinstance(data.get("output_text"), str):
        pieces.append(data["output_text"])
    for item in data.get("output") or []:
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for part in item.get("content") or []:
            if isinstance(part, dict) and part.get("text"):
                pieces.append(str(part["text"]))
    text = "\n".join(pieces).strip()
    reason = (data.get("incomplete_details") or {}).get("reason")
    finish = "length" if data.get("status") == "incomplete" or reason in {"max_output_tokens", "length"} else "stop"
    return text, finish


class HttpLlm:
    def __init__(self, settings: dict, sleep=time.sleep, client: httpx.Client | None = None):
        self.settings = settings
        self.sleep = sleep
        self._client = client
        self._owns_client = client is None

    def close(self) -> None:
        if self._owns_client and self._client is not None:
            self._client.close()

    def _provider(self) -> str:
        return str(self.settings.get("provider") or "")

    def _label(self) -> str:
        return PROVIDERS.get(self._provider(), {}).get("label", "API")

    def _style(self) -> str:
        provider = self._provider()
        if provider in PROVIDERS:
            return PROVIDERS[provider]["style"]
        return self.settings.get("api_style") or "chat"

    def complete(self, system: str, user: str, max_output_tokens: int) -> Completion:
        style = self._style()
        payload = self._payload(style, system, user, max_output_tokens)
        saw_rate_limit = False
        adjustments = 0
        while True:
            try:
                response = self._post(style, payload)
            except httpx.TimeoutException as exc:
                raise LlmError(
                    "Hết giờ chờ. Không tự gửi lại lượt này. Phần đã khóa vẫn giữ.",
                    "timeout",
                ) from exc
            except httpx.TransportError as exc:
                raise LlmError("Không nối được API. Không tự gửi lại.", "network") from exc

            if response.status_code == 429 and style == "chat" and not saw_rate_limit:
                saw_rate_limit = True
                self.sleep(self._wait_seconds(response))
                continue
            if response.status_code == 429:
                raise LlmError("API vẫn báo quá lượt sau khi chờ. Không gửi thêm.", "rate")
            if response.status_code == 400 and adjustments < 2 and self._adjust(payload, response.text):
                adjustments += 1
                continue
            if response.status_code in {408, 524, 504}:
                raise LlmError(
                    "Gateway không trả kết quả. Không tự gửi lại lượt này. Phần đã khóa vẫn giữ.",
                    "timeout",
                )
            if response.status_code in {401, 403}:
                raise LlmError(f"{self._label()} từ chối API. Dán lại rồi bấm Kiểm tra.", "auth")
            if response.status_code >= 400:
                if self._is_context_limit(response.text):
                    raise LlmError("Lượt này dài quá giới hạn. Không tự gửi lại nguyên lượt.", "context")
                raise LlmError(f"{self._label()} không nhận lượt này. Không tự gửi lại.", "bad")

            try:
                data = response.json()
            except ValueError as exc:
                raise LlmError("API không trả JSON. Không tự gửi lại.", "bad") from exc
            if not isinstance(data, dict):
                raise LlmError("API không trả JSON. Không tự gửi lại.", "bad")
            try:
                text, finish = extract_completion(data)
            except LlmError as exc:
                raise LlmError(self._snip(str(exc)), exc.kind) from exc
            if not text.strip():
                raise LlmError("API trả về rỗng. Không nhận lượt này.", "empty")
            return Completion(text=text, finish=finish)

    def _payload(self, style: str, system: str, user: str, max_output_tokens: int) -> dict:
        model = self.settings["model"]
        if style == "claude":
            return {
                "model": model,
                "max_tokens": max_output_tokens,
                "system": system,
                "messages": [{"role": "user", "content": user}],
            }
        if style == "responses":
            payload = {
                "model": model,
                "instructions": system,
                "input": user,
                "max_output_tokens": max_output_tokens,
            }
            if self._provider() == "openai":
                payload["store"] = False
            return payload
        return {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": max_output_tokens,
            "n": 1,
            "stream": False,
        }

    def list_models(self) -> list[str]:
        try:
            response = self._http().get(self._models_endpoint(), headers=self._headers())
        except httpx.TimeoutException as exc:
            raise LlmError("Hết giờ chờ. Bấm Kiểm tra lại.", "timeout") from exc
        except httpx.TransportError as exc:
            raise LlmError("Không nối được API.", "network") from exc
        if response.status_code in {401, 403}:
            body = response.text
            if response.status_code == 403 and "1010" in body:
                raise LlmError("Không nối được API.", "network")
            raise LlmError(f"{self._label()} từ chối API. Dán lại rồi bấm Kiểm tra.", "auth")
        if response.status_code >= 400:
            raise LlmError(f"Không lấy được danh sách model của {self._label()}.", "bad")
        try:
            data = response.json()
        except ValueError as exc:
            raise LlmError("API không trả danh sách.", "bad") from exc
        if not isinstance(data, dict):
            raise LlmError("API không trả danh sách.", "bad")
        models = text_model_ids(parse_model_ids(data), self._provider())
        if not models:
            raise LlmError("Không thấy model chữ nào để chọn.", "empty")
        return models

    def _http(self) -> httpx.Client:
        if self._client is None:
            timeout = float(self.settings.get("request_timeout_seconds") or 180)
            self._client = httpx.Client(timeout=httpx.Timeout(connect=30, read=timeout, write=60, pool=30))
        return self._client

    def _headers(self) -> dict:
        key = str(self.settings.get("api_key") or "")
        if self._style() == "claude":
            return {
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            }
        return {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }

    def _post(self, style: str, payload: dict) -> httpx.Response:
        return self._http().post(self._endpoint(style), headers=self._headers(), json=payload)

    def _base(self) -> str:
        explicit = str(self.settings.get("base_url") or "").rstrip("/")
        if explicit:
            return explicit
        return str(PROVIDERS.get(self._provider(), {}).get("base") or "").rstrip("/")

    def _models_endpoint(self) -> str:
        base = self._base()
        if self._style() == "claude":
            return base + "/v1/models"
        return base if base.endswith("/models") else base + "/models"

    def _endpoint(self, style: str) -> str:
        base = self._base()
        if style == "claude":
            return base if base.endswith("/messages") else base + "/v1/messages"
        if style == "responses":
            return base if base.endswith("/responses") else base + "/responses"
        return base if base.endswith("/chat/completions") else base + "/chat/completions"

    def _adjust(self, payload: dict, body: str) -> bool:
        lowered = body.lower()
        changed = False
        if "max_completion_tokens" in lowered and "max_tokens" in payload:
            payload["max_completion_tokens"] = payload.pop("max_tokens")
            changed = True
        if "temperature" in lowered and "unsupported" in lowered and "temperature" in payload:
            payload.pop("temperature", None)
            changed = True
        if "temperature" in lowered and "not supported" in lowered and "temperature" in payload:
            payload.pop("temperature", None)
            changed = True
        return changed

    def _wait_seconds(self, response: httpx.Response) -> float:
        raw = response.headers.get("retry-after", "")
        try:
            seconds = float(raw)
        except ValueError:
            seconds = 20
        return min(max(seconds, 1), 60)

    def _is_context_limit(self, body: str) -> bool:
        lowered = body.lower()
        markers = (
            "context length",
            "maximum context",
            "context window",
            "too many tokens",
            "input tokens",
            "prompt is too long",
        )
        return any(marker in lowered for marker in markers)

    def _snip(self, text: str) -> str:
        key = str(self.settings.get("api_key") or "")
        if key:
            text = text.replace(key, "…")
        return " ".join(text.split())[:300]
