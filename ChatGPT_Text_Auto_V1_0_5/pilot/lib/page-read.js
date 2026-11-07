/**
 * ChatGPT wait/done detector adapted from ZinPi/sd_civitai_extension
 * ChatGPT_Text_Auto_V1_0_5 content.js:
 *   DONE = new assistant after sent user + no Stop in current composer + text stable.
 */
(function (root) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) =>
    !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const rawText = (el) => String(el?.innerText ?? el?.textContent ?? "");
  const canon = (s) =>
    String(s ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[\u200b\u200c\u200d\ufeff]/g, "");
  const canonLoose = (s) =>
    canon(s)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .trim();

  function qVisible(selectors) {
    for (const sel of selectors.filter(Boolean)) {
      try {
        const hit = [...document.querySelectorAll(sel)].find(visible);
        if (hit) return hit;
      } catch (_) {
        /* ignore bad selector */
      }
    }
    return null;
  }

  function findComposer(selectors = {}) {
    return qVisible([
      selectors.composer,
      'div.ProseMirror[data-composer-markdown][contenteditable="true"]',
      '[data-composer-markdown][contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][role="textbox"][aria-label="Hỏi ChatGPT"]',
      '[contenteditable="true"][role="textbox"][aria-label="Ask ChatGPT"]',
      "#prompt-textarea",
      'textarea[data-testid="prompt-textarea"]',
      'div[contenteditable="true"][role="textbox"]',
      'form[data-type="unified-composer"] [contenteditable="true"]',
      "#thread-bottom-container [contenteditable=\"true\"]",
    ]);
  }

  function nearestComposerForm(c) {
    return (
      c?.closest?.("form") ||
      qVisible(['form[data-type="unified-composer"]', "#thread-bottom-container form", "main form"])
    );
  }

  function composerControlRoot(selectors = {}) {
    const c = findComposer(selectors);
    if (!c) return null;
    return c.closest?.("form") || c.closest?.("[data-composer-body]") || c.parentElement?.parentElement?.parentElement || null;
  }

  function isDisabled(b) {
    return !b || b.disabled || b.getAttribute("aria-disabled") === "true";
  }

  function findStopButton(selectors = {}) {
    const root = composerControlRoot(selectors);
    if (!root) return null;
    const sels = [
      'button[aria-label="Ngừng"]',
      'button[aria-label="Stop"]',
      'button[data-testid="stop-button"]',
      'button[data-testid*="stop"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="Dừng"]',
      'button[aria-label*="Ngừng"]',
      'button[title*="Stop"]',
    ];
    for (const sel of sels) {
      try {
        const b = [...root.querySelectorAll(sel)].find((x) => visible(x) && !isDisabled(x));
        if (b) return b;
      } catch (_) {
        /* ignore */
      }
    }
    return (
      [...root.querySelectorAll("button")].find((x) =>
        visible(x) &&
        !isDisabled(x) &&
        /stop generating|stop response|stop streaming|dừng tạo|dừng phản hồi|ngừng/i.test(
          `${x.getAttribute("aria-label") || ""} ${x.getAttribute("title") || ""} ${rawText(x)}`
        )
      ) || null
    );
  }

  function findSendButton(selectors = {}) {
    const c = findComposer(selectors);
    const form = nearestComposerForm(c);
    const local = (s) => {
      if (!form) return null;
      try {
        return [...form.querySelectorAll(s)].find(visible) || null;
      } catch (_) {
        return null;
      }
    };
    for (const sel of [
      'button[type="submit"][aria-label="Gửi"]',
      'button[type="submit"][aria-label="Send"]',
      "#composer-submit-button",
      'button[data-testid="send-button"]',
      'button[aria-label*="Send prompt"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="Gửi"]',
      "button.composer-submit-btn",
      'button[type="submit"]',
    ]) {
      const b = local(sel) || qVisible([sel]);
      if (b && !isDisabled(b) && (b.getAttribute("data-testid") || "") !== "stop-button") return b;
    }
    return null;
  }

  function uniqueNodes(nodes) {
    const out = [];
    const seen = new Set();
    for (const n of nodes) {
      if (n && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
    return out;
  }

  function turnKey(el) {
    if (!el) return "";
    const direct = String(
      el.getAttribute?.("data-chatgpt-search-unit-key") || el.getAttribute?.("data-content-search-unit-key") || ""
    );
    if (direct) return direct;
    const nested = el.querySelector?.("[data-chatgpt-search-unit-key],[data-content-search-unit-key]");
    return String(
      nested?.getAttribute?.("data-chatgpt-search-unit-key") ||
        nested?.getAttribute?.("data-content-search-unit-key") ||
        ""
    );
  }

  function conversationTurnNodes() {
    try {
      const current = [
        ...document.querySelectorAll(
          '[data-chatgpt-search-unit-key$=":user"],[data-chatgpt-search-unit-key$=":assistant"]'
        ),
      ];
      if (current.length) return uniqueNodes(current);
    } catch (_) {
      /* ignore */
    }
    const all = [];
    for (const sel of [
      'article[data-testid^="conversation-turn-"]',
      '[data-testid^="conversation-turn-"]',
      "article[data-turn]",
      '[data-turn="user"]',
      '[data-turn="assistant"]',
      "[data-message-author-role]",
    ]) {
      try {
        all.push(...document.querySelectorAll(sel));
      } catch (_) {
        /* ignore */
      }
    }
    return uniqueNodes(
      all.map(
        (n) =>
          n.closest?.(
            'article[data-testid^="conversation-turn-"],article[data-turn],[data-testid^="conversation-turn-"]'
          ) || n
      )
    );
  }

  function nodeRole(el) {
    if (!el) return "";
    const key = turnKey(el).toLowerCase();
    if (key.endsWith(":assistant")) return "assistant";
    if (key.endsWith(":user")) return "user";
    if (el.matches?.('[data-conversation-role="assistant"]')) return "assistant";
    if (el.matches?.('[data-user-message-bubble="true"]')) return "user";
    const direct = String(el.getAttribute?.("data-turn") || el.getAttribute?.("data-message-author-role") || "").toLowerCase();
    if (direct) return direct;
    const nested = el.querySelector?.("[data-message-author-role]");
    if (nested) return String(nested.getAttribute("data-message-author-role") || "").toLowerCase();
    return "";
  }

  function withFollowingSiblings(el) {
    let text = rawText(el);
    let sib = el ? el.nextElementSibling : null;
    let hops = 0;
    while (sib && hops < 12 && text.length < 200000) {
      const extra = rawText(sib);
      if (extra) text += `\n${extra}`;
      sib = sib.nextElementSibling;
      hops += 1;
    }
    return text;
  }

  function turnText(el) {
    if (!el) return "";
    const role = nodeRole(el);
    if (role === "assistant") {
      const md = el.querySelector?.(
        '[data-markdown-text-style="assistant-message"],[data-message-author-role="assistant"] .markdown,.markdown,[class*="markdown"]'
      );
      const base = md ? rawText(md) : rawText(el);
      return canonLoose(withFollowingSiblings(el).length > base.length ? withFollowingSiblings(el) : base);
    }
    if (role === "user") {
      const bubble = el.matches?.('[data-user-message-bubble="true"]')
        ? el
        : el.querySelector?.('[data-user-message-bubble="true"]');
      if (bubble) return canonLoose(rawText(bubble));
    }
    return canonLoose(rawText(el));
  }

  function addMessageNode(out, n) {
    if (!n) return;
    for (const o of out) {
      if (o === n || o.contains?.(n)) return;
    }
    for (let i = out.length - 1; i >= 0; i--) {
      if (n.contains?.(out[i])) out.splice(i, 1);
    }
    out.push(n);
  }

  function sortDom(nodes) {
    return [...nodes].sort((a, b) => {
      if (a === b) return 0;
      const p = a.compareDocumentPosition(b);
      if (p & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (p & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
  }

  function assistantContainer(x) {
    if (!x) return null;
    return (
      x.closest?.(
        '[data-chatgpt-search-unit-key$=":assistant"],[data-content-search-unit-key$=":assistant"],article[data-testid^="conversation-turn-"],article[data-turn],[data-testid^="conversation-turn-"]'
      ) ||
      (x.matches?.('[data-conversation-role="assistant"]') ? x.parentElement : null) ||
      x.closest?.('[data-conversation-role="assistant"]')?.parentElement ||
      x
    );
  }

  function userContainer(x) {
    if (!x) return null;
    return (
      x.closest?.(
        '[data-chatgpt-search-unit-key$=":user"],[data-content-search-unit-key$=":user"],article[data-testid^="conversation-turn-"],article[data-turn],[data-testid^="conversation-turn-"]'
      ) || (x.matches?.('[data-user-message-bubble="true"]') ? x.parentElement : null) || x
    );
  }

  function assistantNodes() {
    const out = [];
    for (const x of document.querySelectorAll(
      '[data-chatgpt-search-unit-key$=":assistant"],[data-content-search-unit-key$=":assistant"]'
    ))
      addMessageNode(out, assistantContainer(x));
    for (const x of document.querySelectorAll('[data-conversation-role="assistant"]'))
      addMessageNode(out, assistantContainer(x));
    for (const x of document.querySelectorAll('[data-message-author-role="assistant"]'))
      addMessageNode(out, assistantContainer(x));
    for (const x of conversationTurnNodes().filter((x) => nodeRole(x) === "assistant")) addMessageNode(out, x);
    return sortDom(out);
  }

  function userNodes() {
    const out = [];
    for (const x of document.querySelectorAll(
      '[data-chatgpt-search-unit-key$=":user"],[data-content-search-unit-key$=":user"]'
    ))
      addMessageNode(out, userContainer(x));
    for (const x of document.querySelectorAll('[data-user-message-bubble="true"]')) addMessageNode(out, userContainer(x));
    for (const x of document.querySelectorAll('[data-message-author-role="user"]')) addMessageNode(out, userContainer(x));
    for (const x of conversationTurnNodes().filter((x) => nodeRole(x) === "user")) addMessageNode(out, x);
    return sortDom(out);
  }

  function keySet(nodes) {
    return nodes.map(turnKey).filter(Boolean);
  }

  function latestAssistant() {
    const a = assistantNodes();
    const el = a.at(-1) || null;
    return { count: a.length, key: turnKey(el), text: turnText(el) || canonLoose(rawText(el)), el };
  }

  function latestUser() {
    const a = userNodes();
    const el = a.at(-1) || null;
    return { count: a.length, key: turnKey(el), text: turnText(el) || canonLoose(rawText(el)), el };
  }

  function latestTurn() {
    const a = conversationTurnNodes();
    const el = a.at(-1) || null;
    return { count: a.length, key: turnKey(el), role: nodeRole(el), text: turnText(el), el };
  }

  function findFreshAssistant(baseline = {}) {
    const nodes = assistantNodes();
    const seen = new Set(Array.isArray(baseline.assistantKeys) ? baseline.assistantKeys : []);
    if (seen.size) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const k = turnKey(nodes[i]);
        if (k && !seen.has(k))
          return { el: nodes[i], key: k, text: turnText(nodes[i]) || canonLoose(rawText(nodes[i])), count: nodes.length };
      }
    }
    if (Object.prototype.hasOwnProperty.call(baseline, "assistantCount") && nodes.length > Number(baseline.assistantCount || 0)) {
      const el = nodes.at(-1);
      return { el, key: turnKey(el), text: turnText(el) || canonLoose(rawText(el)), count: nodes.length };
    }
    return null;
  }

  function isAfter(a, b) {
    if (!a || !b || a === b) return false;
    try {
      return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    } catch (_) {
      return false;
    }
  }

  function findSentUser(baseline = {}) {
    const nodes = userNodes();
    if (baseline.sentUserKey) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (turnKey(nodes[i]) === baseline.sentUserKey)
          return { el: nodes[i], key: baseline.sentUserKey, text: turnText(nodes[i]) };
      }
    }
    if (Object.prototype.hasOwnProperty.call(baseline, "userCount") && nodes.length > Number(baseline.userCount || 0)) {
      const el = nodes.at(-1);
      return { el, key: turnKey(el), text: turnText(el) };
    }
    return null;
  }

  function findAssistantAfterSentUser(baseline = {}) {
    const u = findSentUser(baseline);
    if (!u?.el) return null;
    const nodes = assistantNodes();
    let chosen = null;
    for (const el of nodes) {
      if (isAfter(u.el, el)) {
        chosen = { el, key: turnKey(el), text: turnText(el) || canonLoose(rawText(el)), count: nodes.length };
      }
    }
    return chosen;
  }

  function bestResponseCandidate(baseline = {}) {
    const after = findAssistantAfterSentUser(baseline);
    if (after) return { ...after, source: "after-user" };
    const fresh = findFreshAssistant(baseline);
    if (fresh) return { ...fresh, source: "fresh-assistant" };
    const hasBaseline =
      Object.prototype.hasOwnProperty.call(baseline, "lastAssistantText") ||
      (Array.isArray(baseline.assistantKeys) && baseline.assistantKeys.length);
    if (!hasBaseline) return null;
    const nodes = assistantNodes();
    for (let i = nodes.length - 1; i >= 0; i--) {
      const el = nodes[i];
      const text = turnText(el) || canonLoose(rawText(el));
      const key = turnKey(el);
      if (
        text &&
        (text !== String(baseline.lastAssistantText || "") || (key && !(baseline.assistantKeys || []).includes(key)))
      ) {
        return { el, key, text, count: nodes.length, source: "changed-latest" };
      }
    }
    return null;
  }

  function snapshot() {
    const u = latestUser();
    const a = latestAssistant();
    const t = latestTurn();
    return {
      userCount: u.count,
      userKeys: keySet(userNodes()),
      lastUserKey: u.key,
      lastUserText: u.text,
      assistantCount: a.count,
      assistantKeys: keySet(assistantNodes()),
      lastAssistantKey: a.key,
      lastAssistantText: a.text,
      turnCount: t.count,
      lastTurnKey: t.key,
      lastTurnRole: t.role,
    };
  }

  function composerText() {
    const el = findComposer();
    if (!el) return "";
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return String(el.value || "").trim();
    return canonLoose(rawText(el));
  }

  function fold(s) {
    return String(s || "")
      .normalize("NFC")
      .replace(/[\u200b\u200c\u200d\ufeff\u00ad]/g, "")
      .replace(/[\u201c\u201d\u00ab\u00bb]/g, '"')
      .replace(/\s+/g, " ")
      .trim();
  }

  function phraseIn(text, phrases) {
    const hay = fold(text);
    if (!hay) return false;
    return (phrases || []).some((p) => hay.includes(fold(p)));
  }

  root.__lnSnapshot = function __lnSnapshot() {
    return { ok: true, version: "1.8.4", baseline: snapshot() };
  };

  root.__lnReadPage = function __lnReadPage(phrases, baseline) {
    const base = baseline || {};
    const generating = !!findStopButton();
    const composerReady = !!findComposer();
    const candidateObj = bestResponseCandidate(base);
    const fresh = findFreshAssistant(base);
    const reply = candidateObj?.text || fresh?.text || latestAssistant().text || "";
    const assistantTexts = assistantNodes()
      .map((el) => turnText(el) || canonLoose(rawText(el)))
      .filter(Boolean);
    const threadTail = assistantTexts.slice(-20).join("\n\n").slice(-120000);
    const sawNew = !!(
      candidateObj ||
      fresh ||
      (Object.prototype.hasOwnProperty.call(base, "assistantCount") &&
        assistantNodes().length > Number(base.assistantCount || 0))
    );
    return {
      ok: true,
      version: "1.8.4",
      reply,
      pageTail: reply.slice(-8000),
      threadTail,
      lastChars: reply.slice(-240),
      candidateKey: candidateObj?.key || fresh?.key || "",
      candidateSource: candidateObj?.source || (fresh ? "fresh" : ""),
      sawNew,
      generating,
      composerReady,
      composerPending: composerText().length > 80,
      phraseHit: phraseIn(reply, phrases || []),
      hidden: !!document.hidden,
      waitHint: `new=${sawNew ? 1 : 0} generating=${generating ? 1 : 0} chars=${reply.length} source=${candidateObj?.source || "-"}`,
    };
  };

  root.__lnIsGenerating = function __lnIsGenerating() {
    return !!findStopButton();
  };

  async function fillComposer(text) {
    const el = findComposer();
    if (!el) throw new Error("Không tìm thấy ô chat ChatGPT.");
    el.focus();
    el.click();
    await sleep(60);
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return el;
    }
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    try {
      document.execCommand("insertText", false, text);
    } catch (_) {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    return el;
  }

  async function clickSend() {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const btn = findSendButton();
      if (btn) {
        btn.click();
        return;
      }
      await sleep(120);
    }
    const el = findComposer();
    if (el) {
      el.focus();
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true })
      );
    }
  }

  root.__lnSendPrompt = async function __lnSendPrompt(text) {
    const before = snapshot();
    const waitStopUntil = Date.now() + 12000;
    while (findStopButton() && Date.now() < waitStopUntil) await sleep(250);
    await fillComposer(text);
    await sleep(200);
    await clickSend();
    const giveUp = Date.now() + 20000;
    while (Date.now() < giveUp) {
      if (composerText().length <= 80) break;
      if (!findStopButton() && findSendButton()) await clickSend();
      await sleep(250);
    }
    const userWait = Date.now() + 8000;
    while (Date.now() < userWait) {
      const u = latestUser();
      if (u.count > before.userCount || (u.key && u.key !== before.lastUserKey)) {
        before.sentUserKey = u.key || "";
        before.sentUserText = u.text || "";
        break;
      }
      await sleep(200);
    }
    if (!before.sentUserKey) {
      const afterUser = latestUser();
      before.sentUserKey = afterUser.key || "";
      before.sentUserText = afterUser.text || "";
    }
    return {
      ok: true,
      baseline: before,
      generating: !!findStopButton(),
      composerPending: composerText().length > 80,
    };
  };
})(globalThis);
