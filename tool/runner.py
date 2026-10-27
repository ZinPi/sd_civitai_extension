"""Chạy bốn bước theo thứ tự. Mỗi lượt API đọc lại file quy tắc trên đĩa."""

from __future__ import annotations

import json
import re
import threading
from pathlib import Path

from engine import (
    MSG_ONE_LINE,
    MSG_OUTPUT_TOO_SMALL,
    MSG_RULES_AND_REFERENCE,
    MSG_RULES_ONLY,
    OUTPUT_FILES,
    RULE_FILES,
    JobError,
    atomic_write,
    build_call,
    classify_records,
    compile_reference,
    estimate_tokens,
    format_records,
    format_source_rows,
    largest_prefix,
    matching_prefix,
    message_tokens,
    numbered_width,
    parse_prompt_records,
    qa_verdict,
    record_ok,
    read_text,
    source_digest,
    split_source,
)
from llm import HttpLlm, LlmError

OUTPUT_PER_LINE = 500
CEILING = 20

EXTRACT_TASK = """CHỈ LÀM BƯỚC 1.
Nguồn trong CAC_DONG là bản đã chia dòng, mỗi dòng một câu, số thứ tự giữ nguyên.
Làm đủ các lần của bước trích trong quy tắc và xuất danh sách CHAR, BG.
Nhân vật, sinh vật, công cụ và vũ khí cần tham chiếu phải có số đo. Nguồn không có số thì phân tích tác phẩm và đối tượng, rồi sáng tạo kích thước hợp lý.
Đọc tác phẩm và tạo BG cho nơi cần vẽ. Cùng một nơi khi đổi buổi, mưa hoặc trạng thái môi trường khác rõ thì chia thành nhiều trạng thái BG.
Tập nhân vật đã có CHAR riêng và thường có mặt cùng nhau thì khóa thêm một CHAR nhóm cho đúng tập đó. Giữ CHAR riêng của từng người.
Cùng một ngoại hình sinh vật lặp nhiều con thì một CHAR, ghi đúng số con. Bộ máy đã lắp đặt riêng là một CHAR cho cả bộ. Công cụ hoặc vũ khí cầm trên tay ghi cùng người cầm.
"""

MERGE_TASK = """CHỈ GỘP BƯỚC 1.
Các phần trích bên dưới là của cùng một tác phẩm.
Đếm số câu khác nhau trên toàn bộ các phần, rồi xuất một danh sách CHAR và BG duy nhất theo quy tắc.
Giữ CHAR nhóm, CHAR sinh vật dùng cho nhiều con, và CHAR của bộ máy đã lắp. Không gộp các thành viên thành một người. Không tách một bộ máy thành nhiều CHAR.
"""

CHAR_TASK = """CHỈ LÀM BƯỚC 2.
Danh sách đã khóa nằm trong DU_LIEU.
Viết prompt tham chiếu cho mọi CHAR trong danh sách.
Không viết prompt BG ở bước này.
Ghi đúng số đo đã khóa. Số đo sáng tạo hợp lý đã khóa là hợp lệ, không được bỏ.
CHAR nhóm vẽ mỗi thành viên một lần, vẫn là từng người, đúng số đo của người đó.
CHAR sinh vật ghi loài và số đo. CHAR của bộ máy ghi cả bộ đã nối và các số đo của bộ.
"""

BG_TASK = """CHỈ LÀM BƯỚC 3.
Danh sách đã khóa nằm trong DU_LIEU.
Viết prompt tham chiếu cho mọi BG trong danh sách.
Không viết lại prompt CHAR ở bước này.
Tham khảo tác phẩm rồi viết BG. Không bỏ BG đã có trong danh sách.
"""

LINE_TASK = """CHỈ LÀM BƯỚC 4 cho đúng các dòng trong CAC_DONG.
Mỗi dòng nguồn một prompt. Giữ đúng số thứ tự.
Dùng file tham chiếu đã khóa. Không làm lại danh sách CHAR/BG.
Không giải thích ngoài các dòng prompt.
Mỗi prompt phải có ít nhất một BG đã tạo, đúng trạng thái của dòng. Một prompt được có nhiều BG. Không tự đặt mã BG mới.
Nhân vật đã khóa mà có mặt trong hình thì header có CHAR riêng của người đó, hoặc CHAR nhóm đã khóa mà người đó là thành viên. Không gửi cả hai. Phần chữ ghi đúng số đo đã khóa của từng người.
Một CHAR sinh vật đã khóa được dùng cho đúng số con trong dòng. Mỗi con là một cơ thể riêng, cùng số đo, khác vị trí. Không cấp mã mới cho từng con.
Bộ máy đã lắp là một CHAR của cả bộ. Không ghi bộ đó vào người đang xem. Công cụ hoặc vũ khí cầm trên tay ghi cùng CHAR người cầm.
Nơi vật lý trong dòng nguồn dùng BG vật lý đã tạo cho nơi đó. BG chuyển cảnh trừu tượng chỉ dùng khi dòng không diễn ra trong một nơi vật lý.
Nhân vật đang nhớ, nghĩ hoặc nhận ra một nơi khác: dùng BG của nơi đó, hoặc ghép với BG nơi đang đứng theo hiệu ứng manga.
Chưa có BG đúng nơi thì không lấy BG khác để lấp và không giấu địa danh của BG sai.
Giữ đúng số đo đã khóa.
"""

QA_TASK = """CHỈ QA các prompt trong DU_LIEU theo file quy tắc QA.
Không viết lại quy tắc.
FAIL khi một prompt thiếu BG, khi BG không thích hợp với dòng, hoặc khi số đo khác số đã khóa.
Không FAIL chỉ vì số đo là số sáng tạo hợp lý đã khóa.
Nếu BG không thích hợp và bảng đã có BG đúng, chỉ định BG đó. Nếu chưa có BG đúng nơi, nói cần tạo BG từ tác phẩm. Prompt dòng không tự đặt mã BG.
FAIL khi nhân vật đã khóa có mặt trong hình nhưng header không có CHAR riêng của người đó và cũng không có CHAR nhóm đã khóa chứa người đó, hoặc phần chữ không ghi số đo đã khóa.
Mỗi lỗi phải nêu số dòng, loại lỗi, chỗ sai và cách sửa đúng chi tiết đó.
FAIL khi header vừa có CHAR nhóm vừa có CHAR riêng của thành viên trong nhóm đó.
Không FAIL vì dùng CHAR nhóm đã khóa khi tổng ảnh vẫn không quá 10.
FAIL khi nguồn có nhiều con cùng một ngoại hình đã khóa mà prompt chỉ vẽ một con, hoặc tự cấp mã CHAR cho từng con.
FAIL khi bộ máy đã lắp không có CHAR của cả bộ, bị tách từng bộ phận thành nhiều CHAR, hoặc bị ghi vào người đang xem.
FAIL khi dòng diễn ra trong một nơi vật lý mà prompt dùng BG chuyển cảnh trừu tượng thay cho BG vật lý đã tạo.
Nếu dòng cần một nơi vật lý mà không BG đã tạo nào đúng, FAIL và nói cần tạo BG từ tác phẩm. Không bắt sửa bằng cách giấu địa danh hoặc lấy BG khác để lấp.
Suy nghĩ, hồi tưởng hoặc việc sắp tới được vẽ bằng BG của nơi đó, hoặc ghép với BG nơi đang đứng. Không FAIL vì ảnh có nơi được nhớ. Không bắt sửa thành chỉ phản ứng trong phòng hiện tại.
Nếu đạt, dòng cuối là TOOL_QA: PASS
Nếu không đạt, dòng cuối là TOOL_QA: FAIL
"""

