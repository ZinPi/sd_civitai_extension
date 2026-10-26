import unittest
from pathlib import Path

from engine import (
    build_call,
    classify_records,
    compile_reference,
    largest_prefix,
    matching_prefix,
    parse_prompt_records,
    qa_verdict,
    source_digest,
    split_source,
)


class EngineTests(unittest.TestCase):
    def test_split_source_drops_blank_lines(self):
        self.assertEqual(split_source("  một \n\n hai \r\n"), ["một", "hai"])

    def test_digest_ignores_blank_lines(self):
        self.assertEqual(source_digest(split_source("một\n\nhai")), source_digest(["một", "hai"]))

    def test_largest_prefix_shrinks_to_the_limit(self):
        self.assertEqual(largest_prefix([10, 10, 10, 10], 50, 20, 80, 100, 20), 3)
        self.assertEqual(largest_prefix([10, 10], 50, 20, 1000, 1000, 20), 2)
        self.assertEqual(largest_prefix([100], 50, 20, 80, 100, 20), 0)

    def test_rule_text_is_passed_verbatim(self):
        rule = Path(__file__).resolve().parent.parent / "quy-tac-tool" / "03_PROMPT_ANH_THEO_DONG.txt"
        text = rule.read_text(encoding="utf-8")
        _system, user = build_call("lines", [("QUY_TAC", text)], "dong 1")
        self.assertIn(text, user)
        self.assertLess(user.index(text), user.index("dong 1"))

    def test_parse_and_prefix(self):
        raw = "\n".join(
            [
                "ghi chú bỏ qua",
                "001 | CHAR_01.BG_03 | IMAGE_PROMPT: The girl opens the door.",
                "002 | bg_02 | IMAGE_PROMPT: Empty patio in the wind.",
                "004 | CHAR_01.BG_03 | IMAGE_PROMPT: skipped number",
            ]
        )
        records = parse_prompt_records(raw)
        self.assertEqual([record["n"] for record in records], [1, 2, 4])
        self.assertEqual(records[1]["ids"], "BG_02")
        kept = matching_prefix(records, [1, 2, 3])
        self.assertEqual([record["n"] for record in kept], [1, 2])

    def test_truncation_drops_the_last_record(self):
        records = parse_prompt_records(
            "001 | BG_01 | IMAGE_PROMPT: One.\n002 | BG_01 | IMAGE_PROMPT: Two.\n003 | BG_01 | IMAGE_PROMPT: Three"
        )
        kept, status = classify_records(records, [1, 2, 3], "length")
        self.assertEqual(status, "truncated")
        self.assertEqual([record["n"] for record in kept], [1, 2])

    def test_stop_requires_the_full_batch(self):
        records = parse_prompt_records("001 | CHAR_01 | IMAGE_PROMPT: Missing background.")
        kept, status = classify_records(records, [1], "stop")
        self.assertEqual(status, "invalid")
        self.assertEqual(kept, [])

    def test_qa_verdict_reads_the_last_line(self):
        self.assertEqual(qa_verdict("TOOL_QA: FAIL\nđã sửa\nTOOL_QA: PASS"), "pass")
        self.assertEqual(qa_verdict("nhắc tới PASS nhưng không kết luận"), "fail")

    def test_compile_keeps_the_source_text(self):
        compiled = compile_reference("danh sách CHAR_01", "prompt char", "prompt bg")
        self.assertIn("danh sách CHAR_01", compiled)
        self.assertIn("prompt char", compiled)
        self.assertIn("prompt bg", compiled)


if __name__ == "__main__":
    unittest.main()
