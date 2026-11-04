import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from app import create_app
from llm import HttpLlm
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
        self.assertIn("Dán API", text)
        self.assertIn(">Kiểm tra<", text)
        self.assertIn("TeamSocLo", text)
        self.assertIn('id="model-wrap" hidden', text)
        self.assertNotIn("Địa chỉ API", text)
        self.assertNotIn("Tên model", text)
        self.assertNotIn("Kiểu API", text)
        self.assertNotIn("teamsoclo.site", text)
        self.assertNotIn("tuansuapi", text)
        self.assertNotIn("openai.com", text)
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
        self.assertIn("Dán API", response.json()["detail"])

    def test_check_shows_model_choices_without_a_typed_name(self):
        def fake_list(self):
            self.seen_base = self.settings["base_url"]
            return ["m-b", "m-a"]

        with mock.patch.object(HttpLlm, "list_models", fake_list):
            response = self.client.post("/api/settings/test", json={"api_key": "secret-key"})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["models"], ["m-b", "m-a"])
        self.assertEqual(body["message"], "Chọn model.")
        self.assertNotIn("secret-key", response.text)
        self.assertNotIn("api.openai.com", response.text)
        stored = json.loads(Path(self.tmp.name, "data", "settings.json").read_text(encoding="utf-8"))
        self.assertEqual(stored["api_key"], "secret-key")
        self.assertEqual(stored["provider"], "teamsoclo")
        self.assertEqual(stored["base_url"], "https://gpt.teamsoclo.site/v1")
        self.assertEqual(stored["api_style"], "responses")
        self.assertEqual(stored["model"], "")
        self.assertNotIn("base_url", self.client.get("/api/settings").json())
        self.assertNotIn("teamsoclo.site", response.text)

    def test_tuansu_uses_its_chat_endpoint_without_showing_the_address(self):
        with mock.patch.object(HttpLlm, "list_models", lambda self: ["vendor/m"]):
            response = self.client.post(
                "/api/settings/test",
                json={"provider": "tuansu", "api_key": "sk-or-v1-secret"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn("tuansuapi", response.text)
        self.assertNotIn("sk-or-v1-secret", response.text)
        stored = json.loads(Path(self.tmp.name, "data", "settings.json").read_text(encoding="utf-8"))
        self.assertEqual(stored["base_url"], "https://tuansuapi.store/v1")
        self.assertEqual(stored["api_style"], "chat")
        picked = self.client.put("/api/settings", json={"provider": "tuansu", "api_key": "", "model": "vendor/m"})
        self.assertEqual(picked.status_code, 200)
        self.assertEqual(picked.json()["model"], "vendor/m")
        self.assertNotIn("tuansuapi", picked.text)
        self.assertNotIn("sk-or-v1-secret", picked.text)


if __name__ == "__main__":
    unittest.main()
