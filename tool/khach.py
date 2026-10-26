"""Biết tab trình duyệt còn mở. Hết tab thì tiến trình được phép thoát."""

from __future__ import annotations

import os
import re
import threading
import time

_MA = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# Nhịp đã gửi trước khi đóng tab có thể tới sau. Không dùng nhịp đó để giữ tiến trình.
_BO_QUA_NHIP = 1.0


def _gio(name: str, mac_dinh: float, thap: float, cao: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return mac_dinh
    try:
        value = float(raw)
    except ValueError:
        return mac_dinh
    if value < thap or value > cao:
        return mac_dinh
    return value


class KhachTrang:
    """Nhịp từ tab đang mở. Rời tab thì chờ một chút, phòng lúc tải lại trang."""

    def __init__(self, cho_roi: float | None = None, het_nhip: float | None = None):
        self.cho_roi = _gio("TOOL_CHO_ROI_GIAY", 5.0, 0.2, 30.0) if cho_roi is None else cho_roi
        self.het_nhip = _gio("TOOL_HET_NHIP_GIAY", 150.0, 1.0, 600.0) if het_nhip is None else het_nhip
        self._lock = threading.Lock()
        self._nhip: dict[str, float] = {}
        self._roi_luc: dict[str, float] = {}
        self._da_thay = False
        self._hen_tat: float | None = None

    def nhip(self, raw: str, bay_gio: float | None = None) -> bool:
        ma = _hop_le(raw)
        if not ma:
            return False
        now = time.monotonic() if bay_gio is None else bay_gio
        with self._lock:
            roi_luc = self._roi_luc.get(ma)
            if roi_luc is not None and now - roi_luc < _BO_QUA_NHIP:
                return True
            self._roi_luc.pop(ma, None)
            self._nhip[ma] = now
            self._da_thay = True
            self._hen_tat = None
        return True

    def roi(self, raw: str, bay_gio: float | None = None) -> None:
        ma = _hop_le(raw)
        if not ma:
            return
        now = time.monotonic() if bay_gio is None else bay_gio
        with self._lock:
            self._roi_luc[ma] = now
            self._nhip.pop(ma, None)
            self._het_khach(now)

    def nen_tat(self, bay_gio: float | None = None) -> bool:
        now = time.monotonic() if bay_gio is None else bay_gio
        with self._lock:
            self._het_khach(now)
            return self._hen_tat is not None and now >= self._hen_tat

    def _het_khach(self, now: float) -> None:
        cu = [ma for ma, luc in self._nhip.items() if now - luc >= self.het_nhip]
        for ma in cu:
            del self._nhip[ma]
        cu_roi = [ma for ma, luc in self._roi_luc.items() if now - luc >= self.het_nhip]
        for ma in cu_roi:
            del self._roi_luc[ma]
        if self._nhip:
            self._hen_tat = None
            return
        if self._da_thay and self._hen_tat is None:
            self._hen_tat = now + self.cho_roi


def _hop_le(raw: str) -> str:
    ma = (raw or "").strip()
    if not _MA.fullmatch(ma):
        return ""
    return ma
