import json
import unittest

import httpx

from llm import HttpLlm, LlmError, extract_completion, parse_model_ids, text_model_ids


class LlmTests(unittest.TestCase):
    def test_text_models_drop_pictures_and_speech(self):
        kept = text_model_ids(
            ["gpt-5", "gpt-image-1", "whisper-1", "claude-sonnet", "tts-1"],
            "openai",
        )
        self.assertEqual(kept, ["gpt-5"])
        kept = text_model_ids(["claude-sonnet", "gpt-5", "claude-tts"], "claude")
        self.assertEqual(kept, ["claude-sonnet"])

    def test_teamsoclo_posts_responses_with_instructions(self):
        seen = {}

        def handler(request):
            seen["url"] = str(request.url)
            seen["body"] = json.loads(request.content.decode("utf-8"))
            seen["auth"] = request.headers["authorization"]
            return httpx.Response(
                200,
                json={
                    "status": "completed",
                    "output_text": "ok",
                },
            )

        llm = HttpLlm(
            {
                "provider": "teamsoclo",
                "base_url": "https://gpt.teamsoclo.site/v1",
                "api_key": "secret",
                "model": "m",
            },
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        self.assertEqual(llm.complete("quy tac", "dong 1", 32).text, "ok")
        self.assertEqual(seen["url"], "https://gpt.teamsoclo.site/v1/responses")
        self.assertEqual(seen["auth"], "Bearer secret")
        self.assertEqual(seen["body"]["instructions"], "quy tac")
        self.assertEqual(seen["body"]["input"], "dong 1")
        self.assertNotIn("temperature", seen["body"])
        self.assertNotIn("messages", seen["body"])

    def test_claude_posts_messages_with_its_own_header(self):
        seen = {}

        def handler(request):
            seen["url"] = str(request.url)
            seen["key"] = request.headers["x-api-key"]
            seen["body"] = json.loads(request.content.decode("utf-8"))
            return httpx.Response(
                200,
                json={
                    "stop_reason": "end_turn",
                    "content": [{"type": "text", "text": "ok"}],
                },
            )

        llm = HttpLlm(
            {"provider": "claude", "api_key": "secret", "model": "claude-sonnet"},
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        self.assertEqual(llm.complete("sys", "user", 16).text, "ok")
        self.assertEqual(seen["url"], "https://api.anthropic.com/v1/messages")
        self.assertEqual(seen["key"], "secret")
        self.assertEqual(seen["body"]["system"], "sys")
        self.assertEqual(seen["body"]["messages"], [{"role": "user", "content": "user"}])

    def test_model_choices_use_ids_not_display_names(self):
        ids = parse_model_ids(
            {
                "data": [
                    {"id": "b-model", "name": "Tên đẹp", "owned_by": "example.com"},
                    {"id": "a-model", "name": "Tên web"},
                    {"id": "a-model", "name": "trùng"},
                ]
            }
        )
        self.assertEqual(ids, ["a-model", "b-model"])

    def test_list_models_reads_ids(self):
        def handler(request):
            self.assertTrue(request.url.path.endswith("/models"))
            self.assertEqual(request.headers["authorization"], "Bearer secret")
            return httpx.Response(200, json={"data": [{"id": "m", "name": "Tên model"}]})

        llm = HttpLlm(
            {"base_url": "https://example.test/v1", "api_key": "secret", "model": "", "api_style": "chat"},
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        self.assertEqual(llm.list_models(), ["m"])

    def test_bad_key_does_not_echo_the_secret(self):
        def handler(request):
            return httpx.Response(401, json={"error": {"message": "bad secret"}})

        llm = HttpLlm(
            {"base_url": "https://example.test/v1", "api_key": "secret", "model": "", "api_style": "chat"},
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        with self.assertRaises(LlmError) as caught:
            llm.list_models()
        self.assertEqual(caught.exception.kind, "auth")
        self.assertNotIn("secret", str(caught.exception))
        self.assertIn("từ chối", str(caught.exception))

    def test_extract_chat_and_responses(self):
        text, finish = extract_completion(
            {"choices": [{"message": {"content": "ok"}, "finish_reason": "length"}]}
        )
        self.assertEqual((text, finish), ("ok", "length"))
        text, finish = extract_completion(
            {
                "status": "incomplete",
                "incomplete_details": {"reason": "max_output_tokens"},
                "output": [{"type": "message", "content": [{"type": "output_text", "text": "một phần"}]}],
            }
        )
        self.assertEqual(finish, "length")
        self.assertIn("một phần", text)

    def test_timeout_is_not_retried(self):
        calls = {"n": 0}

        def handler(request):
            calls["n"] += 1
            raise httpx.ReadTimeout("hết giờ")

        client = httpx.Client(transport=httpx.MockTransport(handler))
        llm = HttpLlm(
            {"base_url": "http://example.test/v1", "api_key": "secret", "model": "m", "api_style": "chat"},
            client=client,
        )
        with self.assertRaises(LlmError) as caught:
            llm.complete("sys", "user", 16)
        self.assertEqual(caught.exception.kind, "timeout")
        self.assertEqual(calls["n"], 1)
        self.assertNotIn("secret", str(caught.exception))

    def test_rate_limit_waits_once(self):
        calls = {"n": 0}
        slept = []

        def handler(request):
            calls["n"] += 1
            if calls["n"] == 1:
                return httpx.Response(429, headers={"retry-after": "2"}, json={"error": {"message": "slow"}})
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]})

        llm = HttpLlm(
            {"base_url": "http://example.test/v1", "api_key": "secret", "model": "m", "api_style": "chat"},
            sleep=slept.append,
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        result = llm.complete("sys", "user", 16)
        self.assertEqual(result.text, "ok")
        self.assertEqual(slept, [2])
        self.assertEqual(calls["n"], 2)

    def test_rejected_token_field_is_adjusted_once(self):
        seen = []

        def handler(request):
            payload = json.loads(request.content.decode("utf-8"))
            seen.append(payload)
            if "max_tokens" in payload:
                return httpx.Response(400, json={"error": {"message": "use max_completion_tokens"}})
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]})

        llm = HttpLlm(
            {"base_url": "https://example.test/v1/chat/completions", "api_key": "k", "model": "m", "api_style": "chat"},
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        self.assertEqual(llm.complete("sys", "user", 32).text, "ok")
        self.assertEqual(len(seen), 2)
        self.assertIn("max_completion_tokens", seen[1])
        self.assertNotIn("max_tokens", seen[1])


if __name__ == "__main__":
    unittest.main()
