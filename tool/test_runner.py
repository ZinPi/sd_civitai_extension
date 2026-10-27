import re
import tempfile
import unittest
from pathlib import Path

from engine import parse_prompt_records, source_rows
from llm import Completion, LlmError
from runner import Job


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
        reference = (self.data / "TBN6A.txt").read_text(encoding="utf-8")
        self.assertEqual(reference, (self.data / "XX.TXT").read_text(encoding="utf-8"))
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

    def test_timeout_does_not_raise_a_generic_error(self):
        class Slow(Script):
            def complete(self, system, user, max_output_tokens):
                raise LlmError("Hết giờ chờ. Không tự gửi lại lượt này.", "timeout")

        job = Job(self.rules, self.data, client_factory=lambda _settings: Slow())
        job.begin(self.source, self.settings, "next")
        job._thread.join(10)
        self.assertIn("Không tự gửi lại", job.snapshot()["notice"]["text"])

    def test_remembered_place_qa_does_not_stop_the_next_turn(self):
        fail = (
            "001: RESULT: FAIL_H ISSUE_TYPE: WRONG_LOCATION; FUTURE_LEAK "
            "EVIDENCE: The source describes Hermes remembering that he will soon enter the academy "
            "while still in the mansion room. "
            "REQUIRED_FIX: Use the already-created BG_03 and keep Hermes in the mansion room "
            "without depicting the future academy approach.\n"
            "TOOL_QA: FAIL"
        )

        class MemoryQa(Script):
            def __init__(self):
                super().__init__()
                self.qa_count = 0

            def complete(self, system, user, max_output_tokens):
                step = "unknown"
                for line in system.splitlines():
                    if line.startswith("TOOL_STEP:"):
                        step = line.split(":", 1)[1].strip()
                self.calls.append((step, user))
                if step in {"extract", "merge"}:
                    return Completion("CHAR_01 Hermes\nBG_03 mansion\nBG_04 academy\n", "stop")
                if step == "char":
                    return Completion("CHAR_01 front, close, back.\n", "stop")
                if step == "bg":
                    return Completion("BG_03 mansion room.\nBG_04 academy.\n", "stop")
                if step == "qa":
                    self.qa_count += 1
                    if self.qa_count <= 2:
                        return Completion(fail, "stop")
                    return Completion("đối chiếu xong\nTOOL_QA: PASS", "stop")
                rows = source_rows(user) or [
                    (int(match.group(1)), match.group(2))
                    for match in re.finditer(r"(?m)^(\d+)\. (.+)$", user)
                ]
                if step == "repair":
                    text = "\n".join(
                        f"{number:03d} | CHAR_01.BG_03.BG_04 | IMAGE_PROMPT: "
                        "Hermes in the mansion, manga inset memory of the academy."
                        for number, _text in rows
                    )
                    return Completion(text, "stop")
                text = "\n".join(
                    f"{number:03d} | CHAR_01.BG_04 | IMAGE_PROMPT: Hermes standing on the academy approach."
                    for number, _text in rows
                )
                return Completion(text, "stop")

        script = MemoryQa()
        job = Job(self.rules, self.data, client_factory=lambda _settings: script)
        source = (
            "Hermes recuerda que pronto entrará a la academia.\n"
            "El nombre de la institución es inconfundible.\n"
        )
        job.begin(source, self.settings, "all")
        job._thread.join(10)
        snapshot = job.snapshot()
        self.assertEqual(snapshot["state"], "done", snapshot["notice"])
        prompts = (self.data / "PROMPT_THEO_DONG.txt").read_text(encoding="utf-8")
        self.assertIn("manga inset memory", prompts)
        repair_users = [user for step, user in script.calls if step == "repair"]
        self.assertEqual(len(repair_users), 1)
        self.assertIn("KHÓA SỬA MANGA", repair_users[0])

    def test_physical_future_staging_still_stops_the_turn(self):
        fail = (
            "001: RESULT: FAIL_H ISSUE_TYPE: WRONG_LOCATION; FUTURE_LEAK "
            "EVIDENCE: Hermes remembering the academy. "
            "REQUIRED_FIX: keep him in the present mansion room without depicting the academy.\n"
            "TOOL_QA: FAIL"
        )

        class StillThere(Script):
            def complete(self, system, user, max_output_tokens):
                step = "unknown"
                for line in system.splitlines():
                    if line.startswith("TOOL_STEP:"):
                        step = line.split(":", 1)[1].strip()
                self.calls.append((step, user))
                if step in {"extract", "merge"}:
                    return Completion("CHAR_01 Hermes\nBG_03 mansion\n", "stop")
                if step == "char":
                    return Completion("CHAR_01 front.\n", "stop")
                if step == "bg":
                    return Completion("BG_03 room.\n", "stop")
                if step == "qa":
                    return Completion(fail, "stop")
                rows = source_rows(user) or [
                    (int(match.group(1)), match.group(2))
                    for match in re.finditer(r"(?m)^(\d+)\. (.+)$", user)
                ]
                text = "\n".join(
                    f"{number:03d} | CHAR_01.BG_04 | IMAGE_PROMPT: Hermes standing on the academy approach."
                    for number, _text in rows
                )
                return Completion(text, "stop")

        job = Job(self.rules, self.data, client_factory=lambda _settings: StillThere())
        job.begin("Hermes recuerda la academia.\n", self.settings, "all")
        job._thread.join(10)
        snapshot = job.snapshot()
        self.assertIn("Không sang lượt sau", snapshot["notice"]["text"])
        self.assertIn("WRONG_LOCATION", snapshot["notice"]["text"])
        self.assertIn("without depicting", snapshot["notice"]["text"])
        journal = "\n".join(snapshot["log"])
        self.assertIn("BÁO CÁO QA", journal)
        self.assertIn("WRONG_LOCATION", journal)
        self.assertIn("PROMPT ĐANG BỊ CHẤM", journal)
        stored = (self.data / "NHAT_KY.txt").read_text(encoding="utf-8")
        self.assertIn("BÁO CÁO QA", stored)


if __name__ == "__main__":
    unittest.main()
