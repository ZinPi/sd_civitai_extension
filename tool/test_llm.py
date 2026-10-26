import json
import unittest

import httpx

from llm import HttpLlm, LlmError, extract_completion


class LlmTests(unittest.TestCase):
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
