const STATUS_TEXT = {
  pending: "Chưa chạy",
  running: "Đang chạy",
  done: "Xong",
  error: "Lỗi",
  stopped: "Dừng",
};

const FILE_NAMES = {
  "danh-sach": "DANH_SACH_CHAR_BG.txt",
  char: "PROMPT_CHAR.txt",
  bg: "PROMPT_BG.txt",
  dong: "PROMPT_THEO_DONG.txt",
};

const source = document.querySelector("#source");
const count = document.querySelector("#count");
const notice = document.querySelector("#notice");
const detail = document.querySelector("#detail");
const log = document.querySelector("#log");
const preview = document.querySelector("#preview");
const previewNote = document.querySelector("#preview-note");
const download = document.querySelector("#download");
const reference = document.querySelector("#reference");
const run = document.querySelector("#run");
const next = document.querySelector("#next");
const stop = document.querySelector("#stop");
const clear = document.querySelector("#clear");
const connection = document.querySelector("#connection");
const meterWrap = document.querySelector("#meter-wrap");
const meter = document.querySelector("#meter");

let job = null;
let selected = "danh-sach";
let shownKey = "";
let pollTimer = 0;
let sourceReady = false;

function splitSource(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function updateCount() {
  const total = splitSource(source.value).length;
  count.textContent = total ? `${total} dòng` : "Chưa có dòng";
  const done = doneCount();
  const allDone = done === 4 && job?.state === "done";
  const running = Boolean(job?.running);
  run.textContent = primaryLabel();
  run.disabled = running || allDone || total === 0;
  run.setAttribute("aria-busy", running ? "true" : "false");
  next.hidden = running || allDone || job?.state === "error" || total === 0;
}

async function readError(response) {
  try {
    const data = await response.json();
    if (typeof data.detail === "string") return data.detail;
  } catch (_error) {
    return "Không thực hiện được.";
  }
  return "Không thực hiện được.";
}

function showNotice(item) {
  if (!item || !item.kind || !item.text) {
    notice.hidden = true;
    notice.textContent = "";
    notice.className = "notice";
    return;
  }
  notice.hidden = false;
  notice.className = `notice ${item.kind}`;
  notice.textContent = item.text;
}

function formSettings() {
  return {
    model: document.querySelector("#model").value.trim(),
    max_input_tokens: Number(document.querySelector("#max-in").value),
    max_output_tokens: Number(document.querySelector("#max-out").value),
    request_timeout_seconds: Number(document.querySelector("#timeout").value),
  };
}

function fillModelChoices(models, selected) {
  const wrap = document.querySelector("#model-wrap");
  const select = document.querySelector("#model");
  const list = Array.isArray(models) ? models : [];
  select.replaceChildren();
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Chọn model";
  select.appendChild(blank);
  for (const id of list) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id;
    select.appendChild(option);
  }
  select.value = selected && list.includes(selected) ? selected : "";
  wrap.hidden = list.length === 0;
}

function fillSettings(settings) {
  document.querySelector("#max-in").value = settings.max_input_tokens;
  document.querySelector("#max-out").value = settings.max_output_tokens;
  document.querySelector("#timeout").value = settings.request_timeout_seconds;
  const ready = settings.api_state === "ok";
  fillModelChoices(ready ? settings.models : [], settings.model || "");
  connection.textContent = ready ? "Đã kết nối." : (settings.message || "API không hợp lệ");
  connection.className = ready ? "connection" : "connection bad";
}

async function saveSettings() {
  const response = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(formSettings()),
  });
  if (!response.ok) {
    const message = await readError(response);
    showNotice({ kind: "error", text: message });
    if (message.includes("API không hợp lệ") || message.includes("Không nối được API")) {
      connection.textContent = message;
      connection.className = "connection bad";
    }
    return false;
  }
  fillSettings(await response.json());
  return true;
}

function doneCount() {
  return (job?.steps || []).filter((step) => step.status === "done").length;
}

function hasFile() {
  return Object.values(job?.files || {}).some((file) => file.ready);
}

function primaryLabel() {
  if (job?.running) return "Đang chạy…";
  if (job?.state === "error") return "Chạy lại bước này";
  if (job?.state === "stopped") return "Chạy tiếp";
  const done = doneCount();
  if (done === 0) return "Chạy cả bốn bước";
  if (done === 4) return "Đã xong bốn bước";
  return "Chạy tiếp các bước còn lại";
}

function render(nextJob) {
  job = nextJob;
  for (const step of job.steps || []) {
    const row = document.querySelector(`.step[data-step="${step.id}"]`);
    const pill = row.querySelector(".status");
    pill.textContent = STATUS_TEXT[step.status] || step.status;
    pill.className = `status ${step.status}`;
    row.classList.toggle("active", step.id === job.current_step && job.running);
  }
  showNotice(job.notice);
  const banner = job.notice?.text ? job.notice.text.split("\n")[0] : "";
  detail.hidden = !job.detail || job.detail === banner;
  detail.textContent = job.detail || "";

  if (job.current_step === 4 && job.line_total) {
    meterWrap.hidden = false;
    meter.style.width = `${Math.round((100 * job.line_done) / job.line_total)}%`;
    meterWrap.setAttribute("aria-valuenow", String(job.line_done));
    meterWrap.setAttribute("aria-valuemax", String(job.line_total));
    meterWrap.setAttribute("aria-label", `Đã khóa ${job.line_done} trên ${job.line_total} dòng`);
  } else {
    meterWrap.hidden = true;
  }

  log.replaceChildren();
  const history = (job.log || []).slice(0, -1).slice(-6);
  for (const line of history) {
    const item = document.createElement("li");
    item.textContent = line;
    log.appendChild(item);
  }

  updateCount();
  stop.hidden = !job.running;
  clear.hidden = job.running || !hasFile();
  source.readOnly = Boolean(job.running);
  reference.hidden = !job.files?.["tham-chieu"]?.ready;
  showSelected();
  schedule();
}

