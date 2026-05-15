import { spawn, spawnSync } from "node:child_process";

const pyrightEntrypoint = process.argv[2] ?? process.argv[1];
const debugEnabled = process.env.KEDI_DEBUG_EMBEDDED_PYTHON === "1";
const virtualizerCommand = process.env.KEDI_PYTHON_VIRTUALIZER_COMMAND || "python3";
const virtualizerArgs = parseVirtualizerArgs(process.env.KEDI_PYTHON_VIRTUALIZER_ARGS);

if (!pyrightEntrypoint) {
  process.stderr.write("Missing pyright entrypoint argument.\n");
  process.exit(1);
}

const pyright = spawn(process.execPath, [pyrightEntrypoint, "--stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

pyright.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

let nextPyrightId = 1;
let pyrightInitialized = false;
let pendingNotifications = [];
let pendingClientInitializeId = null;
let latestConfig = {};
let warnedVirtualizerFallback = false;

const docs = new Map();
const pendingPyrightRequests = new Map();

function parseVirtualizerArgs(raw) {
  if (!raw) {
    return ["-c", "from kedi.lsp.python_virtual import main; main()"];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    // Fall through to whitespace splitting.
  }
  return raw.split(/\s+/).filter(Boolean);
}

function debug(...args) {
  if (!debugEnabled) {
    return;
  }
  process.stderr.write(`[kedi-embedded-python] ${args.join(" ")}\n`);
}

class Reader {
  constructor(onMessage) {
    this.buffer = Buffer.alloc(0);
    this.onMessage = onMessage;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const length = Number(lengthMatch[1]);
      const messageEnd = headerEnd + 4 + length;
      if (this.buffer.length < messageEnd) {
        return;
      }

      const body = this.buffer.slice(headerEnd + 4, messageEnd).toString("utf8");
      this.buffer = this.buffer.slice(messageEnd);
      this.onMessage(JSON.parse(body));
    }
  }
}

function writeMessage(stream, message) {
  const body = JSON.stringify(message);
  stream.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function sendToClient(message) {
  debug("->client", message.method ?? "response", typeof message.id !== "undefined" ? `id=${message.id}` : "");
  writeMessage(process.stdout, message);
}

function sendToPyright(message) {
  debug("->pyright", message.method ?? "response", typeof message.id !== "undefined" ? `id=${message.id}` : "");
  writeMessage(pyright.stdin, message);
}

function queueOrSendToPyright(message) {
  if (pyrightInitialized || message.method === "initialize") {
    sendToPyright(message);
  } else {
    pendingNotifications.push(message);
  }
}

function flushPendingNotifications() {
  for (const message of pendingNotifications) {
    sendToPyright(message);
  }
  pendingNotifications = [];
}

function createVirtualUri(kediUri) {
  if (!kediUri.startsWith("file://")) {
    return `file:///__kedi_embedded__/${encodeURIComponent(kediUri)}.py`;
  }
  return `${kediUri}.__kedi_embedded__.py`;
}

function comparePosition(a, b) {
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  return a.character - b.character;
}

function isPositionInRange(position, range) {
  return comparePosition(position, range.start) >= 0 && comparePosition(position, range.end) < 0;
}

function buildLineOffsets(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

function offsetToPosition(lineOffsets, offset) {
  let low = 0;
  let high = lineOffsets.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const current = lineOffsets[mid];
    const next = mid + 1 < lineOffsets.length ? lineOffsets[mid + 1] : Number.MAX_SAFE_INTEGER;
    if (offset < current) {
      high = mid - 1;
    } else if (offset >= next) {
      low = mid + 1;
    } else {
      return { line: mid, character: offset - current };
    }
  }
  return { line: 0, character: 0 };
}

function extractPythonRanges(text) {
  const lineOffsets = buildLineOffsets(text);
  const lines = text.split("\n");
  const fencedRanges = [];
  let currentFenceStart = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const trimmed = line.trim();
    const fenceIndex = trimmed.indexOf("```");
    const beforeFence = fenceIndex === -1 ? "" : trimmed.slice(0, fenceIndex).trim();
    const isFenceLine = fenceIndex !== -1 && (beforeFence === "" || beforeFence.endsWith("="));
    if (!isFenceLine) {
      continue;
    }

    const lineStart = lineOffsets[lineIndex];
    const nextLineStart =
      lineIndex + 1 < lineOffsets.length ? lineOffsets[lineIndex + 1] : text.length;

    if (currentFenceStart === null) {
      currentFenceStart = nextLineStart;
    } else {
      fencedRanges.push({
        kind: "fenced",
        startOffset: currentFenceStart,
        endOffset: lineStart,
      });
      currentFenceStart = null;
    }
  }

  const fencedMask = new Array(text.length).fill(false);
  for (const range of fencedRanges) {
    for (let i = range.startOffset; i < range.endOffset && i < fencedMask.length; i += 1) {
      fencedMask[i] = true;
    }
  }

  const inlineRanges = [];
  let inlineStart = null;
  for (let i = 0; i < text.length; i += 1) {
    if (fencedMask[i]) {
      continue;
    }
    if (text.startsWith("```", i)) {
      i += 2;
      continue;
    }
    if (text[i] !== "`") {
      continue;
    }
    const escaped = i > 0 && text[i - 1] === "\\";
    if (escaped) {
      continue;
    }
    if (inlineStart === null) {
      inlineStart = i + 1;
    } else {
      inlineRanges.push({
        kind: "inline",
        startOffset: inlineStart,
        endOffset: i,
      });
      inlineStart = null;
    }
  }

  const allRanges = [...fencedRanges, ...inlineRanges]
    .filter((range) => range.endOffset > range.startOffset)
    .map((range) => ({
      ...range,
      range: {
        start: offsetToPosition(lineOffsets, range.startOffset),
        end: offsetToPosition(lineOffsets, range.endOffset),
      },
    }));

  return allRanges;
}

function buildBlankedPythonDocument(text, ranges) {
  const chars = Array.from(text);
  const keep = new Array(chars.length).fill(false);
  const lineOffsets = buildLineOffsets(text);

  for (const range of ranges) {
    for (let i = range.startOffset; i < range.endOffset && i < keep.length; i += 1) {
      keep[i] = true;
    }
  }

  const out = chars
    .map((char, index) => {
      if (keep[index] || char === "\n") {
        return char;
      }
      return " ";
    })
    .join("")
    .split("");

  addIndentWrappers(text, ranges, lineOffsets, out);
  return out.join("");
}

function lineEndOffset(text, lineOffsets, line) {
  const next = line + 1 < lineOffsets.length ? lineOffsets[line + 1] : text.length;
  return next > 0 && text[next - 1] === "\n" ? next - 1 : next;
}

function lineLength(text, lineOffsets, line) {
  return lineEndOffset(text, lineOffsets, line) - lineOffsets[line];
}

function writeLinePrefix(out, lineOffsets, line, value) {
  const start = lineOffsets[line];
  for (let i = 0; i < value.length; i += 1) {
    out[start + i] = value[i];
  }
}

function firstCodePositionInRange(text, lineOffsets, range) {
  for (let offset = range.startOffset; offset < range.endOffset; offset += 1) {
    const char = text[offset];
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      continue;
    }
    return offsetToPosition(lineOffsets, offset);
  }
  return null;
}

