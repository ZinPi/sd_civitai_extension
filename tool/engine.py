"""Đếm dòng, nhét lượt cho vừa giới hạn, và đọc prompt đúng định dạng quy tắc."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

RULE_FILES = (
    "00_QUY_TRINH_HUONG_DAN.txt",
    "01_TRICH_NHAN_VAT_VA_BOI_CANH.txt",
    "02_PROMPT_THAM_CHIEU_CHAR_BG.txt",
    "03_PROMPT_ANH_THEO_DONG.txt",
    "04_QA_PROMPT_THEO_DONG.txt",
)

RULE_LABELS = {
    "00_QUY_TRINH_HUONG_DAN.txt": "Thứ tự bốn bước",
    "01_TRICH_NHAN_VAT_VA_BOI_CANH.txt": "Trích nhân vật và bối cảnh",
    "02_PROMPT_THAM_CHIEU_CHAR_BG.txt": "Prompt tham chiếu CHAR và BG",
    "03_PROMPT_ANH_THEO_DONG.txt": "Prompt ảnh theo dòng",
    "04_QA_PROMPT_THEO_DONG.txt": "QA prompt theo dòng",
}

OUTPUT_FILES = {
    "danh-sach": "DANH_SACH_CHAR_BG.txt",
    "char": "PROMPT_CHAR.txt",
    "bg": "PROMPT_BG.txt",
    "dong": "PROMPT_THEO_DONG.txt",
    "tham-chieu": "TBN6A.txt",
}

MSG_RULES_ONLY = (
    "Chỉ file quy tắc đã vượt giới hạn token đầu vào. "
    "Đã dừng, không cắt quy tắc."
)
MSG_RULES_AND_REFERENCE = (
    "Quy tắc và file tham chiếu đã vượt giới hạn token đầu vào. "
    "Đã dừng, không cắt quy tắc và không cắt file tham chiếu."
)
MSG_ONE_LINE = (
    "Chỉ một dòng cùng quy tắc và file tham chiếu đã vượt giới hạn token. "
    "Đã dừng, không cắt quy tắc và không cắt file tham chiếu."
)
MSG_OUTPUT_TOO_SMALL = (
    "Giới hạn token đầu ra không đủ cho một prompt. "
    "Tăng token đầu ra. Không cắt quy tắc và không nhận prompt cụt."
)

RECORD_START = re.compile(r"^(\d+)\s*\|\s*([^|]+?)\s*\|\s*IMAGE_PROMPT:\s*(.*)$")
IDS_RE = re.compile(r"^(?:CHAR_\d+\.)*BG_\d+(?:\.BG_\d+)*$")
SOURCE_ROW = re.compile(r"^(\d+)\.\s+(.*)$")


class JobError(Exception):
    pass


def estimate_tokens(text: str) -> int:
    return max(1, (len(text) + 3) // 4)


def split_source(text: str) -> list[str]:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    return [line.strip() for line in normalized.split("\n") if line.strip()]


def source_digest(lines: list[str]) -> str:
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()


def numbered_width(total: int) -> int:
    return max(3, len(str(total)))


def format_source_rows(rows: list[tuple[int, str]], width: int) -> str:
    return "".join(f"{number:0{width}d}. {text}\n" for number, text in rows)


def build_call(step: str, documents: list[tuple[str, str]], material: str) -> tuple[str, str]:
    system = (
        "Bạn xử lý văn bản theo file quy tắc được gắn nguyên văn.\n"
        "File quy tắc là chuẩn. Không rút gọn, không viết lại quy tắc, không bỏ mục.\n"
        "Không tạo ảnh, video hay âm thanh.\n"
        "Chỉ xuất thành phẩm của bước này.\n"
        f"TOOL_STEP: {step}\n"
    )
    parts = [f"===== {label} =====\n{text}" for label, text in documents]
    parts.append(f"===== DU_LIEU =====\n{material}")
    return system, "\n\n".join(parts)


def message_tokens(step: str, documents: list[tuple[str, str]], material: str) -> int:
    system, user = build_call(step, documents, material)
    return estimate_tokens(system) + estimate_tokens(user) + 200


def largest_prefix(
    line_costs: list[int],
    fixed_tokens: int,
    output_per_line: int,
    max_input: int,
    max_output: int,
    ceiling: int,
) -> int:
    count = min(ceiling, len(line_costs))
    while count > 0:
        incoming = fixed_tokens + sum(line_costs[:count])
        outgoing = output_per_line * count
        if incoming <= max_input and outgoing <= max_output:
            return count
        count -= 1
    return 0


def source_rows(material: str) -> list[tuple[int, str]]:
    marker = "CAC_DONG\n"
    index = material.rfind(marker)
    if index < 0:
        return []
    rows: list[tuple[int, str]] = []
    for line in material[index + len(marker) :].splitlines():
        if line.startswith("====="):
            break
        match = SOURCE_ROW.match(line)
        if match:
            rows.append((int(match.group(1)), match.group(2)))
    return rows


def normalize_ids(raw: str) -> str:
    return re.sub(r"\s+", "", raw).upper()


def parse_prompt_records(text: str) -> list[dict]:
    records: list[dict] = []
    current: dict | None = None
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        match = RECORD_START.match(line.strip())
        if match:
            if current is not None:
                records.append(current)
            current = {
                "n": int(match.group(1)),
                "ids": normalize_ids(match.group(2)),
                "body": match.group(3).strip(),
            }
            continue
        if current is not None and line.strip():
            current["body"] = (current["body"] + " " + line.strip()).strip()
    if current is not None:
        records.append(current)
    return records


def record_ok(record: dict) -> bool:
    return bool(IDS_RE.fullmatch(record["ids"]) and record["body"].strip())


def matching_prefix(records: list[dict], expected: list[int]) -> list[dict]:
    kept: list[dict] = []
    for record, number in zip(records, expected):
        if record["n"] != number or not record_ok(record):
            break
        kept.append(record)
    return kept


def classify_records(records: list[dict], expected: list[int], finish: str) -> tuple[list[dict], str]:
    prefix = matching_prefix(records, expected)
    if finish == "length":
        if prefix:
            prefix = prefix[:-1]
        return prefix, "truncated"
    if len(prefix) == len(expected) and len(records) == len(expected):
        return prefix, "ok"
    return prefix, "invalid"


def format_record(record: dict, width: int) -> str:
    body = " ".join(record["body"].split())
    return f"{record['n']:0{width}d} | {record['ids']} | IMAGE_PROMPT: {body}"


def format_records(records: list[dict], width: int) -> str:
    if not records:
        return ""
    return "\n".join(format_record(record, width) for record in records) + "\n"


def qa_verdict(text: str) -> str:
    lines = [line.strip().rstrip(".") for line in text.splitlines() if line.strip()]
    for line in reversed(lines[-6:]):
        if line == "TOOL_QA: PASS":
            return "pass"
        if line == "TOOL_QA: FAIL":
            return "fail"
    return "fail"


def compile_reference(list_text: str, char_text: str, bg_text: str) -> str:
    return (
        "DANH_SACH_CHAR_BG\n"
        f"{list_text.strip()}\n\n"
        "PROMPT_CHAR\n"
        f"{char_text.strip()}\n\n"
        "PROMPT_BG\n"
        f"{bg_text.strip()}\n"
    )


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)
