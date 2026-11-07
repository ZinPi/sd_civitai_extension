(function (root) {
  const {
    SIGNAL,
    FOOTERS,
    promptBatchFooter,
    adaptBatchFooter,
    parsePromptProgress,
    parseSplitLineCount,
  } = root.LN_SIGNALS;
  const P = root.LN_PROMPTS;
  const BATCH_SIZE = 20;

  function normalizeFileName(raw) {
    const trimmed = String(raw || "").trim().replace(/[\\/:*?"<>|]+/g, "");
    if (!trimmed) return "";
    return trimmed.toLowerCase().endsWith(".txt") ? trimmed : `${trimmed}.txt`;
  }

  function withFooter(body, footer) {
    return footer ? `${body}${footer}` : body;
  }

  function normalizePercent(raw) {
    const n = Number.parseInt(String(raw ?? "").replace(/[^\d]/g, ""), 10);
    if (!Number.isFinite(n) || n < 1) return 40;
    return Math.min(100, n);
  }

  const DEFAULT_WAIT_MINUTES = 60;

  function normalizeWaitMinutes(raw) {
    const n = Number.parseInt(String(raw ?? "").replace(/[^\d]/g, ""), 10);
    if (!Number.isFinite(n) || n < 5) return DEFAULT_WAIT_MINUTES;
    return Math.min(180, n);
  }

  function hasRefDoc(state) {
    return !!(String(state?.refFileName || "").trim() || String(state?.refFileText || "").trim());
  }

  const MAX_ADAPT_BATCHES = 40;

  function startStepId(state) {
    return hasRefDoc(state) ? "refPrep" : "sourceAnalysis";
  }

  const KEEP_LINE_COUNT = new Set([
    "chunkPlan",
    "chunk1",
    "chunk2",
    "chunk3",
    "chunk4",
    "mergeCoref",
    "threshold",
    "verifyOnce",
    "b3Final",
    "attachIds",
    "supportFile",
    "promptBatch",
  ]);

  function keepsRememberedLines(stepId) {
    return KEEP_LINE_COUNT.has(stepId);
  }

  function entryStepId(state) {
    const steps = visibleSteps(state).filter((s) => s.id !== "done");
    const chosen = String(state?.startStep || "").trim();
    if (chosen && steps.some((s) => s.id === chosen)) return chosen;
    return startStepId(state);
  }

  const STEPS = [
    {
      id: "refPrep",
      group: "0. Phần liền trước",
      title: "Nạp tài liệu tham khảo",
      kind: "xong",
      allowed: ["REF_PREP_DONE"],
      transitions: { REF_PREP_DONE: "sourceAnalysis" },
      gate: "ref",
      build: (ctx) => {
        const rawName = String(ctx?.refFileName || "").trim();
        const name = rawName ? normalizeFileName(rawName) : "";
        const body = String(ctx?.refFileText || "").trim();
        const parts = [];
        if (name) {
          parts.push(`FILE TÀI LIỆU: "${name}"`);
          parts.push(`MỞ VÀ ĐỌC FILE "${name}" TRONG NGUỒN DỰ ÁN / CUỘC CHAT NÀY.`);
        }
        if (body) {
          parts.push(`===== NỘI DUNG FILE TÀI LIỆU THAM KHẢO${name ? ` (${name})` : ""} =====`);
          parts.push(body);
          parts.push("===== HẾT FILE =====");
        }
        parts.push(P.refPrep);
        return withFooter(parts.join("\n\n"), FOOTERS.refPrep);
      },
    },
    {
      id: "sourceAnalysis",
      group: "1. Bản Nhật",
      title: "Phân tích toàn bộ nguồn",
      kind: "xong",
      allowed: ["SOURCE_ANALYSIS_DONE"],
      transitions: { SOURCE_ANALYSIS_DONE: "batchAdapt" },
      build: () => withFooter(P.sourceAnalysis, FOOTERS.sourceAnalysis),
    },
    {
      id: "batchAdapt",
      group: "1. Bản Nhật",
      title: "Chuyển đổi từng batch",
      kind: "xong",
      allowed: ["ADAPT_BATCH_NEXT", "ADAPT_BATCH_ALL"],
      transitions: { ADAPT_BATCH_NEXT: "batchAdapt", ADAPT_BATCH_ALL: "continuityMerge" },
      build: (ctx) =>
        withFooter(
          P.batchAdapt({ ...ctx, condensePercent: normalizePercent(ctx?.condensePercent) }),
          adaptBatchFooter(ctx)
        ),
    },
    {
      id: "continuityMerge",
      group: "1. Bản Nhật",
      title: "Hợp nhất liền mạch",
      kind: "xong",
      allowed: ["CONTINUITY_MERGE_DONE"],
      transitions: { CONTINUITY_MERGE_DONE: "globalBalance" },
      build: () => withFooter(P.continuityMerge, FOOTERS.continuityMerge),
    },
    {
      id: "globalBalance",
      group: "1. Bản Nhật",
      title: "Cân chỉnh mức cô đọng",
      kind: "xong",
      allowed: ["GLOBAL_BALANCE_DONE"],
      transitions: { GLOBAL_BALANCE_DONE: "finalJpQa" },
      build: (ctx) =>
        withFooter(P.globalBalance(normalizePercent(ctx?.condensePercent)), FOOTERS.globalBalance),
    },
    {
      id: "finalJpQa",
      group: "1. Bản Nhật",
      title: "QA 27 tiêu chí bản Nhật",
      kind: "xong",
      allowed: ["FINAL_JP_QA_DONE"],
      transitions: { FINAL_JP_QA_DONE: "jpLineSplit" },
      build: () => withFooter(P.finalJpQa, FOOTERS.finalJpQa),
    },
    {
      id: "latConvert",
      group: "2. Mỹ Latinh",
      title: "Chuyển bản Nhật → Mỹ Latinh",
      kind: "xong",
      gate: "latin",
      allowed: ["LAT_CONVERT_DONE"],
      transitions: { LAT_CONVERT_DONE: "latQa" },
      build: () => withFooter(P.latConvert, FOOTERS.latConvert),
    },
    {
      id: "latQa",
      group: "2. Mỹ Latinh",
      title: "QA bản Mỹ Latinh",
      kind: "qa",
      gate: "latin",
      allowed: ["LAT_QA_PASS", "LAT_QA_FAIL"],
      transitions: { LAT_QA_PASS: "lineSplit", LAT_QA_FAIL: "latFix" },
      build: () => P.latQa,
    },
    {
      id: "latFix",
      group: "2. Mỹ Latinh",
      title: "Sửa bản Mỹ Latinh theo QA",
      kind: "fix",
      gate: "latin",
      allowed: ["LAT_FIX_DONE"],
      afterIdle: "latQa",
      transitions: { LAT_FIX_DONE: "latQa" },
      build: () => withFooter(P.latFix, FOOTERS.latFix),
    },
    {
      id: "lineSplit",
      group: "2. Mỹ Latinh",
      title: "Chia dòng Mỹ Latinh theo âm tiết",
      kind: "xong",
      gate: "latin",
      allowed: ["LINE_SPLIT_DONE"],
      transitions: { LINE_SPLIT_DONE: "chunkPlan" },
      build: () => withFooter(P.lineSplit, FOOTERS.lineSplit),
      rememberLines: true,
    },
    {
      id: "jpLineSplit",
      group: "1. Bản Nhật",
      title: "Chia dòng bản Nhật đã cô đọng",
      kind: "xong",
      gate: "jpSplit",
      allowed: ["JP_LINE_SPLIT_DONE"],
      transitions: { JP_LINE_SPLIT_DONE: "chunkPlan" },
      build: () => withFooter(P.jpLineSplit, FOOTERS.jpLineSplit),
      rememberLines: true,
    },
    {
      id: "chunkPlan",
      group: "3. Ảnh tham chiếu",
      title: "Chia tác phẩm thành 4 chunk",
      kind: "xong",
      allowed: ["CHUNK_PLAN_DONE"],
      transitions: { CHUNK_PLAN_DONE: "chunk1" },
      build: () => withFooter(P.chunkPlan, FOOTERS.chunkPlan),
    },
    {
      id: "chunk1",
      group: "3. Ảnh tham chiếu",
      title: "Trích xuất chunk 1",
      kind: "xong",
      allowed: ["CHUNK_1_DONE"],
      transitions: { CHUNK_1_DONE: "chunk2" },
      build: (ctx) => withFooter(P.chunkExtract(1, ctx), FOOTERS.chunk1),
    },
    {
      id: "chunk2",
      group: "3. Ảnh tham chiếu",
      title: "Trích xuất chunk 2",
      kind: "xong",
      allowed: ["CHUNK_2_DONE"],
      transitions: { CHUNK_2_DONE: "chunk3" },
      build: (ctx) => withFooter(P.chunkExtract(2, ctx), FOOTERS.chunk2),
    },
    {
      id: "chunk3",
      group: "3. Ảnh tham chiếu",
      title: "Trích xuất chunk 3",
      kind: "xong",
      allowed: ["CHUNK_3_DONE"],
      transitions: { CHUNK_3_DONE: "chunk4" },
      build: (ctx) => withFooter(P.chunkExtract(3, ctx), FOOTERS.chunk3),
    },
    {
      id: "chunk4",
      group: "3. Ảnh tham chiếu",
      title: "Trích xuất chunk 4",
      kind: "xong",
      allowed: ["CHUNK_4_DONE"],
      transitions: { CHUNK_4_DONE: "mergeCoref" },
      build: (ctx) => withFooter(P.chunkExtract(4, ctx), FOOTERS.chunk4),
    },
    {
      id: "mergeCoref",
      group: "3. Ảnh tham chiếu",
      title: "Gộp và coreference",
      kind: "xong",
      allowed: ["MERGE_CORE_DONE"],
      transitions: { MERGE_CORE_DONE: "threshold" },
      build: () => withFooter(P.mergeCoref, FOOTERS.mergeCoref),
    },
    {
      id: "threshold",
      group: "3. Ảnh tham chiếu",
      title: "Tính CAC_CAU / SO_CAU / ngưỡng",
      kind: "xong",
      allowed: ["THRESHOLD_DONE"],
      transitions: { THRESHOLD_DONE: "verifyOnce" },
      build: () => withFooter(P.threshold, FOOTERS.threshold),
    },
    {
      id: "verifyOnce",
      group: "3. Ảnh tham chiếu",
      title: "Verify đúng 1 lượt",
      kind: "xong",
      allowed: ["VERIFY_ONCE_DONE"],
      transitions: { VERIFY_ONCE_DONE: "b3Final" },
      build: () => withFooter(P.verifyOnce, FOOTERS.verifyOnce),
    },
    {
      id: "b3Final",
      group: "3. Ảnh tham chiếu",
      title: "Xuất B3 final",
      kind: "xong",
      allowed: ["B3_FINAL_DONE"],
      transitions: { B3_FINAL_DONE: "attachIds" },
      build: () => withFooter(P.b3Final, FOOTERS.b3Final),
    },
    {
      id: "attachIds",
      group: "3. Ảnh tham chiếu",
      title: "Gắn CHAR_XX / BG_XX",
      kind: "xong",
      allowed: ["ATTACH_IDS_DONE"],
      transitions: { ATTACH_IDS_DONE: "charPrompt" },
      build: () => withFooter(P.attachIds, FOOTERS.attachIds),
    },
    {
      id: "charPrompt",
      group: "4. Prompt CHAR / BG",
      title: "Tạo prompt mọi CHAR",
      kind: "xong",
      allowed: ["CHAR_PROMPT_DONE"],
      transitions: { CHAR_PROMPT_DONE: "bgPrompt" },
      build: () => withFooter(P.charPrompt, FOOTERS.charPrompt),
    },
    {
      id: "bgPrompt",
      group: "4. Prompt CHAR / BG",
      title: "Tạo prompt mọi BG",
      kind: "xong",
      allowed: ["BG_PROMPT_DONE"],
      transitions: { BG_PROMPT_DONE: "supportFile" },
      build: () => withFooter(P.bgPrompt, FOOTERS.bgPrompt),
    },
    {
      id: "supportFile",
      group: "5. File hỗ trợ",
      title: "Tổng hợp XXXX.txt",
      kind: "xong",
      needsFile: true,
      allowed: ["SUPPORT_DONE"],
      transitions: { SUPPORT_DONE: "promptBatch" },
      build: (ctx) => withFooter(P.supportFile(ctx.fileName, ctx.doVideo), FOOTERS.supportFile),
    },
    {
      id: "promptBatch",
      group: "6. Prompt ảnh",
      title: "Tạo / QA prompt từng dòng",
      kind: "loop",
      needsFile: true,
      allowed: ["PROMPT_CONTINUE", "PROMPT_QA_FAIL", "PROMPT_ALL_DONE"],
      transitions: {
        PROMPT_CONTINUE: "promptBatch",
        PROMPT_QA_FAIL: "promptBatch",
        PROMPT_ALL_DONE: "askEmerged",
      },
      build: (ctx) => withFooter(P.promptBatch(ctx.fileName, ctx.doVideo), promptBatchFooter(ctx)),
    },
    {
      id: "askEmerged",
      group: "7. Sau prompt",
      title: "Hỏi CHAR / BG phát sinh",
      kind: "xong",
      allowed: ["EMERGED_DONE"],
      transitions: { EMERGED_DONE: "exportFinal" },
      build: (ctx) => withFooter(P.askEmerged(ctx.doVideo), FOOTERS.askEmerged),
    },
    {
      id: "exportFinal",
      group: "7. Sau prompt",
      title: "Xuất danh sách và file final",
      kind: "xong",
      allowed: ["EXPORT_FINAL_DONE"],
      transitions: { EXPORT_FINAL_DONE: "done" },
      build: (ctx) => withFooter(P.exportFinal(ctx.doVideo), FOOTERS.exportFinal),
    },
    {
      id: "done",
      group: "Xong",
      title: "Pipeline hoàn tất",
      kind: "done",
      allowed: [],
      build: () => "",
    },
  ];

  const STEP_MAP = Object.fromEntries(STEPS.map((s) => [s.id, s]));

  function createState() {
    return {
      running: false,
      paused: false,
      stepId: "sourceAnalysis",
      adaptBatchTotal: 0,
      adaptBatchDone: 0,
      fileName: "",
      condensePercent: 40,
      doLatin: false,
      doVideo: false,
      startStep: "",
      refFileName: "",
      refFileText: "",
      totalLines: 0,
      promptLinesDone: 0,
      promptRounds: 0,
      tabId: null,
      qaLoops: 0,
      maxQaLoops: 12,
      delayMs: 1500,
      waitMinutes: DEFAULT_WAIT_MINUTES,
      timeoutMs: DEFAULT_WAIT_MINUTES * 60 * 1000,
      lastSignal: "",
      lastError: "",
      engaged: false,
      log: [],
    };
  }

  function normalizeTotalLines(raw) {
    const n = Number.parseInt(String(raw || "").replace(/[^\d]/g, ""), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function remainingLines(state) {
    return Math.max(0, (state.totalLines || 0) - (state.promptLinesDone || 0));
  }

  function currentBatch(state) {
    const remain = remainingLines(state);
    if (!state.totalLines || remain <= 0) {
      return { from: 0, to: 0, count: 0, remain: 0 };
    }
    const from = (state.promptLinesDone || 0) + 1;
    const to = Math.min((state.promptLinesDone || 0) + BATCH_SIZE, state.totalLines);
    return { from, to, count: to - from + 1, remain };
  }

  function promptsComplete(state) {
    return state.totalLines > 0 && state.promptLinesDone >= state.totalLines;
  }

  function applyPromptProgress(state, signalId, reply) {
    const parsed = parsePromptProgress(reply);
    if (parsed) {
      const cap = state.totalLines || parsed.total || parsed.done;
      state.promptLinesDone = Math.max(0, Math.min(parsed.done, cap));
      return;
    }
    if (signalId === "PROMPT_CONTINUE") {
      const add = state.totalLines
        ? Math.min(BATCH_SIZE, remainingLines(state))
        : BATCH_SIZE;
      state.promptLinesDone += add;
    }
  }

  function maxPromptRounds(state) {
    if (!state.totalLines) return 40;
    return Math.ceil(state.totalLines / BATCH_SIZE) * 4 + 20;
  }

  function nextAfterSignal(step, signalId, opts = {}) {
    if (!step) return null;
    if (step.id === "finalJpQa" && signalId === "FINAL_JP_QA_DONE") {
      return opts.doLatin ? "latConvert" : "jpLineSplit";
    }
    if (!step.transitions) return null;
    return step.transitions[signalId] || null;
  }

  function shouldResume(state) {
    if (!state || state.running) return false;
    const stepId = String(state.stepId || "");
    if (!stepId || stepId === "done") return false;
    if (state.engaged || state.lastError || state.lastSignal) return true;
    if ((state.promptLinesDone || 0) > 0 || (state.promptRounds || 0) > 0) return true;
    if (state.stepId === "batchAdapt" && (state.adaptBatchTotal || 0) > 0) return true;
    if ((state.qaLoops || 0) > 0) return true;
    return false;
  }

  function visibleSteps(opts = {}) {
    const doLatin = !!opts.doLatin;
    const ref = hasRefDoc(opts);
    return STEPS.filter((s) => {
      if (s.id === "done") return true;
      if (s.gate === "ref") return ref;
      if (s.gate === "latin") return doLatin;
      if (s.gate === "jpSplit") return !doLatin;
      return true;
    });
  }

  root.LN_MACHINE = {
    SIGNAL,
    STEPS,
    STEP_MAP,
    BATCH_SIZE,
    normalizeFileName,
    normalizeTotalLines,
    normalizePercent,
    normalizeWaitMinutes,
    DEFAULT_WAIT_MINUTES,
    MAX_ADAPT_BATCHES,
    hasRefDoc,
    startStepId,
    entryStepId,
    shouldResume,
    keepsRememberedLines,
    visibleSteps,
    createState,
    remainingLines,
    currentBatch,
    parseSplitLineCount,
    promptsComplete,
    applyPromptProgress,
    maxPromptRounds,
    nextAfterSignal,
  };
})(globalThis);