function addIndentWrappers(text, ranges, lineOffsets, out) {
  const wrapper = "if 1:";
  const wrappedLines = new Set();

  for (const range of ranges) {
    const firstCodePosition = firstCodePositionInRange(text, lineOffsets, range);
    if (!firstCodePosition || firstCodePosition.character === 0) {
      continue;
    }

    for (let line = firstCodePosition.line - 1; line >= 0; line -= 1) {
      if (wrappedLines.has(line)) {
        break;
      }
      if (lineLength(text, lineOffsets, line) < wrapper.length) {
        continue;
      }
      writeLinePrefix(out, lineOffsets, line, wrapper);
      wrappedLines.add(line);
      break;
    }
  }
}

function normalizeRange(raw) {
  if (!raw) {
    return {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    };
  }
  return {
    start: {
      line: Number(raw.start?.line ?? 0),
      character: Number(raw.start?.character ?? 0),
    },
    end: {
      line: Number(raw.end?.line ?? 0),
      character: Number(raw.end?.character ?? 0),
    },
  };
}

function fallbackMappings(ranges) {
  const mappings = [];
  for (const range of ranges) {
    const startLine = range.range.start.line;
    const endLine = range.range.end.line;
    for (let line = startLine; line <= endLine; line += 1) {
      const startCharacter = line === startLine ? range.range.start.character : 0;
      const endCharacter = line === endLine ? range.range.end.character : Number.MAX_SAFE_INTEGER;
      if (line === endLine && endCharacter === 0) {
        continue;
      }
      const mappedRange = {
        start: { line, character: startCharacter },
        end: { line, character: endCharacter },
      };
      mappings.push({
        kind: range.kind,
        sourceRange: mappedRange,
        virtualRange: mappedRange,
      });
    }
  }
  return mappings;
}