async function showSelected() {
  const info = job?.files?.[selected];
  const tabReady = Boolean(info?.ready);
  for (const tab of document.querySelectorAll(".tabs button")) {
    tab.setAttribute("aria-selected", tab.dataset.file === selected ? "true" : "false");
  }
  if (!tabReady) {
    preview.textContent = "Chưa có file này.";
    previewNote.hidden = true;
    download.hidden = true;
    shownKey = "";
    return;
  }
  download.hidden = false;
  download.href = `/api/file/${selected}`;
  download.setAttribute("download", FILE_NAMES[selected]);
  download.textContent = `Tải ${FILE_NAMES[selected]}`;
  const key = `${selected}:${info.bytes}`;
  if (shownKey === key) return;
  const response = await fetch(`/api/file/${selected}?preview=200`);
  if (!response.ok) {
    preview.textContent = "Chưa đọc được file.";
    return;
  }
  const data = await response.json();
  preview.textContent = data.text || "File trống.";
  previewNote.hidden = !data.truncated;
  previewNote.textContent = data.truncated ? `Đang xem 200 dòng đầu. File đủ ${data.lines} dòng khi tải về.` : "";
  shownKey = key;
}

function selectTab(file) {
  selected = file;
  shownKey = "";
  if (job) showSelected();
}

async function refresh(includeSource) {
  const response = await fetch(includeSource ? "/api/job?source=1" : "/api/job");
  if (!response.ok) return;
  const data = await response.json();
  if (includeSource && !sourceReady) {
    if (!source.value && data.source_text) source.value = data.source_text;
    sourceReady = true;
    updateCount();
  }
  render(data);
}

function schedule() {
  clearTimeout(pollTimer);
  if (job?.running) pollTimer = setTimeout(() => refresh(false), 800);
}

async function start(mode) {
  run.disabled = true;
  next.disabled = true;
  if (!(await saveSettings())) {
    next.disabled = false;
    await refresh(false);
    return;
  }
  const response = await fetch("/api/job", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_text: source.value, mode }),
  });
  next.disabled = false;
  if (!response.ok) {
    const message = await readError(response);
    showNotice({ kind: "error", text: message });
    if (message.includes("API không hợp lệ") || message.includes("Không nối được API")) {
      connection.textContent = message;
      connection.className = "connection bad";
    }
    await refresh(false);
    return;
  }
  render(await response.json());
}

async function loadRules() {
  const response = await fetch("/api/rules");
  if (!response.ok) {
    document.querySelector("#rules-dir").textContent = "Không đọc được danh sách quy tắc.";
    return;
  }
  const data = await response.json();
  document.querySelector("#rules-dir").textContent = data.directory;
  const list = document.querySelector("#rules");
  list.replaceChildren();
  for (const file of data.files) {
    const item = document.createElement("li");
    const size = file.missing ? "không thấy file" : `${Math.max(1, Math.round(file.bytes / 1024))} KB`;
    item.textContent = `${file.name} — ${file.label} — ${size}`;
    if (file.missing) item.className = "missing";
    list.appendChild(item);
  }
}

document.querySelector("#steps").addEventListener("click", (event) => {
  const row = event.target.closest(".step");
  if (row) selectTab(row.dataset.file);
});

document.querySelector(".tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("button");
  if (tab) selectTab(tab.dataset.file);
});

source.addEventListener("input", updateCount);
document.querySelector("#file").addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".txt")) {
    showNotice({ kind: "error", text: "Chỉ nhận file .txt, mỗi dòng một câu." });
    event.target.value = "";
    return;
  }
  source.value = await file.text();
  updateCount();
});

const drop = document.querySelector("#drop");
drop.addEventListener("dragover", (event) => {
  event.preventDefault();
  drop.classList.add("drag");
});
drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
drop.addEventListener("drop", async (event) => {
  event.preventDefault();
  drop.classList.remove("drag");
  const file = event.dataTransfer.files && event.dataTransfer.files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".txt")) {
    showNotice({ kind: "error", text: "Chỉ nhận file .txt, mỗi dòng một câu." });
    return;
  }
  source.value = await file.text();
  updateCount();
});

run.addEventListener("click", () => {
  if (job?.state === "error") start("next");
  else start("all");
});
next.addEventListener("click", () => start("next"));
stop.addEventListener("click", async () => {
  stop.disabled = true;
  await fetch("/api/job/stop", { method: "POST" });
  stop.disabled = false;
  refresh(false);
});
clear.addEventListener("click", async () => {
  if (!window.confirm("Xóa kết quả của bản này?")) return;
  const response = await fetch("/api/job/clear", { method: "POST" });
  if (response.ok) {
    shownKey = "";
    render(await response.json());
  }
});

document.querySelector("#model").addEventListener("change", async () => {
  if (!document.querySelector("#model").value) return;
  await saveSettings();
});

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !run.disabled) {
    event.preventDefault();
    run.click();
  }
});

updateCount();
loadRules();
fetch("/api/settings").then(async (response) => {
  if (response.ok) fillSettings(await response.json());
}).finally(() => refresh(true));
