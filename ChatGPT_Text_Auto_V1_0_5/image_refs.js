(function (root) {
  const ID_RE = /\b((?:CHAR|BG)_\d+)\b/gi;

  function parseRefIds(text) {
    const seen = new Set();
    const out = [];
    for (const match of String(text || "").matchAll(ID_RE)) {
      const id = match[1].toUpperCase();
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  }

  function splitPromptLines(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function fileStem(name) {
    return String(name || "")
      .replace(/^.*[\\/]/, "")
      .replace(/\.[^.]+$/, "")
      .trim()
      .toUpperCase();
  }

  function isImageName(name) {
    return /\.(png|jpe?g|webp|gif|bmp)$/i.test(String(name || ""));
  }

  function indexRefFiles(files) {
    const map = {};
    for (const file of files || []) {
      const name = file.name || file.fileName || "";
      if (!isImageName(name)) continue;
      const stem = fileStem(name);
      const exact = stem.match(/^(CHAR|BG)_\d+$/);
      if (exact) {
        map[stem] = file;
        continue;
      }
      const prefix = stem.match(/^((?:CHAR|BG)_\d+)(?:[_-\s].*)?$/);
      if (prefix && !map[prefix[1]]) map[prefix[1]] = file;
    }
    return map;
  }

  function matchLineFiles(line, index) {
    const ids = parseRefIds(line);
    const found = [];
    const missing = [];
    for (const id of ids) {
      if (index[id]) found.push({ id, file: index[id] });
      else missing.push(id);
    }
    return { ids, found, missing };
  }

  function sanitizePrefix(value) {
    return String(value || "")
      .trim()
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 80);
  }

  function outputName(prefix, number, ext) {
    const base = sanitizePrefix(prefix) || "ANH";
    const kind = String(ext || "png").replace(/^\./, "") || "png";
    return `${base}_${Number(number)}.${kind}`;
  }

  function clampBatchSize(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(10, n));
  }

  function sliceFromStart(lines, startLine) {
    const all = Array.isArray(lines) ? lines : [];
    const start = Math.max(1, Math.floor(Number(startLine) || 1));
    return all.slice(start - 1);
  }

  function sliceBatches(lines, batchSize) {
    const size = clampBatchSize(batchSize);
    const out = [];
    for (let i = 0; i < lines.length; i += size) out.push(lines.slice(i, i + size));
    return out;
  }

  function composeImagePrompt(lines, extra) {
    const body = (Array.isArray(lines) ? lines : [lines])
      .map((line) => String(line || "").trim())
      .filter(Boolean)
      .join("\n");
    const add = String(extra || "").trim();
    if (!body) return add;
    if (!add) return body;
    return `${body}\n\n${add}`;
  }

  function parseRefIdsFromLines(lines) {
    const seen = new Set();
    const out = [];
    for (const line of lines || []) {
      for (const id of parseRefIds(line)) {
        if (!seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
    }
    return out;
  }

  root.ChatGptImageRefs = {
    parseRefIds,
    splitPromptLines,
    fileStem,
    isImageName,
    indexRefFiles,
    matchLineFiles,
    sanitizePrefix,
    outputName,
    clampBatchSize,
    sliceFromStart,
    sliceBatches,
    composeImagePrompt,
    parseRefIdsFromLines,
  };
})(typeof window !== "undefined" ? window : globalThis);