function computeScopeAwareVirtualDocument(uri, text) {
  const input = JSON.stringify({ text, uri });
  const result = spawnSync(virtualizerCommand, virtualizerArgs, {
    input,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0 || !result.stdout) {
    debug("virtualizer fallback", result.status, result.stderr || "");
    warnVirtualizerFallback(result.status, result.stderr);
    return null;
  }

  try {
    const payload = JSON.parse(result.stdout);
    const ranges = (payload.ranges ?? []).map((range) => ({
      kind: range.kind,
      range: normalizeRange(range.sourceRange ?? range.range),
      virtualRange: normalizeRange(range.virtualRange),
      text: range.text ?? "",
    }));
    const mappings = (payload.mappings ?? []).map((mapping) => ({
      kind: mapping.kind,
      sourceRange: normalizeRange(mapping.sourceRange),
      virtualRange: normalizeRange(mapping.virtualRange),
    }));
    const symbols = (payload.symbols ?? []).map((symbol) => ({
      kind: symbol.kind,
      name: symbol.name,
      sourceRange: normalizeRange(symbol.sourceRange),
      virtualRange: normalizeRange(symbol.virtualRange),
    }));
    if (typeof payload.text === "string" && ranges.length > 0 && mappings.length > 0) {
      return {
        text: payload.text,
        ranges,
        mappings,
        symbols,
      };
    }
  } catch (error) {
    debug("virtualizer parse failed", String(error));
  }
  return null;
}

function warnVirtualizerFallback(status, stderr) {
  if (warnedVirtualizerFallback) {
    return;
  }
  warnedVirtualizerFallback = true;
  const detail = String(stderr || "").trim().split(/\r?\n/).slice(-1)[0] || `exit status ${status}`;
  process.stderr.write(
    `[kedi-embedded-python] scope-aware virtualizer unavailable via ${virtualizerCommand}: ${detail}\n`,
  );
}

function buildPythonDocument(uri, text) {
  const scopeAware = computeScopeAwareVirtualDocument(uri, text);
  if (scopeAware) {
    return scopeAware;
  }

  const ranges = extractPythonRanges(text);
  return {
    text: buildBlankedPythonDocument(text, ranges),
    ranges,
    mappings: fallbackMappings(ranges),
    symbols: [],
  };
}

function syncDocumentToPyright(uri, text, version) {
  const virtualUri = createVirtualUri(uri);
  const virtualDoc = buildPythonDocument(uri, text);
  const previous = docs.get(uri);

  docs.set(uri, {
    uri,
    virtualUri,
    text,
    version,
    ranges: virtualDoc.ranges,
    mappings: virtualDoc.mappings,
    symbols: virtualDoc.symbols,
    blankedText: virtualDoc.text,
  });
  debug("sync", uri, "as", virtualUri, "ranges", JSON.stringify(virtualDoc.ranges.map((range) => range.range)));

  if (previous) {
    queueOrSendToPyright({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri: virtualUri, version },
        contentChanges: [{ text: virtualDoc.text }],
      },
    });
    return;
  }

  queueOrSendToPyright({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: virtualUri,
        languageId: "python",
        version,
        text: virtualDoc.text,
      },
    },
  });
}

