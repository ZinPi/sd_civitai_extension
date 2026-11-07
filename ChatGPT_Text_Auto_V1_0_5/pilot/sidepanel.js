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
    hasRefDoc,
    startStepId,
    shouldResume,
    visibleSteps,
    createState,
    currentBatch,
  } = LN_MACHINE;

  const els = {
    runBadge: document.getElementById("runBadge"),
    tabStatus: document.getElementById("tabStatus"),
    fileName: document.getElementById("fileName"),
    condensePercent: document.getElementById("condensePercent"),
    waitMinutes: document.getElementById("waitMinutes"),
    doLatin: document.getElementById("doLatin"),
    doVideo: document.getElementById("doVideo"),
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
  let formDirty = false;
  let focused = "";

  function msg(payload) {
    if (!chrome?.runtime?.sendMessage) return Promise.resolve({ ok: false, error: "NO_EXTENSION_RUNTIME" });
    return chrome.runtime.sendMessage(payload);
  }

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

  function liveSteps() {
    return visibleSteps(state).filter((s) => s.id !== "done");
  }

  function stepIndex(id) {
    return liveSteps().findIndex((s) => s.id === id);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function readForm() {
    const cfg = {
      condensePercent: normalizePercent(els.condensePercent && els.condensePercent.value),
      waitMinutes: normalizeWaitMinutes(els.waitMinutes && els.waitMinutes.value),
      doLatin: !!(els.doLatin && els.doLatin.checked),
      doVideo: !!(els.doVideo && els.doVideo.checked),
      refFileName: String((els.refFileName && els.refFileName.value) || state.refFileName || "").trim(),
      startStep: els.startStep && els.startStep.value ? els.startStep.value : state.startStep,
      fileName: normalizeFileName((els.fileName && els.fileName.value) || state.fileName),
      totalLines: normalizeTotalLines((els.totalLines && els.totalLines.value) || state.totalLines),
      refFileText: state.refFileText || "",
    };
    if (els.condensePercent) els.condensePercent.value = String(cfg.condensePercent);
    if (els.waitMinutes) els.waitMinutes.value = String(cfg.waitMinutes);
    if (els.refFileHint) {
      const preview = { refFileName: cfg.refFileName, refFileText: cfg.refFileText };
      els.refFileHint.textContent = hasRefDoc(preview)
        ? `Sẽ gửi tài liệu ${cfg.refFileName || "đã chọn"} trước Bước 1, chờ câu ĐÃ CẬP NHẬT ĐẦY ĐỦ DỮ LIỆU THAM KHẢO.`
        : "Để trống thì chạy bình thường từ Bước 1. Có file thì tool gửi file đó trước, chờ câu ĐÃ CẬP NHẬT ĐẦY ĐỦ DỮ LIỆU THAM KHẢO.";
    }
    return cfg;
  }

  function pushConfig() {
    const config = readForm();
    Object.assign(state, config);
    return msg({ type: "UPDATE_PILOT_CONFIG", config });
  }

  function applyFormFromState(next) {
    if (focused !== "fileName" && els.fileName && next.fileName) {
      els.fileName.value = String(next.fileName).replace(/\.txt$/i, "");
    }
    if (focused !== "totalLines" && els.totalLines) {
      els.totalLines.value = next.totalLines ? String(next.totalLines) : "";
    }
    if (focused !== "condensePercent" && els.condensePercent) {
      els.condensePercent.value = String(normalizePercent(next.condensePercent));
    }
    if (focused !== "waitMinutes" && els.waitMinutes) {
      els.waitMinutes.value = String(normalizeWaitMinutes(next.waitMinutes));
    }
    if (focused !== "doLatin" && els.doLatin) els.doLatin.checked = !!next.doLatin;
    if (focused !== "doVideo" && els.doVideo) els.doVideo.checked = !!next.doVideo;
    if (focused !== "refFileName" && els.refFileName) els.refFileName.value = next.refFileName || "";
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

  function renderLog() {
    els.logList.innerHTML = (state.log || [])
      .map((item) => `<li><span class="time">${escapeHtml(item.time)}</span>${escapeHtml(item.message)}</li>`)
      .join("");
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
    if (focused !== "startStep" && els.startStep.value !== state.startStep) els.startStep.value = state.startStep;
  }

  function renderSteps() {
    renderStartOptions();
    const current = stepIndex(state.stepId);
    let lastGroup = "";
    els.stepList.innerHTML = liveSteps()
      .map((s, i) => {
        const stuck = s.id === state.stepId && state.lastError && !state.running;
        const cls = [s.id === state.stepId ? "active" : "", i < current ? "done" : "", stuck ? "stuck" : ""]
          .filter(Boolean)
          .join(" ");
        const groupName = state.doVideo && s.id === "promptBatch" ? "6. Prompt video" : s.group;
        const stepTitle =
          state.doVideo && s.id === "promptBatch" ? "Tạo / QA prompt video từng dòng" : s.title;
        const group = groupName !== lastGroup ? `<span class="group">${escapeHtml(groupName)}</span>` : "";
        lastGroup = groupName;
        return `<li class="${cls}">${group}${escapeHtml(stepTitle)}</li>`;
      })
      .join("");
    const step = STEP_MAP[state.stepId];
    const stepTitle =
      step && state.doVideo && step.id === "promptBatch" ? "Tạo / QA prompt video từng dòng" : step?.title;
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
    const waitNote = state.running && !state.paused && state.lastVerification ? ` · ${state.lastVerification}` : "";
    els.nowText.textContent = !step
      ? "Bước hiện tại: chưa chạy"
      : state.lastError && !state.running
        ? `Dừng ở: ${stepTitle}${progress}. Chạy tiếp gửi lại đúng bước này.${signalNote}`
        : resume && !state.running
          ? `Đã đến: ${stepTitle}${progress}. Chạy tiếp làm tiếp bước này.${signalNote}`
          : `Bước hiện tại: ${stepTitle}${progress}${signalNote}${waitNote}`;
    if (els.resumeHint) {
      els.resumeHint.textContent =
        resume && !state.running
          ? "Tool nhớ bước đang dừng. Chạy tiếp không quay về đầu. Muốn làm lại từ bước đầu thì bấm Chạy lại từ đầu. Đóng panel không dừng pipeline."
          : "Đóng panel hoặc đổi tab không dừng pipeline — background cầm lệnh giống tab Văn bản / Tạo ảnh.";
    }
    els.btnStart.textContent = state.running && !state.paused ? "Gửi lại vào ô chat" : resume ? "Chạy tiếp" : "Chạy pipeline";
    els.btnStart.disabled = false;
    els.btnPause.disabled = !state.running || state.paused;
    els.btnStop.disabled = false;
    setBadge();
    if (els.refFileHint) readForm();
  }

  function applyState(next) {
    if (!next || typeof next !== "object") return;
    const keepText = state.refFileText;
    state = { ...createState(), ...next };
    if (!state.refFileText && keepText) state.refFileText = keepText;
    if (!formDirty) applyFormFromState(state);
    renderSteps();
    renderLog();
  }

  async function refresh() {
    const r = await msg({ type: "GET_PILOT_STATE" }).catch(() => null);
    if (r?.ok && r.state) applyState(r.state);
  }

  async function findTab() {
    const res = await withTimeout(msg({ type: "FIND_CHATGPT" }), 8000, "Hết giờ tìm tab ChatGPT.");
    return res?.tab || null;
  }

  async function openChatGPT() {
    const res = await msg({ type: "OPEN_CHATGPT" });
    return res?.tab || null;
  }

  async function refreshTabStatus() {
    try {
      const tab = state.tabId ? { id: state.tabId } : await findTab();
      if (!tab?.id) {
        els.tabStatus.textContent = "Chưa thấy tab ChatGPT.";
        return;
      }
      state.tabId = tab.id;
      await msg({ type: "ENSURE_CONTENT", tabId: tab.id }).catch(() => null);
      const st = await withTimeout(
        chrome.tabs.sendMessage(tab.id, { type: "GET_STATUS" }),
        8000,
        "Hết giờ gọi tab ChatGPT."
      );
      if (!st?.loggedIn) {
        els.tabStatus.textContent = "Đã mở tab nhưng chưa đăng nhập. Hãy login trên chatgpt.com.";
        return;
      }
      els.tabStatus.textContent = st.generating
        ? "Đã kết nối · ChatGPT đang trả lời…"
        : state.running && !state.paused
          ? "Đã kết nối · pipeline đang chạy ở background."
          : "Đã kết nối · đã đăng nhập.";
    } catch (err) {
      const message = err?.message || "";
      els.tabStatus.textContent = /đóng băng|Không còn tab/i.test(message)
        ? message
        : "Chưa gắn được script vào tab. Bấm vào tab ChatGPT, F5, rồi bấm Kết nối tab.";
    }
  }

  async function tabIdOrThrow() {
    const tab = state.tabId ? { id: state.tabId } : await findTab();
    if (!tab?.id) throw new Error("Không có tab ChatGPT. Bấm Kết nối tab hoặc Mở ChatGPT.");
    state.tabId = tab.id;
    await msg({ type: "SET_PILOT_TAB", tabId: tab.id });
    return tab.id;
  }

  async function startFrom(fromCurrent, restart) {
    try {
      const tabId = await tabIdOrThrow();
      const config = readForm();
      const type = fromCurrent && state.paused ? "RESUME_PILOT" : "START_PILOT";
      const r = await msg({ type, tabId, fromCurrent, restart, config });
      if (!r?.ok) throw new Error(r?.error || "Không chạy được pipeline.");
      await refresh();
    } catch (err) {
      els.tabStatus.textContent = err.message || String(err);
    }
  }

  els.btnConnect.addEventListener("click", async () => {
    const tab = await findTab();
    if (!tab) {
      els.tabStatus.textContent = "Chưa có tab ChatGPT. Bấm Mở ChatGPT.";
      return;
    }
    state.tabId = tab.id;
    await msg({ type: "SET_PILOT_TAB", tabId: tab.id });
    await refreshTabStatus();
  });

  els.btnOpen.addEventListener("click", async () => {
    const tab = await openChatGPT();
    state.tabId = tab?.id || null;
    if (tab?.id) await msg({ type: "SET_PILOT_TAB", tabId: tab.id });
    setTimeout(refreshTabStatus, 1200);
  });

  els.btnStart.addEventListener("click", async () => {
    if (state.running && !state.paused) {
      try {
        const tabId = await tabIdOrThrow();
        await msg({ type: "RESEND_PILOT", tabId, config: readForm() });
        await refresh();
      } catch (err) {
        els.tabStatus.textContent = err.message || String(err);
      }
      return;
    }
    if (state.paused) return startFrom(true, false);
    startFrom(shouldResume(state), false);
  });

  els.btnRestart.addEventListener("click", () => {
    const config = readForm();
    state.startStep = startStepId(config);
    if (els.startStep) els.startStep.value = state.startStep;
    startFrom(false, true);
  });

  els.btnPause.addEventListener("click", async () => {
    await msg({ type: "PAUSE_PILOT" });
    await refresh();
  });

  els.btnStop.addEventListener("click", async () => {
    await msg({ type: "STOP_PILOT" });
    await refresh();
  });

  els.btnResend.addEventListener("click", async () => {
    try {
      const tabId = await tabIdOrThrow();
      await msg({ type: "RESEND_PILOT", tabId, config: readForm() });
      await refresh();
    } catch (err) {
      els.tabStatus.textContent = err.message || String(err);
    }
  });

  els.btnReadLast.addEventListener("click", async () => {
    const r = await msg({ type: "READ_PILOT_LAST" });
    if (!r?.ok) els.tabStatus.textContent = r?.error || "Không đọc được câu cuối.";
    await refresh();
  });

  els.btnForceNext.addEventListener("click", async () => {
    await msg({ type: "FORCE_PILOT_NEXT" });
    await refresh();
  });

  els.btnForceFail.addEventListener("click", async () => {
    await msg({ type: "FORCE_PILOT_FAIL" });
    await refresh();
  });

  els.btnClearLog.addEventListener("click", async () => {
    await msg({ type: "CLEAR_PILOT_LOG" });
    await refresh();
  });

  function bindForm(el, key) {
    if (!el) return;
    el.addEventListener("focus", () => {
      focused = key;
      formDirty = true;
    });
    el.addEventListener("blur", () => {
      focused = "";
      formDirty = false;
      pushConfig();
    });
    el.addEventListener("change", () => {
      pushConfig();
      renderSteps();
    });
  }

  bindForm(els.fileName, "fileName");
  bindForm(els.condensePercent, "condensePercent");
  bindForm(els.waitMinutes, "waitMinutes");
  bindForm(els.doLatin, "doLatin");
  bindForm(els.doVideo, "doVideo");
  bindForm(els.startStep, "startStep");
  bindForm(els.refFileName, "refFileName");
  bindForm(els.totalLines, "totalLines");

  els.refFileName.addEventListener("input", () => {
    state.refFileName = String(els.refFileName.value || "").trim();
    renderSteps();
  });

  els.refFile.addEventListener("change", async () => {
    const file = els.refFile.files && els.refFile.files[0];
    if (!file) {
      state.refFileText = "";
      await pushConfig();
      renderSteps();
      return;
    }
    if (!String(els.refFileName.value || "").trim()) els.refFileName.value = file.name;
    try {
      state.refFileText = await file.text();
    } catch (err) {
      state.refFileText = "";
      els.tabStatus.textContent = `Không đọc được file tham khảo: ${err.message || err}`;
    }
    await pushConfig();
    renderSteps();
  });

  chrome.storage.local.get("pipelineState", ({ pipelineState }) => {
    if (pipelineState) applyState(pipelineState);
    else {
      renderSteps();
      renderLog();
    }
    refresh();
    refreshTabStatus();
    setInterval(refresh, 1200);
    setInterval(refreshTabStatus, 4000);
  });
})();
