const text = document.querySelector("#text");
const autosend = document.querySelector("#autosend");
const run = document.querySelector("#run");
const status = document.querySelector("#status");
const file = document.querySelector("#file");

function setStatus(message, kind) {
  status.textContent = message;
  status.className = kind || "";
}

async function restore() {
  const saved = await chrome.storage.local.get(["draft", "autosend"]);
  if (typeof saved.draft === "string") text.value = saved.draft;
  if (typeof saved.autosend === "boolean") autosend.checked = saved.autosend;
}

function persist() {
  return chrome.storage.local.set({
    draft: text.value,
    autosend: autosend.checked,
  });
}

file.addEventListener("change", async () => {
  const picked = file.files && file.files[0];
  if (!picked) return;
  text.value = await picked.text();
  await persist();
  setStatus(`Đã đọc ${picked.name}.`, "ok");
});

text.addEventListener("input", persist);
autosend.addEventListener("change", persist);

run.addEventListener("click", async () => {
  const body = text.value.trim();
  if (!body) {
    setStatus("Chưa có văn bản để điền.", "bad");
    return;
  }
  run.disabled = true;
  setStatus("Đang điền trên ChatGPT…");
  try {
    const result = await chrome.runtime.sendMessage({
      type: "RUN_CHATGPT_AUTOFILL",
      text: body,
      send: autosend.checked,
    });
    if (!result || !result.ok) {
      setStatus((result && result.error) || "Không điền được.", "bad");
      return;
    }
    setStatus(autosend.checked ? "Đã điền và gửi." : "Đã điền, chưa gửi.", "ok");
  } catch (error) {
    setStatus(error.message || "Không nói được với extension.", "bad");
  } finally {
    run.disabled = false;
  }
});

restore();
