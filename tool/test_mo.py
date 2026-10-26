import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import mo


class MoTests(unittest.TestCase):
    def test_cong_chua_mo(self):
        self.assertFalse(mo.cong_dang_mo("127.0.0.1", 9))

    def test_may_chu_mo_roi_tat(self):
        server = mo.mo_may_chu("127.0.0.1", 18765)
        self.addCleanup(lambda: setattr(server, "should_exit", True))
        self.assertTrue(mo.doi_cong("127.0.0.1", 18765, giay=10))
        server.should_exit = True

    def test_co_tach_khoi_cua_so_den(self):
        self.assertEqual(mo.CO_TACH & 0x00000008, 0x00000008)
        self.assertEqual(mo.CO_TACH & 0x00000200, 0x00000200)
        self.assertEqual(mo.CO_TACH & 0x01000000, 0x01000000)
        self.assertEqual(mo.CO_TACH_DU_PHONG & 0x01000000, 0)

    def test_uu_tien_pythonw(self):
        with tempfile.TemporaryDirectory() as tmp:
            thu = Path(tmp)
            (thu / "python.exe").write_text("", encoding="utf-8")
            (thu / "pythonw.exe").write_text("", encoding="utf-8")
            self.assertEqual(mo.trinh_chay_nen(thu / "python.exe"), str(thu / "pythonw.exe"))
            (thu / "pythonw.exe").unlink()
            self.assertEqual(mo.trinh_chay_nen(thu / "python.exe"), str(thu / "python.exe"))

    def test_thu_lai_khi_khong_thoat_duoc_job(self):
        calls = []

        def popen(argv, **kwargs):
            calls.append(kwargs["creationflags"])
            if len(calls) == 1:
                raise OSError("access denied")
            return "proc"

        with mock.patch("mo.subprocess.Popen", popen):
            got = mo.bat_dau_tach(["py", "mo.py"], Path("."), he_windows=True)
        self.assertEqual(got, "proc")
        self.assertEqual(calls[0] & 0x01000000, 0x01000000)
        self.assertEqual(calls[1] & 0x00000008, 0x00000008)
        self.assertEqual(calls[1] & 0x01000000, 0)

    def test_lenh_nen_khong_goi_lai_chinh_no(self):
        with mock.patch("mo.bat_dau_tach", return_value=None) as tach:
            mo.chay_nen()
        argv = tach.call_args.args[0]
        self.assertEqual(argv[1], str(Path(mo.__file__).resolve()))
        self.assertNotIn("--nen", argv)

    def test_trang_van_chay_sau_khi_tien_trinh_mo_da_thoat(self):
        port = 18772
        self.assertFalse(mo.cong_dang_mo("127.0.0.1", port))
        env = os.environ.copy()
        env["TOOL_PORT"] = str(port)
        env["TOOL_KHONG_MO_TRINH_DUYET"] = "1"
        mo.FILE_LOI.unlink(missing_ok=True)
        mo.FILE_PID.unlink(missing_ok=True)
        tien_trinh = subprocess.Popen(
            [sys.executable, str(Path(mo.__file__).resolve()), "--nen"],
            env=env,
            cwd=str(mo.THU_MUC),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        ma = tien_trinh.wait(timeout=15)
        pid = None
        try:
            if ma != 0:
                loi = mo.FILE_LOI.read_text(encoding="utf-8") if mo.FILE_LOI.is_file() else ""
                self.fail(loi or f"mo nen tra ve {ma}")
            if not mo.doi_cong("127.0.0.1", port, giay=15):
                loi = mo.FILE_LOI.read_text(encoding="utf-8") if mo.FILE_LOI.is_file() else ""
                self.fail(loi or "trang khong mo")
            pid = int(mo.FILE_PID.read_text(encoding="utf-8").strip())
            os.kill(pid, 0)
            self.assertNotEqual(pid, tien_trinh.pid)
            self.assertIsNotNone(tien_trinh.poll())
        finally:
            if pid:
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass
            for _ in range(50):
                if not mo.cong_dang_mo("127.0.0.1", port):
                    break
                time.sleep(0.1)
            mo.FILE_PID.unlink(missing_ok=True)
            mo.FILE_LOI.unlink(missing_ok=True)

    def test_chay_bat_tu_tat_va_de_trang_chay(self):
        text = Path(mo.__file__).with_name("Chay.bat").read_bytes()
        self.assertFalse(text.startswith(b"\xef\xbb\xbf"))
        self.assertIn(b"\r\n", text)
        noi = text.decode("ascii")
        self.assertIn('mo.py" --nen', noi)
        self.assertNotIn("chay_an.vbs", noi)
        self.assertNotIn("app.py", noi)
        self.assertIn(
            "https://github.com/ZinPi/sd_civitai_extension/archive/refs/heads/cursor/quy-tac-tool-48d3.zip",
            noi,
        )
        self.assertIn("Tat.bat", noi)
        damo = noi.split(":damo", 1)[1].split(":loimo", 1)[0]
        self.assertIn("\nexit\r\n", damo)
        self.assertNotIn("exit /b", damo)
        tat = Path(mo.__file__).with_name("Tat.bat").read_text(encoding="ascii")
        self.assertIn("tool.pid", tat)
        self.assertIn("8765", tat)
        self.assertIn("taskkill", tat)
        self.assertNotIn("chay_an.vbs", tat)


if __name__ == "__main__":
    unittest.main()