function closeDocumentInPyright(uri) {
  const existing = docs.get(uri);
  if (!existing) {
    return;
  }

  docs.delete(uri);
  queueOrSendToPyright({
    jsonrpc: "2.0",
    method: "textDocument/didClose",
    params: {
      textDocument: { uri: existing.virtualUri },
    },
  });
}

function mapUri(uri) {
  for (const doc of docs.values()) {
    if (uri === doc.virtualUri) {
      return doc.uri;
    }
  }
  return uri;
}

function mapPosition(mappings, position, fromKey, toKey) {
  for (const mapping of mappings) {
    const from = mapping[fromKey];
    const to = mapping[toKey];
    if (!from || !to || !isPositionInRange(position, from)) {
      continue;
    }
    return {
      line: to.start.line,
      character: position.character + to.start.character - from.start.character,
    };
  }
  return null;
}

function mapRange(mappings, range, fromKey, toKey) {
  if (!range) {
    return null;
  }
  const start = mapPosition(mappings, range.start, fromKey, toKey);
  let end = mapPosition(mappings, range.end, fromKey, toKey);
  if (!end && range.end.character > 0) {
    end = mapPosition(
      mappings,
      { line: range.end.line, character: range.end.character - 1 },
      fromKey,
      toKey,
    );
    if (end) {
      end = { ...end, character: end.character + 1 };
    }
  }
  if (!start || !end) {
    return null;
  }
  return { start, end };
}

function mapVirtualRangeToSource(doc, range) {
  return (
    mapRange(doc.mappings, range, "virtualRange", "sourceRange") ??
    mapRange(doc.symbols ?? [], range, "virtualRange", "sourceRange")
  );
}

function virtualWordAtPosition(doc, position) {
  const line = (doc.blankedText ?? "").split(/\r?\n/)[position.line] ?? "";
  let index = position.character;
  if (!isIdentifierChar(line[index] ?? "")) {
    index -= 1;
  }
  if (index < 0 || !isIdentifierChar(line[index] ?? "")) {
    return null;
  }

  let start = index;
  while (start > 0 && isIdentifierChar(line[start - 1])) {
    start -= 1;
  }
  let end = index + 1;
  while (end < line.length && isIdentifierChar(line[end])) {
    end += 1;
  }
  return {
    name: line.slice(start, end),
    range: {
      start: { line: position.line, character: start },
      end: { line: position.line, character: end },
    },
  };
}

function isIdentifierChar(char) {
  return /^[A-Za-z0-9_]$/.test(char);
}

function syntheticSymbolAtPosition(doc, position) {
  const word = virtualWordAtPosition(doc, position);
  if (!word) {
    return null;
  }
  const candidates = (doc.symbols ?? [])
    .filter((symbol) => symbol.name === word.name)
    .sort((a, b) => comparePosition(b.virtualRange.start, a.virtualRange.start));
  const symbol = candidates.find(
    (candidate) => comparePosition(candidate.virtualRange.start, position) <= 0,
  );
  return symbol ? { symbol, wordRange: word.range } : null;
}

function sameRange(a, b) {
  return (
    a?.start?.line === b?.start?.line &&
    a?.start?.character === b?.start?.character &&
    a?.end?.line === b?.end?.line &&
    a?.end?.character === b?.end?.character
  );
}

function hasLocation(locations, candidate) {
  return locations.some(
    (location) => location.uri === candidate.uri && sameRange(location.range, candidate.range),
  );
}

