"""Giữ trang chạy nền. Đóng cửa sổ đen không tắt trang."""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn

from app import app

HOST = "127.0.0.1"
PORT = 8765
THU_MUC = Path(__file__).resolve().parent
FILE_PID = THU_MUC / "tool.pid"
FILE_LOI = THU_MUC / "loi.txt"

# DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB
CO_TACH = 0x00000008 | 0x00000200 | 0x01000000
# Không thoát được job thì vẫn tách khỏi cửa sổ đen.
CO_TACH_DU_PHONG = 0x00000008 | 0x00000200


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


def _cong() -> int:
    raw = os.environ.get("TOOL_PORT", "")
    if raw.isdigit():
        return int(raw)
    return PORT


def _mo_trinh_duyet(port: int) -> None:
    if os.environ.get("TOOL_KHONG_MO_TRINH_DUYET"):
        return
    dia_chi = f"http://{HOST}:{port}"
    if os.name == "nt":
        os.startfile(dia_chi)
        return
    webbrowser.open(dia_chi)


def trinh_chay_nen(exe: Path | None = None) -> str:
    """pythonw không gắn cửa sổ đen. Không có file đó thì dùng python đang chạy."""
    goc = Path(exe or sys.executable)
    pyw = goc.with_name("pythonw.exe")
    if pyw.is_file():
        return str(pyw)
    return str(goc)


def bat_dau_tach(argv: list[str], cwd: Path, *, he_windows: bool | None = None) -> subprocess.Popen:
    """Tách tiến trình khỏi cửa sổ đang mở. Đóng cửa sổ không tắt tiến trình."""
    windows = os.name == "nt" if he_windows is None else he_windows
    chung = {
        "cwd": str(cwd),
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if not windows:
        return subprocess.Popen(argv, start_new_session=True, **chung)
    try:
        return subprocess.Popen(argv, creationflags=CO_TACH, **chung)
    except OSError:
        return subprocess.Popen(argv, creationflags=CO_TACH_DU_PHONG, **chung)


def chay_nen() -> None:
    argv = [trinh_chay_nen(), str(Path(__file__).resolve())]
    bat_dau_tach(argv, THU_MUC)


def main() -> None:
    port = _cong()
    if cong_dang_mo(HOST, port):
        _mo_trinh_duyet(port)
        return
    FILE_PID.write_text(str(os.getpid()), encoding="utf-8")
    server = mo_may_chu(HOST, port)
    if not doi_cong(HOST, port):
        server.should_exit = True
        FILE_PID.unlink(missing_ok=True)
        raise RuntimeError(f"Trang không mở được trên cổng {port}.")
    _mo_trinh_duyet(port)
    try:
        while True:
            time.sleep(0.5)
    finally:
        server.should_exit = True
        FILE_PID.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        if "--nen" in sys.argv[1:]:
            chay_nen()
        else:
            main()
    except Exception:
        import traceback

        FILE_LOI.write_text(traceback.format_exc(), encoding="utf-8")
        raise SystemExit(1)
