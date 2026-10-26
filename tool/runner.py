"""Chạy bốn bước theo thứ tự. Mỗi lượt API đọc lại file quy tắc trên đĩa."""

from __future__ import annotations

import json
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
"""

MERGE_TASK = """CHỈ GỘP BƯỚC 1.
Các phần trích bên dưới là của cùng một tác phẩm.
Đếm số câu khác nhau trên toàn bộ các phần, rồi xuất một danh sách CHAR và BG duy nhất theo quy tắc.
"""

CHAR_TASK = """CHỈ LÀM BƯỚC 2.
Danh sách đã khóa nằm trong DU_LIEU.
Viết prompt tham chiếu cho mọi CHAR trong danh sách.
Không viết prompt BG ở bước này.
"""

BG_TASK = """CHỈ LÀM BƯỚC 3.
Danh sách đã khóa nằm trong DU_LIEU.
Viết prompt tham chiếu cho mọi BG trong danh sách.
Không viết lại prompt CHAR ở bước này.
"""

LINE_TASK = """CHỈ LÀM BƯỚC 4 cho đúng các dòng trong CAC_DONG.
Mỗi dòng nguồn một prompt. Giữ đúng số thứ tự.
Dùng file tham chiếu đã khóa. Không làm lại danh sách CHAR/BG.
Không giải thích ngoài các dòng prompt.
"""

QA_TASK = """CHỈ QA các prompt trong DU_LIEU theo file quy tắc QA.
Không viết lại quy tắc.
Nếu đạt, dòng cuối là TOOL_QA: PASS
Nếu không đạt, dòng cuối là TOOL_QA: FAIL
"""

REPAIR_TASK = """Sửa đúng các prompt sau theo báo cáo QA và file quy tắc tạo prompt.
Giữ nguyên số dòng và số thứ tự đã cho.
Chỉ xuất các dòng prompt, đúng định dạng trong quy tắc.
"""

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
            kept = self._qa_batch(client, guide, qa_rules, rules, reference, kept, width)
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
        if verdict == "pass":
            self._log(f"QA đạt, dòng {rows[0][0]}–{rows[-1][0]}.")
            return records
        self._log(f"QA chưa đạt ở dòng {rows[0][0]}–{rows[-1][0]}. Sửa đúng lỗi rồi kiểm lại.")
        documents = [("HUONG_DAN", guide), ("QUY_TAC", line_rules)]
        repair = (
            REPAIR_TASK
            + "\nBAO_CAO_QA\n"
            + report
            + "\nDONG_NGUON\n"
            + format_source_rows(rows, width)
            + "\nPROMPT_CU\n"
            + format_records(records, width)
        )
        self._ensure_material_fits("repair", documents, repair, reference)
        text, finish = self._call(client, "repair", documents, repair)
        expected = [number for number, _text in rows]
        kept, status = classify_records(parse_prompt_records(text), expected, finish)
        if status != "ok":
            raise JobError("Bản sửa sau QA không đủ prompt đúng số dòng. Không khóa lượt này.")
        verdict, report = self._qa_once(client, guide, qa_rules, line_rules, reference, rows, kept, width)
        if verdict != "pass":
            excerpt = " ".join(report.split())[:1500]
            raise JobError("QA vẫn chưa đạt sau một lần sửa. Không sang lượt sau.\n\n" + excerpt)
        self._log(f"QA đạt sau khi sửa, dòng {rows[0][0]}–{rows[-1][0]}.")
        return kept

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
            excerpt = " ".join(text.split())[:1500]
            raise JobError("QA tổng thể chưa đạt. Không tự viết lại toàn bộ.\n\n" + excerpt)

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
            self._detail = message.split("\n", 1)[0][:240]
            self._logs.append(self._detail)
            del self._logs[:-80]
            self._save()

    def _mark(self, step: int, status: str) -> None:
        with self._lock:
            self._steps[step] = status
            self._current = step if status == "running" else self._current
            self._save()

    def _log(self, message: str) -> None:
        with self._lock:
            self._log_unlocked(message)
            self._save()

    def _log_unlocked(self, message: str) -> None:
        clean = " ".join(message.split())
        if len(clean) > 240:
            clean = clean[:237] + "…"
        self._detail = clean
        self._logs.append(clean)
        del self._logs[:-80]

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
