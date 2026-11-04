"""API giả để bấm thử giao diện. Không dùng cho tác phẩm thật."""

from __future__ import annotations

import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from engine import source_rows


def answer(system: str, user: str) -> str:
    step = "test"
    for line in system.splitlines():
        if line.startswith("TOOL_STEP:"):
            step = line.split(":", 1)[1].strip()
    if step == "test":
        return "ok"
    if step in {"extract", "merge"}:
        return (
            "CHAR_01\n"
            "Tên: cô bé\n"
            "Xuất hiện từ hai câu khác nhau, đứng ở cửa patio.\n\n"
            "BG_01\n"
            "Patio, cửa gỗ, gió lay rèm.\n"
        )
    if step == "char":
        return (
            "CHAR_01 — full body three-quarter front, simple dress, dark hair, standing at a wooden door.\n"
            "CHAR_01 — head and shoulders, same face, same hair, soft daylight.\n"
            "CHAR_01 — full body back view, same dress and hair, patio behind.\n"
        )
    if step == "bg":
        return "BG_01 — wooden patio door, linen curtain, afternoon wind, empty of people.\n"
    if step == "qa":
        return "Đối chiếu đủ dòng, đủ BG.\nTOOL_QA: PASS"
    rows = source_rows(user)
    lines = []
    for number, _text in rows:
        width = max(3, len(str(number)))
        lines.append(
            f"{number:0{width}d} | CHAR_01.BG_01 | IMAGE_PROMPT: "
            "A girl at a wooden patio door, wind moving a linen curtain, late daylight."
        )
    return "\n".join(lines)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length) or b"{}")
        system = ""
        user = ""
        for message in payload.get("messages") or []:
            if message.get("role") == "system":
                system += message.get("content") or ""
            if message.get("role") == "user":
                user += message.get("content") or ""
        time.sleep(0.45)
        body = json.dumps(
            {"choices": [{"message": {"content": answer(system, user)}, "finish_reason": "stop"}]},
            ensure_ascii=False,
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        return


if __name__ == "__main__":
    import os

    server = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("MOCK_PORT", "8766"))), Handler)
    server.serve_forever()
