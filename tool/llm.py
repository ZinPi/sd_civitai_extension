"""Gọi API kiểu Chat hoặc Responses. Không tự gửi lại khi hết giờ chờ."""

from __future__ import annotations

import time
from dataclasses import dataclass

import httpx


class LlmError(Exception):
    def __init__(self, message: str, kind: str = "other"):
        super().__init__(message)
        self.kind = kind


@dataclass
class Completion:
    text: str
    finish: str


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

    def complete(self, system: str, user: str, max_output_tokens: int) -> Completion:
        style = self.settings.get("api_style") or "chat"
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

            if response.status_code == 429 and not saw_rate_limit:
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
                raise LlmError("Khóa API bị từ chối.", "auth")
            if response.status_code >= 400:
                kind = "context" if self._is_context_limit(response.text) else "bad"
                raise LlmError(self._snip(response.text) or f"API trả lỗi {response.status_code}.", kind)

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
        if style == "responses":
            return {
                "model": self.settings["model"],
                "input": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "max_output_tokens": max_output_tokens,
                "temperature": 0,
                "stream": False,
            }
        return {
            "model": self.settings["model"],
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": max_output_tokens,
            "temperature": 0,
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
            raise LlmError("API không dùng được.", "auth")
        if response.status_code >= 400:
            raise LlmError("API không dùng được.", "bad")
        try:
            data = response.json()
        except ValueError as exc:
            raise LlmError("API không trả danh sách.", "bad") from exc
        if not isinstance(data, dict):
            raise LlmError("API không trả danh sách.", "bad")
        models = parse_model_ids(data)
        if not models:
            raise LlmError("Không thấy model nào.", "empty")
        return models

    def _http(self) -> httpx.Client:
        if self._client is None:
            timeout = float(self.settings.get("request_timeout_seconds") or 180)
            self._client = httpx.Client(timeout=httpx.Timeout(connect=30, read=timeout, write=60, pool=30))
        return self._client

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.settings.get('api_key', '')}",
            "Content-Type": "application/json",
        }

    def _post(self, style: str, payload: dict) -> httpx.Response:
        return self._http().post(self._endpoint(style), headers=self._headers(), json=payload)

    def _models_endpoint(self) -> str:
        base = str(self.settings.get("base_url") or "").rstrip("/")
        return base if base.endswith("/models") else base + "/models"

    def _endpoint(self, style: str) -> str:
        base = str(self.settings.get("base_url") or "").rstrip("/")
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
