/**
 * One unique end-phrase per outcome. Never reuse a phrase across steps.
 * QA steps keep the exact phrases already written inside [...].
 * Non-QA steps use XONG, not ĐẠT.
 */
(function (root) {
  const SIGNAL = {
    REF_PREP_DONE: "ĐÃ CẬP NHẬT ĐẦY ĐỦ DỮ LIỆU THAM KHẢO",
    SOURCE_ANALYSIS_DONE: "PHÂN TÍCH NGUỒN XONG THỰC HIỆN CHUYỂN ĐỔI BATCH",
    ADAPT_BATCH_NEXT: "XONG LÀM BATCH TIẾP THEO",
    ADAPT_BATCH_ALL: "XONG THỰC HIỆN HỢP NHẤT LIỀN MẠCH",
    CONTINUITY_MERGE_DONE: "HỢP NHẤT LIỀN MẠCH XONG THỰC HIỆN CÂN CHỈNH MỨC CÔ ĐỌNG",
    GLOBAL_BALANCE_DONE: "CÂN CHỈNH MỨC CÔ ĐỌNG TOÀN TÁC PHẨM XONG THỰC HIỆN QA CUỐI",
    FINAL_JP_QA_DONE: "QA 27 TIÊU CHÍ BẢN NHẬT XONG THỰC HIỆN BƯỚC TIẾP THEO",
    LAT_CONVERT_DONE: "CHUYỂN ĐỔI MỸ LATINH XONG THỰC HIỆN BƯỚC TIẾP THEO",
    LAT_QA_PASS: "BẢN CHUYỂN ĐỔI ĐẠT RỒI THỰC HIỆN BƯỚC TIẾP THEO",
    LAT_QA_FAIL: "BẢN CHUYỂN ĐỔI CHƯA ĐẠT CẦN SỬA LẠI",
    LINE_SPLIT_DONE: "CHIA DÒNG XONG THỰC HIỆN BƯỚC TIẾP THEO",
    JP_LINE_SPLIT_DONE: "ĐÃ CHIA XONG",
    CHUNK_PLAN_DONE: "PHÂN TÍCH CHUNK XONG THỰC HIỆN BƯỚC TIẾP THEO",
    CHUNK_1_DONE: "CHUNK 1 TRÍCH XONG THỰC HIỆN BƯỚC TIẾP THEO",
    CHUNK_2_DONE: "CHUNK 2 TRÍCH XONG THỰC HIỆN BƯỚC TIẾP THEO",
    CHUNK_3_DONE: "CHUNK 3 TRÍCH XONG THỰC HIỆN BƯỚC TIẾP THEO",
    CHUNK_4_DONE: "CHUNK 4 TRÍCH XONG THỰC HIỆN BƯỚC TIẾP THEO",
    MERGE_CORE_DONE: "MERGE COREFERENCE XONG THỰC HIỆN BƯỚC TIẾP THEO",
    THRESHOLD_DONE: "TÍNH NGƯỠNG CAC_CAU XONG THỰC HIỆN BƯỚC TIẾP THEO",
    VERIFY_ONCE_DONE: "VERIFY MỘT LƯỢT XONG THỰC HIỆN BƯỚC TIẾP THEO",
    B3_FINAL_DONE: "B3 FINAL XONG THỰC HIỆN BƯỚC TIẾP THEO",
    LAT_FIX_DONE: "SỬA BẢN MỸ LATINH XONG THỰC HIỆN BƯỚC TIẾP THEO",
    ATTACH_IDS_DONE: "GẮN ID XONG THỰC HIỆN BƯỚC TIẾP THEO",
    CHAR_PROMPT_DONE: "TẠO PROMPT CHAR XONG THỰC HIỆN BƯỚC TIẾP THEO",
    BG_PROMPT_DONE: "TẠO PROMPT BG XONG THỰC HIỆN BƯỚC TIẾP THEO",
    SUPPORT_DONE: "TÀI LIỆU HỖ TRỢ XONG THỰC HIỆN BƯỚC TIẾP THEO",
    EMERGED_DONE: "KIỂM TRA PHÁT SINH CHAR BG XONG THỰC HIỆN BƯỚC TIẾP THEO",
    EXPORT_FINAL_DONE: "XUẤT BỘ FILE FINAL XONG THỰC HIỆN BƯỚC TIẾP THEO",
    PROMPT_CONTINUE: "TẠO PROMPT ẢNH THEO DÒNG XONG THỰC HIỆN BƯỚC TIẾP THEO",
    PROMPT_QA_FAIL: "QA PROMPT ẢNH CHƯA ĐẠT CẦN SỬA LẠI",
    PROMPT_ALL_DONE:
      "QUÁ TRÌNH TẠO PROMPT ẢNH THEO DÒNG ĐÃ HOÀN TẤT THÌ MỚI THỰC HIỆN BƯỚC TIẾP THEO",
    PROMPT_CONTINUE_VIDEO: "TẠO PROMPT VIDEO THEO DÒNG XONG THỰC HIỆN BƯỚC TIẾP THEO",
    PROMPT_QA_FAIL_VIDEO: "QA PROMPT VIDEO CHƯA ĐẠT CẦN SỬA LẠI",
    PROMPT_ALL_DONE_VIDEO:
      "QUÁ TRÌNH TẠO PROMPT VIDEO THEO DÒNG ĐÃ HOÀN TẤT THÌ MỚI THỰC HIỆN BƯỚC TIẾP THEO",
  };

  const PROGRESS_PREFIX = "TIẾN ĐỘ PROMPT ẢNH:";
  const PROGRESS_PREFIX_VIDEO = "TIẾN ĐỘ PROMPT VIDEO:";
  const SPLIT_COUNT_PREFIX = "TỔNG SỐ DÒNG ĐÃ CHIA:";
  const SPLIT_REPORT_PATTERN = /TÁC PHẨM CHIA(?: DÒNG)? XONG CÓ\s+(\d+)\s+DÒNG/i;

  const FOOTER_ONLY = (phrase) =>
    [
      "",
      "CUỐI CÂU TRẢ LỜI BẮT BUỘC IN ĐÚNG MỘT DÒNG SAU, TRONG NGOẶC KÉP, KHÔNG THÊM CHỮ KHÁC Ở DÒNG ĐÓ, KHÔNG DÙNG CỤM NHẬN BIẾT CỦA BƯỚC KHÁC:",
      `"${phrase}"`,
    ].join("\n");

  const FOOTER_CHOICE = (phrases) =>
    [
      "",
      "CUỐI CÂU TRẢ LỜI BẮT BUỘC IN ĐÚNG MỘT TRONG CÁC DÒNG SAU, TRONG NGOẶC KÉP, KHÔNG THÊM CHỮ KHÁC Ở DÒNG ĐÓ, KHÔNG DÙNG CỤM NHẬN BIẾT CỦA BƯỚC KHÁC:",
      ...phrases.map((p) => `"${p}"`),
    ].join("\n");

  /** Appended after [...] only when the original block cannot uniquely signal the next action. */
  const FOOTERS = {
    refPrep: FOOTER_ONLY(SIGNAL.REF_PREP_DONE),
    sourceAnalysis: [
      "",
      "TRƯỚC DÒNG CHỐT, BẮT BUỘC IN ĐÚNG MỘT DÒNG SAU, KHÔNG THÊM CHỮ KHÁC Ở DÒNG ĐÓ (thay N bằng số batch vừa quyết định, một số nguyên, không cố định trước):",
      "TỔNG SỐ BATCH ADAPTATION: N",
      "VÍ DỤ: TỔNG SỐ BATCH ADAPTATION: 8",
      FOOTER_ONLY(SIGNAL.SOURCE_ANALYSIS_DONE).trim(),
    ].join("\n"),
    continuityMerge: FOOTER_ONLY(SIGNAL.CONTINUITY_MERGE_DONE),
    globalBalance: FOOTER_ONLY(SIGNAL.GLOBAL_BALANCE_DONE),
    finalJpQa: FOOTER_ONLY(SIGNAL.FINAL_JP_QA_DONE),
    latConvert: FOOTER_ONLY(SIGNAL.LAT_CONVERT_DONE),
    latQa: "",
    latFix: FOOTER_ONLY(SIGNAL.LAT_FIX_DONE),
    lineSplit: [
      "",
      "SAU KHI TẠO XONG BẢN CHIA DÒNG, BẮT BUỘC BÁO CÁO SỐ DÒNG BẰNG ĐÚNG MỘT DÒNG SAU, KHÔNG THÊM CHỮ KHÁC Ở DÒNG ĐÓ (thay N bằng số nguyên đếm đúng từng dòng đã chia, không đếm dòng hướng dẫn):",
      "TÁC PHẨM CHIA DÒNG XONG CÓ N DÒNG",
      "VÍ DỤ: TÁC PHẨM CHIA DÒNG XONG CÓ 356 DÒNG",
      `CÓ THỂ IN THÊM: ${SPLIT_COUNT_PREFIX} N`,
      FOOTER_ONLY(SIGNAL.LINE_SPLIT_DONE).trim(),
    ].join("\n"),
    jpLineSplit: [
      "",
      "SAU KHI TẠO XONG BẢN CHIA DÒNG, BẮT BUỘC BÁO CÁO SỐ DÒNG BẰNG ĐÚNG MỘT DÒNG SAU, KHÔNG THÊM CHỮ KHÁC Ở DÒNG ĐÓ (thay N bằng số nguyên đếm đúng từng dòng đã chia, không đếm dòng hướng dẫn):",
      "TÁC PHẨM CHIA DÒNG XONG CÓ N DÒNG",
      "VÍ DỤ: TÁC PHẨM CHIA DÒNG XONG CÓ 356 DÒNG",
      `CÓ THỂ IN THÊM: ${SPLIT_COUNT_PREFIX} N`,
      FOOTER_ONLY(SIGNAL.JP_LINE_SPLIT_DONE).trim(),
    ].join("\n"),
    chunkPlan: FOOTER_ONLY(SIGNAL.CHUNK_PLAN_DONE),
    chunk1: FOOTER_ONLY(SIGNAL.CHUNK_1_DONE),
    chunk2: FOOTER_ONLY(SIGNAL.CHUNK_2_DONE),
    chunk3: FOOTER_ONLY(SIGNAL.CHUNK_3_DONE),
    chunk4: FOOTER_ONLY(SIGNAL.CHUNK_4_DONE),
    mergeCoref: FOOTER_ONLY(SIGNAL.MERGE_CORE_DONE),
    threshold: FOOTER_ONLY(SIGNAL.THRESHOLD_DONE),
    verifyOnce: FOOTER_ONLY(SIGNAL.VERIFY_ONCE_DONE),
    b3Final: FOOTER_ONLY(SIGNAL.B3_FINAL_DONE),
    attachIds: FOOTER_ONLY(SIGNAL.ATTACH_IDS_DONE),
    charPrompt: FOOTER_ONLY(SIGNAL.CHAR_PROMPT_DONE),
    bgPrompt: FOOTER_ONLY(SIGNAL.BG_PROMPT_DONE),
    supportFile: FOOTER_ONLY(SIGNAL.SUPPORT_DONE),
    askEmerged: FOOTER_ONLY(SIGNAL.EMERGED_DONE),
    exportFinal: FOOTER_ONLY(SIGNAL.EXPORT_FINAL_DONE),
    promptBatch: FOOTER_CHOICE([
      SIGNAL.PROMPT_CONTINUE,
      SIGNAL.PROMPT_QA_FAIL,
      SIGNAL.PROMPT_ALL_DONE,
    ]),
  };

  function adaptBatchCursor(ctx) {
    const total = Number(ctx?.adaptBatchTotal) || 0;
    const done = Number(ctx?.adaptBatchDone) || 0;
    const index = done + 1;
    const last = total > 0 && index >= total;
    return { index, total, done, last };
  }

  function adaptBatchClosing(ctx) {
    const { index, total, last } = adaptBatchCursor(ctx);
    const shown = total > 0 ? String(total) : "?";
    if (last) return `BATCH ADAPTATION ${index}/${shown} XONG THỰC HIỆN HỢP NHẤT LIỀN MẠCH`;
    return `BATCH ADAPTATION ${index}/${shown} XONG LÀM BATCH TIẾP THEO`;
  }

  function adaptBatchFooter(ctx) {
    const { index, total, last } = adaptBatchCursor(ctx);
    const which = total
      ? `LẦN NÀY LÀ BATCH ${index}/${total}. ${last ? "ĐÂY LÀ BATCH CUỐI." : "CHƯA PHẢI BATCH CUỐI, CẤM IN CÂU HỢP NHẤT."}`
      : "CHƯA CÓ SỐ BATCH. PHẢI CHẠY BƯỚC PHÂN TÍCH NGUỒN TRƯỚC.";
    return ["", which, "CẤM DÙNG CÂU CHỐT CỦA BATCH KHÁC HOẶC CỦA BƯỚC KHÁC.", FOOTER_ONLY(adaptBatchClosing(ctx)).trim()].join(
      "\n"
    );
  }

  function parseAdaptBatchTotal(text) {
    const all = [...String(text || "").matchAll(/TỔNG SỐ BATCH ADAPTATION:\s*(\d+)/gi)];
    if (!all.length) return 0;
    const n = Number(all[all.length - 1][1]);
    return n > 0 ? n : 0;
  }

  function parseAdaptBatchMark(text) {
    const raw = String(text || "");
    const strict = [...raw.matchAll(/BATCH ADAPTATION\s+(\d+)\s*\/\s*(\d+)\s+XONG/gi)];
    const loose = [...raw.matchAll(/BATCH ADAPTATION\s+(\d+)\s*\/\s*(\d+)/gi)];
    const all = strict.length ? strict : loose;
    if (!all.length) return null;
    const m = all[all.length - 1];
    const index = Number(m[1]);
    const total = Number(m[2]);
    if (!(index > 0) || !(total > 0) || index > total) return null;
    return { index, total };
  }

  function parseAdaptBatchProgress(text) {
    const mark = parseAdaptBatchMark(text);
    const listed = parseAdaptBatchTotal(text);
    const total = (mark && mark.total) || listed || 0;
    const done = mark ? mark.index : 0;
    return {
      total,
      done,
      complete: !!(mark && total && mark.index >= total),
      mark,
    };
  }

  function matchStepSignal(step, text, ctx) {
    const allowed = step?.allowed || [];
    if (step?.id === "batchAdapt") {
      const signal = findSignal(text, allowed);
      const mark = parseAdaptBatchMark(text);
      if (!signal || !mark) return null;
      const expect = adaptBatchCursor(ctx);
      if (expect.total > 0) {
        if (mark.total !== expect.total) return null;
        if (mark.index === expect.done) return null;
        if (mark.index !== expect.index) return null;
        if (expect.last && signal.id !== "ADAPT_BATCH_ALL") return null;
        if (!expect.last && signal.id !== "ADAPT_BATCH_NEXT") return null;
      } else if (mark.index < mark.total && signal.id !== "ADAPT_BATCH_NEXT") {
        return null;
      } else if (mark.index === mark.total && signal.id !== "ADAPT_BATCH_ALL") {
        return null;
      }
      return signal;
    }
    return findSignal(text, allowed);
  }

  function promptPhrases(doVideo) {
    if (doVideo) {
      return {
        continue: SIGNAL.PROMPT_CONTINUE_VIDEO,
        fail: SIGNAL.PROMPT_QA_FAIL_VIDEO,
        done: SIGNAL.PROMPT_ALL_DONE_VIDEO,
        progress: PROGRESS_PREFIX_VIDEO,
      };
    }
    return {
      continue: SIGNAL.PROMPT_CONTINUE,
      fail: SIGNAL.PROMPT_QA_FAIL,
      done: SIGNAL.PROMPT_ALL_DONE,
      progress: PROGRESS_PREFIX,
    };
  }

  function promptBatchFooter(ctx) {
    const phrases = promptPhrases(!!ctx?.doVideo);
    const total = Number(ctx?.totalLines) || 0;
    const done = Number(ctx?.promptLinesDone) || 0;
    const remain = Math.max(0, total - done);
    const from = done + 1;
    const to = Math.min(done + 20, total);
    const count = remain > 0 ? Math.max(0, to - from + 1) : 0;
    const batchNo = count ? Math.floor(done / 20) + 1 : Math.ceil(total / 20);
    const batchTotal = Math.max(1, Math.ceil(total / 20));
    const rangeLine =
      remain > 0
        ? `LẦN NÀY CHỈ PHÂN TÍCH VÀ TẠO PROMPT CHO DÒNG ${from} ĐẾN DÒNG ${to} (ĐÚNG ${count} CÂU, LƯỢT ${batchNo}/${batchTotal}). CẤM LÀM DÒNG TRƯỚC ${from} HOẶC SAU ${to}.`
        : `ĐÃ ĐỦ ${total} DÒNG. LẦN NÀY CHỈ QA THEO B6, KHÔNG TẠO THÊM DÒNG MỚI.`;
    return [
      FOOTER_CHOICE([phrases.continue, phrases.fail, phrases.done]),
      "",
      `TOOL ĐÃ GHI NHỚ TỪ BƯỚC CHIA DÒNG: TÁC PHẨM CÓ ${total} DÒNG.`,
      rangeLine,
      `TOOL ĐÃ GHI NHẬN: ${done}/${total}. CÒN LẠI: ${remain}.`,
      `TRƯỚC DÒNG CHỐT, BẮT BUỘC IN ĐÚNG MỘT DÒNG: ${phrases.progress} {số_dòng_đã_có_prompt}/${total}.`,
      "ĐÚNG QUY TẮC NGUỒN: MỖI LẦN CHAT CHỈ TẠO TỐI ĐA 20 PROMPT. LƯỢT CUỐI LẤY PHẦN CÒN LẠI. QA CHƯA ĐẠT THÌ KHÔNG TĂNG SỐ DÒNG ĐÃ XONG.",
      `CHỈ ĐƯỢC IN "${phrases.done}" KHI SỐ DÒNG ĐÃ CÓ PROMPT >= ${total} VÀ QA CUỐI ĐÃ XONG.`,
      remain > 0
        ? `CÒN THIẾU ${remain} DÒNG THÌ CẤM IN CÂU HOÀN TẤT. SAU LƯỢT NÀY IN "${phrases.continue}" HOẶC "${phrases.fail}".`
        : `ĐỦ ${total} DÒNG RỒI: NẾU QA CUỐI CHƯA XONG THÌ IN "${phrases.continue}" HOẶC "${phrases.fail}"; CHỈ IN CÂU HOÀN TẤT KHI QA CUỐI ĐÃ XONG.`,
    ].join("\n");
  }

  function parsePromptProgress(text) {
    const m = String(text || "").match(/TIẾN ĐỘ PROMPT (?:ẢNH|VIDEO):\s*(\d+)\s*\/\s*(\d+)/i);
    if (!m) return null;
    return { done: Number(m[1]), total: Number(m[2]) };
  }

  function parseSplitLineCount(text) {
    const raw = String(text || "");
    const reported = raw.match(SPLIT_REPORT_PATTERN);
    if (reported) {
      const n = Number(reported[1]);
      return n > 0 ? n : 0;
    }
    const tagged = raw.match(/TỔNG SỐ DÒNG ĐÃ CHIA:\s*(\d+)/i);
    if (tagged) {
      const n = Number(tagged[1]);
      return n > 0 ? n : 0;
    }
    return countSplitContentLines(raw);
  }

  function countSplitContentLines(text) {
    const skipSubs = [
      SIGNAL.LINE_SPLIT_DONE,
      SIGNAL.JP_LINE_SPLIT_DONE,
      SPLIT_COUNT_PREFIX,
      "TÁC PHẨM CHIA DÒNG XONG CÓ",
      "TÁC PHẨM CHIA XONG CÓ",
      "CUỐI CÂU TRẢ LỜI",
      "THỰC HIỆN BƯỚC TIẾP THEO",
    ];
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !skipSubs.some((s) => l.includes(s)));
    const numbered = lines.filter(
      (l) => /^(\d+[\.\)\:\-|、]\s+|\(\d+\)\s+|\[\d+\]\s+|\d+\s+\S)/.test(l) && l.length > 3
    );
    if (numbered.length >= 3) return numbered.length;
    return lines.length;
  }

  const CATALOG = [
    { id: "REF_PREP_DONE", phrase: SIGNAL.REF_PREP_DONE, kind: "xong" },
    { id: "SOURCE_ANALYSIS_DONE", phrase: SIGNAL.SOURCE_ANALYSIS_DONE, kind: "xong" },
    { id: "ADAPT_BATCH_NEXT", phrase: SIGNAL.ADAPT_BATCH_NEXT, kind: "xong" },
    { id: "ADAPT_BATCH_ALL", phrase: SIGNAL.ADAPT_BATCH_ALL, kind: "xong" },
    { id: "CONTINUITY_MERGE_DONE", phrase: SIGNAL.CONTINUITY_MERGE_DONE, kind: "xong" },
    { id: "GLOBAL_BALANCE_DONE", phrase: SIGNAL.GLOBAL_BALANCE_DONE, kind: "xong" },
    { id: "FINAL_JP_QA_DONE", phrase: SIGNAL.FINAL_JP_QA_DONE, kind: "xong" },
    { id: "LAT_CONVERT_DONE", phrase: SIGNAL.LAT_CONVERT_DONE, kind: "xong" },
    { id: "LAT_QA_PASS", phrase: SIGNAL.LAT_QA_PASS, kind: "dat" },
    { id: "LAT_QA_FAIL", phrase: SIGNAL.LAT_QA_FAIL, kind: "chua" },
    { id: "LINE_SPLIT_DONE", phrase: SIGNAL.LINE_SPLIT_DONE, kind: "xong" },
    { id: "JP_LINE_SPLIT_DONE", phrase: SIGNAL.JP_LINE_SPLIT_DONE, kind: "xong" },
    { id: "CHUNK_PLAN_DONE", phrase: SIGNAL.CHUNK_PLAN_DONE, kind: "xong" },
    { id: "CHUNK_1_DONE", phrase: SIGNAL.CHUNK_1_DONE, kind: "xong" },
    { id: "CHUNK_2_DONE", phrase: SIGNAL.CHUNK_2_DONE, kind: "xong" },
    { id: "CHUNK_3_DONE", phrase: SIGNAL.CHUNK_3_DONE, kind: "xong" },
    { id: "CHUNK_4_DONE", phrase: SIGNAL.CHUNK_4_DONE, kind: "xong" },
    { id: "MERGE_CORE_DONE", phrase: SIGNAL.MERGE_CORE_DONE, kind: "xong" },
    { id: "THRESHOLD_DONE", phrase: SIGNAL.THRESHOLD_DONE, kind: "xong" },
    { id: "VERIFY_ONCE_DONE", phrase: SIGNAL.VERIFY_ONCE_DONE, kind: "xong" },
    { id: "B3_FINAL_DONE", phrase: SIGNAL.B3_FINAL_DONE, kind: "xong" },
    { id: "LAT_FIX_DONE", phrase: SIGNAL.LAT_FIX_DONE, kind: "xong" },
    { id: "ATTACH_IDS_DONE", phrase: SIGNAL.ATTACH_IDS_DONE, kind: "xong" },
    { id: "CHAR_PROMPT_DONE", phrase: SIGNAL.CHAR_PROMPT_DONE, kind: "xong" },
    { id: "BG_PROMPT_DONE", phrase: SIGNAL.BG_PROMPT_DONE, kind: "xong" },
    { id: "SUPPORT_DONE", phrase: SIGNAL.SUPPORT_DONE, kind: "xong" },
    { id: "EMERGED_DONE", phrase: SIGNAL.EMERGED_DONE, kind: "xong" },
    { id: "EXPORT_FINAL_DONE", phrase: SIGNAL.EXPORT_FINAL_DONE, kind: "xong" },
    {
      id: "PROMPT_CONTINUE",
      phrase: SIGNAL.PROMPT_CONTINUE,
      altPhrases: [SIGNAL.PROMPT_CONTINUE_VIDEO],
      kind: "xong",
    },
    {
      id: "PROMPT_QA_FAIL",
      phrase: SIGNAL.PROMPT_QA_FAIL,
      altPhrases: [SIGNAL.PROMPT_QA_FAIL_VIDEO],
      kind: "chua",
    },
    {
      id: "PROMPT_ALL_DONE",
      phrase: SIGNAL.PROMPT_ALL_DONE,
      altPhrases: [SIGNAL.PROMPT_ALL_DONE_VIDEO],
      kind: "done",
    },
  ].sort((a, b) => b.phrase.length - a.phrase.length);

  function lastLines(text, n = 10) {
    return String(text || "")
      .replace(/\u201c|\u201d|\u00ab|\u00bb/g, '"')
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-n)
      .join("\n");
  }

  function folded(s) {
    return String(s || "")
      .normalize("NFC")
      .replace(/[\u200b\u200c\u200d\ufeff\u00ad]/g, "")
      .replace(/[\u201c\u201d\u00ab\u00bb]/g, '"')
      .replace(/\s+/g, " ")
      .trim();
  }

  function signalPhrases(s) {
    return [s?.phrase, ...(s?.altPhrases || [])].filter(Boolean);
  }

  function findSignal(text, allowedIds) {
    const allow = new Set(allowedIds);
    const pool = CATALOG.filter((s) => allow.has(s.id));
    const tail = lastLines(text, 40);
    const hayTail = folded(tail);
    for (const s of pool) {
      for (const phrase of signalPhrases(s)) {
        if (tail.includes(phrase) || hayTail.includes(folded(phrase))) return { ...s, phrase };
      }
    }
    const full = String(text || "");
    const hayFull = folded(full);
    for (const s of pool) {
      for (const phrase of signalPhrases(s)) {
        if (full.includes(phrase) || hayFull.includes(folded(phrase))) return { ...s, phrase };
      }
    }
    return null;
  }

  root.LN_SIGNALS = {
    SIGNAL,
    FOOTERS,
    CATALOG,
    PROGRESS_PREFIX,
    PROGRESS_PREFIX_VIDEO,
    SPLIT_COUNT_PREFIX,
    promptPhrases,
    signalPhrases,
    findSignal,
    matchStepSignal,
    folded,
    lastLines,
    adaptBatchCursor,
    adaptBatchClosing,
    adaptBatchFooter,
    parseAdaptBatchTotal,
    parseAdaptBatchMark,
    parseAdaptBatchProgress,
    promptBatchFooter,
    parsePromptProgress,
    parseSplitLineCount,
    countSplitContentLines,
  };
})(globalThis);
