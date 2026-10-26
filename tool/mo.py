"""Giữ trang chạy nền. Đóng cửa sổ đen không tắt trang."""

from __future__ import annotations

import os
import socket
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn

from app import app

HOST = "127.0.0.1"
PORT = 8765
DIA_CHI = f"http://{HOST}:{PORT}"
THU_MUC = Path(__file__).resolve().parent
FILE_PID = THU_MUC / "tool.pid"


def cong_dang_mo(host: str = HOST, port: int = PORT) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        return sock.connect_ex((host, port)) == 0


def mo_may_chu(host: str = HOST, port: int = PORT) -> uvicorn.Server:
    config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    server = uvicorn.Server(config)
    server.install_signal_handlers = False

    def run() -> None:
        server.run()

    threading.Thread(target=run, daemon=True).start()
    return server


def doi_cong(host: str = HOST, port: int = PORT, giay: float = 15) -> bool:
    het_gio = time.time() + giay
    while time.time() < het_gio:
        if cong_dang_mo(host, port):
            return True
        time.sleep(0.1)
    return False


def _mo_trinh_duyet() -> None:
    webbrowser.open(DIA_CHI)
    if os.name == "nt":
        os.startfile(DIA_CHI)


def main() -> None:
    if cong_dang_mo():
        _mo_trinh_duyet()
        return
    FILE_PID.write_text(str(os.getpid()), encoding="utf-8")
    server = mo_may_chu()
    if not doi_cong():
        server.should_exit = True
        FILE_PID.unlink(missing_ok=True)
        raise RuntimeError("Trang không mở được trên cổng 8765.")
    _mo_trinh_duyet()
    try:
        while True:
            time.sleep(0.5)
    finally:
        server.should_exit = True
        FILE_PID.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        from pathlib import Path

        Path(__file__).resolve().with_name("loi.txt").write_text(traceback.format_exc(), encoding="utf-8")
        raise
