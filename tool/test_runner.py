import tempfile
import unittest
from pathlib import Path

from engine import estimate_tokens, format_records, parse_prompt_records, source_rows
from llm import Completion, LlmError
from runner import LINE_BATCH, OUTPUT_PER_LINE, PROMPT_CHARS, Job


def write_rules(directory: Path, body: str = "QUY-TAC-KHONG-DUOC-CAT") -> None:
    for name in (
        "00_QUY_TRINH_HUONG_DAN.txt",
        "01_TRICH_NHAN_VAT_VA_BOI_CANH.txt",
        "02_PROMPT_THAM_CHIEU_CHAR_BG.txt",
        "03_PROMPT_ANH_THEO_DONG.txt",
        "04_QA_PROMPT_THEO_DONG.txt",
    ):
        (directory / name).write_text(body + "\n" + name + "\n", encoding="utf-8")


class Script:
    def __init__(self):
        self.calls = []

    def complete(self, system, user, max_output_tokens):
        step = "unknown"
        for line in system.splitlines():
            if line.startswith("TOOL_STEP:"):
                step = line.split(":", 1)[1].strip()
        self.calls.append((step, user))
        if step in {"extract", "merge"}:
            return Completion("CHAR_01 cô bé\nBG_01 patio\n", "stop")
        if step == "char":
            return Completion("CHAR_01 front, close, back.\n", "stop")
        if step == "bg":
            return Completion("BG_01 wooden door.\n", "stop")
        if step == "qa":
            return Completion("đối chiếu xong\nTOOL_QA: PASS", "stop")
        rows = source_rows(user)
        if step == "lines" and len(rows) > 2 and not any(item[0] == "lines" and "001." in item[1] and "003." not in item[1] for item in self.calls[:-1]):
            text = "\n".join(self._prompt(number) for number, _text in rows[:3])
            return Completion(text, "length")
        if step == "repair":
            rows = source_rows(user) or self._numbers_in(user)
        return Completion("\n".join(self._prompt(number) for number, _text in rows), "stop")

    def _numbers_in(self, user):
        return source_rows("CAC_DONG\n" + user)

    def _prompt(self, number):
        return (
            f"{number:03d} | CHAR_01.BG_01 | IMAGE_PROMPT: "
            "The girl stands at the wooden patio door while the wind moves the curtain."
        )


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.rules = root / "rules"
        self.data = root / "data"
        self.rules.mkdir()
        write_rules(self.rules)
        self.script = Script()
        self.job = Job(self.rules, self.data, client_factory=lambda _settings: self.script)
        self.settings = {
            "base_url": "http://127.0.0.1:9/v1",
            "api_key": "test-key",
            "model": "mock",
            "api_style": "chat",
            "max_input_tokens": 10000,
            "max_output_tokens": 4000,
            "request_timeout_seconds": 30,
        }
        self.source = "\n".join(
            [
                "El viento abrió la puerta del patio.",
                "La niña miró la puerta.",
                "El viento movió la cortina.",
                "La niña cerró la puerta.",
            ]
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_full_run_keeps_rules_and_line_count(self):
        self.job.begin(self.source, self.settings, "all")
        self.job._thread.join(10)
        snapshot = self.job.snapshot()
        self.assertEqual(snapshot["state"], "done", snapshot["notice"])
        prompts = (self.data / "PROMPT_THEO_DONG.txt").read_text(encoding="utf-8")
        records = parse_prompt_records(prompts)
        self.assertEqual([record["n"] for record in records], [1, 2, 3, 4])
        self.assertTrue(all("BG_" in record["ids"] for record in records))
        reference = (self.data / "FILE_TONG_HOP.txt").read_text(encoding="utf-8")
        self.assertFalse((self.data / "TBN6A.txt").exists())
        self.assertFalse((self.data / "XX.TXT").exists())
        self.assertIn("CHAR_01 cô bé", reference)
        self.assertIn("CHAR_01 front, close, back.", reference)
        joined = "\n".join(user for _step, user in self.script.calls)
        self.assertIn("QUY-TAC-KHONG-DUOC-CAT", joined)
        line_calls = [user for step, user in self.script.calls if step == "lines"]
        self.assertGreaterEqual(len(line_calls), 2)
        self.assertIn("004.", line_calls[0])
        self.assertNotIn("001.", line_calls[1])

    def test_missing_ids_do_not_continue(self):
        class Empty(Script):
            def complete(self, system, user, max_output_tokens):
                self.calls.append(("extract", user))
                return Completion("không có mã", "stop")

        script = Empty()
        job = Job(self.rules, self.data, client_factory=lambda _settings: script)
        job.begin(self.source, self.settings, "all")
        job._thread.join(10)
        snapshot = job.snapshot()
        self.assertEqual(snapshot["state"], "error")
        self.assertIn("CHAR_", snapshot["notice"]["text"])
        self.assertEqual(snapshot["steps"][1]["status"], "pending")
        self.assertIn("không có mã", (self.data / "DANH_SACH_CHAR_BG.txt").read_text(encoding="utf-8"))

    def test_one_line_overflow_does_not_call_the_model(self):
        self.job.begin("Một câu duy nhất.", {**self.settings, "max_input_tokens": 80}, "all")
        self.job._thread.join(10)
        snapshot = self.job.snapshot()
        self.assertEqual(snapshot["state"], "error")
        self.assertIn("không cắt quy tắc", snapshot["notice"]["text"])
        self.assertEqual(self.script.calls, [])

    def test_step4_reserves_4000_characters_per_prompt(self):
        self.assertEqual(PROMPT_CHARS, 4000)
        self.assertEqual(OUTPUT_PER_LINE, estimate_tokens("x" * PROMPT_CHARS))
        self.assertEqual(LINE_BATCH, 10)
        self.job._settings = {**self.settings, "max_input_tokens": 200_000, "max_output_tokens": 8192}
        rows = [(number, f"Câu {number}.") for number in range(1, 17)]
        count, wanted = self.job._fit_line_batch([("QUY_TAC", "ngan")], "BG_01", rows, 3)
        self.assertEqual(wanted, 10)
        self.assertEqual(count, 10)

    def test_prompt_file_over_three_million_characters_is_kept_whole(self):
        records = [{"n": number, "ids": "BG_01", "body": "z" * PROMPT_CHARS} for number in range(1, 801)]
        text = format_records(records, 3)
        self.assertGreater(len(text), 3_000_000)
        self.job._write("PROMPT_THEO_DONG.txt", text)
        saved = (self.data / "PROMPT_THEO_DONG.txt").read_text(encoding="utf-8")
        self.assertEqual(saved, text)
        self.assertEqual(len(parse_prompt_records(saved)), 800)

    def test_timeout_does_not_raise_a_generic_error(self):
        class Slow(Script):
            def complete(self, system, user, max_output_tokens):
                raise LlmError("Hết giờ chờ. Không tự gửi lại lượt này.", "timeout")

        job = Job(self.rules, self.data, client_factory=lambda _settings: Slow())
        job.begin(self.source, self.settings, "next")
        job._thread.join(10)
        self.assertIn("Không tự gửi lại", job.snapshot()["notice"]["text"])


if __name__ == "__main__":
    unittest.main()