function applySyntheticFallback(method, mappedResult, doc, virtualPosition) {
  if (!doc || !virtualPosition) {
    return mappedResult;
  }
  const synthetic = syntheticSymbolAtPosition(doc, virtualPosition);
  if (!synthetic) {
    return mappedResult;
  }

  if (method === "textDocument/definition") {
    if (Array.isArray(mappedResult) && mappedResult.length > 0) {
      return mappedResult;
    }
    if (mappedResult && !Array.isArray(mappedResult)) {
      return mappedResult;
    }
    return [{ uri: doc.uri, range: synthetic.symbol.sourceRange }];
  }

  if (method === "textDocument/references") {
    const references = Array.isArray(mappedResult) ? [...mappedResult] : [];
    const declaration = { uri: doc.uri, range: synthetic.symbol.sourceRange };
    if (!hasLocation(references, declaration)) {
      references.unshift(declaration);
    }
    const usageRange = mapVirtualRangeToSource(doc, synthetic.wordRange);
    if (usageRange) {
      const usage = { uri: doc.uri, range: usageRange };
      if (!hasLocation(references, usage)) {
        references.push(usage);
      }
    }
    return references;
  }

  return mappedResult;
}

function mapResult(result, doc) {
  if (!result) {
    return result;
  }
  if (Array.isArray(result)) {
    return result.map((item) => mapResult(item, doc)).filter((item) => item !== null);
  }
  if (typeof result !== "object") {
    return result;
  }
  if (typeof result.uri === "string" && result.range) {
    if (!doc || result.uri !== doc.virtualUri) {
      return { ...result, uri: mapUri(result.uri) };
    }
    const range = mapVirtualRangeToSource(doc, result.range);
    return range ? { ...result, uri: doc.uri, range } : null;
  }
  if (typeof result.targetUri === "string") {
    if (!doc || result.targetUri !== doc.virtualUri) {
      return { ...result, targetUri: mapUri(result.targetUri) };
    }
    const targetRange = mapVirtualRangeToSource(doc, result.targetRange);
    const targetSelectionRange = mapVirtualRangeToSource(
      doc,
      result.targetSelectionRange ?? result.targetRange,
    );
    if (!targetRange || !targetSelectionRange) {
      return null;
    }
    return {
      ...result,
      targetUri: doc.uri,
      targetRange,
      targetSelectionRange,
    };
  }
  if (result.range && doc) {
    const range = mapVirtualRangeToSource(doc, result.range);
    if (range) {
      return { ...result, range };
    }
    const clone = { ...result };
    delete clone.range;
    return clone;
  }
  return result;
}

function respondEmptyForMethod(method) {
  if (method === "textDocument/references") {
    return [];
  }
  return null;
}

function handleClientRequest(message) {
  switch (message.method) {
    case "initialize": {
      pendingClientInitializeId = message.id;
      sendToPyright({
        jsonrpc: "2.0",
        id: nextPyrightId,
        method: "initialize",
        params: message.params,
      });
      pendingPyrightRequests.set(nextPyrightId, { type: "initialize" });
      nextPyrightId += 1;
      return;
    }
    case "shutdown": {
      sendToClient({ jsonrpc: "2.0", id: message.id, result: null });
      queueOrSendToPyright({
        jsonrpc: "2.0",
        method: "shutdown",
        id: nextPyrightId,
        params: null,
      });
      nextPyrightId += 1;
      return;
    }
    case "textDocument/hover":
    case "textDocument/definition":
    case "textDocument/references": {
      const uri = message.params?.textDocument?.uri;
      const position = message.params?.position;
      const doc = docs.get(uri);
      if (!doc || !position) {
        sendToClient({
          jsonrpc: "2.0",
          id: message.id,
          result: respondEmptyForMethod(message.method),
        });
        return;
      }

      const activeRange = doc.ranges.find((range) => isPositionInRange(position, range.range));
      if (!activeRange) {
        sendToClient({
          jsonrpc: "2.0",
          id: message.id,
          result: respondEmptyForMethod(message.method),
        });
        return;
      }
      const virtualPosition = mapPosition(doc.mappings, position, "sourceRange", "virtualRange");
      if (!virtualPosition) {
        sendToClient({
          jsonrpc: "2.0",
          id: message.id,
          result: respondEmptyForMethod(message.method),
        });
        return;
      }

      const pyrightId = nextPyrightId++;
      pendingPyrightRequests.set(pyrightId, {
        type: "clientRequest",
        clientId: message.id,
        method: message.method,
        docUri: uri,
        virtualPosition,
      });

      sendToPyright({
        jsonrpc: "2.0",
        id: pyrightId,
        method: message.method,
        params: {
          ...message.params,
          textDocument: {
            ...message.params.textDocument,
            uri: doc.virtualUri,
          },
          position: virtualPosition,
        },
      });
      return;
    }
    default: {
      if (typeof message.id !== "undefined") {
        sendToClient({
          jsonrpc: "2.0",
          id: message.id,
          result: null,
        });
      }
    }
  }
}