REPAIR_TASK = """Sửa đúng các prompt sau theo báo cáo QA và file quy tắc tạo prompt.
Với từng dòng được giao: đọc loại lỗi, chỗ sai và cách sửa. Chỉ đổi đúng chi tiết đó.
Giữ nguyên mọi câu, mã, số đo, panel và nhân vật mà báo cáo không nêu. Không viết lại cả prompt.
Không thêm cách sửa mà báo cáo không nêu. Không viết lại dòng không được gửi.
Giữ nguyên số dòng và số thứ tự đã cho.
Mỗi dòng vẫn có ít nhất một BG đã tạo, đúng trạng thái của dòng. Không tự đặt mã BG mới.
Nhân vật có mặt trong hình thì header có CHAR riêng của người đó, hoặc CHAR nhóm đã khóa chứa người đó. Không gửi cả hai. Phần chữ ghi số đo đã khóa.
Một CHAR sinh vật dùng cho đúng số con. Bộ máy đã lắp dùng một CHAR của cả bộ.
Nếu có BG_VUA_TAO, dùng đúng mã đó cho nơi còn thiếu. Không giữ BG cũ rồi giấu địa danh.
Nơi vật lý dùng BG vật lý đã tạo, không thay bằng BG chuyển cảnh trừu tượng.
Giữ đúng số đo đã khóa.
"""

ADD_BG_TASK = """CHỈ VIẾT PROMPT cho nơi vật lý còn thiếu.
Không viết prompt theo dòng. Không tự đặt mã BG.
Đọc dòng nguồn và báo cáo. Các dòng cùng một nơi thì một prompt. Các nơi khác nhau thì mỗi nơi một prompt.
Mỗi prompt bắt đầu bằng dòng DONG: rồi số dòng nguồn, cách nhau bằng dấu phẩy.
Dòng sau là PROMPT: rồi mô tả nơi, bố cục và trạng thái. Không chép một BG đã có.
"""

MANGA_REPAIR = """KHÓA SỬA MANGA, ưu tiên hơn REQUIRED_FIX nếu QA bắt xóa nơi được nhớ.
Viết lại prompt bằng BG của nơi được nhớ, hoặc ghép BG nơi đang đứng với BG nơi đó theo hiệu ứng manga.
Prompt sửa phải có memory, manga inset hoặc split background.
Không dựng nhân vật đang đứng sẵn tại nơi tương lai như sự kiện đã xảy ra.
Không sửa thành chỉ phản ứng trong phòng và cấm vẽ nơi được nhớ.
"""

_MEMORY_CUE = re.compile(r"(?i)(remember|will soon|recognition|recogniz|nhớ|hồi tưởng|nhận ra|sắp tới|sắp vào)")
_HIDE_REMEMBERED = re.compile(
    r"(?i)(without depicting|do not depict|present mansion|phòng hiện tại|"
    r"already-created BG_|chỉ còn phản ứng|cấm vẽ|visualizing his reaction|visible reaction)"
)
_MANGA_STAGING = re.compile(r"(?i)\b(memory|recollection|flashback|manga|inset|split[- ]background|hồi tưởng)\b")


def memory_place_false_fail(report: str) -> bool:
    text = report or ""
    if not re.search(r"(?i)WRONG_LOCATION|FUTURE_LEAK", text):
        return False
    if not _MEMORY_CUE.search(text):
        return False
    return bool(_HIDE_REMEMBERED.search(text))


def records_use_manga_memory(records: list[dict]) -> bool:
    text = " ".join(str(record.get("body", "")) for record in records)
    return bool(_MANGA_STAGING.search(text))


def failed_line_numbers(report: str, allowed: set[int]) -> list[int]:
    """Line numbers a QA report actually marks FAIL, such as '001 | FAIL_H' or RECHECK_SCOPE."""
    found: set[int] = set()
    text = report or ""
    for match in re.finditer(
        r"(?im)^\s*(\d{1,6})\s*[|:]\s*(?:RESULT:\s*)?FAIL(?:_[A-Z0-9]+)?\b",
        text,
    ):
        number = int(match.group(1))
        if number in allowed:
            found.add(number)
    for match in re.finditer(r"(?i)RECHECK_SCOPE\s*[:=]\s*(\d{1,6})", text):
        number = int(match.group(1))
        if number in allowed:
            found.add(number)
    return sorted(found)


def format_line_list(numbers: list[int], width: int) -> str:
    return ", ".join(f"{number:0{width}d}" for number in numbers)


def qa_fail_blocks(report: str) -> list[tuple[int, str]]:
    """Each FAIL row and the text that belongs to it, up to the next FAIL row."""
    text = report or ""
    matches = list(
        re.finditer(
            r"(?im)^\s*(\d{1,6})\s*[|:]\s*(?:RESULT:\s*)?FAIL(?:_[A-Z0-9]+)?\b",
            text,
        )
    )
    blocks: list[tuple[int, str]] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        blocks.append((int(match.group(1)), text[match.start() : end]))
    return blocks


_CREATE_BG = re.compile(
    r"(?i)(upstream|crear|tạo bg|tao bg|resolve bg|chua có bg|chưa có bg|"
    r"no hay un bg|no physical bg|không có bg|khong co bg|bg đã tạo nào khác|bg fisic)"
)
_NEGATED_BG = re.compile(
    r"(?i)(không dùng|khong dung|do not use|don't use|no usar|no sustitu|"
    r"sin usar|not use|không lấy|instead of)"
)
_POSITIVE_BG = re.compile(
    r"(?i)(use|dùng|dung|usar|utilizar|utilice|already-created|ya creado)"
)


