import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "image_refs.js"), "utf8");
const run = new Function(`${src}; return globalThis.ChatGptImageRefs;`);
const api = run();

assert.ok(api, "ChatGptImageRefs missing");
assert.deepEqual(api.parseRefIds("001 | CHAR_01.BG_02 | IMAGE_PROMPT: a street"), ["CHAR_01", "BG_02"]);
assert.deepEqual(api.parseRefIds("CHAR_03 đứng trước cửa"), ["CHAR_03"]);
assert.deepEqual(api.parseRefIds("chỉ bối cảnh BG_10 và BG_10 lại"), ["BG_10"]);
assert.deepEqual(api.parseRefIds("char_04 và bg_05"), ["CHAR_04", "BG_05"]);
assert.deepEqual(api.parseRefIds("không có mã tham chiếu"), []);
assert.deepEqual(api.splitPromptLines("a\n\n  b  \r\nc"), ["a", "b", "c"]);

const index = api.indexRefFiles([
  { name: "CHAR_01.png" },
  { name: "bg_02.JPG" },
  { name: "CHAR_03-front.webp" },
  { name: "folder/BG_07.png" },
  { name: "notes.txt" },
]);
assert.equal(index.CHAR_01.name, "CHAR_01.png");
assert.equal(index.BG_02.name, "bg_02.JPG");
assert.equal(index.CHAR_03.name, "CHAR_03-front.webp");
assert.equal(index.BG_07.name, "folder/BG_07.png");
assert.equal(index.notes, undefined);

const both = api.matchLineFiles("CHAR_01.BG_02", index);
assert.deepEqual(both.ids, ["CHAR_01", "BG_02"]);
assert.equal(both.found.length, 2);
assert.deepEqual(both.missing, []);

const onlyChar = api.matchLineFiles("CHAR_01 đi một mình", index);
assert.deepEqual(onlyChar.ids, ["CHAR_01"]);
assert.equal(onlyChar.found.length, 1);
assert.deepEqual(onlyChar.missing, []);

const onlyBg = api.matchLineFiles("phong nền BG_02", index);
assert.deepEqual(onlyBg.ids, ["BG_02"]);
assert.equal(onlyBg.found.length, 1);

const none = api.matchLineFiles("cảnh trống không mã", index);
assert.deepEqual(none.ids, []);
assert.equal(none.found.length, 0);

const missing = api.matchLineFiles("CHAR_01.BG_09", index);
assert.deepEqual(missing.ids, ["CHAR_01", "BG_09"]);
assert.equal(missing.found.length, 1);
assert.deepEqual(missing.missing, ["BG_09"]);

assert.equal(api.outputName("canh", 1, "png"), "canh_1.png");
assert.equal(api.outputName("", 3, "jpg"), "ANH_3.jpg");
assert.equal(api.outputName("a/b:c", 2, "png"), "a_b_c_2.png");

console.log("image_refs.js: 16 tests passed");
