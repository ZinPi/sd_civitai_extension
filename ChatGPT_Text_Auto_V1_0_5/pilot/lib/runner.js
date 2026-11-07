/**
 * One rule for every pipeline step:
 * only the newest assistant message counts, and only that step's unique phrase.
 * Text that still looks like the prompt we just sent is ignored.
 */
(function (root) {
  const { findSignal, folded, parseSplitLineCount, matchStepSignal, parseAdaptBatchTotal } = root.LN_SIGNALS;

  const PROMPT_MARKERS = [
    "CUỐI CÂU TRẢ LỜI",
    "TÁC PHẨM GỐC:",
    "TOOL ĐÃ GHI NHỚ",
    "TRONG NGOẶC KÉP",
    "TRONG NGOẶC KHÉP",
    "PHẢI CHI 1 TRONG 2",
    "BẮT BUỘC IN ĐÚNG",
    "BẮT BUỘC BÁO CÁO SỐ DÒNG",
    "TÀI LIỆU CỦA PHẦN LIỀN TRƯỚC",
    "CHIA TÁC PHẨM VỪA CÔ ĐỘNG",
  ];

  function isPromptEcho(text) {
    const t = String(text || "");
    return PROMPT_MARKERS.some((m) => t.includes(m));
  }

  function fingerprint(text) {
    const s = folded(text);
    if (!s) return "";
    return `${s.length}:${s.slice(0, 96)}:${s.slice(-160)}`;
  }

  function isNewAssistantReply(before, current) {
    const a = folded(before);
    const b = folded(current);
    if (!b || b.length < 8) return false;
    if (!a) return true;
    if (b === a) return false;
    if (fingerprint(before) === fingerprint(current)) return false;
    if (a.includes(b)) return false;
    if (b.includes(a)) return b.slice(-160) !== a.slice(-160);
    return b.slice(-160) !== a.slice(-160);
  }

  function hitInText(text, allowed) {
    if (!text || isPromptEcho(text)) return null;
    return findSignal(text, allowed || []) || null;
  }

  function consider(text, allowed, beforeReply) {
    if (!text || isPromptEcho(text)) return null;
    if (!isNewAssistantReply(beforeReply, text)) return null;
    const signal = hitInText(text, allowed);
    if (!signal) return null;
    return { text, signal, ready: true };
  }

  /**
   * ZinPi ChatGPT_Text_Auto waitResponse:
   * DONE iff new assistant after the sent user + no Stop in current composer
   * + composer ready + text unchanged for stableMs (default 5s).
   * sawGenerating is tracked but never required.
   */
  const STABLE_MS = 5000;

  function isSafetyRefusal(text) {
    const hay = folded(text).toLowerCase();
    return hay.includes("không thể hiển thị nội dung này vì lý do an toàn");
  }

  function isDeadTabError(message) {
    return /đóng băng|Không còn tab/i.test(String(message || ""));
  }

  function chargeWait(st) {
    if (!st || st.ok === false || st.stalled) return false;
    if (st.hidden) return false;
    return true;
  }

  function writingDone(st) {
    return !!(
      st?.sawNew &&
      st?.last &&
      !st?.generating &&
      st?.composerReady &&
      Number(st?.stableFor || 0) >= STABLE_MS
    );
  }

  function phraseAfterWriting(step, last, ctx) {
    const text = String(last || "");
    if (!text || isPromptEcho(text)) {
      return { ready: false, signal: null, text, reason: "echo-or-empty" };
    }
    const allowed = step?.allowed || [];
    if (!allowed.length) {
      return { ready: text.length > 40, signal: null, text };
    }
    const signal = matchStepSignal(step, text, ctx);
    if (step?.id === "sourceAnalysis" && findSignal(text, allowed) && !parseAdaptBatchTotal(text)) {
      return { ready: false, signal: findSignal(text, allowed), text, needBatches: true, reason: "need-batches" };
    }
    if (!signal) return { ready: false, signal: null, text, reason: "no-phrase" };
    if (step.rememberLines && !parseSplitLineCount(text)) {
      return { ready: false, signal, text, needLines: true, reason: "need-lines" };
    }
    return { ready: true, signal, text };
  }

  /**
   * Accept a signal only from a *new* assistant reply, never from the
   * prompt we just pasted or from the previous step's message.
   */
  function detectStepFinish(step, st, beforeReply, ctx) {
    const allowed = step?.allowed || [];
    const reply = String(st?.reply || "");
    if (!allowed.length) {
      if (!isPromptEcho(reply) && isNewAssistantReply(beforeReply, reply) && reply.length > 40) {
        return { text: reply, signal: null, ready: true };
      }
      return { text: "", signal: null, ready: false };
    }

    const chunks = [reply, st?.pageTail, st?.lastChars];
    for (const raw of chunks) {
      const text = String(raw || "");
      if (!text || isPromptEcho(text) || !isNewAssistantReply(beforeReply, text)) continue;
      if (step?.id === "sourceAnalysis" && findSignal(text, allowed) && !parseAdaptBatchTotal(text)) {
        return { text, signal: findSignal(text, allowed), ready: false, needBatches: true };
      }
      const signal = matchStepSignal(step, text, ctx);
      if (!signal) continue;
      if (step.rememberLines && !parseSplitLineCount(text)) {
        return { text, signal, ready: false, needLines: true };
      }
      return { text, signal, ready: true };
    }
    return { text: "", signal: null, ready: false };
  }

  root.LN_RUNNER = {
    isPromptEcho,
    fingerprint,
    isNewAssistantReply,
    detectStepFinish,
    hitInText,
    writingDone,
    isSafetyRefusal,
    isDeadTabError,
    chargeWait,
    phraseAfterWriting,
    STABLE_MS,
  };
})(globalThis);
