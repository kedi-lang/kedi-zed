import { spawn } from "node:child_process";

const pyrightEntrypoint = process.argv[2] ?? process.argv[1];
const debugEnabled = process.env.KEDI_DEBUG_EMBEDDED_PYTHON === "1";

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

const docs = new Map();
const pendingPyrightRequests = new Map();

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
    if (!trimmed.startsWith("```")) {
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

  for (const range of ranges) {
    for (let i = range.startOffset; i < range.endOffset && i < keep.length; i += 1) {
      keep[i] = true;
    }
  }

  return chars
    .map((char, index) => {
      if (keep[index] || char === "\n") {
        return char;
      }
      return " ";
    })
    .join("");
}

function syncDocumentToPyright(uri, text, version) {
  const virtualUri = createVirtualUri(uri);
  const ranges = extractPythonRanges(text);
  const blankedText = buildBlankedPythonDocument(text, ranges);
  const previous = docs.get(uri);

  docs.set(uri, {
    uri,
    virtualUri,
    text,
    version,
    ranges,
    blankedText,
  });

  if (previous) {
    queueOrSendToPyright({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri: virtualUri, version },
        contentChanges: [{ text: blankedText }],
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
        text: blankedText,
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

function mapLocations(result) {
  if (!result) {
    return result;
  }
  if (Array.isArray(result)) {
    return result.map(mapLocations);
  }
  if (typeof result !== "object") {
    return result;
  }
  if (typeof result.uri === "string" && result.range) {
    return { ...result, uri: mapUri(result.uri) };
  }
  if (typeof result.targetUri === "string") {
    return { ...result, targetUri: mapUri(result.targetUri) };
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

      const pyrightId = nextPyrightId++;
      pendingPyrightRequests.set(pyrightId, {
        type: "clientRequest",
        clientId: message.id,
        method: message.method,
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
      sendToClient({
        jsonrpc: "2.0",
        id: pending.clientId,
        result: mapLocations(message.result),
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