def _names_existing_bg(block: str) -> bool:
    for match in re.finditer(r"(?i)BG_\d+", block):
        before = block[max(0, match.start() - 70) : match.start()]
        if _NEGATED_BG.search(before):
            continue
        if _POSITIVE_BG.search(before):
            return True
    return False


def lines_needing_new_bg(report: str, allowed: set[int]) -> list[int]:
    """FAIL rows whose place has no created BG, so a filler BG must not be reused."""
    found: list[int] = []
    for number, block in qa_fail_blocks(report):
        if number not in allowed or number in found:
            continue
        if not re.search(r"(?i)WRONG_LOCATION", block):
            continue
        if not _CREATE_BG.search(block):
            continue
        if _names_existing_bg(block):
            continue
        found.append(number)
    return found


def parse_new_places(text: str, allowed: set[int]) -> list[tuple[list[int], str]]:
    places: list[tuple[list[int], str]] = []
    numbers: list[int] | None = None
    body: list[str] = []

    def flush() -> None:
        nonlocal numbers, body
        if numbers and body:
            places.append((numbers, " ".join(body).strip()))
        numbers = None
        body = []

    for raw in (text or "").splitlines():
        line = raw.strip()
        head = re.match(r"(?i)^DONG:\s*(.+)$", line)
        if head:
            flush()
            numbers = []
            for item in re.findall(r"\d+", head.group(1)):
                number = int(item)
                if number in allowed and number not in numbers:
                    numbers.append(number)
            continue
        if numbers is None:
            continue
        prompt = re.match(r"(?i)^PROMPT:\s*(.*)$", line)
        if prompt:
            if prompt.group(1).strip():
                body.append(prompt.group(1).strip())
            continue
        if line:
            body.append(line)
    flush()
    return places


def next_bg_id(text: str) -> str:
    found = re.findall(r"(?i)BG_(\d+)", text or "")
    if not found:
        return "BG_01"
    width = max(len(item) for item in found)
    number = max(int(item) for item in found) + 1
    return f"BG_{number:0{width}d}"


def _qa_field(block: str, name: str) -> str:
    match = re.search(rf"(?im)^{name}\s*:\s*(.+)$", block)
    return " ".join(match.group(1).split()) if match else ""


def _clip(text: str, limit: int) -> str:
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def fault_brief(report: str, allowed: set[int], width: int) -> str:
    """One line per QA fail: the line, the error, where it is wrong, and the exact fix."""
    lines: list[str] = []
    for number, block in qa_fail_blocks(report):
        if number not in allowed:
            continue
        issue = _qa_field(block, "ISSUE_TYPE")
        if not issue:
            first = block.splitlines()[0] if block.splitlines() else ""
            inline = re.search(r"(?i)FAIL(?:_[A-Z0-9]+)?\b\s*[—:\-]+\s*(.+)", first)
            issue = " ".join(inline.group(1).split()) if inline else ""
        evidence = _qa_field(block, "EVIDENCE")
        fix = _qa_field(block, "REQUIRED_FIX")
        piece = f"{number:0{width}d}"
        if issue:
            piece += f" | {_clip(issue, 120)}"
        if evidence:
            piece += f" | chỗ sai: {_clip(evidence, 220)}"
        if fix:
            piece += f" | sửa: {_clip(fix, 220)}"
        lines.append(piece)
    return "\n".join(lines)


def valid_repair_map(text: str, expected: list[int], finish: str) -> dict[int, dict]:
    wanted = set(expected)
    found: dict[int, dict] = {}
    order: list[int] = []
    for record in parse_prompt_records(text):
        number = record["n"]
        if number in wanted and record_ok(record) and number not in found:
            found[number] = record
            order.append(number)
    if finish == "length" and order:
        found.pop(order[-1], None)
    return found


def qa_log_body(report: str, records: list[dict], width: int) -> str:
    """Keep the QA report readable. The page log used to drop everything after one sentence."""
    findings = (report or "").strip() or "(QA không trả nội dung.)"
    prompts = format_records(records, width).strip()
    brief = fault_brief(report, {record["n"] for record in records}, width)
    body = ""
    if brief:
        body = "LỖI CẦN SỬA\n" + brief + "\n\n"
    body += "BÁO CÁO QA\n" + findings
    if prompts:
        body += "\n\nPROMPT ĐANG BỊ CHẤM\n" + prompts
    if len(body) > 20000:
        body = body[:20000] + "\n…(nhật ký đã cắt bớt)"
    return body

STEP_TITLES = {
    1: "Danh sách nhân vật và bối cảnh",
    2: "Prompt ảnh nhân vật",
    3: "Prompt ảnh bối cảnh",
    4: "Prompt ảnh theo dòng",
}


class AlreadyRunning(Exception):
    pass


class Stopped(Exception):
    pass


