"""Mở trang trên trình duyệt và giữ tool bằng một cửa sổ thường."""

from __future__ import annotations

import socket
import threading
import time
import webbrowser

import uvicorn

from app import app

HOST = "127.0.0.1"
PORT = 8765
DIA_CHI = f"http://{HOST}:{PORT}"


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


def _hop_thoai(noi_dung: str) -> None:
    import tkinter as tk
    from tkinter import messagebox

    goc = tk.Tk()
    goc.withdraw()
    messagebox.showinfo("Tạo prompt ảnh", noi_dung)
    goc.destroy()


def _cua_so(server: uvicorn.Server) -> None:
    import tkinter as tk

    goc = tk.Tk()
    goc.title("Tạo prompt ảnh")
    goc.configure(bg="#f3ecdf")
    goc.resizable(False, False)
    goc.geometry("440x210")

    chu = tk.Label(
        goc,
        text="Trang đã mở trên trình duyệt.\nCửa sổ này giữ tool chạy.\nThu nhỏ cũng được.\nDùng xong thì bấm Tắt.",
        bg="#f3ecdf",
        fg="#221c16",
        font=("Segoe UI", 12),
        justify="left",
    )
    chu.pack(anchor="w", padx=22, pady=(22, 12))

    hang = tk.Frame(goc, bg="#f3ecdf")
    hang.pack(anchor="w", padx=22)

    def mo_lai() -> None:
        webbrowser.open(DIA_CHI)

    def tat() -> None:
        server.should_exit = True
        goc.destroy()

    tk.Button(
        hang,
        text="Mở lại trang",
        command=mo_lai,
        font=("Segoe UI", 11),
        bg="#fffdf8",
        relief="flat",
        padx=12,
        pady=6,
    ).pack(side="left")
    tk.Button(
        hang,
        text="Tắt",
        command=tat,
        font=("Segoe UI", 11, "bold"),
        bg="#8f3d1b",
        fg="#fffaf6",
        activebackground="#8f3d1b",
        activeforeground="#fffaf6",
        relief="flat",
        padx=16,
        pady=6,
    ).pack(side="left", padx=(10, 0))

    goc.protocol("WM_DELETE_WINDOW", tat)
    goc.mainloop()


def main() -> None:
    if cong_dang_mo():
        webbrowser.open(DIA_CHI)
        _hop_thoai("Tool đang chạy sẵn.\nTrình duyệt đã được mở lại.\nCửa sổ Tạo prompt ảnh lúc nãy dùng để tắt.")
        return
    server = mo_may_chu()
    if not doi_cong():
        _hop_thoai("Không mở được trang.\nChụp màn hình này rồi gửi lại.")
        server.should_exit = True
        return
    webbrowser.open(DIA_CHI)
    _cua_so(server)


if __name__ == "__main__":
    main()
