const CHATGPT_URLS = ["https://chatgpt.com/*", "https://chat.openai.com/*"];

function isChatGpt(url) {
  try {
    const host = new URL(url).hostname;
    return host === "chatgpt.com" || host === "chat.openai.com" || host.endsWith(".chatgpt.com");
  } catch {
    return false;
  }
}

async function findChatGptTab() {
  const tabs = await chrome.tabs.query({ url: CHATGPT_URLS });
  return tabs.find((tab) => tab.id && isChatGpt(tab.url || "")) || null;
}

function waitForComplete(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }, 20000);
    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function ensureChatGptTab() {
  const existing = await findChatGptTab();
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    return existing.id;
  }
  const created = await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
  if (created.status !== "complete") await waitForComplete(created.id);
  return created.id;
}

async function inject(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["fill.js", "content.js"],
  });
}

async function askTab(tabId, payload, attempt) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    if (attempt >= 2) throw error;
    await inject(tabId);
    await new Promise((resolve) => setTimeout(resolve, 400));
    return askTab(tabId, payload, attempt + 1);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (!message || message.type !== "RUN_CHATGPT_AUTOFILL") return;
  (async () => {
    const tabId = await ensureChatGptTab();
    const result = await askTab(tabId, {
      type: "CHATGPT_AUTOFILL",
      text: message.text || "",
      send: message.send !== false,
    }, 0);
    reply(result || { ok: false, error: "Trang ChatGPT không trả lời." });
  })().catch((error) => {
    reply({ ok: false, error: error.message || "Không gửi được sang tab ChatGPT." });
  });
  return true;
});
