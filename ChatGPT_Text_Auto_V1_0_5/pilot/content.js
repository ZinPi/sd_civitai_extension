(() => {
  const CONTENT_VERSION = "1.8.4";
  window.__lnPipelineGen = (window.__lnPipelineGen || 0) + 1;
  const myGen = window.__lnPipelineGen;
  window.__lnPipelineContent = CONTENT_VERSION;

  function isLive() {
    return window.__lnPipelineGen === myGen;
  }

  const COMPOSER_SELECTORS = [
    "#prompt-textarea",
    'form[data-chatgpt-composer] .ProseMirror[contenteditable="true"]',
    'form[data-type="unified-composer"] #prompt-textarea',
    'div[contenteditable="true"][data-id="root"]',
    '[contenteditable="true"][role="textbox"]',
    "textarea#prompt-textarea",
    'textarea[data-id="root"]',
  ];

  const SEND_SELECTORS = [
    'button[data-testid="send-button"]',
    "#composer-submit-button[data-testid='send-button']",
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'form[data-chatgpt-composer] button[aria-label="Send"]',
    "button.composer-submit-btn",
    'button[aria-label*="Send prompt"]',
    'button[aria-label="Gửi prompt"]',
    'button[aria-label="Gửi tin nhắn"]',
    'button[aria-label*="Gửi prompt"]',
  ];

  const LOGIN_SELECTORS = [
    'button[data-testid="login-button"]',
    'a[href*="/auth/login"]',
    'button[data-testid="welcome-login-button"]',
  ];

  const ASSISTANT_SELECTORS = [
    '[data-message-author-role="assistant"]',
    '[data-turn="assistant"]',
    'section[data-turn="assistant"]',
    'article[data-turn="assistant"]',
    '[data-testid^="conversation-turn-"][data-turn="assistant"]',
    '[data-testid="assistant-turn"]',
  ];

  const PROMPT_MARKERS = [
    "CUỐI CÂU TRẢ LỜI BẮT BUỘC",
    "TÁC PHẨM GỐC:",
    "TOOL ĐÃ GHI NHỚ TỪ BƯỚC CHIA DÒNG",
  ];

  let abortWait = false;
  let sendCycle = {
    genStarted: false,
    beforeReply: "",
    sent: false,
  };

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  }

  function first(selectors) {
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      for (const n of nodes) {
        if (visible(n)) return n;
      }
    }
    return null;
  }

  function composer() {
    return first(COMPOSER_SELECTORS);
  }

  function submitButton() {
    return (
      document.querySelector("#composer-submit-button") ||
      first([
        'button[data-testid="stop-button"]',
        'button[data-testid="send-button"]',
        ...SEND_SELECTORS,
      ])
    );
  }

  function sendButton() {
    const btn = submitButton();
    if (btn && !isStopButton(btn)) return btn;
    return first(SEND_SELECTORS);
  }

  function sendEnabled() {
    const btn = sendButton();
    if (!btn) return false;
    return !btn.disabled && btn.getAttribute("aria-disabled") !== "true";
  }

  function fold(s) {
    return String(s || "")
      .normalize("NFC")
      .replace(/[\u200b\u200c\u200d\ufeff\u00ad]/g, "")
      .replace(/[\u201c\u201d\u00ab\u00bb]/g, '"')
      .replace(/\s+/g, " ")
      .trim();
  }

  function isStopButton(el) {
    if (!el) return false;
    const id = (el.getAttribute("data-testid") || "").toLowerCase();
    const label = (el.getAttribute("aria-label") || "").toLowerCase();
    const title = (el.getAttribute("title") || "").toLowerCase();
    const hay = `${id} ${label} ${title}`;
    if (id === "stop-button") return true;
    if (/stop (streaming|generating|response|thinking)/i.test(hay)) return true;
    if (/(dừng|huỷ|hủy).*(stream|tạo|viết|trả lời|suy nghĩ|phản hồi)/i.test(hay)) return true;
    if (/^(dừng|ngừng|stop)$/i.test(label.trim())) return true;
    if (/ngừng/i.test(hay)) return true;
    return false;
  }

  function composerControlRoot() {
    const c = composer();
    if (!c) return null;
    return c.closest("form") || c.closest("[data-composer-body]") || c.parentElement;
  }

  function findStopControl() {
    const root = composerControlRoot();
    if (!root) return null;
    const nodes = root.querySelectorAll(
      [
        "#composer-submit-button",
        'button[data-testid="stop-button"]',
        'button[data-testid*="stop"]',
        'button[aria-label*="Stop" i]',
        'button[aria-label*="Dừng" i]',
        'button[aria-label*="Ngừng" i]',
        'button[aria-label*="Huỷ" i]',
        'button[aria-label*="Hủy" i]',
      ].join(",")
    );
    for (const n of nodes) {
      if (visible(n) && isStopButton(n) && n.getAttribute("aria-disabled") !== "true" && !n.disabled) return n;
    }
    return (
      [...root.querySelectorAll("button")].find(
        (x) =>
          visible(x) &&
          /stop generating|stop response|stop streaming|dừng tạo|dừng phản hồi|ngừng/i.test(
            `${x.getAttribute("aria-label") || ""} ${x.getAttribute("title") || ""} ${x.innerText || ""}`
          )
      ) || null
    );
  }

  function isGenerating() {
    if (typeof __lnIsGenerating === "function") return __lnIsGenerating();
    return !!findStopControl();
  }

  function loggedIn() {
    if (first(LOGIN_SELECTORS) && !composer()) return false;
    if (location.pathname.startsWith("/auth")) return false;
    return !!composer();
  }

  function nodeText(el) {
    if (!el) return "";
    return ((el.innerText || el.textContent || "") + "").replace(/\u00a0/g, " ").trim();
  }

  function queryAll(selectors) {
    const seen = new Set();
    const out = [];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((n) => {
        if (!seen.has(n)) {
          seen.add(n);
          out.push(n);
        }
      });
    }
    return out;
  }

  function looksLikePrompt(text) {
    const t = String(text || "");
    return PROMPT_MARKERS.some((m) => t.includes(m));
  }

  function assistantTurns() {
    const nodes = queryAll(ASSISTANT_SELECTORS).filter((el) => {
      if (!el || el.closest("form")) return false;
      if (el.closest('[data-message-author-role="user"]') && !el.matches('[data-message-author-role="assistant"]')) {
        return false;
      }
      return true;
    });
    return nodes.filter((el) => !nodes.some((other) => other !== el && other.contains(el)));
  }

  function lastAssistantTurn() {
    const turns = assistantTurns();
    return turns[turns.length - 1] || null;
  }

  function textFromCopyBar() {
    const copies = [
      ...document.querySelectorAll(
        'button[data-testid="copy-turn-action-button"], button[aria-label*="Copy response" i], button[aria-label*="Sao chép" i], button[aria-label="Copy"]'
      ),
    ].filter((b) => visible(b) && !b.closest("form"));
    const copy = copies[copies.length - 1];
    if (!copy) return "";
    const turn = copy.closest(ASSISTANT_SELECTORS.join(","));
    if (turn) return nodeText(turn);
    let el = copy.parentElement;
    let best = "";
    for (let i = 0; i < 16 && el && el !== document.body; i++) {
      if (el.matches("main, form, body")) break;
      const t = nodeText(el);
      if (t.length > best.length && t.length < 500000) best = t;
      el = el.parentElement;
    }
    return best;
  }

  function scrapeReply() {
    const turn = lastAssistantTurn();
    if (turn) {
      const t = nodeText(turn);
      if (t.length > 20 && !looksLikePrompt(t)) return t;
      if (t.length > 20) return t;
    }
    const fromCopy = textFromCopyBar();
    if (fromCopy.length > 40 && !looksLikePrompt(fromCopy)) return fromCopy;
    const main = document.querySelector("main");
    if (!main) return fromCopy || "";
    const form = document.querySelector("form");
    let t = nodeText(main);
    const ft = form ? nodeText(form) : "";
    if (ft && t.includes(ft)) t = t.replace(ft, "");
    return t.trim();
  }

  function clip(text) {
    const s = String(text || "");
    return s.length > 160000 ? s.slice(-160000) : s;
  }

  function phraseInText(text, phrases) {
    const hay = fold(text);
    if (!hay) return false;
    return (phrases || []).some((p) => {
      const needle = fold(p);
      return needle && hay.includes(needle);
    });
  }

  function composerText() {
    const el = composer();
    if (!el) return "";
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      return String(el.value || "")
        .replace(/[\u200b\ufeff]/g, "")
        .trim();
    }
    return nodeText(el)
      .replace(/[\u200b\ufeff]/g, "")
      .replace(/^(Ask anything|Hỏi ChatGPT|Message ChatGPT)\s*/i, "")
      .trim();
  }

  function composerPending() {
    return composerText().length > 80;
  }

  function hasCopyOnLastTurn() {
    const turn = lastAssistantTurn();
    if (!turn) return false;
    return !!turn.querySelector(
      'button[data-testid="copy-turn-action-button"], button[aria-label*="Copy" i], button[aria-label*="Sao chép" i]'
    );
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function fillComposer(text) {
    const el = composer();
    if (!el) throw new Error("Không tìm thấy ô chat ChatGPT.");
    el.focus();
    el.click();
    await sleep(80);

    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      setNativeValue(el, text);
      return;
    }

    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);

    const inserted = document.execCommand("insertText", false, text);
    if (!inserted || !(el.innerText || "").trim()) {
      el.textContent = "";
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        })
      );
    }

    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
  }

  async function clickSend() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (sendEnabled()) {
        sendButton().click();
        return;
      }
      await sleep(150);
    }
    const el = composer();
    if (el) {
      el.focus();
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
        })
      );
    }
    await sleep(400);
    if (sendEnabled()) sendButton()?.click();
  }

  async function waitWhileGenerating(timeoutMs) {
    const start = Date.now();
    while (isGenerating()) {
      if (abortWait) throw new Error("Đã dừng chờ.");
      if (Date.now() - start > timeoutMs) {
        throw new Error("ChatGPT còn đang trả lời. Không gửi lệnh mới đè lên.");
      }
      sendCycle.genStarted = true;
      await sleep(400);
    }
  }

  async function sendPrompt(text, expectPhrases) {
    abortWait = false;
    if (!loggedIn()) throw new Error("Tab ChatGPT chưa đăng nhập hoặc chưa mở ô chat.");
    await waitWhileGenerating(12 * 1000);

    sendCycle.beforeReply = scrapeReply();
    sendCycle.genStarted = false;
    sendCycle.sent = false;

    await fillComposer(text);
    await sleep(250);
    await clickSend();

    const giveUp = Date.now() + 25000;
    while (Date.now() < giveUp) {
      if (isGenerating()) sendCycle.genStarted = true;
      const pending = composerPending();
      if (!pending) {
        sendCycle.sent = true;
        break;
      }
      if (!isGenerating() && sendEnabled()) await clickSend();
      await sleep(300);
    }

    if (composerPending() && !isGenerating()) {
      throw new Error("Ô chat còn nguyên lệnh, ChatGPT chưa nhận tin.");
    }

    sendCycle.sent = true;
    await sleep(800);
    return {
      ok: true,
      generating: isGenerating(),
      beforeReply: clip(sendCycle.beforeReply),
      genStarted: sendCycle.genStarted,
    };
  }

  function waitReasons(st) {
    const reasons = [];
    if (st.generating) reasons.push("còn nút dừng");
    else reasons.push("không còn nút dừng");
    if (st.composerPending) reasons.push("ô chat còn lệnh");
    if (!st.phraseHit) reasons.push("chưa thấy câu chốt ở tin trợ lý");
    else reasons.push("đã thấy câu chốt");
    if (st.promptEcho) reasons.push("đang đọc nhầm lệnh vừa gửi");
    if (!st.replyChanged) reasons.push("chưa có tin trợ lý mới");
    if (st.copyReady) reasons.push("đã có nút sao chép");
    return reasons.join(" · ");
  }

  function readState(expectPhrases) {
    if (isGenerating()) sendCycle.genStarted = true;
    const reply = scrapeReply();
    const promptEcho = looksLikePrompt(reply);
    const phraseHit = !promptEcho && phraseInText(reply, expectPhrases || []);
    const st = {
      ok: true,
      reply: clip(reply),
      generating: isGenerating(),
      genStarted: sendCycle.genStarted,
      replyChanged: !!reply && reply !== sendCycle.beforeReply,
      composerPending: composerPending(),
      phraseHit,
      promptEcho,
      copyReady: hasCopyOnLastTurn(),
      loggedIn: loggedIn(),
      hasComposer: !!composer(),
      lastChars: (reply || "").slice(-160),
    };
    st.waitHint = waitReasons(st);
    return st;
  }

  function status() {
    return {
      ok: true,
      version: CONTENT_VERSION,
      url: location.href,
      loggedIn: loggedIn(),
      hasComposer: !!composer(),
      generating: isGenerating(),
      lastChars: scrapeReply().slice(-80),
    };
  }

  let activePilotTurn = null;

  async function waitPilotReply(turn, timeoutMs, emit) {
    const stableMs = 5000;
    let remaining = Math.max(60000, Number(timeoutMs) || 60 * 60 * 1000);
    let lastTick = Date.now();
    let last = "";
    let lastKey = "";
    let lastChange = Date.now();
    let sawNew = false;
    let lastBeat = 0;
    const baseline = turn?.baseline || {};
    while (remaining > 0) {
      if (abortWait) throw new Error("STOPPED_BY_USER");
      const now = Date.now();
      const dt = Math.max(0, now - lastTick);
      lastTick = now;
      if (!document.hidden) remaining -= dt;
      const st =
        typeof __lnReadPage === "function"
          ? __lnReadPage([], baseline)
          : readState([]);
      if (st?.sawNew) sawNew = true;
      const candidate = String(st?.reply || "");
      const candidateKey = String(st?.candidateKey || "");
      if (candidate && (candidate !== last || candidateKey !== lastKey)) {
        last = candidate;
        lastKey = candidateKey;
        lastChange = now;
      }
      const generating = !!st?.generating;
      const composerReady = st?.composerReady !== false;
      const stableFor = now - lastChange;
      if (now - lastBeat >= 2000) {
        lastBeat = now;
        await emit({
          kind: "PROGRESS",
          phase: "WAIT_RESPONSE",
          verification: `pilotWait chars=${last.length} generating=${generating} stable=${Math.round(stableFor / 100) / 10}s hidden=${document.hidden}`,
        });
      }
      if (sawNew && last && !generating && composerReady && stableFor >= stableMs) return last;
      await sleep(document.hidden ? 750 : 300);
    }
    throw new Error("RESPONSE_TIMEOUT_NO_SAFE_ADVANCE");
  }

  async function runPilotTurn(turn, settings) {
    const emit = (e) =>
      chrome.runtime.sendMessage({ type: "TEXT_EVENT", event: { turnId: turn.id, ...e } }).catch(() => null);
    try {
      abortWait = false;
      await emit({ kind: "PROGRESS", phase: "PASTE_SEND", verification: "dán lệnh vào ô chat ngay, không chờ idle" });
      let sent;
      if (typeof __lnSendPrompt === "function") sent = await __lnSendPrompt(turn.prompt || "");
      else sent = await sendPrompt(turn.prompt || "", []);
      if (sent?.ok === false) throw new Error(sent.error || "SEND_FAILED");
      turn.baseline = sent?.baseline || sent || {};
      await emit({
        kind: "SENT",
        method: "PILOT_FILL_SEND",
        baseline: turn.baseline,
        verification: "đã dán và bấm gửi",
      });
      const timeoutMs = Math.max(60000, Number(settings?.responseTimeoutMin || 60) * 60000);
      const reply = await waitPilotReply(turn, timeoutMs, emit);
      await emit({ kind: "DONE", text: reply, method: "PILOT_ASSISTANT_DONE" });
    } catch (err) {
      await emit({ kind: "FAILED", error: String(err?.message || err) });
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!isLive()) return false;
    (async () => {
      if (msg?.type === "PING") return status();
      if (msg?.type === "GET_STATUS") return status();
      if (msg?.type === "STOP_WAIT" || msg?.type === "ABORT_TEXT_AUTO") {
        abortWait = true;
        activePilotTurn = null;
        return { ok: true };
      }
      if (msg?.type === "READ_LAST") {
        return readState(msg.expectPhrases || []);
      }
      if (msg?.type === "CLICK_SEND") {
        await clickSend();
        return { ok: true, generating: isGenerating(), composerPending: composerPending() };
      }
      if (msg?.type === "SEND_PROMPT") {
        return sendPrompt(msg.text, msg.expectPhrases || []);
      }
      if (msg?.type === "RUN_PILOT_TURN") {
        if (activePilotTurn) return { ok: false, error: "TURN_ALREADY_ACTIVE" };
        abortWait = false;
        activePilotTurn = msg.turn;
        runPilotTurn(msg.turn, msg.settings || {}).finally(() => {
          if (activePilotTurn?.id === msg.turn?.id) activePilotTurn = null;
        });
        return { ok: true };
      }
      if (msg?.type === "SEND_AND_WAIT") {
        await sendPrompt(msg.text, msg.expectPhrases || []);
        const start = Date.now();
        const timeoutMs = msg.timeoutMs || 60 * 60 * 1000;
        while (Date.now() - start < timeoutMs) {
          if (abortWait) throw new Error("Đã dừng chờ.");
          const st = readState(msg.expectPhrases || []);
          if (!st.generating && !st.promptEcho && (st.phraseHit || (st.replyChanged && st.reply && st.reply.length > 80))) {
            await sleep(1500);
            const again = readState(msg.expectPhrases || []);
            if (!again.generating && (again.phraseHit || again.reply)) return again;
          }
          await sleep(800);
        }
        throw new Error("Hết giờ chờ ChatGPT.");
      }
      return undefined;
    })()
      .then((result) => {
        if (result !== undefined) sendResponse(result);
      })
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return [
      "PING",
      "GET_STATUS",
      "STOP_WAIT",
      "READ_LAST",
      "CLICK_SEND",
      "SEND_PROMPT",
      "SEND_AND_WAIT",
      "RUN_PILOT_TURN",
      "ABORT_TEXT_AUTO",
    ].includes(msg?.type);
  });
})();
