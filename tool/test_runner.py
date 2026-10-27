import re
import tempfile
import unittest
from pathlib import Path

from engine import parse_prompt_records, source_rows
from llm import Completion, LlmError
from runner import Job, failed_line_numbers, lines_needing_new_bg, valid_repair_map


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

    def test_failed_line_numbers_keep_only_cited_rows(self):
        report = (
            "001 | FAIL_H  \n"
            "ISSUE_TYPE: MISSING_REQUIRED_REFERENCE\n"
            "008 | FAIL_H  \n"
            "ISSUE_TYPE: WRONG_LOCATION\n"
            "RECHECK_SCOPE: 008\n"
            "TOOL_QA: FAIL\n"
        )
        self.assertEqual(failed_line_numbers(report, set(range(1, 17))), [1, 8])
        colon = (
            "001: RESULT: FAIL_H ISSUE_TYPE: WRONG_LOCATION\n"
            "RECHECK_SCOPE: 002\n"
            "TOOL_QA: FAIL\n"
        )
        self.assertEqual(failed_line_numbers(colon, {1, 2}), [1, 2])
        self.assertEqual(failed_line_numbers("đối chiếu xong\nTOOL_QA: FAIL\n", {1, 2}), [])

    def test_length_cut_drops_the_last_repaired_line(self):
        text = (
            "001 | CHAR_01.BG_01 | IMAGE_PROMPT: CHAR_01 stands in the street, 174 cm.\n"
            "002 | CHAR_01.BG_03 | IMAGE_PROMPT: CHAR_01 wakes in the room, 168 cm.\n"
        )
        cut = valid_repair_map(text, [1, 2], "length")
        self.assertEqual(list(cut), [1])
        whole = valid_repair_map(text, [1, 2], "stop")
        self.assertEqual(list(whole), [1, 2])

    def test_qa_repair_rewrites_only_the_failed_line(self):
        fail = (
            "001 | FAIL_H\n"
            "ISSUE_TYPE: MISSING_REQUIRED_REFERENCE\n"
            "REQUIRED_FIX: Add CHAR_01 and the locked size.\n"
            "TOOL_QA: FAIL\n"
        )
        kept = "KEEP-LINE-TWO the patio curtain stays untouched."

        class OneFail(Script):
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
                    return Completion("CHAR_01 người trẻ\nBG_01 phố\nBG_03 phòng\n", "stop")
                if step == "char":
                    return Completion("CHAR_01 front, close, back.\n", "stop")
                if step == "bg":
                    return Completion("BG_01 street.\nBG_03 room.\n", "stop")
                if step == "qa":
                    self.qa_count += 1
                    if self.qa_count == 1:
                        return Completion(fail, "stop")
                    return Completion("đối chiếu xong\nTOOL_QA: PASS", "stop")
                if step == "repair":
                    return Completion(
                        "001 | CHAR_01.BG_01 | IMAGE_PROMPT: "
                        "CHAR_01 the young man, 174 cm, watches the street.\n",
                        "stop",
                    )
                return Completion(
                    "001 | BG_01 | IMAGE_PROMPT: A young man watches the street.\n"
                    f"002 | CHAR_01.BG_01 | IMAGE_PROMPT: {kept}\n",
                    "stop",
                )

        script = OneFail()
        job = Job(self.rules, self.data, client_factory=lambda _settings: script)
        source = "Người trẻ đứng nhìn phố.\nCô bé nhìn cánh cửa sân.\n"
        job.begin(source, self.settings, "all")
        job._thread.join(10)
        snapshot = job.snapshot()
        self.assertEqual(snapshot["state"], "done", snapshot["notice"])
        prompts = (self.data / "PROMPT_THEO_DONG.txt").read_text(encoding="utf-8")
        self.assertIn("174 cm", prompts)
        self.assertIn(kept, prompts)
        repair_users = [user for step, user in script.calls if step == "repair"]
        self.assertEqual(len(repair_users), 1)
        self.assertIn("DONG_CAN_SUA", repair_users[0])
        self.assertIn("001. Người trẻ đứng nhìn phố.", repair_users[0])
        self.assertNotIn("002. Cô bé nhìn cánh cửa sân.", repair_users[0])
        self.assertIn("CHỈ TRẢ ĐÚNG CÁC DÒNG: 001", repair_users[0])
        journal = "\n".join(snapshot["log"])
        self.assertIn("Chỉ sửa dòng 001", journal)
        self.assertIn("Giữ các dòng QA không nêu lỗi", journal)

    def test_short_repair_retries_only_the_missing_line(self):
        fail = (
            "001 | FAIL_H\nISSUE_TYPE: MISSING_REQUIRED_REFERENCE\nTOOL_QA: FAIL\n"
            "002 | FAIL_H\nISSUE_TYPE: WRONG_LOCATION\nTOOL_QA: FAIL\n"
        )

        class ShortThenRest(Script):
            def __init__(self):
                super().__init__()
                self.qa_count = 0
                self.repairs = 0

            def complete(self, system, user, max_output_tokens):
                step = "unknown"
                for line in system.splitlines():
                    if line.startswith("TOOL_STEP:"):
                        step = line.split(":", 1)[1].strip()
                self.calls.append((step, user))
                if step in {"extract", "merge"}:
                    return Completion("CHAR_01 người trẻ\nBG_01 phố\nBG_03 phòng\n", "stop")
                if step == "char":
                    return Completion("CHAR_01 front.\n", "stop")
                if step == "bg":
                    return Completion("BG_01 street.\nBG_03 room.\n", "stop")
                if step == "qa":
                    self.qa_count += 1
                    if self.qa_count == 1:
                        return Completion(fail, "stop")
                    return Completion("đối chiếu xong\nTOOL_QA: PASS", "stop")
                if step == "lines":
                    return Completion(
                        "001 | BG_01 | IMAGE_PROMPT: A young man watches the street.\n"
                        "002 | BG_06 | IMAGE_PROMPT: An abstract awakening transition.\n",
                        "stop",
                    )
                self.repairs += 1
                if self.repairs == 1:
                    return Completion(
                        "001 | CHAR_01.BG_01 | IMAGE_PROMPT: CHAR_01, 174 cm, watches the street.\n"
                        "không đủ dòng còn lại",
                        "stop",
                    )
                return Completion(
                    "002 | CHAR_01.BG_03 | IMAGE_PROMPT: CHAR_01, 168 cm, wakes in the physical room.\n",
                    "stop",
                )

        script = ShortThenRest()
        job = Job(self.rules, self.data, client_factory=lambda _settings: script)
        job.begin("Người trẻ đứng nhìn phố.\nAnh tỉnh dậy trong phòng.\n", self.settings, "all")
        job._thread.join(10)
        snapshot = job.snapshot()
        self.assertEqual(snapshot["state"], "done", snapshot["notice"])
        prompts = (self.data / "PROMPT_THEO_DONG.txt").read_text(encoding="utf-8")
        self.assertIn("174 cm", prompts)
        self.assertIn("168 cm", prompts)
        self.assertNotIn("abstract awakening", prompts)
        repair_users = [user for step, user in script.calls if step == "repair"]
        self.assertEqual(len(repair_users), 2)
        self.assertIn("001. Người trẻ đứng nhìn phố.", repair_users[0])
        self.assertIn("002. Anh tỉnh dậy trong phòng.", repair_users[0])
        self.assertIn("002. Anh tỉnh dậy trong phòng.", repair_users[1])
        self.assertNotIn("001. Người trẻ đứng nhìn phố.", repair_users[1])
        self.assertIn("CHỈ TRẢ ĐÚNG CÁC DÒNG: 002", repair_users[1])
        journal = "\n".join(snapshot["log"])
        self.assertIn("Bản sửa thiếu dòng 002", journal)
        self.assertIn("Chỉ gửi lại các dòng này", journal)

    def test_second_short_repair_names_the_missing_line_and_stops(self):
        fail = "001 | FAIL_H\nISSUE_TYPE: MISSING_REQUIRED_REFERENCE\nTOOL_QA: FAIL\n"

        class AlwaysShort(Script):
            def complete(self, system, user, max_output_tokens):
                step = "unknown"
                for line in system.splitlines():
                    if line.startswith("TOOL_STEP:"):
                        step = line.split(":", 1)[1].strip()
                self.calls.append((step, user))
                if step in {"extract", "merge"}:
                    return Completion("CHAR_01 người trẻ\nBG_01 phố\n", "stop")
                if step == "char":
                    return Completion("CHAR_01 front.\n", "stop")
                if step == "bg":
                    return Completion("BG_01 street.\n", "stop")
                if step == "qa":
                    return Completion(fail, "stop")
                if step == "lines":
                    return Completion(
                        "001 | BG_01 | IMAGE_PROMPT: A young man watches the street.\n"
                        "002 | CHAR_01.BG_01 | IMAGE_PROMPT: KEEP-LINE-TWO stays put.\n",
                        "stop",
                    )
                return Completion("không có prompt", "stop")

        job = Job(self.rules, self.data, client_factory=lambda _settings: AlwaysShort())
        job.begin("Người trẻ đứng nhìn phố.\nCô bé nhìn cửa.\n", self.settings, "all")
        job._thread.join(10)
        snapshot = job.snapshot()
        self.assertEqual(snapshot["state"], "error")
        self.assertIn("Bản sửa thiếu dòng 001", snapshot["notice"]["text"])
        self.assertIn("Không khóa lượt này", snapshot["notice"]["text"])
        journal = "\n".join(snapshot["log"])
        self.assertIn("Bản sửa thiếu dòng 001", journal)
        self.assertIn("không có prompt", journal)