function handleClientNotification(message) {
  switch (message.method) {
    case "initialized":
      queueOrSendToPyright(message);
      return;
    case "workspace/didChangeConfiguration":
      latestConfig = message.params?.settings ?? {};
      queueOrSendToPyright(message);
      return;
    case "textDocument/didOpen": {
      const doc = message.params?.textDocument;
      if (!doc?.uri || typeof doc.text !== "string") {
        return;
      }
      syncDocumentToPyright(doc.uri, doc.text, doc.version ?? 0);
      return;
    }
    case "textDocument/didChange": {
      const uri = message.params?.textDocument?.uri;
      const version = message.params?.textDocument?.version ?? 0;
      const text = message.params?.contentChanges?.[0]?.text;
      if (!uri || typeof text !== "string") {
        return;
      }
      syncDocumentToPyright(uri, text, version);
      return;
    }
    case "textDocument/didClose": {
      const uri = message.params?.textDocument?.uri;
      if (!uri) {
        return;
      }
      closeDocumentInPyright(uri);
      return;
    }
    case "exit":
      pyright.kill();
      process.exit(0);
      return;
    default:
      queueOrSendToPyright(message);
  }
}

function handlePyrightMessage(message) {
  if (typeof message.method === "string" && typeof message.id !== "undefined") {
    if (message.method === "workspace/configuration") {
      const items = message.params?.items ?? [];
      sendToPyright({
        jsonrpc: "2.0",
        id: message.id,
        result: items.map(() => latestConfig),
      });
      return;
    }
    sendToPyright({
      jsonrpc: "2.0",
      id: message.id,
      result: null,
    });
    return;
  }

  if (typeof message.id !== "undefined") {
    const pending = pendingPyrightRequests.get(message.id);
    if (!pending) {
      return;
    }
    pendingPyrightRequests.delete(message.id);

    if (pending.type === "initialize") {
      pyrightInitialized = true;
      flushPendingNotifications();
      sendToClient({
        jsonrpc: "2.0",
        id: pendingClientInitializeId,
        result: {
          capabilities: {
            textDocumentSync: {
              openClose: true,
              change: 1,
            },
            hoverProvider: true,
            definitionProvider: true,
            referencesProvider: true,
          },
          serverInfo: {
            name: "kedi-embedded-python",
          },
        },
      });
      pendingClientInitializeId = null;
      return;
    }

    if (pending.type === "clientRequest") {
      const doc = docs.get(pending.docUri);
      const mappedResult = mapResult(message.result, doc);
      sendToClient({
        jsonrpc: "2.0",
        id: pending.clientId,
        result: applySyntheticFallback(
          pending.method,
          mappedResult,
          doc,
          pending.virtualPosition,
        ),
      });
      return;
    }

    return;
  }

  if (message.method === "window/logMessage") {
    sendToClient(message);
  }
}

const clientReader = new Reader((message) => {
  if (typeof message.method === "string") {
    if (typeof message.id !== "undefined") {
      handleClientRequest(message);
    } else {
      handleClientNotification(message);
    }
  }
});

const pyrightReader = new Reader(handlePyrightMessage);

process.stdin.on("data", (chunk) => clientReader.push(chunk));
pyright.stdout.on("data", (chunk) => pyrightReader.push(chunk));
process.stdin.on("data", () => debug("<-client chunk"));
pyright.stdout.on("data", () => debug("<-pyright chunk"));

pyright.on("exit", (code, signal) => {
  if (signal === "SIGTERM" || signal === "SIGINT") {
    process.exit(0);
    return;
  }

  process.stderr.write(`Pyright exited unexpectedly (code=${code}, signal=${signal}).\n`);
  process.exit(code ?? 1);
});