class Job:
    def __init__(self, rules_dir: Path, data_dir: Path, client_factory=None):
        self.rules_dir = Path(rules_dir)
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.client_factory = client_factory or (lambda settings: HttpLlm(settings))
        self._lock = threading.RLock()
        self._running = False
        self._stop = False
        self._thread: threading.Thread | None = None
        self._settings: dict = {}
        self._source_text = ""
        self._lines: list[str] = []
        self._digest = ""
        self._steps = {step: "pending" for step in (1, 2, 3, 4)}
        self._current = 0
        self._state = "idle"
        self._detail = ""
        self._notice = {"kind": "", "text": ""}
        self._logs: list[str] = []
        self._ceiling = CEILING
        self._qa_omitted_rule = False
        self._load()

    def begin(self, source_text: str, settings: dict, mode: str) -> None:
        with self._lock:
            if self._running:
                raise AlreadyRunning()
            self._prepare(source_text, settings)
            self._running = True
            self._stop = False
            self._state = "running"
            self._notice = {"kind": "", "text": ""}
            self._detail = "Bắt đầu."
            self._mode = mode if mode in {"all", "next"} else "all"
            self._save()
        self._thread = threading.Thread(target=self._thread_main, daemon=True)
        self._thread.start()

    def request_stop(self) -> None:
        with self._lock:
            self._stop = True
            if self._running:
                self._detail = "Sẽ dừng sau lượt đang gọi."
                self._save()

    def clear(self) -> None:
        with self._lock:
            if self._running:
                raise AlreadyRunning()
            source = self._source_text
            lines = list(self._lines)
            digest = self._digest
            self._reset_outputs()
            self._source_text = source
            self._lines = lines
            self._digest = digest
            self._state = "idle"
            self._notice = {"kind": "", "text": ""}
            self._detail = ""
            self._log_unlocked("Đã xóa kết quả.")
            self._save()

    def snapshot(self, include_source: bool = False) -> dict:
        with self._lock:
            files = {}
            for key, name in OUTPUT_FILES.items():
                path = self.data_dir / name
                ready = path.is_file() and path.stat().st_size > 0
                files[key] = {
                    "ready": ready,
                    "filename": name,
                    "bytes": path.stat().st_size if ready else 0,
                }
            return {
                "state": self._state,
                "running": self._running,
                "current_step": self._current,
                "detail": self._detail,
                "notice": dict(self._notice),
                "log": list(self._logs),
                "line_total": len(self._lines),
                "line_done": self._locked_count(),
                "steps": [
                    {"id": step, "title": STEP_TITLES[step], "status": self._steps[step]}
                    for step in (1, 2, 3, 4)
                ],
                "files": files,
                "source_text": self._source_text if include_source else "",
            }

    def output_path(self, filename: str) -> Path:
        if filename not in OUTPUT_FILES.values() and filename != "XX.TXT":
            raise JobError("Không có file này.")
        return self.data_dir / filename

    def _thread_main(self) -> None:
        try:
            self._execute()
        except Stopped as exc:
            self._finish("stopped", "stop", str(exc))
        except JobError as exc:
            self._finish("error", "error", str(exc))
        except LlmError as exc:
            self._finish("error", "error", str(exc))
        except Exception as exc:
            self._finish("error", "error", "Lỗi không dự tính: " + str(exc))
        finally:
            with self._lock:
                self._running = False
                self._save()

    def _execute(self) -> None:
        self._ensure_rules()
        client = self.client_factory(self._settings)
        try:
            for step in self._plan():
                self._check_stop()
                if step == 1:
                    self._step_extract(client)
                elif step == 2:
                    self._step_reference(client, 2, "PROMPT_CHAR.txt", CHAR_TASK, "char")
                elif step == 3:
                    self._step_reference(client, 3, "PROMPT_BG.txt", BG_TASK, "bg")
                else:
                    self._step_lines(client)
        finally:
            close = getattr(client, "close", None)
            if close:
                close()
        with self._lock:
            complete = all(self._steps[step] == "done" for step in (1, 2, 3, 4))
            self._state = "done" if complete else "idle"
            self._current = 0
            if complete:
                self._notice = {"kind": "ok", "text": "Đủ bốn bước. Có thể tải ba file."}
                self._detail = self._notice["text"]
            else:
                self._notice = {"kind": "", "text": ""}
            self._save()

    def _prepare(self, source_text: str, settings: dict) -> None:
        self._validate_settings(settings)
        lines = split_source(source_text)
        if not lines:
            raise JobError("Chưa có dòng nào. Dán bản đã chia dòng, mỗi dòng một câu.")
        if len(source_text) > 2_000_000:
            raise JobError("Bản nguồn quá dài.")
        digest = source_digest(lines)
        if self._digest and digest != self._digest:
            self._reset_outputs()
            self._log_unlocked("Bản nguồn khác lần trước, chạy lại từ bước 1.")
        self._settings = {
            "provider": str(settings.get("provider") or "teamsoclo"),
            "base_url": settings["base_url"].strip(),
            "api_key": settings["api_key"],
            "model": settings["model"].strip(),
            "api_style": settings["api_style"],
            "max_input_tokens": int(settings["max_input_tokens"]),
            "max_output_tokens": int(settings["max_output_tokens"]),
            "request_timeout_seconds": int(settings["request_timeout_seconds"]),
        }
        self._source_text = source_text
        self._lines = lines
        self._digest = digest
        self._qa_omitted_rule = False

    def _validate_settings(self, settings: dict) -> None:
        if not str(settings.get("base_url") or "").strip() or not str(settings.get("api_key") or "").strip():
            raise JobError("Dán API rồi bấm Kiểm tra.")
        if not str(settings.get("model") or "").strip():
            raise JobError("Bấm Kiểm tra, rồi chọn model.")
        if settings.get("api_style") not in {"chat", "responses", "claude"}:
            raise JobError("API không dùng được.")

    def _plan(self) -> list[int]:
        with self._lock:
            pending = [step for step in (1, 2, 3, 4) if self._steps[step] != "done"]
            mode = self._mode
        if not pending:
            raise JobError("Đã xong bốn bước. Xóa kết quả nếu muốn chạy lại.")
        if mode == "next":
            return pending[:1]
        return pending

    def _step_extract(self, client) -> None:
        self._mark(1, "running")
        guide, rules = self._pair("00_QUY_TRINH_HUONG_DAN.txt", "01_TRICH_NHAN_VAT_VA_BOI_CANH.txt")
        documents = [("HUONG_DAN", guide), ("QUY_TAC", rules)]
        self._log("Bước 1 — đã gắn nguyên văn quy tắc trích xuất.")
        chunks = self._chunks(documents, "extract", EXTRACT_TASK, "")
        parts = []
        for chunk in chunks:
            self._check_stop()
            if len(chunks) > 1:
                self._log(f"Đang trích dòng {chunk[0][0]}–{chunk[-1][0]}.")
            material = EXTRACT_TASK + "\nCAC_DONG\n" + format_source_rows(chunk, numbered_width(len(self._lines)))
            text = self._complete_whole(client, "extract", documents, material)
            parts.append(text.strip())
        if len(parts) == 1:
            final = parts[0]
        else:
            self._log("Đang gộp các phần trích thành một danh sách.")
            material = MERGE_TASK + "\nPHAN_TRICH\n" + "\n\n---\n\n".join(parts)
            self._ensure_material_fits("merge", documents, material, "")
            final = self._complete_whole(client, "merge", documents, material)
        self._write("DANH_SACH_CHAR_BG.txt", final.strip() + "\n")
        if "CHAR_" not in final and "BG_" not in final:
            raise JobError(
                "Danh sách chưa có mã CHAR_ hoặc BG_. Không sang bước sau. "
                "Xem tab Danh sách rồi chạy lại bước này."
            )
        self._mark(1, "done")
        self._log("Xong danh sách.")

    def _step_reference(self, client, step: int, filename: str, task: str, label: str) -> None:
        self._mark(step, "running")
        guide, rules = self._pair("00_QUY_TRINH_HUONG_DAN.txt", "02_PROMPT_THAM_CHIEU_CHAR_BG.txt")
        documents = [("HUONG_DAN", guide), ("QUY_TAC", rules)]
        listing = self._require_text("DANH_SACH_CHAR_BG.txt", "Chưa có danh sách đã khóa.")
        material = task + "\nDANH_SACH_DA_KHOA\n" + listing.strip() + "\n"
        self._log(f"Bước {step} — đã gắn nguyên văn quy tắc tham chiếu.")
        self._ensure_material_fits(label, documents, material, "")
        text = self._complete_whole(client, label, documents, material)
        self._write(filename, text.strip() + "\n")
        self._mark(step, "done")
        self._log("Xong bước " + str(step) + ".")

    def _step_lines(self, client) -> None:
        self._mark(4, "running")
        reference = self._compile()
        guide = self._rule("00_QUY_TRINH_HUONG_DAN.txt")
        rules = self._rule("03_PROMPT_ANH_THEO_DONG.txt")
        qa_rules = self._rule("04_QA_PROMPT_THEO_DONG.txt")
        documents = [("HUONG_DAN", guide), ("QUY_TAC", rules)]
        self._log("Bước 4 — đã gắn nguyên văn quy tắc prompt theo dòng và file tham chiếu.")
        total = len(self._lines)
        width = numbered_width(total)
        locked = self._valid_locked()
        index = len(locked)
        self._write("PROMPT_THEO_DONG.txt", format_records(locked, width))
        while index < total:
            self._check_stop()
            remaining_rows = [(number, self._lines[number - 1]) for number in range(index + 1, total + 1)]
            count, wanted = self._fit_line_batch(documents, reference, remaining_rows, width)
            if count < wanted:
                self._log(f"Giảm còn {count} dòng vì lượt đầy vượt giới hạn.")
            batch = remaining_rows[:count]
            self._log(f"Đang viết dòng {batch[0][0]}–{batch[-1][0]}.")
            try:
                kept, status = self._generate_batch(client, documents, reference, batch, width)
            except LlmError as exc:
                if exc.kind == "context" and count > 1:
                    self._ceiling = max(1, count // 2)
                    self._log("API báo vượt cửa sổ ngữ cảnh. Giảm số dòng của lượt sau.")
                    continue
                raise JobError(self._with_range(exc, batch)) from exc
            if not kept:
                if count == 1:
                    raise JobError(
                        "Một dòng bị cắt vì hết token đầu ra. Tăng giới hạn token đầu ra. "
                        "Không nhận prompt bị cắt."
                    )
                self._ceiling = max(1, count // 2)
                self._log(f"Phản hồi bị cắt. Chưa khóa dòng nào. Lượt sau còn tối đa {self._ceiling} dòng.")
                continue
            kept, reference = self._qa_batch(client, guide, qa_rules, rules, reference, kept, width)
            locked.extend(kept)
            index += len(kept)
            self._write("PROMPT_THEO_DONG.txt", format_records(locked, width))
            self._log(f"Đã khóa {index}/{total} dòng.")
            if status == "truncated":
                self._ceiling = max(1, count // 2)
        self._final_qa(client, guide, qa_rules, rules, reference, locked, width)
        self._mark(4, "done")

    def _generate_batch(self, client, documents, reference, batch, width):
        material = self._line_material(reference, batch, width, LINE_TASK)
        text, finish = self._call(client, "lines", documents, material)
        expected = [number for number, _text in batch]
        kept, status = classify_records(parse_prompt_records(text), expected, finish)
        if status != "invalid":
            return kept, status
        self._log("Lượt này chưa đủ prompt đúng số dòng. Sửa một lần.")
        repair = REPAIR_TASK + "\nDONG_NGUON\n" + format_source_rows(batch, width) + "\nPROMPT_DA_TRA\n" + text
        repaired, finish = self._call(client, "repair", documents, repair)
        kept, status = classify_records(parse_prompt_records(repaired), expected, finish)
        if status == "invalid":
            excerpt = " ".join(repaired.split())[:1200]
            raise JobError("Lượt này vẫn không đủ một prompt cho mỗi dòng. Không nhận bản thiếu.\n\n" + excerpt)
        return kept, status

    def _qa_batch(self, client, guide, qa_rules, line_rules, reference, records, width):
        rows = [(record["n"], self._lines[record["n"] - 1]) for record in records]
        verdict, report = self._qa_once(client, guide, qa_rules, line_rules, reference, rows, records, width)
        if verdict == "pass" or (memory_place_false_fail(report) and records_use_manga_memory(records)):
            self._log(f"QA đạt, dòng {rows[0][0]}–{rows[-1][0]}.")
            return records, reference
        open_lines = self._open_fail_lines(report, records, width)
        if not open_lines:
            self._log(f"QA đạt, dòng {rows[0][0]}–{rows[-1][0]}.")
            return records, reference
        brief = fault_brief(report, {record["n"] for record in records}, width)
        lead = brief.splitlines()[0] if brief else f"dòng {rows[0][0]}–{rows[-1][0]}"
        self._log(
            f"QA chưa đạt. {lead}. Sửa đúng chi tiết này.",
            qa_log_body(report, records, width),
        )
        documents = [("HUONG_DAN", guide), ("QUY_TAC", line_rules)]
        added: list[tuple[str, list[int]]] = []
        covered: set[int] = set()
        reference = self._supply_missing_backgrounds(
            client, guide, report, rows, width, reference, added, covered, set(open_lines)
        )
        kept = self._repair_selected(
            client,
            documents,
            report,
            rows,
            records,
            width,
            reference,
            self._bg_repair_note(added, width),
            open_lines,
        )
        verdict, report = self._qa_once(client, guide, qa_rules, line_rules, reference, rows, kept, width)
        if verdict == "pass" or (memory_place_false_fail(report) and records_use_manga_memory(kept)):
            if memory_place_false_fail(report) and records_use_manga_memory(kept) and verdict != "pass":
                self._log(f"QA bắt xóa nơi được nhớ. Khóa manga cho sang lượt sau, dòng {rows[0][0]}–{rows[-1][0]}.")
            else:
                self._log(f"QA đạt sau khi sửa, dòng {rows[0][0]}–{rows[-1][0]}.")
            return kept, reference
        open_lines = self._open_fail_lines(report, kept, width)
        if not open_lines:
            self._log(f"QA đạt sau khi sửa, dòng {rows[0][0]}–{rows[-1][0]}.")
            return kept, reference
        if open_lines:
            self._log(
                f"QA vẫn chưa đạt. Chỉ sửa các dòng còn lỗi: {format_line_list(open_lines, width)}.",
                "LỖI CẦN SỬA\n" + fault_brief(report, set(open_lines), width),
            )
            reference = self._supply_missing_backgrounds(
                client, guide, report, rows, width, reference, added, covered, set(open_lines)
            )
            kept = self._repair_selected(
                client,
                documents,
                report,
                rows,
                kept,
                width,
                reference,
                self._bg_repair_note(added, width),
                open_lines,
            )
            verdict, report = self._qa_once(client, guide, qa_rules, line_rules, reference, rows, kept, width)
            if verdict == "pass" or (memory_place_false_fail(report) and records_use_manga_memory(kept)):
                if memory_place_false_fail(report) and records_use_manga_memory(kept) and verdict != "pass":
                    self._log(
                        f"QA bắt xóa nơi được nhớ. Khóa manga cho sang lượt sau, dòng {rows[0][0]}–{rows[-1][0]}."
                    )
                else:
                    self._log(f"QA đạt sau khi sửa, dòng {rows[0][0]}–{rows[-1][0]}.")
                return kept, reference
            open_lines = self._open_fail_lines(report, kept, width)
            if not open_lines:
                self._log(f"QA đạt sau khi sửa, dòng {rows[0][0]}–{rows[-1][0]}.")
                return kept, reference
        listed = format_line_list(open_lines, width)
        where = f" ở dòng {listed}" if listed else ""
        raise JobError(
            f"QA vẫn chưa đạt{where}. Không sang lượt sau.\n\n" + qa_log_body(report, kept, width)
        )

    def _open_fail_lines(self, report: str, records: list[dict], width: int) -> list[int]:
        del width
        return failed_line_numbers(report, {record["n"] for record in records})

    def _bg_repair_note(self, added: list[tuple[str, list[int]]], width: int) -> str:
        if not added:
            return ""
        lines = [
            f"{bg_id} dùng cho dòng {format_line_list(numbers, width)}. "
            "Dùng mã này. Không giữ BG cũ để lấp. Không giấu địa danh."
            for bg_id, numbers in added
        ]
        return "BG_VUA_TAO\n" + "\n".join(lines) + "\n"

    def _supply_missing_backgrounds(
        self, client, guide, report, rows, width, reference, added, covered: set[int], only: set[int] | None = None
    ) -> str:
        allowed = {number for number, _text in rows}
        needed = [number for number in lines_needing_new_bg(report, allowed) if number not in covered]
        if only is not None:
            needed = [number for number in needed if number in only]
        if not needed:
            return reference
        listed = format_line_list(needed, width)
        self._log(f"Dòng {listed} chưa có BG đúng nơi. Tạo BG từ dòng nguồn, không lấy BG khác để lấp.")
        source = {number: text for number, text in rows}
        selected = [(number, source[number]) for number in needed]
        bg_rules = self._rule("02_PROMPT_THAM_CHIEU_CHAR_BG.txt")
        documents = [("HUONG_DAN", guide), ("QUY_TAC", bg_rules)]
        listing = self._require_text("DANH_SACH_CHAR_BG.txt", "Chưa có danh sách đã khóa.")
        material = (
            ADD_BG_TASK
            + "\nDANH_SACH_DA_KHOA\n"
            + listing.strip()
            + "\n\nBAO_CAO_QA\n"
            + report
            + "\nDONG_NGUON\n"
            + format_source_rows(selected, width)
        )
        self._ensure_material_fits("add-bg", documents, material, "")
        text, finish = self._call(client, "add-bg", documents, material)
        if finish == "length":
            raise JobError("Lượt tạo BG bị cắt vì hết token đầu ra. Không khóa lượt này.")
        places = parse_new_places(text, set(needed))
        covered_now = {number for numbers, _prompt in places for number in numbers}
        if not places or any(number not in covered_now for number in needed):
            excerpt = " ".join(text.split())[:1200]
            raise JobError(
                f"Dòng {listed} chưa có BG đúng nơi. Lượt tạo BG không trả prompt nơi. Không khóa lượt này.\n\n"
                + excerpt
            )
        listing_text = listing.strip() + "\n"
        bg_text = self._require_text("PROMPT_BG.txt", "Chưa có prompt bối cảnh đã khóa.").strip() + "\n"
        fresh = reference
        for numbers, prompt in places:
            bg_id = next_bg_id(fresh + "\n" + listing_text + "\n" + bg_text)
            listing_text += f"{bg_id}: nơi của dòng {format_line_list(numbers, width)}.\n"
            bg_text += f"{bg_id}\n{prompt}\n"
            fresh += f"\n{bg_id}\n"
            added.append((bg_id, numbers))
            covered.update(numbers)
            self._log(f"Đã thêm {bg_id} cho dòng {format_line_list(numbers, width)}.")
        self._write("DANH_SACH_CHAR_BG.txt", listing_text)
        self._write("PROMPT_BG.txt", bg_text)
        char_text = self._require_text("PROMPT_CHAR.txt", "Chưa có prompt nhân vật đã khóa.")
        reference = compile_reference(listing_text, char_text, bg_text)
        self._write("TBN6A.txt", reference)
        self._write("XX.TXT", reference)
        return reference

    def _repair_selected(
        self, client, documents, report, rows, records, width, reference, bg_note: str = "", only: list[int] | None = None
    ):
        """Rewrite only the lines QA marked FAIL. Keep every other line in this window."""
        source = {number: text for number, text in rows}
        current = {record["n"]: record for record in records}
        cited = list(only) if only is not None else failed_line_numbers(report, set(current))
        cited = [number for number in cited if number in current]
        if cited and len(cited) < len(records):
            self._log(
                f"Chỉ sửa dòng {format_line_list(cited, width)}. Giữ các dòng QA không nêu lỗi."
            )
            pending = cited
        else:
            pending = cited or [record["n"] for record in records]
        manga = memory_place_false_fail(report)
        for attempt in range(2):
            selected_rows = [(number, source[number]) for number in pending]
            selected_records = [current[number] for number in pending]
            brief = fault_brief(report, set(pending), width)
            repair = (
                REPAIR_TASK
                + ("\n" + MANGA_REPAIR if manga else "")
                + ("\n" + bg_note if bg_note else "")
                + ("\nLỖI CẦN SỬA\n" + brief + "\n" if brief else "")
                + "\nBAO_CAO_QA\n"
                + report
                + "\nDONG_CAN_SUA\n"
                + format_source_rows(selected_rows, width)
                + "PROMPT_CU\n"
                + format_records(selected_records, width)
                + "CHỈ TRẢ ĐÚNG CÁC DÒNG: "
                + format_line_list(pending, width)
                + "\n"
            )
            self._ensure_material_fits("repair", documents, repair, reference)
            text, finish = self._call(client, "repair", documents, repair)
            found = valid_repair_map(text, pending, finish)
            current.update(found)
            missing = [number for number in pending if number not in found]
            if not missing:
                break
            excerpt = " ".join(text.split())[:1200]
            listed = format_line_list(missing, width)
            if attempt == 0:
                self._log(
                    f"Bản sửa thiếu dòng {listed}. Chỉ gửi lại các dòng này.",
                    excerpt,
                )
                pending = missing
                continue
            raise JobError(f"Bản sửa thiếu dòng {listed}. Không khóa lượt này.\n\n" + excerpt)
        return [current[record["n"]] for record in records]

    def _qa_once(self, client, guide, qa_rules, line_rules, reference, rows, records, width):
        material = (
            QA_TASK
            + "\nFILE_THAM_CHIEU_DA_KHOA\n"
            + reference.strip()
            + "\n\nDONG_NGUON\n"
            + format_source_rows(rows, width)
            + "PROMPT\n"
            + format_records(records, width)
        )
        documents, omitted = self._qa_documents(guide, qa_rules, line_rules, material)
        if message_tokens("qa", documents, material) > self._max_input():
            raise JobError(MSG_RULES_AND_REFERENCE)
        if omitted and not self._qa_omitted_rule:
            self._qa_omitted_rule = True
            self._log("Một lượt QA không vừa thêm file 03. File 04 và file tham chiếu vẫn được gửi đủ, không cắt file 03.")
        text, finish = self._call(client, "qa", documents, material)
        if finish == "length":
            raise JobError("QA bị cắt vì hết token đầu ra. Không khóa lượt này. Tăng token đầu ra.")
        return qa_verdict(text), text

    def _final_qa(self, client, guide, qa_rules, line_rules, reference, records, width):
        rows = [(index, line) for index, line in enumerate(self._lines, start=1)]
        material = (
            QA_TASK
            + "\nDAY LA QA TONG THE TOAN BO TAC PHAM.\nFILE_THAM_CHIEU_DA_KHOA\n"
            + reference.strip()
            + "\n\nDONG_NGUON\n"
            + format_source_rows(rows, width)
            + "PROMPT\n"
            + format_records(records, width)
        )
        documents = [("HUONG_DAN", guide), ("QUY_TAC_QA", qa_rules), ("QUY_TAC_TAO_PROMPT", line_rules)]
        if message_tokens("qa", documents, material) > self._max_input():
            documents = [("HUONG_DAN", guide), ("QUY_TAC_QA", qa_rules)]
        if message_tokens("qa", documents, material) > self._max_input():
            self._log("QA tổng một lượt không vừa giới hạn. Từng lượt trước đã QA. Không cắt quy tắc để nhét toàn bộ.")
            return
        self._log("Đang QA tổng thể.")
        text, finish = self._call(client, "qa", documents, material)
        if finish == "length" or qa_verdict(text) != "pass":
            raise JobError(
                "QA tổng thể chưa đạt. Không tự viết lại toàn bộ.\n\n" + qa_log_body(text, records, width)
            )

    def _qa_documents(self, guide, qa_rules, line_rules, material):
        full = [("HUONG_DAN", guide), ("QUY_TAC_QA", qa_rules), ("QUY_TAC_TAO_PROMPT", line_rules)]
        if message_tokens("qa", full, material) <= self._max_input():
            return full, False
        return [("HUONG_DAN", guide), ("QUY_TAC_QA", qa_rules)], True

    def _fit_line_batch(self, documents, reference, rows, width):
        fixed = message_tokens("lines", documents, self._line_material(reference, [], width, LINE_TASK))
        rules_only = message_tokens("lines", documents, LINE_TASK + "\nCAC_DONG\n")
        costs = [estimate_tokens(f"{number:0{width}d}. {text}\n") for number, text in rows]
        wanted = min(self._ceiling, len(rows))
        count = largest_prefix(costs, fixed, OUTPUT_PER_LINE, self._max_input(), self._max_output(), wanted)
        if count > 0:
            return count, wanted
        if OUTPUT_PER_LINE > self._max_output():
            raise JobError(MSG_OUTPUT_TOO_SMALL)
        if rules_only > self._max_input():
            raise JobError(MSG_RULES_ONLY)
        if fixed > self._max_input():
            raise JobError(MSG_RULES_AND_REFERENCE)
        raise JobError(MSG_ONE_LINE)

    def _chunks(self, documents, step: str, task: str, reference: str) -> list[list[tuple[int, str]]]:
        width = numbered_width(len(self._lines))
        fixed = message_tokens(step, documents, task + "\nCAC_DONG\n" + reference)
        if fixed > self._max_input():
            raise JobError(MSG_RULES_ONLY)
        chunks: list[list[tuple[int, str]]] = []
        current: list[tuple[int, str]] = []
        current_cost = 0
        for number, text in enumerate(self._lines, start=1):
            cost = estimate_tokens(f"{number:0{width}d}. {text}\n")
            if current and fixed + current_cost + cost > self._max_input():
                chunks.append(current)
                current = []
                current_cost = 0
            if fixed + cost > self._max_input():
                raise JobError(MSG_ONE_LINE)
            current.append((number, text))
            current_cost += cost
        if current:
            chunks.append(current)
        return chunks

    def _line_material(self, reference: str, rows, width: int, task: str) -> str:
        return (
            task
            + "\nFILE_THAM_CHIEU_DA_KHOA\n"
            + reference.strip()
            + "\n\nCAC_DONG\n"
            + format_source_rows(rows, width)
        )

    def _compile(self) -> str:
        listing = self._require_text("DANH_SACH_CHAR_BG.txt", "Chưa có danh sách đã khóa.")
        char_text = self._require_text("PROMPT_CHAR.txt", "Chưa có prompt nhân vật đã khóa.")
        bg_text = self._require_text("PROMPT_BG.txt", "Chưa có prompt bối cảnh đã khóa.")
        text = compile_reference(listing, char_text, bg_text)
        self._write("TBN6A.txt", text)
        self._write("XX.TXT", text)
        self._log("Đã tổng hợp file tham chiếu TBN6A.txt.")
        return text

    def _complete_whole(self, client, step: str, documents, material: str) -> str:
        text, finish = self._call(client, step, documents, material)
        if finish == "length":
            raise JobError(
                "Phản hồi bị cắt vì hết token đầu ra. Không nhận phần bị cắt. "
                "Tăng giới hạn token đầu ra rồi chạy lại bước này."
            )
        if not text.strip():
            raise JobError("API trả về rỗng.")
        return text

    def _ensure_material_fits(self, step: str, documents, material: str, reference: str) -> None:
        tokens = message_tokens(step, documents, material)
        if tokens <= self._max_input():
            return
        rules_only = message_tokens(step, documents, "")
        if rules_only > self._max_input():
            raise JobError(MSG_RULES_ONLY)
        if reference and tokens > self._max_input():
            raise JobError(MSG_RULES_AND_REFERENCE)
        raise JobError(MSG_RULES_ONLY)

    def _call(self, client, step: str, documents, material: str):
        system, user = build_call(step, documents, material)
        completion = client.complete(system, user, self._max_output())
        return completion.text, completion.finish

    def _with_range(self, exc: LlmError, batch) -> str:
        start, end = batch[0][0], batch[-1][0]
        if exc.kind in {"timeout", "network"}:
            return f"{exc} Dòng {start}–{end} chưa có prompt. Bấm chạy tiếp nếu muốn gửi lại các dòng chưa khóa."
        if exc.kind == "rate":
            return f"API vẫn báo quá lượt. Dòng {start}–{end} chưa khóa. Không gửi thêm."
        return str(exc)

    def _check_stop(self) -> None:
        with self._lock:
            stopped = self._stop
        if stopped:
            raise Stopped("Đã dừng. Phần đã khóa vẫn giữ. Bấm chạy tiếp khi muốn làm tiếp.")

    def _valid_locked(self) -> list[dict]:
        text = self._output_text("PROMPT_THEO_DONG.txt")
        expected = list(range(1, len(self._lines) + 1))
        records = parse_prompt_records(text)
        return matching_prefix(records, expected)

    def _locked_count(self) -> int:
        text = self._output_text("PROMPT_THEO_DONG.txt")
        if not text.strip() or not self._lines:
            return 0
        expected = list(range(1, len(self._lines) + 1))
        return len(matching_prefix(parse_prompt_records(text), expected))

    def _finish(self, state: str, kind: str, message: str) -> None:
        with self._lock:
            self._state = state
            self._notice = {"kind": kind, "text": message}
            if self._current and self._steps.get(self._current) == "running":
                self._steps[self._current] = "error" if state == "error" else "stopped"
            first, _, rest = message.partition("\n")
            self._log_unlocked(first, rest)
            self._save()

    def _mark(self, step: int, status: str) -> None:
        with self._lock:
            self._steps[step] = status
            self._current = step if status == "running" else self._current
            self._save()

    def _log(self, message: str, body: str = "") -> None:
        with self._lock:
            self._log_unlocked(message, body)
            self._save()

    def _log_unlocked(self, message: str, body: str = "") -> None:
        summary = " ".join(message.split())
        if len(summary) > 240:
            summary = summary[:237] + "…"
        entry = summary
        detail = (body or "").strip()
        if detail:
            entry = summary + "\n" + detail
        self._detail = summary
        self._logs.append(entry)
        del self._logs[:-80]
        atomic_write(self.data_dir / "NHAT_KY.txt", "\n\n".join(self._logs) + "\n")

    def _pair(self, guide_name: str, rule_name: str) -> tuple[str, str]:
        return self._rule(guide_name), self._rule(rule_name)

    def _rule(self, name: str) -> str:
        path = self.rules_dir / name
        if not path.is_file():
            raise JobError(f"Thiếu file quy tắc {name}. Không chạy khi thiếu file.")
        return read_text(path)

    def _ensure_rules(self) -> None:
        missing = [name for name in RULE_FILES if not (self.rules_dir / name).is_file()]
        if missing:
            raise JobError("Thiếu file quy tắc: " + ", ".join(missing) + ". Không chạy khi thiếu file.")

    def _require_text(self, filename: str, message: str) -> str:
        text = self._output_text(filename)
        if not text.strip():
            raise JobError(message)
        return text

    def _write(self, filename: str, text: str) -> None:
        atomic_write(self.data_dir / filename, text)

    def _output_text(self, filename: str) -> str:
        path = self.data_dir / filename
        if not path.is_file():
            return ""
        return read_text(path)

    def _max_input(self) -> int:
        return int(self._settings["max_input_tokens"])

    def _max_output(self) -> int:
        return int(self._settings["max_output_tokens"])

    def _reset_outputs(self) -> None:
        for name in list(OUTPUT_FILES.values()) + ["XX.TXT"]:
            path = self.data_dir / name
            if path.exists():
                path.unlink()
        self._steps = {step: "pending" for step in (1, 2, 3, 4)}
        self._current = 0
        self._ceiling = CEILING
        self._qa_omitted_rule = False

    def _load(self) -> None:
        path = self.data_dir / "state.json"
        source_path = self.data_dir / "source.txt"
        if source_path.is_file():
            self._source_text = read_text(source_path)
            self._lines = split_source(self._source_text)
            self._digest = source_digest(self._lines) if self._lines else ""
        if not path.is_file():
            return
        try:
            data = json.loads(read_text(path))
        except json.JSONDecodeError:
            return
        saved_steps = data.get("steps") or {}
        for step in (1, 2, 3, 4):
            status = saved_steps.get(str(step), "pending")
            if status == "running":
                status = "stopped"
            if status in {"pending", "done", "error", "stopped"}:
                self._steps[step] = status
        self._ceiling = int(data.get("ceiling") or CEILING)
        self._logs = list(data.get("log") or [])[-80:]
        self._detail = str(data.get("detail") or "")
        notice = data.get("notice") or {}
        if isinstance(notice, dict):
            self._notice = {"kind": str(notice.get("kind") or ""), "text": str(notice.get("text") or "")}
        state = str(data.get("state") or "idle")
        if state == "running":
            self._state = "stopped"
            self._notice = {
                "kind": "stop",
                "text": "Tool dừng giữa chừng. Phần đã khóa vẫn giữ. Bấm chạy tiếp.",
            }
            current = int(data.get("current_step") or 0)
            if current in self._steps and self._steps[current] != "done":
                self._steps[current] = "stopped"
        elif state in {"idle", "done", "error", "stopped"}:
            self._state = state

    def _save(self) -> None:
        atomic_write(self.data_dir / "source.txt", self._source_text)
        payload = {
            "state": self._state,
            "current_step": self._current,
            "steps": {str(step): status for step, status in self._steps.items()},
            "detail": self._detail,
            "notice": self._notice,
            "log": self._logs[-80:],
            "ceiling": self._ceiling,
            "digest": self._digest,
        }
        atomic_write(self.data_dir / "state.json", json.dumps(payload, ensure_ascii=False, indent=2))
