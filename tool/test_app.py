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
        self.root = root
        self.client = TestClient(create_app(rules, root / "data", root / "config.json"))

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
        self.assertIn('id="model-wrap" hidden', text)
        self.assertNotIn("Dán API", text)
        self.assertNotIn(">Kiểm tra<", text)
        self.assertNotIn("TeamSocLo", text)
        self.assertNotIn('id="api-key"', text)
        self.assertNotIn("Địa chỉ API", text)
        self.assertNotIn("Tên model", text)
        self.assertNotIn("Kiểu API", text)
        self.assertNotIn("teamsoclo.site", text)
        self.assertNotIn("tuansuapi", text)
        self.assertNotIn("openai.com", text)
        self.assertNotIn("Chọn bộ quy tắc", text)
        self.assertNotIn("USD", text)
        self.assertNotIn("ZIP", text)

    def write_config(self, provider="teamsoclo", api_key=""):
        Path(self.root, "config.json").write_text(
            json.dumps({"provider": provider, "api_key": api_key}),
            encoding="utf-8",
        )

    def test_settings_do_not_echo_the_key(self):
        self.write_config(api_key="super-secret-key")
        with mock.patch.object(HttpLlm, "list_models", lambda self: ["mock"]):
            saved = self.client.get("/api/settings")
        self.assertEqual(saved.status_code, 200)
        self.assertNotIn("super-secret-key", saved.text)
        self.assertNotIn("has_key", saved.text)
        self.assertEqual(saved.json()["api_state"], "ok")
        again = self.client.put(
            "/api/settings",
            json={
                "api_key": "another-secret",
                "model": "mock",
                "max_input_tokens": 120000,
                "max_output_tokens": 8192,
                "request_timeout_seconds": 180,
            },
        )
        stored = json.loads(Path(self.tmp.name, "data", "settings.json").read_text(encoding="utf-8"))
        self.assertNotIn("api_key", stored)
        self.assertNotIn("super-secret-key", again.text)
        self.assertNotIn("another-secret", again.text)

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
        self.assertIn("API không hợp lệ", response.json()["detail"])

    def test_open_lists_models_from_the_config_file(self):
        self.write_config(api_key="secret-key")

        def fake_list(self):
            self.seen_base = self.settings["base_url"]
            return ["m-b", "m-a"]

        with mock.patch.object(HttpLlm, "list_models", fake_list):
            response = self.client.get("/api/settings")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["api_state"], "ok")
        self.assertEqual(body["models"], ["m-b", "m-a"])
        self.assertNotIn("secret-key", response.text)
        self.assertNotIn("api.openai.com", response.text)
        stored = json.loads(Path(self.tmp.name, "data", "settings.json").read_text(encoding="utf-8")) if Path(self.tmp.name, "data", "settings.json").is_file() else {}
        self.assertNotIn("api_key", stored)
        self.assertNotIn("base_url", body)
        self.assertNotIn("teamsoclo.site", response.text)

    def test_rejected_key_and_network_use_different_messages(self):
        from llm import LlmError

        self.write_config(api_key="secret-key")
        with mock.patch.object(HttpLlm, "list_models", side_effect=LlmError("no", "auth")):
            rejected = self.client.get("/api/settings")
        self.assertEqual(rejected.json()["api_state"], "invalid")
        self.assertEqual(rejected.json()["message"], "API không hợp lệ")
        self.assertEqual(rejected.json()["models"], [])

        client = TestClient(create_app(self.root / "rules", self.root / "data-net", self.root / "config.json"))
        with mock.patch.object(HttpLlm, "list_models", side_effect=LlmError("down", "network")):
            offline = client.get("/api/settings")
        self.assertEqual(offline.json()["api_state"], "network")
        self.assertEqual(offline.json()["message"], "Không nối được API.")
        self.assertNotIn("API không hợp lệ", offline.text)

    def test_tuansu_uses_its_chat_endpoint_without_showing_the_address(self):
        self.write_config(provider="tuansu", api_key="sk-or-v1-secret")
        with mock.patch.object(HttpLlm, "list_models", lambda self: ["vendor/m"]):
            response = self.client.get("/api/settings")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn("tuansuapi", response.text)
        self.assertNotIn("sk-or-v1-secret", response.text)
        picked = self.client.put("/api/settings", json={"model": "vendor/m"})
        self.assertEqual(picked.status_code, 200)
        self.assertEqual(picked.json()["model"], "vendor/m")
        stored = json.loads(Path(self.tmp.name, "data", "settings.json").read_text(encoding="utf-8"))
        self.assertEqual(stored["base_url"], "https://tuansuapi.store/v1")
        self.assertEqual(stored["api_style"], "chat")
        self.assertNotIn("api_key", stored)
        self.assertNotIn("tuansuapi", picked.text)
        self.assertNotIn("sk-or-v1-secret", picked.text)


if __name__ == "__main__":
    unittest.main()
