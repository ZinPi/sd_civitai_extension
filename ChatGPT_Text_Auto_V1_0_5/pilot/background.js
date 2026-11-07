chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (chrome.sidePanel?.open) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});

const PILOT_CONTENT_VERSION = "1.8.4";
const pilotInjectedTabs = new Set();

async function keepTabAlive(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error("Không còn tab ChatGPT. Mở lại trang rồi bấm Chạy tiếp.");
  }
  if (tab.discarded) {
    throw new Error(
      "Tab ChatGPT đã bị Chrome đóng băng. Bấm vào tab đó một lần cho trang mở lại, rồi bấm Chạy tiếp."
    );
  }
  try {
    if (tab.autoDiscardable !== false) {
      await chrome.tabs.update(tabId, { autoDiscardable: false });
    }
  } catch {
    /* Chrome cũ không có cờ này. */
  }
  return tab;
}

async function injectDriver(tabId) {
  await keepTabAlive(tabId);
  if (pilotInjectedTabs.has(tabId)) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["pilot/lib/page-read.js"],
  });
  pilotInjectedTabs.add(tabId);
}

if (chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => pilotInjectedTabs.delete(tabId));
}

async function ensurePilotContent(tabId) {
  await keepTabAlive(tabId);
  try {
    const st = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    if (st?.version === PILOT_CONTENT_VERSION) return true;
  } catch {
    /* inject */
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["pilot/lib/page-read.js", "pilot/content.js"],
  });
  return true;
}

async function snapshotPage(tabId) {
  await injectDriver(tabId);
  const [inj] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => (typeof __lnSnapshot === "function" ? __lnSnapshot() : { ok: false, error: "no snapshot" }),
  });
  return inj?.result || { ok: false, error: "Không chụp được trạng thái ChatGPT." };
}

async function readPage(tabId, expectPhrases, baseline) {
  await injectDriver(tabId);
  const [inj] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (phrases, base) =>
      typeof __lnReadPage === "function" ? __lnReadPage(phrases, base) : { ok: false, error: "no reader" },
    args: [expectPhrases || [], baseline || {}],
  });
  return inj?.result || { ok: false, error: "Không đọc được trang ChatGPT." };
}

async function sendPrompt(tabId, text) {
  await injectDriver(tabId);
  const [inj] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (body) => {
      if (typeof __lnSendPrompt !== "function") return Promise.resolve({ ok: false, error: "no sender" });
      return __lnSendPrompt(body);
    },
    args: [text],
  });
  return inj?.result || { ok: false, error: "Không gửi được tin ChatGPT." };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === "FIND_CHATGPT") {
      const tabs = await chrome.tabs.query({
        url: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
      });
      const active = tabs.find((t) => t.active) || tabs[0] || null;
      return { tab: active };
    }
    if (msg?.type === "OPEN_CHATGPT") {
      const existing = await chrome.tabs.query({
        url: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
      });
      if (existing[0]) {
        await chrome.tabs.update(existing[0].id, { active: true });
        if (existing[0].windowId) {
          await chrome.windows.update(existing[0].windowId, { focused: true });
        }
        return { tab: existing[0] };
      }
      const created = await chrome.tabs.create({ url: "https://chatgpt.com/" });
      return { tab: created };
    }
    if (msg?.type === "ENSURE_CONTENT") {
      await ensurePilotContent(msg.tabId);
      return { ok: true };
    }
    if (msg?.type === "SNAPSHOT_PAGE") {
      return snapshotPage(msg.tabId);
    }
    if (msg?.type === "READ_PAGE") {
      return readPage(msg.tabId, msg.expectPhrases || [], msg.baseline || {});
    }
    if (msg?.type === "SEND_PAGE") {
      return sendPrompt(msg.tabId, msg.text || "");
    }
    return undefined;
  })()
    .then((result) => {
      if (result !== undefined) sendResponse(result);
    })
    .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return [
    "FIND_CHATGPT",
    "OPEN_CHATGPT",
    "ENSURE_CONTENT",
    "SNAPSHOT_PAGE",
    "READ_PAGE",
    "SEND_PAGE",
  ].includes(msg?.type);
});