class MissingBackgroundTests(unittest.TestCase):
    def setUp(self):
        RunnerTests.setUp(self)

    def tearDown(self):
        RunnerTests.tearDown(self)

    def test_missing_place_lines_ignore_a_named_existing_bg(self):
        report = (
            "033 | FAIL_H\n"
            "ISSUE_TYPE: WRONG_TIMING_STATE\n"
            "REQUIRED_FIX: Xóa trạng thái visibly recovered.\n"
            "036 | FAIL_H\n"
            "ISSUE_TYPE: WRONG_LOCATION\n"
            "EVIDENCE: chưa có BG đã tạo nào khác.\n"
            "REQUIRED_FIX: Cần resolve BG đúng nơi upstream; không dùng BG_02.\n"
            "037 | FAIL_H\n"
            "ISSUE_TYPE: WRONG_LOCATION\n"
            "REQUIRED_FIX: Resolver y crear upstream los BG físicos. No sustituirlos por BG_01 o BG_02.\n"
            "TOOL_QA: FAIL\n"
        )
        self.assertEqual(lines_needing_new_bg(report, set(range(33, 38))), [36, 37])
        named = (
            "001: RESULT: FAIL_H ISSUE_TYPE: WRONG_LOCATION "
            "REQUIRED_FIX: Use the already-created BG_03 and keep him in the room.\n"
            "TOOL_QA: FAIL\n"
        )
        self.assertEqual(lines_needing_new_bg(named, {1}), [])

    def test_missing_place_creates_a_bg_before_the_line_repair(self):
        fail = (
            "001 | FAIL_H\n"
            "ISSUE_TYPE: WRONG_LOCATION\n"
            "EVIDENCE: chưa có BG đã tạo nào khác cho buổi tập.\n"
            "REQUIRED_FIX: Cần resolve BG đúng nơi upstream; không dùng BG_01.\n"
            "TOOL_QA: FAIL\n"
        )

        class AddPlace(Script):
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
                    return Completion("CHAR_01 Hermes\nBG_01 phòng ngủ\n", "stop")
                if step == "char":
                    return Completion("CHAR_01 front.\n", "stop")
                if step == "bg":
                    return Completion("BG_01 aristocratic bedroom.\n", "stop")
                if step == "qa":
                    self.qa_count += 1
                    if self.qa_count == 1:
                        return Completion(fail, "stop")
                    return Completion("đối chiếu xong\nTOOL_QA: PASS", "stop")
                if step == "add-bg":
                    return Completion(
                        "DONG: 001\nPROMPT: A quiet training yard beside the house.\n",
                        "stop",
                    )
                if step == "lines":
                    return Completion(
                        "001 | CHAR_01.BG_01 | IMAGE_PROMPT: Hermes trains in the bedroom, 170 cm.\n",
                        "stop",
                    )
                return Completion(
                    "001 | CHAR_01.BG_02 | IMAGE_PROMPT: Hermes trains in the yard, 170 cm.\n",
                    "stop",
                )

        script = AddPlace()
        job = Job(self.rules, self.data, client_factory=lambda _settings: script)
        job.begin("Hermes tập luyện suốt hai tuần.\n", self.settings, "all")
        job._thread.join(10)
        snapshot = job.snapshot()
        self.assertEqual(snapshot["state"], "done", snapshot["notice"])
        reference = (self.data / "TBN6A.txt").read_text(encoding="utf-8")
        self.assertIn("BG_02", reference)
        self.assertIn("training yard", reference)
        prompts = (self.data / "PROMPT_THEO_DONG.txt").read_text(encoding="utf-8")
        self.assertIn("CHAR_01.BG_02", prompts)
        self.assertNotIn("trains in the bedroom", prompts)
        repair_users = [user for step, user in script.calls if step == "repair"]
        self.assertEqual(len(repair_users), 1)
        self.assertIn("BG_VUA_TAO", repair_users[0])
        self.assertIn("BG_02", repair_users[0])
        self.assertIn("Không giấu địa danh", repair_users[0])
        journal = "\n".join(snapshot["log"])
        self.assertIn("chưa có BG đúng nơi", journal)
        self.assertIn("Đã thêm BG_02", journal)

    def test_recheck_repairs_only_the_newly_failed_line(self):
        first = (
            "001 | FAIL_H\nISSUE_TYPE: WRONG_TIMING_STATE\n"
            "REQUIRED_FIX: Xóa trạng thái recovered.\nTOOL_QA: FAIL\n"
        )
        second = (
            "002 | FAIL_H\nISSUE_TYPE: WRONG_CURRENT_MOMENT\n"
            "REQUIRED_FIX: Vẽ lúc bắt đầu muốn ôm, chưa ôm xong.\nTOOL_QA: FAIL\n"
        )

        class Recheck(Script):
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
                    return Completion("CHAR_01 Hermes\nBG_02 phòng\n", "stop")
                if step == "char":
                    return Completion("CHAR_01 front.\n", "stop")
                if step == "bg":
                    return Completion("BG_02 bedroom.\n", "stop")
                if step == "qa":
                    self.qa_count += 1
                    if self.qa_count == 1:
                        return Completion(first, "stop")
                    if self.qa_count == 2:
                        return Completion(second, "stop")
                    return Completion("đối chiếu xong\nTOOL_QA: PASS", "stop")
                if step == "lines":
                    return Completion(
                        "001 | CHAR_01.BG_02 | IMAGE_PROMPT: Hermes visibly recovered, 170 cm.\n"
                        "002 | CHAR_01.BG_02 | IMAGE_PROMPT: The embrace is already complete.\n",
                        "stop",
                    )
                rows = [
                    (int(match.group(1)), match.group(2))
                    for match in re.finditer(r"(?m)^(\d+)\. (.+)$", user)
                ]
                bodies = {
                    1: "Hermes is not yet recovered, 170 cm.",
                    2: "His mother is only beginning to reach for him.",
                }
                text = "\n".join(
                    f"{number:03d} | CHAR_01.BG_02 | IMAGE_PROMPT: {bodies[number]}"
                    for number, _text in rows
                )
                return Completion(text, "stop")

        script = Recheck()
        job = Job(self.rules, self.data, client_factory=lambda _settings: script)
        job.begin("Hermes chưa hồi phục.\nMẹ muốn ôm Hermes.\n", self.settings, "all")
        job._thread.join(10)
        snapshot = job.snapshot()
        self.assertEqual(snapshot["state"], "done", snapshot["notice"])
        prompts = (self.data / "PROMPT_THEO_DONG.txt").read_text(encoding="utf-8")
        self.assertIn("not yet recovered", prompts)
        self.assertIn("beginning to reach", prompts)
        repair_users = [user for step, user in script.calls if step == "repair"]
        self.assertEqual(len(repair_users), 2)
        self.assertIn("001. Hermes chưa hồi phục.", repair_users[0])
        self.assertNotIn("002. Mẹ muốn ôm Hermes.", repair_users[0])
        self.assertIn("002. Mẹ muốn ôm Hermes.", repair_users[1])
        self.assertNotIn("001. Hermes chưa hồi phục.", repair_users[1])
        self.assertNotIn("add-bg", [step for step, _user in script.calls])
        journal = "\n".join(snapshot["log"])
        self.assertIn("Chỉ sửa các dòng còn lỗi: 002", journal)


class RuleLockTests(unittest.TestCase):
    def test_group_creature_and_machine_locks_are_in_the_tool_rules(self):
        root = Path(__file__).resolve().parents[1] / "quy-tac-tool"
        joined = "\n".join(
            (root / name).read_text(encoding="utf-8")
            for name in (
                "00_QUY_TRINH_HUONG_DAN.txt",
                "01_TRICH_NHAN_VAT_VA_BOI_CANH.txt",
                "02_PROMPT_THAM_CHIEU_CHAR_BG.txt",
                "03_PROMPT_ANH_THEO_DONG.txt",
                "04_QA_PROMPT_THEO_DONG.txt",
            )
        )
        self.assertIn("CHAR nhóm", joined)
        self.assertIn("không gửi thêm char riêng", joined.lower())
        self.assertIn("đúng số con", joined)
        self.assertIn("bộ máy đã lắp", joined)
        self.assertIn("không viết trên 10", joined)
        self.assertIn("CHAR_297 (Helga and Lucian, two people)", joined)
        self.assertIn("exactly three living mice", joined)


if __name__ == "__main__":
    unittest.main()
