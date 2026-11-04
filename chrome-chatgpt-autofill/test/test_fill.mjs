import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fillSource = readFileSync(join(root, "fill.js"), "utf8");

function loadDom(html) {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true });
  dom.window.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  const script = dom.window.document.createElement("script");
  script.textContent = fillSource;
  dom.window.document.body.appendChild(script);
  return dom;
}

const composerPage = `<!doctype html><html><body>
  <div id="prompt-textarea" contenteditable="true" style="display:block"></div>
  <button data-testid="send-button" aria-label="Send prompt">Send</button>
  <pre id="out"></pre>
</body></html>`;

const textareaPage = `<!doctype html><html><body>
  <textarea id="prompt-textarea"></textarea>
  <button data-testid="send-button">Send</button>
</body></html>`;

{
  const dom = loadDom(composerPage);
  const { document, ChatGptAutofill } = dom.window;
  document.querySelector("[data-testid='send-button']").addEventListener("click", () => {
    document.querySelector("#out").textContent = document.querySelector("#prompt-textarea").textContent;
  });
  const result = ChatGptAutofill.fillAndSend("Xin chào ChatGPT");
  assert.equal(result.ok, true, result.error);
  assert.match(document.querySelector("#prompt-textarea").textContent, /Xin chào ChatGPT/);
  assert.equal(document.querySelector("#out").textContent, "Xin chào ChatGPT");
}

{
  const dom = loadDom(textareaPage);
  const result = dom.window.ChatGptAutofill.fillAndSend("Dòng thứ hai");
  assert.equal(result.ok, true, result.error);
  assert.equal(dom.window.document.querySelector("#prompt-textarea").value, "Dòng thứ hai");
}

{
  const dom = loadDom("<!doctype html><html><body><p>Không có ô chat</p></body></html>");
  const result = dom.window.ChatGptAutofill.fillAndSend("abc");
  assert.equal(result.ok, false);
  assert.match(result.error, /Không thấy ô chat/);
}

{
  const dom = loadDom(composerPage);
  const result = dom.window.ChatGptAutofill.fillAndSend("Chỉ điền", { send: false });
  assert.equal(result.ok, true);
  assert.equal(dom.window.document.querySelector("#prompt-textarea").textContent.includes("Chỉ điền"), true);
}

console.log("fill.js: 4 tests passed");
