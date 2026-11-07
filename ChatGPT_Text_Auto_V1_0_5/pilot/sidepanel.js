(() => {
  if (typeof chrome === "undefined" || !chrome?.storage?.local) {
    const store = {};
    window.chrome = {
      storage: {
        local: {
          get: (key, cb) => cb(typeof key === "string" ? { [key]: store[key] } : store),
          set: (obj) => Object.assign(store, obj),
        },
      },
      runtime: { sendMessage: async () => ({}) },
      tabs: { sendMessage: async () => ({ ok: false, error: "Chỉ chạy trong extension." }) },
    };
  }

  const {
    STEP_MAP,
    normalizeFileName,
    normalizeTotalLines,
    normalizePercent,
    normalizeWaitMinutes,
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
    promptsComplete,
    applyPromptProgress,
    maxPromptRounds,
    nextAfterSignal,
  } = LN_MACHINE;
  const { findSignal, matchStepSignal, CATALOG, parseSplitLineCount, parseAdaptBatchTotal } = LN_SIGNALS;
  const { detectStepFinish, isPromptEcho, writingDone, isSafetyRefusal, isDeadTabError, chargeWait, phraseAfterWriting, STABLE_MS } =
    LN_RUNNER;
  const MAX_SAFETY_RETRIES = 5;

  const els = {
    runBadge: document.getElementById("runBadge"),
    tabStatus: document.getElementById("tabStatus"),
    fileName: document.getElementById("fileName"),
    condensePercent: document.getElementById("condensePercent"),
    waitMinutes: document.getElementById("waitMinutes"),
    doLatin: document.getElementById("doLatin"),
    refFileName: document.getElementById("refFileName"),
    refFile: document.getElementById("refFile"),
    refFileHint: document.getElementById("refFileHint"),
    totalLines: document.getElementById("totalLines"),
    btnConnect: document.getElementById("btnConnect"),
    btnOpen: document.getElementById("btnOpen"),
    startStep: document.getElementById("startStep"),
    btnStart: document.getElementById("btnStart"),
    btnRestart: document.getElementById("btnRestart"),
    btnPause: document.getElementById("btnPause"),
    btnStop: document.getElementById("btnStop"),
    btnResend: document.getElementById("btnResend"),
    btnReadLast: document.getElementById("btnReadLast"),
    btnForceNext: document.getElementById("btnForceNext"),
    btnForceFail: document.getElementById("btnForceFail"),
    btnClearLog: document.getElementById("btnClearLog"),
    nowText: document.getElementById("nowText"),
    resumeHint: document.getElementById("resumeHint"),
    stepList: document.getElementById("stepList"),
    logList: document.getElementById("logList"),
  };

  const buildVersion = document.getElementById("buildVersion");
  if (buildVersion) {
    const version = chrome.runtime?.getManifest?.().version || "";
    buildVersion.textContent = version ? `Bản ${version}` : "";
  }

  let state = createState();
  let busy = false;
  let runGen = 0;

  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label || "Hết giờ gọi tab ChatGPT.")), ms);
      Promise.resolve(promise).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  function haltRun(message) {
    runGen += 1;
    state.running = false;
    state.paused = false;
    busy = false;
    addLog(message);
    renderSteps();
    persist();
  }

  function liveSteps() {
    return visibleSteps(state).filter((s) => s.id !== "done");
  }

  function stepIndex(id) {
    return liveSteps().findIndex((s) => s.id === id);
  }

  function readForm() {
    state.condensePercent = normalizePercent(els.condensePercent && els.condensePercent.value);
    if (els.condensePercent) els.condensePercent.value = String(state.condensePercent);
    state.waitMinutes = normalizeWaitMinutes(els.waitMinutes && els.waitMinutes.value);
    state.timeoutMs = state.waitMinutes * 60 * 1000;
    if (els.waitMinutes) els.waitMinutes.value = String(state.waitMinutes);
    state.doLatin = !!(els.doLatin && els.doLatin.checked);
    state.refFileName = String((els.refFileName && els.refFileName.value) || state.refFileName || "").trim();
    if (els.startStep && els.startStep.value) state.startStep = els.startStep.value;
    if (els.refFileHint) {
      els.refFileHint.textContent = hasRefDoc(state)
        ? `Sẽ gửi tài liệu ${state.refFileName || "đã chọn"} trước Bước 1, chờ câu ĐÃ CẬP NHẬT ĐẦY ĐỦ DỮ LIỆU THAM KHẢO.`
        : "Để trống thì chạy bình thường từ Bước 1. Có file thì tool gửi file đó trước, chờ câu ĐÃ CẬP NHẬT ĐẦY ĐỦ DỮ LIỆU THAM KHẢO.";
    }
  }

  function addLog(message) {
    const time = new Date().toLocaleTimeString("vi-VN", { hour12: false });
    state.log.unshift({ time, message });
    state.log = state.log.slice(0, 80);
    renderLog();
    persist();
  }

  function persist() {
    const saved = {
      ...state,
      running: false,
      paused: false,
    };
    if (String(saved.refFileText || "").length > 400000) {
      saved.refFileText = String(saved.refFileText).slice(0, 400000);
    }
    chrome.storage.local.set({ pipelineState: saved });
  }

  function renderLog() {
    els.logList.innerHTML = state.log
      .map((item) => `<li><span class="time">${item.time}</span>${escapeHtml(item.message)}</li>`)
      .join("");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function setBadge() {
    const el = els.runBadge;
    el.className = "badge idle";
    if (state.lastError) {
      el.className = "badge err";
      el.textContent = "Lỗi";
      return;
    }
    if (state.stepId === "done") {
      el.className = "badge done";
      el.textContent = "Hoàn tất";
      return;
    }
    if (state.running && state.paused) {
      el.className = "badge pause";
      el.textContent = "Tạm dừng";
      return;
    }
    if (state.running) {
      el.className = "badge run";
      el.textContent = "Đang chạy";
      return;
    }
    el.textContent = "Đang chờ";
  }

  function renderStartOptions() {
    const steps = liveSteps();
    const ids = steps.map((s) => s.id).join(",");
    if (!steps.some((s) => s.id === state.startStep)) state.startStep = startStepId(state);
    if (els.startStep.dataset.ids !== ids) {
      els.startStep.innerHTML = steps
        .map((s) => `<option value="${s.id}">${escapeHtml(s.group)} — ${escapeHtml(s.title)}</option>`)
        .join("");
      els.startStep.dataset.ids = ids;
    }
    if (els.startStep.value !== state.startStep) els.startStep.value = state.startStep;
  }

  function renderSteps() {
    readForm();
    renderStartOptions();
    const current = stepIndex(state.stepId);
    let lastGroup = "";
    els.stepList.innerHTML = liveSteps()
      .map((s, i) => {
        const stuck = s.id === state.stepId && state.lastError && !state.running;
        const cls = [s.id === state.stepId ? "active" : "", i < current ? "done" : "", stuck ? "stuck" : ""]
          .filter(Boolean)
          .join(" ");
        const group = s.group !== lastGroup ? `<span class="group">${s.group}</span>` : "";
        lastGroup = s.group;
        return `<li class="${cls}">${group}${s.title}</li>`;
      })
      .join("");
    const step = STEP_MAP[state.stepId];
    const batch = currentBatch(state);
    const progress =
      state.stepId === "batchAdapt" && state.adaptBatchTotal > 0
        ? ` · batch ${Math.min((state.adaptBatchDone || 0) + 1, state.adaptBatchTotal)}/${state.adaptBatchTotal}`
        : state.totalLines > 0
          ? batch.count
            ? ` · ${state.promptLinesDone || 0}/${state.totalLines} · lượt này dòng ${batch.from}–${batch.to}`
            : ` · ${state.promptLinesDone || 0}/${state.totalLines} · đủ dòng, đang QA cuối`
          : "";
    const resume = state.paused || shouldResume(state);
    const signalNote = state.lastSignal ? ` · nhận: ${state.lastSignal}` : "";
    els.nowText.textContent = !step
      ? "Bước hiện tại: chưa chạy"
      : state.lastError && !state.running
        ? `Dừng ở: ${step.title}${progress}. Chạy tiếp gửi lại đúng bước này.${signalNote}`
        : resume && !state.running
          ? `Đã đến: ${step.title}${progress}. Chạy tiếp làm tiếp bước này.${signalNote}`
          : `Bước hiện tại: ${step.title}${progress}${signalNote}`;
    if (els.resumeHint) {
      els.resumeHint.textContent =
        resume && !state.running
          ? "Tool nhớ bước đang dừng. Chạy tiếp không quay về đầu. Muốn làm lại từ bước đầu thì bấm Chạy lại từ đầu."
          : "";
    }
    els.btnStart.textContent = resume ? "Chạy tiếp" : "Chạy pipeline";
    els.btnStart.disabled = state.running && !state.paused;
    els.btnPause.disabled = !state.running;
    els.btnStop.disabled = false;
    setBadge();
  }

  async function findTab() {
    const res = await withTimeout(chrome.runtime.sendMessage({ type: "FIND_CHATGPT" }), 8000, "Hết giờ tìm tab ChatGPT.");
    return res?.tab || null;
  }

  async function openChatGPT() {
    const res = await chrome.runtime.sendMessage({ type: "OPEN_CHATGPT" });
    return res?.tab || null;
  }

  async function askTab(tabId, payload) {
    const idempotent = payload?.type === "GET_STATUS" || payload?.type === "READ_LAST" || payload?.type === "PING";
    const attempts = idempotent ? 3 : 1;
    let lastError = "Hết giờ gọi tab ChatGPT.";
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const ready = await withTimeout(
          chrome.runtime.sendMessage({ type: "ENSURE_CONTENT", tabId }),
          20000,
          "Hết giờ gọi tab ChatGPT."
        );
        if (ready && ready.ok === false) {
          throw new Error(ready.error || "Chưa gắn được script vào tab ChatGPT.");
        }
        return await withTimeout(
          chrome.tabs.sendMessage(tabId, payload),
          20000,
          "Hết giờ gọi tab ChatGPT."
        );
      } catch (err) {
        lastError = err.message || String(err);
        if (/đóng băng|Không còn tab/i.test(lastError) || !idempotent) break;
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    throw new Error(lastError);
  }

  async function snapshotPage(tabId) {
    return withTimeout(
      chrome.runtime.sendMessage({ type: "SNAPSHOT_PAGE", tabId }),
      15000,
      "Hết giờ chụp trang ChatGPT."
    );
  }

  async function readPage(tabId, expectPhrases, baseline) {
    const viaBg = await withTimeout(
      chrome.runtime.sendMessage({
        type: "READ_PAGE",
        tabId,
        expectPhrases: expectPhrases || [],
        baseline: baseline || {},
      }),
      12000,
      "Hết giờ đọc trang ChatGPT."
    );
    if (viaBg?.ok) return viaBg;
    try {
      return await askTab(tabId, { type: "READ_LAST", expectPhrases: expectPhrases || [] });
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  function pickSignaledText(step, st, beforeReply) {
    const hit = detectStepFinish(step, st, beforeReply || "", state);
    if (hit.ready && hit.text) return hit;
    if (hit.text && hit.signal) return hit;
    const reply = String(st?.reply || st?.pageTail || "");
    if (reply && !isPromptEcho(reply)) return { text: reply, signal: findSignal(reply, step.allowed || []), ready: false };
    return { text: "", signal: null, ready: false };
  }

  async function refreshTabStatus() {
    try {
      const tab = state.tabId ? { id: state.tabId } : await findTab();
      if (!tab?.id) {
        els.tabStatus.textContent = "Chưa thấy tab ChatGPT.";
        return null;
      }
      state.tabId = tab.id;
      const st = await askTab(tab.id, { type: "GET_STATUS" });
      if (!st?.ok && st?.error) {
        els.tabStatus.textContent = st.error;
        return null;
      }
      if (!st?.loggedIn) {
        els.tabStatus.textContent = "Đã mở tab nhưng chưa đăng nhập. Hãy login trên chatgpt.com.";
        return st;
      }
      els.tabStatus.textContent = st.generating
        ? "Đã kết nối · ChatGPT đang trả lời…"
        : "Đã kết nối · đã đăng nhập.";
      return st;
    } catch (err) {
      const message = err?.message || "";
      els.tabStatus.textContent = /đóng băng|Không còn tab/i.test(message)
        ? message
        : "Chưa gắn được script vào tab. Bấm vào tab ChatGPT, F5, rồi bấm Kết nối tab.";
      return null;
    }
  }

  function fileNameOrThrow() {
    const name = normalizeFileName(els.fileName.value || state.fileName);
    if (!name) throw new Error("Nhập tên file hỗ trợ trước bước tổng hợp file.");
    state.fileName = name;
    els.fileName.value = name.replace(/\.txt$/i, "");
    return name;
  }

  function rememberTotalLines(n) {
    const count = normalizeTotalLines(n);
    if (!count) return 0;
    state.totalLines = count;
    els.totalLines.value = String(count);
    return count;
  }

  function totalLinesOrThrow() {
    const n = rememberTotalLines(els.totalLines.value || state.totalLines);
    if (!n) {
      throw new Error(
        "Chưa ghi nhớ được số dòng sau bước chia dòng. Chạy lại chia dòng để ChatGPT in: TÁC PHẨM CHIA DÒNG XONG CÓ N DÒNG."
      );
    }
    return n;
  }

  function buildMessage(step) {
    readForm();
    const ctx = {
      fileName: step.needsFile ? fileNameOrThrow() : state.fileName,
      totalLines: state.totalLines,
      promptLinesDone: state.promptLinesDone || 0,
      condensePercent: state.condensePercent,
      refFileName: state.refFileName,
      refFileText: state.refFileText,
      doLatin: state.doLatin,
      adaptBatchTotal: state.adaptBatchTotal || 0,
      adaptBatchDone: state.adaptBatchDone || 0,
    };
    if (step.id === "batchAdapt" && !ctx.adaptBatchTotal) {
      throw new Error(
        "Chưa có số batch. Chạy bước phân tích nguồn để ChatGPT in: TỔNG SỐ BATCH ADAPTATION: N."
      );
    }
    if (step.id === "promptBatch") {
      ctx.totalLines = totalLinesOrThrow();
    }
    return step.build(ctx);
  }

  async function sendCurrentStep() {
    const step = STEP_MAP[state.stepId];
    if (!step || step.id === "done") return { done: true };
    const tab = state.tabId ? { id: state.tabId } : await findTab();
    if (!tab?.id) throw new Error("Không có tab ChatGPT.");
    state.tabId = tab.id;
    const text = buildMessage(step);
    if (step.id === "promptBatch") {
      const batch = currentBatch(state);
      addLog(
        batch.count
          ? `Gửi prompt theo dòng: dòng ${batch.from}–${batch.to} / ${state.totalLines}`
          : `Gửi prompt theo dòng: QA cuối ${state.promptLinesDone}/${state.totalLines}`
      );
    } else if (step.id === "batchAdapt") {
      const index = (state.adaptBatchDone || 0) + 1;
      addLog(`Gửi chuyển đổi batch ${index}/${state.adaptBatchTotal}`);
    } else {
      addLog(`Gửi: ${step.title}`);
    }
    const expectPhrases = (step.allowed || [])
      .map((id) => CATALOG.find((s) => s.id === id)?.phrase)
      .filter(Boolean);
    const gen = runGen;
    const stopped = () => runGen !== gen || !state.running || state.paused;
    const snap = await snapshotPage(tab.id);
    if (stopped()) throw new Error("Đã dừng chờ.");
    const sent = await withTimeout(
      chrome.runtime.sendMessage({
        type: "SEND_PAGE",
        tabId: tab.id,
        text,
      }),
      30000,
      "Hết giờ gửi tin ChatGPT."
    );
    if (stopped()) throw new Error("Đã dừng chờ.");
    if (!sent?.ok) {
      const fallback = await askTab(tab.id, { type: "SEND_PROMPT", text, expectPhrases });
      if (!fallback?.ok) throw new Error(sent?.error || fallback?.error || "Gửi tin thất bại.");
    }
    const baseline = sent?.baseline || snap?.baseline || {};
    addLog(
      `Đã gửi. Chờ tối đa ${state.waitMinutes || 60} phút: tin trợ lý mới, không Stop trong ô chat, chữ đứng 5 giây.`
    );

    const timeoutMs = state.timeoutMs || 60 * 60 * 1000;
    let remaining = timeoutMs;
    let lastTick = Date.now();
    let last = "";
    let lastKey = "";
    let lastChange = Date.now();
    let sawNew = false;
    let lastNote = 0;
    const stableMs = STABLE_MS || 5000;

    while (remaining > 0) {
      if (stopped()) throw new Error("Đã dừng chờ.");
      const now = Date.now();
      const dt = Math.max(0, now - lastTick);
      lastTick = now;
      let st;
      try {
        st = await readPage(tab.id, expectPhrases, baseline);
      } catch (err) {
        const message = err.message || String(err);
        if (isDeadTabError(message)) throw err;
        st = { ok: false, stalled: true, error: message };
      }
      if (stopped()) throw new Error("Đã dừng chờ.");
      if (isDeadTabError(st?.error)) throw new Error(st.error);
      if (chargeWait(st)) remaining -= dt;
      if (st?.ok === false || st?.stalled) {
        if (now - lastNote > 8000) {
          lastNote = now;
          addLog(
            `Tab ChatGPT đang ẩn hoặc phản hồi chậm (${st.error || "không đọc được"}). Vẫn chờ, không trừ giờ chờ.`
          );
          persist();
          renderSteps();
        }
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }

      if (st?.composerPending && !st?.generating) {
        addLog("Ô chat còn lệnh chưa gửi — đang bấm gửi nốt.");
        try {
          await askTab(tab.id, { type: "CLICK_SEND" });
        } catch (err) {
          const message = err.message || String(err);
          if (/đóng băng|Không còn tab/i.test(message)) throw err;
          addLog(`Chưa bấm được nút gửi (${message}). Vẫn chờ tab ChatGPT.`);
        }
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }

      if (st?.sawNew) sawNew = true;
      const candidate = String(st?.reply || "");
      const candidateKey = String(st?.candidateKey || "");
      if (candidate && (candidate !== last || candidateKey !== lastKey)) {
        last = candidate;
        lastKey = candidateKey;
        lastChange = now;
      }
      const stableFor = now - lastChange;
      const doneWriting = writingDone({
        sawNew,
        last,
        generating: !!st?.generating,
        composerReady: st?.composerReady !== false,
        stableFor,
      });

      if (doneWriting) {
        if (isSafetyRefusal(last)) {
          addLog("ChatGPT ngừng viết nhưng chặn nội dung vì an toàn. Sẽ gửi lại đúng bước này.");
          return { step, safetyRetry: true, reply: last };
        }
        const hit = phraseAfterWriting(step, last, state);
        if (hit.needLines) {
          throw new Error(
            "ChatGPT đã ngừng viết nhưng thiếu dòng TÁC PHẨM CHIA DÒNG XONG CÓ N DÒNG."
          );
        }
        if (hit.needBatches) {
          throw new Error(
            "ChatGPT đã ngừng viết nhưng thiếu dòng TỔNG SỐ BATCH ADAPTATION: N."
          );
        }
        if (hit.ready) {
          addLog(
            hit.signal
              ? `ChatGPT ngừng viết · thấy [${hit.signal.id}] · chuyển bước.`
              : "ChatGPT ngừng viết · chuyển bước."
          );
          return { step, reply: hit.text };
        }
        throw new Error(
          `ChatGPT đã ngừng viết (${last.length} ký tự, ${st?.candidateSource || "no-source"}) nhưng không có câu chốt của bước này. Cuối: ${last.slice(-200)}`
        );
      }

      if (now - lastNote > 8000) {
        lastNote = now;
        const hint = `new=${sawNew ? 1 : 0} generating=${st?.generating ? 1 : 0} stable=${Math.round(stableFor / 100) / 10}s chars=${last.length} source=${st?.candidateSource || "-"}`;
        addLog(`Vẫn chờ ChatGPT… ${Math.round((timeoutMs - remaining) / 1000)}s · ${hint}`);
        persist();
        renderSteps();
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    const finalSt = await readPage(tab.id, expectPhrases, baseline);
    const finalText = String(finalSt?.reply || last || "");
    if (isSafetyRefusal(finalText) && !finalSt?.generating) {
      addLog("ChatGPT ngừng viết nhưng chặn nội dung vì an toàn. Sẽ gửi lại đúng bước này.");
      return { step, safetyRetry: true, reply: finalText };
    }
    if (finalText && !finalSt?.generating && finalSt?.composerReady !== false) {
      await new Promise((r) => setTimeout(r, Math.min(stableMs, 2500)));
      const again = await readPage(tab.id, expectPhrases, baseline);
      const againText = String(again?.reply || "");
      if (againText === finalText && !again?.generating) {
        const hit = phraseAfterWriting(step, againText, state);
        if (hit.ready) {
          addLog("ChatGPT ngừng viết (lượt cuối) · chuyển bước.");
          return { step, reply: hit.text };
        }
      }
    }
    throw new Error("Hết giờ chờ ChatGPT ngừng viết.");
  }

  function applySignal(step, signal, reply) {
    state.lastSignal = signal.phrase;
    state.lastError = "";
    let signalId = signal.id;

    if (step.id === "sourceAnalysis") {
      const n = parseAdaptBatchTotal(reply || "");
      if (!n) {
        throw new Error(
          "Phân tích nguồn xong nhưng không đọc được số batch. Cần dòng: TỔNG SỐ BATCH ADAPTATION: N."
        );
      }
      if (n > MAX_ADAPT_BATCHES) {
        throw new Error(`Số batch ${n} quá lớn. Tối đa ${MAX_ADAPT_BATCHES} batch một lần chạy.`);
      }
      state.adaptBatchTotal = n;
      state.adaptBatchDone = 0;
      addLog(`Ghi nhớ ${n} batch. Chuyển đổi sẽ chạy lần lượt từ batch 1 đến batch ${n}.`);
    }

    if (step.id === "batchAdapt") {
      if (signalId === "ADAPT_BATCH_NEXT") {
        state.adaptBatchDone = (state.adaptBatchDone || 0) + 1;
        addLog(`Batch ${state.adaptBatchDone}/${state.adaptBatchTotal} xong. Gửi batch tiếp theo.`);
      } else if (signalId === "ADAPT_BATCH_ALL") {
        state.adaptBatchDone = state.adaptBatchTotal;
        addLog(`Đã chuyển hết ${state.adaptBatchTotal} batch. Sang hợp nhất.`);
      }
    }

    if (step.id === "lineSplit" || step.id === "jpLineSplit") {
      const counted = parseSplitLineCount(reply || "");
      if (!counted) {
        throw new Error(
          "Chia dòng xong nhưng không đọc được số dòng. Cần dòng: TÁC PHẨM CHIA DÒNG XONG CÓ N DÒNG."
        );
      }
      rememberTotalLines(counted);
      state.promptLinesDone = 0;
      state.promptRounds = 0;
      addLog(`Ghi nhớ ${counted} dòng sau chia dòng. Prompt theo dòng sẽ làm 20 dòng/lần đến hết.`);
    }

    if (step.id === "promptBatch") {
      applyPromptProgress(state, signalId, reply || "");
      state.promptRounds = (state.promptRounds || 0) + 1;
      if (state.promptRounds > maxPromptRounds(state)) {
        throw new Error(
          `Prompt theo dòng chạy quá ${maxPromptRounds(state)} lượt. Dừng để tránh kẹt. Hiện ${state.promptLinesDone}/${state.totalLines} dòng.`
        );
      }
      if (signalId === "PROMPT_QA_FAIL") {
        state.qaLoops += 1;
        if (state.qaLoops > state.maxQaLoops) {
          throw new Error(`QA prompt lặp quá ${state.maxQaLoops} lần. Dừng để tránh kẹt.`);
        }
      } else {
        state.qaLoops = 0;
      }
      if (signalId === "PROMPT_ALL_DONE" && !promptsComplete(state)) {
        addLog(
          `Bỏ qua câu hoàn tất: mới ${state.promptLinesDone}/${state.totalLines} dòng. Gửi tiếp lô còn thiếu.`
        );
        signalId = "PROMPT_CONTINUE";
      } else if (signalId === "PROMPT_CONTINUE" || signalId === "PROMPT_QA_FAIL") {
        addLog(
          `Prompt ảnh ${state.promptLinesDone}/${state.totalLines} · còn ${remainingLines(state)} dòng.`
        );
      }
    } else if (step.kind === "qa" && signal.kind === "chua") {
      state.qaLoops += 1;
      if (state.qaLoops > state.maxQaLoops) {
        throw new Error(`QA lặp quá ${state.maxQaLoops} lần. Dừng để tránh kẹt.`);
      }
    } else if (signal.kind !== "chua") {
      state.qaLoops = 0;
    }

    const next = nextAfterSignal(step, signalId, state);
    if (!next) throw new Error(`Không có bước tiếp theo cho ${signalId}`);
    addLog(`Nhận [${signalId}]: ${signal.phrase}`);
    state.stepId = next;
    if (next === "done") {
      if (step.id === "promptBatch" && !promptsComplete(state)) {
        state.stepId = "promptBatch";
        addLog(`Chưa đủ dòng (${state.promptLinesDone}/${state.totalLines}), không thoát bước prompt theo dòng.`);
        return;
      }
      state.running = false;
      addLog("Pipeline hoàn tất.");
    }
  }

  async function handleReply(step, reply) {
    if (step.kind === "fix" && !(step.allowed || []).length) {
      addLog("Sửa xong, gửi lại QA.");
      state.stepId = step.afterIdle;
      return;
    }
    const signal = matchStepSignal(step, reply, state);
    if (!signal) {
      state.lastError = "Không thấy cụm nhận biết riêng của bước này.";
      state.running = false;
      addLog(`${state.lastError} Dừng ở “${step.title}”. Bấm Chạy tiếp để gửi lại đúng bước này.`);
      return;
    }
    applySignal(step, signal, reply);
    const next = STEP_MAP[state.stepId];
    if (next && next.id !== "done") addLog(`Sắp gửi bước tiếp: ${next.title}`);
  }

  async function tick() {
    if (!state.running || state.paused || busy) return;
    if (state.stepId === "done") {
      state.running = false;
      renderSteps();
      return;
    }
    busy = true;
    renderSteps();
    try {
      const sent = await sendCurrentStep();
      if (sent.done) {
        state.running = false;
      } else if (sent.safetyRetry) {
        state.safetyRetries = (state.safetyRetries || 0) + 1;
        if (state.safetyRetries > MAX_SAFETY_RETRIES) {
          throw new Error(
            `ChatGPT chặn nội dung vì an toàn ${MAX_SAFETY_RETRIES} lần liên tiếp. Bấm Chạy tiếp để gửi lại đúng bước này.`
          );
        }
        addLog(
          `Gửi lại “${sent.step.title}” vì lý do an toàn (lần ${state.safetyRetries}/${MAX_SAFETY_RETRIES}).`
        );
        await new Promise((r) => setTimeout(r, state.delayMs));
      } else {
        state.safetyRetries = 0;
        await handleReply(sent.step, sent.reply);
        if (state.running && !state.paused && state.stepId !== "done") {
          await new Promise((r) => setTimeout(r, state.delayMs));
        }
      }
    } catch (err) {
      const message = err.message || String(err);
      if (message === "Đã dừng chờ.") {
        state.running = false;
        state.paused = false;
        state.lastError = "";
      } else {
        state.lastError = message;
        state.running = false;
        const title = STEP_MAP[state.stepId]?.title || state.stepId;
        addLog(`Lỗi ở “${title}”: ${state.lastError} Bấm Chạy tiếp để làm lại đúng bước này.`);
      }
    } finally {
      busy = false;
      persist();
      renderSteps();
      refreshTabStatus();
      if (state.running && !state.paused) queueMicrotask(tick);
    }
  }

  function start(fromCurrent = false) {
    readForm();
    state.lastError = "";
    if (!fromCurrent) {
      state.stepId = entryStepId(state);
      state.qaLoops = 0;
      state.promptLinesDone = 0;
      state.promptRounds = 0;
      if (state.stepId === "sourceAnalysis" || state.stepId === "refPrep") {
        state.adaptBatchTotal = 0;
        state.adaptBatchDone = 0;
      }
      if (keepsRememberedLines(state.stepId)) {
        state.totalLines = normalizeTotalLines((els.totalLines && els.totalLines.value) || state.totalLines);
      } else {
        state.totalLines = 0;
        if (els.totalLines) els.totalLines.value = "";
      }
    }
    state.safetyRetries = 0;
    state.engaged = true;
    state.running = true;
    state.paused = false;
    const chosen = STEP_MAP[state.stepId];
    const skipped = !fromCurrent && state.stepId !== startStepId(state);
    if (!fromCurrent && state.stepId === "refPrep") {
      addLog(`Gửi tài liệu tham khảo ${state.refFileName || "đã chọn"} trước Bước 1.`);
    }
    addLog(
      fromCurrent
        ? `Chạy tiếp đúng bước đang dừng: “${chosen.title}”.`
        : skipped
          ? `Bắt đầu từ “${chosen.title}”. Bỏ các bước trước.`
          : `Bắt đầu pipeline · cô đọng ${state.condensePercent}%${state.doLatin ? " · có Mỹ Latinh" : " · bỏ Mỹ Latinh, chia dòng bản Nhật"}.`
    );
    renderSteps();
    tick();
  }

  els.btnConnect.addEventListener("click", async () => {
    const tab = await findTab();
    if (!tab) {
      els.tabStatus.textContent = "Chưa có tab ChatGPT. Bấm Mở ChatGPT.";
      return;
    }
    state.tabId = tab.id;
    await refreshTabStatus();
  });

  els.btnOpen.addEventListener("click", async () => {
    const tab = await openChatGPT();
    state.tabId = tab?.id || null;
    setTimeout(refreshTabStatus, 1200);
  });

  els.btnStart.addEventListener("click", () => {
    if (state.paused) {
      state.paused = false;
      state.running = true;
      addLog("Tiếp tục.");
      renderSteps();
      tick();
      return;
    }
    start(shouldResume(state));
  });

  els.btnRestart.addEventListener("click", () => {
    readForm();
    state.startStep = startStepId(state);
    if (els.startStep) els.startStep.value = state.startStep;
    state.qaLoops = 0;
    state.promptLinesDone = 0;
    state.promptRounds = 0;
    state.totalLines = 0;
    if (els.totalLines) els.totalLines.value = "";
    start(false);
  });

  els.btnPause.addEventListener("click", () => {
    if (!state.running) return;
    state.paused = true;
    runGen += 1;
    addLog("Tạm dừng. ChatGPT có thể vẫn đang trả lời lượt hiện tại.");
    renderSteps();
    persist();
  });

  els.btnStop.addEventListener("click", () => {
    if (!state.running && !busy) {
      addLog("Không có lượt nào đang chạy.");
      return;
    }
    haltRun("Đã dừng pipeline.");
  });

  els.btnResend.addEventListener("click", () => {
    if (busy) return;
    state.lastError = "";
    state.running = true;
    state.paused = false;
    tick();
  });

  els.btnReadLast.addEventListener("click", async () => {
    if (busy) return;
    const step = STEP_MAP[state.stepId];
    if (!step || step.id === "done") return;
    busy = true;
    state.lastError = "";
    try {
      const tab = state.tabId ? { id: state.tabId } : await findTab();
      if (!tab?.id) throw new Error("Không có tab ChatGPT.");
      state.tabId = tab.id;
      const expectPhrases = (step.allowed || [])
        .map((id) => CATALOG.find((s) => s.id === id)?.phrase)
        .filter(Boolean);
      const result = await readPage(tab.id, expectPhrases);
      const hit = pickSignaledText(step, result, "");
      const reply = hit.text || result?.reply || "";
      if (!reply) throw new Error("Không đọc được câu trả lời cuối.");
      if (isSafetyRefusal(reply)) {
        addLog("Câu cuối bị chặn vì an toàn. Gửi lại đúng bước này.");
        state.safetyRetries = 0;
        state.running = true;
        state.paused = false;
        queueMicrotask(tick);
        return;
      }
      addLog("Đọc câu trả lời đang có trên tab, không gửi lại.");
      await handleReply(step, reply);
      persist();
      renderSteps();
      if (state.stepId !== "done") {
        state.running = true;
        state.paused = false;
        queueMicrotask(tick);
      }
    } catch (err) {
      state.lastError = err.message || String(err);
      addLog(`Lỗi: ${state.lastError}`);
      renderSteps();
    } finally {
      busy = false;
    }
  });

  els.btnForceNext.addEventListener("click", () => {
    const step = STEP_MAP[state.stepId];
    if (!step) return;
    if (step.id === "promptBatch" && !promptsComplete(state)) {
      applySignal(step, CATALOG.find((s) => s.id === "PROMPT_CONTINUE"), "");
      persist();
      renderSteps();
      return;
    }
    if (step.id === "sourceAnalysis") {
      addLog("Bước phân tích nguồn cần dòng TỔNG SỐ BATCH ADAPTATION: N. Dùng Đọc câu cuối rồi chạy tiếp.");
      return;
    }
    if (step.id === "batchAdapt") {
      if (!state.adaptBatchTotal) {
        addLog("Chưa có số batch nên không ép được. Chạy bước phân tích nguồn trước.");
        return;
      }
      const last = (state.adaptBatchDone || 0) + 1 >= state.adaptBatchTotal;
      const id = last ? "ADAPT_BATCH_ALL" : "ADAPT_BATCH_NEXT";
      applySignal(step, CATALOG.find((s) => s.id === id), "");
      persist();
      renderSteps();
      return;
    }
    const pass = (step.allowed || []).find((id) => {
      const item = CATALOG.find((s) => s.id === id);
      return item && (item.kind === "xong" || item.kind === "dat" || item.kind === "done");
    });
    if (!pass) {
      if (step.afterIdle) {
        state.stepId = step.afterIdle;
        addLog("Ép xong bước sửa, chuyển sang QA.");
      }
    } else {
      applySignal(step, CATALOG.find((s) => s.id === pass), "");
    }
    persist();
    renderSteps();
  });

  els.btnForceFail.addEventListener("click", () => {
    const step = STEP_MAP[state.stepId];
    const fail = (step.allowed || []).find((id) => CATALOG.find((s) => s.id === id)?.kind === "chua");
    if (!fail) {
      addLog("Bước này không có nhánh CHƯA ĐẠT.");
      return;
    }
    applySignal(step, CATALOG.find((s) => s.id === fail), "");
    persist();
    renderSteps();
  });

  els.btnClearLog.addEventListener("click", () => {
    state.log = [];
    renderLog();
    persist();
  });

  els.fileName.addEventListener("change", () => {
    state.fileName = normalizeFileName(els.fileName.value);
    persist();
  });

  els.condensePercent.addEventListener("change", () => {
    readForm();
    persist();
    renderSteps();
  });
  els.condensePercent.addEventListener("blur", () => {
    readForm();
    persist();
  });
  els.waitMinutes.addEventListener("change", () => {
    readForm();
    persist();
  });
  els.waitMinutes.addEventListener("blur", () => {
    readForm();
    persist();
  });

  els.doLatin.addEventListener("change", () => {
    readForm();
    persist();
    renderSteps();
  });

  els.startStep.addEventListener("change", () => {
    state.startStep = els.startStep.value;
    persist();
  });

  els.refFileName.addEventListener("change", () => {
    readForm();
    persist();
    renderSteps();
  });
  els.refFileName.addEventListener("input", () => {
    state.refFileName = String(els.refFileName.value || "").trim();
    renderSteps();
  });

  els.refFile.addEventListener("change", async () => {
    const file = els.refFile.files && els.refFile.files[0];
    if (!file) {
      state.refFileText = "";
      persist();
      renderSteps();
      return;
    }
    if (!String(els.refFileName.value || "").trim()) {
      els.refFileName.value = file.name;
    }
    try {
      state.refFileText = await file.text();
    } catch (err) {
      addLog(`Không đọc được file tham khảo: ${err.message || err}`);
      state.refFileText = "";
    }
    readForm();
    persist();
    renderSteps();
  });

  els.totalLines.addEventListener("change", () => {
    state.totalLines = normalizeTotalLines(els.totalLines.value);
    persist();
    renderSteps();
  });

  chrome.storage.local.get("pipelineState", ({ pipelineState }) => {
    if (pipelineState) {
      state = { ...createState(), ...pipelineState, running: false, paused: false };
      if (state.fileName) els.fileName.value = String(state.fileName).replace(/\.txt$/i, "");
      if (state.totalLines) els.totalLines.value = String(state.totalLines);
    }
    if (["jpConvert", "jpQa", "jpFix"].includes(state.stepId) || (state.stepId && !STEP_MAP[state.stepId])) {
      state.stepId = "sourceAnalysis";
    }
    if (["jpConvert", "jpQa", "jpFix"].includes(state.startStep)) state.startStep = "";
    state.adaptBatchTotal = Number(state.adaptBatchTotal) || 0;
    state.adaptBatchDone = Number(state.adaptBatchDone) || 0;
    state.condensePercent = normalizePercent(state.condensePercent);
    if (els.condensePercent) els.condensePercent.value = String(state.condensePercent);
    if (pipelineState && pipelineState.waitMinutes == null) state.waitMinutes = 60;
    state.waitMinutes = normalizeWaitMinutes(state.waitMinutes);
    state.timeoutMs = state.waitMinutes * 60 * 1000;
    if (els.waitMinutes) els.waitMinutes.value = String(state.waitMinutes);
    if (els.doLatin) els.doLatin.checked = !!state.doLatin;
    if (els.refFileName) els.refFileName.value = state.refFileName || "";
    renderSteps();
    renderLog();
    refreshTabStatus();
  });
})();
