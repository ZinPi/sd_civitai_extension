/**
 * Pilot pipeline driver. Same mechanism as the text/image tabs:
 * the service worker owns the run, the ChatGPT content script waits,
 * the side panel is UI only. Closing the panel does not stop the pipeline.
 */
(() => {
  const M = self.LN_MACHINE;
  const S = self.LN_SIGNALS;
  const R = self.LN_RUNNER;
  const STORAGE_KEY = "pipelineState";
  const MAX_SAFETY_RETRIES = 5;
  const PILOT_TYPES = new Set([
    "GET_PILOT_STATE",
    "START_PILOT",
    "STOP_PILOT",
    "PAUSE_PILOT",
    "RESUME_PILOT",
    "RESEND_PILOT",
    "READ_PILOT_LAST",
    "FORCE_PILOT_NEXT",
    "FORCE_PILOT_FAIL",
    "UPDATE_PILOT_CONFIG",
    "SET_PILOT_TAB",
    "CLEAR_PILOT_LOG",
  ]);

  let pstate = M.createState();
  pstate.pendingTurn = null;
  pstate.lastVerification = "";
  pstate.safetyRetries = 0;
  pstate.phase = "";
  let loaded = false;
  let persistTimer = null;
  const ready = (async () => {
    try {
      const got = await chrome.storage.local.get(STORAGE_KEY);
      if (got[STORAGE_KEY] && typeof got[STORAGE_KEY] === "object") {
        pstate = { ...M.createState(), ...got[STORAGE_KEY] };
      }
    } catch (_) {
      /* keep defaults */
    }
    pstate.adaptBatchTotal = Number(pstate.adaptBatchTotal) || 0;
    pstate.adaptBatchDone = Number(pstate.adaptBatchDone) || 0;
    pstate.condensePercent = M.normalizePercent(pstate.condensePercent);
    pstate.waitMinutes = M.normalizeWaitMinutes(pstate.waitMinutes);
    pstate.timeoutMs = pstate.waitMinutes * 60 * 1000;
    if (["jpConvert", "jpQa", "jpFix"].includes(pstate.stepId) || (pstate.stepId && !M.STEP_MAP[pstate.stepId])) {
      pstate.stepId = "sourceAnalysis";
    }
    if (["jpConvert", "jpQa", "jpFix"].includes(pstate.startStep)) pstate.startStep = "";
    loaded = true;
  })();

  function nowTime() {
    return new Date().toLocaleTimeString("vi-VN", { hour12: false });
  }

  function persistable() {
    const saved = { ...pstate };
    if (String(saved.refFileText || "").length > 400000) {
      saved.refFileText = String(saved.refFileText).slice(0, 400000);
    }
    const turn = saved.pendingTurn;
    if (turn?.prompt && String(turn.prompt).length > 200000) {
      saved.pendingTurn = { ...turn, prompt: String(turn.prompt).slice(0, 200000) };
    }
    return saved;
  }

  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      chrome.storage.local.set({ [STORAGE_KEY]: persistable() }).catch(() => {});
    }, 80);
  }

  async function persistNow() {
    clearTimeout(persistTimer);
    await chrome.storage.local.set({ [STORAGE_KEY]: persistable() });
  }

  function addLog(message) {
    pstate.log = pstate.log || [];
    pstate.log.unshift({ time: nowTime(), message: String(message || "") });
    pstate.log = pstate.log.slice(0, 80);
    persist();
  }

  function isOccupied() {
    return !!(pstate.running || pstate.paused || pstate.pendingTurn);
  }

  function isActive() {
    return !!(pstate.running && !pstate.paused);
  }

  function ownsEvent(tabId, event) {
    if (!pstate.pendingTurn) return false;
    if (pstate.tabId && tabId && Number(tabId) !== Number(pstate.tabId)) return false;
    if (event?.turnId && pstate.pendingTurn.id && event.turnId !== pstate.pendingTurn.id) return false;
    return true;
  }

  function publicState() {
    return persistable();
  }

  function mergeConfig(cfg = {}) {
    if (cfg.fileName != null) pstate.fileName = M.normalizeFileName(cfg.fileName);
    if (cfg.condensePercent != null) pstate.condensePercent = M.normalizePercent(cfg.condensePercent);
    if (cfg.waitMinutes != null) {
      pstate.waitMinutes = M.normalizeWaitMinutes(cfg.waitMinutes);
      pstate.timeoutMs = pstate.waitMinutes * 60 * 1000;
    }
    if (cfg.doLatin != null) pstate.doLatin = !!cfg.doLatin;
    if (cfg.doVideo != null) pstate.doVideo = !!cfg.doVideo;
    if (cfg.startStep != null) pstate.startStep = String(cfg.startStep || "");
    if (cfg.refFileName != null) pstate.refFileName = String(cfg.refFileName || "").trim();
    if (cfg.refFileText != null) pstate.refFileText = String(cfg.refFileText || "");
    if (cfg.totalLines != null) pstate.totalLines = M.normalizeTotalLines(cfg.totalLines);
    persist();
  }

  function fileNameOrThrow() {
    const name = M.normalizeFileName(pstate.fileName);
    if (!name) throw new Error("Nhập tên file hỗ trợ trước bước tổng hợp file.");
    pstate.fileName = name;
    return name;
  }

  function rememberTotalLines(n) {
    const count = M.normalizeTotalLines(n);
    if (!count) return 0;
    pstate.totalLines = count;
    return count;
  }

  function rememberBatchProgress(text) {
    const parsed = S.parseAdaptBatchProgress(text);
    if (!parsed.total) return parsed;
    pstate.adaptBatchTotal = parsed.total;
    if (parsed.done > 0) pstate.adaptBatchDone = parsed.done;
    return parsed;
  }

  function scanTextOf(result) {
    return [result?.threadTail, result?.reply, result?.pageTail, result?.lastChars].filter(Boolean).join("\n");
  }

  function totalLinesOrThrow() {
    const n = rememberTotalLines(pstate.totalLines);
    if (!n) {
      throw new Error(
        "Chưa ghi nhớ được số dòng sau bước chia dòng. Chạy lại chia dòng để ChatGPT in: TÁC PHẨM CHIA DÒNG XONG CÓ N DÒNG."
      );
    }
    return n;
  }

  function buildMessage(step) {
    const ctx = {
      fileName: step.needsFile ? fileNameOrThrow() : pstate.fileName,
      totalLines: pstate.totalLines,
      promptLinesDone: pstate.promptLinesDone || 0,
      condensePercent: pstate.condensePercent,
      refFileName: pstate.refFileName,
      refFileText: pstate.refFileText,
      doLatin: pstate.doLatin,
      doVideo: pstate.doVideo,
      adaptBatchTotal: pstate.adaptBatchTotal || 0,
      adaptBatchDone: pstate.adaptBatchDone || 0,
    };
    if (step.id === "batchAdapt" && !ctx.adaptBatchTotal) {
      throw new Error("Chưa có số batch. Tool chưa đọc được TỔNG SỐ BATCH ADAPTATION: N hoặc BATCH ADAPTATION X/Y trên tab ChatGPT.");
    }
    if (step.id === "promptBatch") ctx.totalLines = totalLinesOrThrow();
    return step.build(ctx);
  }

  async function abortTab(tabId) {
    if (!tabId) return;
    try {
      await chrome.tabs.sendMessage(tabId, { type: "ABORT_TEXT_AUTO" });
    } catch (_) {}
    try {
      await chrome.tabs.sendMessage(tabId, { type: "STOP_WAIT" });
    } catch (_) {}
  }

  async function otherRunActive() {
    return typeof isTextOrImageRunning === "function" && isTextOrImageRunning();
  }

  function applySignal(step, signal, reply) {
    pstate.lastSignal = signal.phrase;
    pstate.lastError = "";
    let signalId = signal.id;

    if (step.id === "sourceAnalysis") {
      const n = S.parseAdaptBatchTotal(reply || "");
      if (!n) {
        throw new Error("Phân tích nguồn xong nhưng không đọc được số batch. Cần dòng: TỔNG SỐ BATCH ADAPTATION: N.");
      }
      if (n > M.MAX_ADAPT_BATCHES) {
        throw new Error(`Số batch ${n} quá lớn. Tối đa ${M.MAX_ADAPT_BATCHES} batch một lần chạy.`);
      }
      pstate.adaptBatchTotal = n;
      pstate.adaptBatchDone = 0;
      addLog(`Ghi nhớ ${n} batch. Chuyển đổi sẽ chạy lần lượt từ batch 1 đến batch ${n}.`);
    }

    if (step.id === "batchAdapt") {
      const mark = S.parseAdaptBatchProgress(reply || "").mark;
      if (mark?.total) pstate.adaptBatchTotal = mark.total;
      if (signalId === "ADAPT_BATCH_NEXT") {
        pstate.adaptBatchDone = mark?.index || (pstate.adaptBatchDone || 0) + 1;
        addLog(`Batch ${pstate.adaptBatchDone}/${pstate.adaptBatchTotal} xong. Gửi batch tiếp theo.`);
      } else if (signalId === "ADAPT_BATCH_ALL") {
        pstate.adaptBatchDone = mark?.index || pstate.adaptBatchTotal;
        addLog(`Đã chuyển hết ${pstate.adaptBatchTotal} batch. Sang hợp nhất.`);
      }
    }

    if (step.id === "lineSplit" || step.id === "jpLineSplit") {
      const counted = S.parseSplitLineCount(reply || "");
      if (!counted) {
        throw new Error("Chia dòng xong nhưng không đọc được số dòng. Cần dòng: TÁC PHẨM CHIA DÒNG XONG CÓ N DÒNG.");
      }
      rememberTotalLines(counted);
      pstate.promptLinesDone = 0;
      pstate.promptRounds = 0;
      addLog(`Ghi nhớ ${counted} dòng sau chia dòng. Prompt theo dòng sẽ làm 20 dòng/lần đến hết.`);
    }

    if (step.id === "promptBatch") {
      M.applyPromptProgress(pstate, signalId, reply || "");
      pstate.promptRounds = (pstate.promptRounds || 0) + 1;
      if (pstate.promptRounds > M.maxPromptRounds(pstate)) {
        throw new Error(
          `Prompt theo dòng chạy quá ${M.maxPromptRounds(pstate)} lượt. Dừng để tránh kẹt. Hiện ${pstate.promptLinesDone}/${pstate.totalLines} dòng.`
        );
      }
      if (signalId === "PROMPT_QA_FAIL") {
        pstate.qaLoops += 1;
        if (pstate.qaLoops > pstate.maxQaLoops) {
          throw new Error(`QA prompt lặp quá ${pstate.maxQaLoops} lần. Dừng để tránh kẹt.`);
        }
      } else {
        pstate.qaLoops = 0;
      }
      if (signalId === "PROMPT_ALL_DONE" && !M.promptsComplete(pstate)) {
        addLog(`Bỏ qua câu hoàn tất: mới ${pstate.promptLinesDone}/${pstate.totalLines} dòng. Gửi tiếp lô còn thiếu.`);
        signalId = "PROMPT_CONTINUE";
      } else if (signalId === "PROMPT_CONTINUE" || signalId === "PROMPT_QA_FAIL") {
        addLog(`Prompt ảnh ${pstate.promptLinesDone}/${pstate.totalLines} · còn ${M.remainingLines(pstate)} dòng.`);
      }
    } else if (step.kind === "qa" && signal.kind === "chua") {
      pstate.qaLoops += 1;
      if (pstate.qaLoops > pstate.maxQaLoops) {
        throw new Error(`QA lặp quá ${pstate.maxQaLoops} lần. Dừng để tránh kẹt.`);
      }
    } else if (signal.kind !== "chua") {
      pstate.qaLoops = 0;
    }

    const next = M.nextAfterSignal(step, signalId, pstate);
    if (!next) throw new Error(`Không có bước tiếp theo cho ${signalId}`);
    addLog(`Nhận [${signalId}]: ${signal.phrase}`);
    pstate.stepId = next;
    if (next === "done") {
      if (step.id === "promptBatch" && !M.promptsComplete(pstate)) {
        pstate.stepId = "promptBatch";
        addLog(`Chưa đủ dòng (${pstate.promptLinesDone}/${pstate.totalLines}), không thoát bước prompt theo dòng.`);
        return;
      }
      pstate.running = false;
      pstate.paused = false;
      pstate.pendingTurn = null;
      pstate.phase = "DONE";
      addLog("Pipeline hoàn tất.");
    }
  }

  function handleReply(step, reply) {
    if (step.kind === "fix" && !(step.allowed || []).length) {
      addLog("Sửa xong, gửi lại QA.");
      pstate.stepId = step.afterIdle;
      return true;
    }
    let signal = S.matchStepSignal(step, reply, pstate);
    if (!signal) {
      const allIds = [...new Set(M.visibleSteps(pstate).flatMap((s) => s.allowed || []))];
      signal = S.findSignal(reply, allIds);
      if (signal) {
        const owner = M.visibleSteps(pstate).find((s) => (s.allowed || []).includes(signal.id));
        if (owner && owner.id !== step.id) {
          addLog(`Câu cuối thuộc bước “${owner.title}”, không phải “${step.title}”.`);
          step = owner;
          pstate.stepId = owner.id;
          signal = S.matchStepSignal(step, reply, pstate) || signal;
        }
      }
    }
    if (!signal) {
      const tail = String(reply || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(-220);
      pstate.lastError = "Không thấy cụm nhận biết trong câu cuối.";
      pstate.running = false;
      pstate.paused = false;
      pstate.pendingTurn = null;
      pstate.phase = "ERROR";
      addLog(`${pstate.lastError} Dừng ở “${step.title}”. Cuối: ${tail || "(trống)"}`);
      return false;
    }
    applySignal(step, signal, reply);
    const next = M.STEP_MAP[pstate.stepId];
    if (next && next.id !== "done") addLog(`Sắp gửi bước tiếp: ${next.title}`);
    return true;
  }

  async function resolvePilotTab() {
    let tabId = Number(pstate.tabId);
    if (tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.id && (typeof isChatUrl !== "function" || isChatUrl(tab.url || ""))) return tab.id;
      } catch {
        /* find again */
      }
    }
    const tabs = await chrome.tabs
      .query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] })
      .catch(() => []);
    const tab = (tabs || []).find((t) => t.active) || (tabs || [])[0] || null;
    if (tab?.id) {
      pstate.tabId = tab.id;
      persist();
      return tab.id;
    }
    return 0;
  }

  function failStep(message) {
    const title = M.STEP_MAP[pstate.stepId]?.title || pstate.stepId;
    pstate.lastError = String(message || "UNKNOWN_ERROR");
    pstate.running = false;
    pstate.paused = false;
    pstate.pendingTurn = null;
    pstate.phase = "ERROR";
    addLog(`Lỗi ở “${title}”: ${pstate.lastError} Bấm Chạy tiếp để làm lại đúng bước này.`);
    persist();
  }

  async function pumpPilot() {
    await ready;
    if (!pstate.running || pstate.paused) return;
    if (pstate.pendingTurn?.sentConfirmed) return;
    if (pstate.stepId === "done") {
      pstate.running = false;
      persist();
      return;
    }
    let step = M.STEP_MAP[pstate.stepId];
    if (!step) return failStep("Bước không hợp lệ.");
    const tabId = Number(pstate.tabId);
    if (!tabId) return failStep("Không có tab ChatGPT.");
    try {
      if (pstate.pendingTurn && !pstate.pendingTurn.sentConfirmed) {
        addLog("Lượt trước chưa dán xong — hủy rồi dán lại vào ô chat.");
        await abortTab(tabId);
        pstate.pendingTurn = null;
      }
      if (typeof keepTabAlive === "function") await keepTabAlive(tabId);
      if (typeof ensurePilotContent === "function") await ensurePilotContent(tabId);
      if (step.id === "batchAdapt") {
        const page = await readPage(tabId, ["XONG LÀM BATCH TIẾP THEO", "XONG THỰC HIỆN HỢP NHẤT LIỀN MẠCH"], {}).catch(
          () => null
        );
        const parsed = rememberBatchProgress(scanTextOf(page));
        if (parsed.total) {
          addLog(`Đọc từ ChatGPT: BATCH ADAPTATION ${pstate.adaptBatchDone}/${pstate.adaptBatchTotal}.`);
        }
        if (parsed.complete || (pstate.adaptBatchTotal && pstate.adaptBatchDone >= pstate.adaptBatchTotal)) {
          pstate.stepId = "continuityMerge";
          pstate.startStep = "continuityMerge";
          pstate.pendingTurn = null;
          addLog("ChatGPT đã xong hết batch. Sang hợp nhất liền mạch.");
          persist();
          schedulePump(200);
          return;
        }
        step = M.STEP_MAP[pstate.stepId];
      }
      const text = buildMessage(step);
      if (!String(text || "").trim()) return failStep("Lệnh bước này trống, không có gì để dán.");
      if (step.id === "promptBatch") {
        const batch = M.currentBatch(pstate);
        addLog(
          batch.count
            ? `Dán prompt ${pstate.doVideo ? "video" : "ảnh"} theo dòng: dòng ${batch.from}–${batch.to} / ${pstate.totalLines}`
            : `Dán prompt ${pstate.doVideo ? "video" : "ảnh"} theo dòng: QA cuối ${pstate.promptLinesDone}/${pstate.totalLines}`
        );
      } else if (step.id === "batchAdapt") {
        addLog(`Dán chuyển đổi batch ${(pstate.adaptBatchDone || 0) + 1}/${pstate.adaptBatchTotal}`);
      } else {
        addLog(`Dán vào ô chat: ${step.title}`);
      }
      const turn = {
        id: `pilot_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        index: 0,
        kind: `PILOT_${step.id}`,
        prompt: text,
        startedAt: new Date().toISOString(),
        sentConfirmed: false,
        stage: "PREPARE",
        stepId: step.id,
        baseline: null,
      };
      pstate.pendingTurn = turn;
      pstate.phase = "PASTE_SEND";
      pstate.lastError = "";
      await persistNow();
      const settings = { responseTimeoutMin: pstate.waitMinutes || 60 };
      let r = await chrome.tabs
        .sendMessage(tabId, { type: "RUN_PILOT_TURN", turn, settings })
        .catch((e) => ({ ok: false, error: String(e?.message || e) }));
      if (!r?.ok && /TURN_ALREADY_ACTIVE|Receiving end does not exist/i.test(String(r?.error || ""))) {
        await abortTab(tabId);
        await new Promise((res) => setTimeout(res, 400));
        if (typeof ensurePilotContent === "function") await ensurePilotContent(tabId);
        r = await chrome.tabs
          .sendMessage(tabId, { type: "RUN_PILOT_TURN", turn, settings })
          .catch((e) => ({ ok: false, error: String(e?.message || e) }));
      }
      if (!r?.ok) return failStep(r?.error || "TURN_START_FAILED");
    } catch (err) {
      failStep(err.message || String(err));
    }
  }

  function schedulePump(delayMs) {
    const wait = Math.max(0, Number(delayMs || pstate.delayMs || 1500));
    setTimeout(() => pumpPilot().catch((e) => failStep(String(e?.message || e))), wait);
  }

  async function onTextEvent(tabId, event) {
    await ready;
    const turn = pstate.pendingTurn;
    if (!ownsEvent(tabId, event)) return { ok: false, error: "RUN_NOT_ACTIVE" };
    if (event.kind === "PROGRESS") {
      pstate.phase = event.phase || pstate.phase;
      if (event.verification) pstate.lastVerification = event.verification;
      persist();
      return { ok: true };
    }
    if (event.kind === "SENT") {
      if (!turn) return { ok: false, error: "NO_PENDING_TURN" };
      turn.sentConfirmed = true;
      turn.stage = "WAIT_RESPONSE";
      turn.baseline = event.baseline || turn.baseline;
      pstate.phase = "WAIT_RESPONSE";
      pstate.lastVerification = event.verification || "SEND_CONFIRMED";
      addLog(`Đã gửi. Chờ tối đa ${pstate.waitMinutes || 60} phút: tin trợ lý mới, không Stop trong ô chat, chữ đứng 5 giây.`);
      await persistNow();
      return { ok: true };
    }
    if (event.kind === "FAILED") {
      const error = String(event.error || event.detail || "TURN_FAILED");
      if (pstate.paused || /STOPPED_BY_USER/.test(error)) {
        pstate.pendingTurn = null;
        persist();
        return { ok: true };
      }
      failStep(error);
      return { ok: true };
    }
    if (event.kind === "DONE") {
      if (!turn) return { ok: false, error: "NO_PENDING_TURN" };
      const step = M.STEP_MAP[turn.stepId || pstate.stepId];
      const reply = String(event.text || "");
      pstate.pendingTurn = null;
      pstate.lastVerification = event.method || "";
      pstate.phase = "TURN_DONE";
      if (!step) {
        failStep("Bước không hợp lệ sau khi ChatGPT trả lời.");
        return { ok: true };
      }
      if (R.isSafetyRefusal(reply)) {
        pstate.safetyRetries = (pstate.safetyRetries || 0) + 1;
        if (pstate.safetyRetries > MAX_SAFETY_RETRIES) {
          failStep(
            `ChatGPT chặn nội dung vì an toàn ${MAX_SAFETY_RETRIES} lần liên tiếp. Bấm Chạy tiếp để gửi lại đúng bước này.`
          );
          return { ok: true };
        }
        addLog(`Gửi lại “${step.title}” vì lý do an toàn (lần ${pstate.safetyRetries}/${MAX_SAFETY_RETRIES}).`);
        persist();
        if (pstate.running && !pstate.paused) schedulePump(pstate.delayMs);
        return { ok: true };
      }
      const hit = R.phraseAfterWriting(step, reply, pstate);
      if (hit.needLines) {
        failStep("ChatGPT đã ngừng viết nhưng thiếu dòng TÁC PHẨM CHIA DÒNG XONG CÓ N DÒNG.");
        return { ok: true };
      }
      if (hit.needBatches) {
        failStep("ChatGPT đã ngừng viết nhưng thiếu dòng TỔNG SỐ BATCH ADAPTATION: N.");
        return { ok: true };
      }
      if (!hit.ready) {
        failStep(
          `ChatGPT đã ngừng viết (${reply.length} ký tự) nhưng không có câu chốt của bước này. Cuối: ${reply.slice(-200)}`
        );
        return { ok: true };
      }
      try {
        addLog(hit.signal ? `ChatGPT ngừng viết · thấy [${hit.signal.id}] · chuyển bước.` : "ChatGPT ngừng viết · chuyển bước.");
        handleReply(step, hit.text);
        pstate.safetyRetries = 0;
      } catch (err) {
        failStep(err.message || String(err));
        return { ok: true };
      }
      persist();
      if (pstate.running && !pstate.paused && pstate.stepId !== "done") schedulePump(pstate.delayMs);
      else persist();
      return { ok: true };
    }
    return { ok: true };
  }

  async function nudge(tabId, reason) {
    await ready;
    const turn = pstate.pendingTurn;
    if (!isActive() || !turn?.sentConfirmed) return;
    if (tabId && pstate.tabId && Number(tabId) !== Number(pstate.tabId)) return;
    const targetId = Number(pstate.tabId);
    if (!targetId) return;
    try {
      if (typeof ensureContent === "function") {
        const cs = await ensureContent(targetId);
        if (!cs?.ok) return;
      }
      const ping = await chrome.tabs.sendMessage(targetId, { type: "PING_TEXT_AUTO" }).catch(() => null);
      if (ping?.activeTurnId === turn.id || ping?.activeTurnId) return;
      const rr = await chrome.tabs
        .sendMessage(targetId, {
          type: "RECOVER_TEXT_TURN",
          turn,
          settings: {
            stableSec: 5,
            responseTimeoutMin: pstate.waitMinutes || 60,
            cdpFallback: true,
            selectors: {},
          },
        })
        .catch((e) => ({ ok: false, error: String(e?.message || e) }));
      if (rr?.ok) {
        pstate.phase = "RECOVER_WAIT_RESPONSE";
        addLog(`Gắn lại chờ câu trả lời (${reason || "WAKE"}).`);
        persist();
      }
    } catch (_) {}
  }

  async function startPilot(msg) {
    await ready;
    if (await otherRunActive()) return { ok: false, error: "TEXT_OR_IMAGE_RUN_ACTIVE" };
    const tabId = Number(msg.tabId || pstate.tabId);
    if (!tabId) return { ok: false, error: "NO_TAB" };
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (_) {
      return { ok: false, error: "TAB_NOT_FOUND" };
    }
    if (typeof isChatUrl === "function" && !isChatUrl(tab.url || "")) return { ok: false, error: "TAB_NOT_CHATGPT" };
    mergeConfig(msg.config || {});
    pstate.tabId = tabId;
    pstate.lastError = "";
    const restart = !!msg.restart;
    const chosenStart = String(pstate.startStep || "").trim();
    const startFromChosen = !!(chosenStart && chosenStart !== pstate.stepId && M.STEP_MAP[chosenStart]);
    const fromCurrent = !!msg.fromCurrent && !restart && !startFromChosen;
    if (!fromCurrent) {
      pstate.stepId = restart ? M.startStepId(pstate) : M.entryStepId(pstate);
      pstate.qaLoops = 0;
      pstate.promptLinesDone = 0;
      pstate.promptRounds = 0;
      if (pstate.stepId === "sourceAnalysis" || pstate.stepId === "refPrep") {
        pstate.adaptBatchTotal = 0;
        pstate.adaptBatchDone = 0;
      }
      if (M.keepsRememberedLines(pstate.stepId)) {
        pstate.totalLines = M.normalizeTotalLines(pstate.totalLines);
      } else {
        pstate.totalLines = 0;
      }
    }
    pstate.startStep = pstate.stepId;
    pstate.safetyRetries = 0;
    pstate.engaged = true;
    pstate.running = true;
    pstate.paused = false;
    pstate.pendingTurn = null;
    pstate.phase = "READY";
    if (typeof keepTabAlive === "function") {
      try {
        await keepTabAlive(tabId);
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    }
    if (typeof ensurePilotContent === "function") {
      try {
        await ensurePilotContent(tabId);
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    }
    await abortTab(tabId);
    const chosen = M.STEP_MAP[pstate.stepId];
    const skipped = !fromCurrent && pstate.stepId !== M.startStepId(pstate);
    if (!fromCurrent && pstate.stepId === "refPrep") {
      addLog(`Gửi tài liệu tham khảo ${pstate.refFileName || "đã chọn"} trước Bước 1.`);
    }
    addLog(
      fromCurrent
        ? `Chạy tiếp đúng bước đang dừng: “${chosen?.title || pstate.stepId}”.`
        : startFromChosen || skipped
          ? `Bắt đầu từ bước đã chọn: “${chosen?.title || pstate.stepId}”.`
          : `Bắt đầu pipeline · cô đọng ${pstate.condensePercent}%${pstate.doLatin ? " · có Mỹ Latinh" : " · bỏ Mỹ Latinh, chia dòng bản Nhật"}${pstate.doVideo ? " · prompt video theo dòng" : " · prompt ảnh theo dòng"}.`
    );
    await persistNow();
    schedulePump(150);
    return { ok: true };
  }

  async function stopPilot() {
    await ready;
    pstate.running = false;
    pstate.paused = false;
    pstate.pendingTurn = null;
    pstate.phase = "STOPPED_BY_USER";
    addLog("Đã dừng pipeline.");
    await abortTab(pstate.tabId);
    await persistNow();
    return { ok: true };
  }

  async function pausePilot() {
    await ready;
    if (!pstate.running) return { ok: true };
    pstate.paused = true;
    pstate.running = true;
    pstate.phase = "PAUSED";
    addLog("Tạm dừng. ChatGPT có thể vẫn đang trả lời lượt hiện tại.");
    await abortTab(pstate.tabId);
    pstate.pendingTurn = null;
    await persistNow();
    return { ok: true };
  }

  async function resumePilot(msg) {
    await ready;
    if (await otherRunActive()) return { ok: false, error: "TEXT_OR_IMAGE_RUN_ACTIVE" };
    if (msg?.tabId) pstate.tabId = Number(msg.tabId);
    mergeConfig(msg?.config || {});
    pstate.paused = false;
    pstate.running = true;
    pstate.lastError = "";
    pstate.pendingTurn = null;
    addLog("Tiếp tục.");
    await persistNow();
    schedulePump(150);
    return { ok: true };
  }

  async function resendPilot(msg) {
    await ready;
    mergeConfig(msg?.config || {});
    if (msg?.tabId) pstate.tabId = Number(msg.tabId);
    pstate.lastError = "";
    pstate.running = true;
    pstate.paused = false;
    await abortTab(pstate.tabId);
    pstate.pendingTurn = null;
    addLog("Gửi lại bước hiện tại — dán vào ô chat ngay.");
    await persistNow();
    schedulePump(200);
    return { ok: true };
  }

  function pickSignaledText(step, st, beforeReply) {
    const hit = R.detectStepFinish(step, st, beforeReply || "", pstate);
    if (hit.ready && hit.text) return hit;
    if (hit.text && hit.signal) return hit;
    const reply = String(st?.reply || st?.pageTail || "");
    if (reply && !R.isPromptEcho(reply)) return { text: reply, signal: S.findSignal(reply, step.allowed || []), ready: false };
    return { text: "", signal: null, ready: false };
  }

  async function readLast() {
    await ready;
    const tabId = await resolvePilotTab();
    if (!tabId) return { ok: false, error: "NO_TAB" };
    if (typeof ensurePilotContent === "function") {
      try {
        await ensurePilotContent(tabId);
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    }
    let step = M.STEP_MAP[pstate.stepId] || M.STEP_MAP.sourceAnalysis;
    const expectPhrases = [
      ...new Set(
        M.visibleSteps(pstate).flatMap((s) =>
          (s.allowed || []).flatMap((id) => S.signalPhrases(S.CATALOG.find((x) => x.id === id)))
        )
      ),
    ].filter(Boolean);
    let result;
    try {
      result = await readPage(tabId, expectPhrases, {});
    } catch (err) {
      result = { ok: false, error: err.message || String(err) };
    }
    if (!result?.ok || !(result?.reply || result?.pageTail)) {
      try {
        const fallback = await chrome.tabs.sendMessage(tabId, { type: "READ_LAST", expectPhrases });
        if (fallback?.reply || fallback?.ok) result = fallback;
      } catch (err) {
        if (!result?.reply) return { ok: false, error: result?.error || err.message || "Không đọc được câu trả lời cuối." };
      }
    }
    const hit = pickSignaledText(step, result, "");
    const reply = hit.text || result?.reply || result?.pageTail || "";
    if (!reply) return { ok: false, error: result?.error || "Không đọc được câu trả lời cuối." };
    if (R.isSafetyRefusal(reply)) {
      addLog("Câu cuối bị chặn vì an toàn. Gửi lại đúng bước này.");
      pstate.safetyRetries = 0;
      pstate.running = true;
      pstate.paused = false;
      pstate.pendingTurn = null;
      persist();
      schedulePump(200);
      return { ok: true };
    }
    addLog("Đọc câu trả lời đang có trên tab, không gửi lại.");
    const batchInfo = rememberBatchProgress(scanTextOf(result) + "\n" + reply);
    if (batchInfo.total) {
      addLog(`Ghi nhớ số batch từ ChatGPT: ${pstate.adaptBatchDone}/${pstate.adaptBatchTotal}.`);
    }
    let okHit = false;
    try {
      okHit = handleReply(step, reply);
    } catch (err) {
      failStep(err.message || String(err));
      return { ok: false, error: err.message || String(err) };
    }
    if (!okHit && batchInfo.total) {
      pstate.lastError = "";
      pstate.stepId = batchInfo.complete ? "continuityMerge" : "batchAdapt";
      okHit = true;
      addLog(
        batchInfo.complete
          ? `ChatGPT đã xong ${batchInfo.total} batch. Bấm Chạy tiếp để hợp nhất.`
          : `Đã ghi batch ${pstate.adaptBatchDone}/${pstate.adaptBatchTotal}. Bấm Chạy tiếp để làm batch ${pstate.adaptBatchDone + 1}.`
      );
    }
    await abortTab(tabId);
    pstate.pendingTurn = null;
    pstate.running = false;
    pstate.paused = false;
    pstate.startStep = pstate.stepId;
    if (okHit && pstate.stepId !== "done") {
      pstate.lastError = "";
      pstate.phase = "READY";
      addLog("Đã nhận. Bấm Chạy tiếp để dán lệnh bước sau vào ô ChatGPT.");
    }
    persist();
    return okHit ? { ok: true } : { ok: false, error: pstate.lastError || "Không thấy cụm nhận biết trong câu cuối." };
  }

  function forceNext() {
    const step = M.STEP_MAP[pstate.stepId];
    if (!step) return { ok: false, error: "NO_STEP" };
    try {
      if (step.id === "promptBatch" && !M.promptsComplete(pstate)) {
        applySignal(step, S.CATALOG.find((s) => s.id === "PROMPT_CONTINUE"), "");
        persist();
        return { ok: true };
      }
      if (step.id === "sourceAnalysis") {
        addLog("Bước phân tích nguồn cần dòng TỔNG SỐ BATCH ADAPTATION: N. Dùng Đọc câu cuối rồi chạy tiếp.");
        persist();
        return { ok: true };
      }
      if (step.id === "batchAdapt") {
        if (!pstate.adaptBatchTotal) {
          addLog("Chưa có số batch nên không ép được. Chạy bước phân tích nguồn trước.");
          persist();
          return { ok: true };
        }
        const last = (pstate.adaptBatchDone || 0) + 1 >= pstate.adaptBatchTotal;
        const id = last ? "ADAPT_BATCH_ALL" : "ADAPT_BATCH_NEXT";
        applySignal(step, S.CATALOG.find((s) => s.id === id), "");
        persist();
        return { ok: true };
      }
      const pass = (step.allowed || []).find((id) => {
        const item = S.CATALOG.find((s) => s.id === id);
        return item && (item.kind === "xong" || item.kind === "dat" || item.kind === "done");
      });
      if (!pass) {
        if (step.afterIdle) {
          pstate.stepId = step.afterIdle;
          addLog("Ép xong bước sửa, chuyển sang QA.");
        }
      } else {
        applySignal(step, S.CATALOG.find((s) => s.id === pass), "");
      }
      persist();
      return { ok: true };
    } catch (err) {
      failStep(err.message || String(err));
      return { ok: false, error: err.message || String(err) };
    }
  }

  function forceFail() {
    const step = M.STEP_MAP[pstate.stepId];
    const fail = (step.allowed || []).find((id) => S.CATALOG.find((s) => s.id === id)?.kind === "chua");
    if (!fail) {
      addLog("Bước này không có nhánh CHƯA ĐẠT.");
      persist();
      return { ok: true };
    }
    try {
      applySignal(step, S.CATALOG.find((s) => s.id === fail), "");
      persist();
      return { ok: true };
    } catch (err) {
      failStep(err.message || String(err));
      return { ok: false, error: err.message || String(err) };
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!PILOT_TYPES.has(msg?.type)) return false;
    (async () => {
      await ready;
      switch (msg.type) {
        case "GET_PILOT_STATE":
          return { ok: true, state: publicState() };
        case "START_PILOT":
          return startPilot(msg);
        case "STOP_PILOT":
          return stopPilot();
        case "PAUSE_PILOT":
          return pausePilot();
        case "RESUME_PILOT":
          return resumePilot(msg);
        case "RESEND_PILOT":
          return resendPilot(msg);
        case "READ_PILOT_LAST":
          return readLast();
        case "FORCE_PILOT_NEXT":
          return forceNext();
        case "FORCE_PILOT_FAIL":
          return forceFail();
        case "UPDATE_PILOT_CONFIG":
          mergeConfig(msg.config || {});
          return { ok: true };
        case "SET_PILOT_TAB":
          pstate.tabId = Number(msg.tabId || 0) || null;
          persist();
          return { ok: true, tabId: pstate.tabId };
        case "CLEAR_PILOT_LOG":
          pstate.log = [];
          persist();
          return { ok: true };
        default:
          return { ok: false, error: "UNKNOWN_MESSAGE" };
      }
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  });

  ready.then(() => {
    setTimeout(() => {
      if (pstate.running && !pstate.paused) {
        if (pstate.pendingTurn?.sentConfirmed) nudge(pstate.tabId, "SERVICE_WORKER_RESTART").catch(() => {});
        else if (!pstate.pendingTurn) schedulePump(400);
      }
    }, 800);
  });

  self.PilotEngine = {
    isOccupied,
    isActive,
    ownsEvent,
    onTextEvent,
    nudge,
    getState: publicState,
  };
})();
