import json
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from app import create_app
from test_runner import write_rules


class AppTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        rules = root / "rules"
        rules.mkdir()
        write_rules(rules, "quy tac")
        self.client = TestClient(create_app(rules, root / "data"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_page_has_one_primary_path(self):
        page = self.client.get("/")
        self.assertEqual(page.status_code, 200)
        text = page.text
        self.assertIn("Chạy cả bốn bước", text)
        self.assertIn("Bản đã chia dòng", text)
        self.assertIn("Tat.bat", text)
        self.assertIn("Chay.bat", text)
        self.assertNotIn("Chọn bộ quy tắc", text)
        self.assertNotIn("USD", text)
        self.assertNotIn("ZIP", text)

    def test_settings_do_not_echo_the_key(self):
        saved = self.client.put(
            "/api/settings",
            json={
                "base_url": "http://127.0.0.1:9/v1",
                "api_key": "super-secret-key",
                "model": "mock",
                "api_style": "chat",
                "max_input_tokens": 120000,
                "max_output_tokens": 8192,
                "request_timeout_seconds": 180,
            },
        )
        self.assertEqual(saved.status_code, 200)
        self.assertNotIn("super-secret-key", saved.text)
        self.assertTrue(saved.json()["has_key"])
        again = self.client.put(
            "/api/settings",
            json={
                "base_url": "http://127.0.0.1:9/v1",
                "api_key": "",
                "model": "mock",
                "api_style": "chat",
                "max_input_tokens": 120000,
                "max_output_tokens": 8192,
                "request_timeout_seconds": 180,
            },
        )
        stored = json.loads(Path(self.tmp.name, "data", "settings.json").read_text(encoding="utf-8"))
        self.assertEqual(stored["api_key"], "super-secret-key")
        self.assertNotIn("super-secret-key", again.text)

    def test_rules_endpoint_lists_files(self):
        response = self.client.get("/api/rules")
        self.assertEqual(response.status_code, 200)
        files = response.json()["files"]
        self.assertEqual([item["name"] for item in files], [
            "00_QUY_TRINH_HUONG_DAN.txt",
            "01_TRICH_NHAN_VAT_VA_BOI_CANH.txt",
            "02_PROMPT_THAM_CHIEU_CHAR_BG.txt",
            "03_PROMPT_ANH_THEO_DONG.txt",
            "04_QA_PROMPT_THEO_DONG.txt",
        ])
        self.assertTrue(all(item["bytes"] > 0 and not item["missing"] for item in files))

    def test_run_without_a_key_explains_where_to_fill_it(self):
        response = self.client.post("/api/job", json={"source_text": "Một câu.", "mode": "all"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("Kết nối API", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
