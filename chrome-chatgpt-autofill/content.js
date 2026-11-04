(() => {
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (!message || message.type !== "CHATGPT_AUTOFILL") return;
    const api = window.ChatGptAutofill;
    if (!api) {
      reply({ ok: false, error: "Thiếu fill.js trên trang ChatGPT." });
      return;
    }
    reply(api.fillAndSend(message.text || "", { send: message.send !== false }));
  });
})();
