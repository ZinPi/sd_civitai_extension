(function (root) {
  const COMPOSER_SELECTORS = [
    "#prompt-textarea",
    '[data-testid="prompt-textarea"]',
    "textarea[data-id=\"root\"]",
    "div.ProseMirror[contenteditable=\"true\"]",
    '[contenteditable="true"][id="prompt-textarea"]',
  ];

  const SEND_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send"]',
    'button[aria-label="Gửi"]',
  ];

  function hidden(el) {
    if (!el) return true;
    const style = root.getComputedStyle ? root.getComputedStyle(el) : null;
    return Boolean(style && (style.display === "none" || style.visibility === "hidden"));
  }

  function firstMatch(selectors) {
    for (const selector of selectors) {
      const found = [...document.querySelectorAll(selector)].find((el) => !hidden(el));
      if (found) return found;
    }
    return null;
  }

  function findComposer() {
    return firstMatch(COMPOSER_SELECTORS);
  }

  function findSend() {
    const explicit = firstMatch(SEND_SELECTORS);
    if (explicit) return explicit;
    return [...document.querySelectorAll("button")].find((button) => {
      if (!visible(button) || button.disabled) return false;
      const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`.toLowerCase();
      return /\bsend\b|gửi/.test(label);
    }) || null;
  }

  function setNativeValue(el, text) {
    const proto = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setContentEditable(el, text) {
    el.focus();
    try {
      const selection = window.getSelection();
      if (selection && document.createRange) {
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } catch (_error) {
      // JSDOM and some ChatGPT builds do not expose a full selection API.
    }
    const inserted = typeof document.execCommand === "function"
      && document.execCommand("insertText", false, text);
    if (!inserted || !(el.textContent || "").trim()) {
      el.textContent = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function readComposer(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value || "";
    return (el.innerText || el.textContent || "").trim();
  }

  function fill(text) {
    const composer = findComposer();
    if (!composer) return { ok: false, error: "Không thấy ô chat ChatGPT." };
    composer.focus();
    if (composer.tagName === "TEXTAREA" || composer.tagName === "INPUT") {
      setNativeValue(composer, text);
    } else {
      setContentEditable(composer, text);
    }
    const written = readComposer(composer);
    if (!written) return { ok: false, error: "Đã thấy ô chat nhưng không điền được chữ." };
    return { ok: true, written };
  }

  function send() {
    const button = findSend();
    if (!button) return { ok: false, error: "Không thấy nút gửi." };
    if (button.disabled) return { ok: false, error: "Nút gửi đang khóa." };
    button.click();
    return { ok: true };
  }

  function fillAndSend(text, options) {
    const settings = options || {};
    const filled = fill(text);
    if (!filled.ok) return filled;
    if (settings.send === false) return filled;
    return { ...filled, ...send() };
  }

  root.ChatGptAutofill = {
    findComposer,
    findSend,
    fill,
    send,
    fillAndSend,
    readComposer,
  };
})(typeof window !== "undefined" ? window : globalThis);
