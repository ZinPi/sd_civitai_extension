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

  root.ChatGptImageRefs = {
    parseRefIds,
    splitPromptLines,
    fileStem,
    isImageName,
    indexRefFiles,
    matchLineFiles,
    sanitizePrefix,
    outputName,
  };
})(typeof window !== "undefined" ? window : globalThis);
