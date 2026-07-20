import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const proxyPath = path.join(root, "embedded-python-proxy", "server.mjs");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kedi-proxy-test-"));
const fakePyrightPath = path.join(tempDir, "fake-pyright.mjs");
const fakeVirtualizerPath = path.join(tempDir, "fake-virtualizer.mjs");
const virtualizerStartsPath = path.join(tempDir, "virtualizer-starts.txt");
const virtualizerRequestsPath = path.join(tempDir, "virtualizer-requests.txt");
const virtualizerFocusPath = path.join(tempDir, "virtualizer-focus.txt");
const virtualizerCrashPath = path.join(tempDir, "virtualizer-crashed.txt");
const pyrightChangesPath = path.join(tempDir, "pyright-changes.txt");

fs.writeFileSync(
  fakeVirtualizerPath,
  [
    "import fs from 'node:fs';",
    `const startsPath = ${JSON.stringify(virtualizerStartsPath)};`,
    `const requestsPath = ${JSON.stringify(virtualizerRequestsPath)};`,
    `const focusPath = ${JSON.stringify(virtualizerFocusPath)};`,
    `const crashPath = ${JSON.stringify(virtualizerCrashPath)};`,
    "function increment(file) {",
    "  let value = 0;",
    "  try { value = Number(fs.readFileSync(file, 'utf8')) || 0; } catch {}",
    "  fs.writeFileSync(file, String(value + 1));",
    "}",
    "function append(file, value) {",
    "  fs.appendFileSync(file, `${value}\\n`);",
    "}",
    "function resultFor(text, focusLine) {",
    "  if (text.includes('module_scope')) {",
    "    if (focusLine === -1) {",
    "      return {",
    "        text: 'from typing import Any\\n\\nfoo: Any = ...\\nfoo\\n',",
    "        ranges: [{ kind: 'inline', range: { start: { line: 5, character: 4 }, end: { line: 5, character: 7 } }, sourceRange: { start: { line: 5, character: 4 }, end: { line: 5, character: 7 } }, virtualRange: { start: { line: 3, character: 0 }, end: { line: 3, character: 3 } }, text: 'foo' }],",
    "        mappings: [{ kind: 'inline', sourceRange: { start: { line: 5, character: 4 }, end: { line: 5, character: 7 } }, virtualRange: { start: { line: 3, character: 0 }, end: { line: 3, character: 3 } } }],",
    "        symbols: []",
    "      };",
    "    }",
    "    return {",
    "      text: 'from typing import Any\\n\\ndef __kedi_module_scope() -> Any:\\n    module_scope = 1\\n    foo = 1\\n',",
    "      ranges: [{ kind: 'fenced', range: { start: { line: 1, character: 0 }, end: { line: 3, character: 0 } }, sourceRange: { start: { line: 1, character: 0 }, end: { line: 3, character: 0 } }, virtualRange: { start: { line: 3, character: 4 }, end: { line: 4, character: 11 } }, text: 'module_scope = 1\\nfoo = 1' }],",
    "      mappings: [{ kind: 'fenced', sourceRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 7 } }, virtualRange: { start: { line: 4, character: 3 }, end: { line: 4, character: 10 } } }],",
    "      symbols: []",
    "    };",
    "  }",
    "  if (text.includes('focus_existing_range')) {",
    "    if (focusLine === -1) {",
    "      return {",
    "        text: 'from typing import Any\\n\\nlimit: Any = ...\\nlimit\\n',",
    "        ranges: [{ kind: 'fenced', range: { start: { line: 2, character: 0 }, end: { line: 4, character: 0 } }, sourceRange: { start: { line: 2, character: 0 }, end: { line: 4, character: 0 } }, virtualRange: { start: { line: 2, character: 0 }, end: { line: 3, character: 5 } }, text: 'focus_existing_range\\nlimit' }],",
    "        mappings: [{ kind: 'fenced', sourceRange: { start: { line: 3, character: 2 }, end: { line: 3, character: 7 } }, virtualRange: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } } }],",
    "        symbols: []",
    "      };",
    "    }",
    "    return {",
    "      text: 'from typing import Any\\n\\ndef __kedi_scope_x(limit: int) -> str:\\n    limit\\n',",
    "      ranges: [{ kind: 'fenced', range: { start: { line: 2, character: 0 }, end: { line: 4, character: 0 } }, sourceRange: { start: { line: 2, character: 0 }, end: { line: 4, character: 0 } }, virtualRange: { start: { line: 3, character: 4 }, end: { line: 3, character: 9 } }, text: 'focus_existing_range\\nlimit' }],",
    "      mappings: [{ kind: 'fenced', sourceRange: { start: { line: 3, character: 2 }, end: { line: 3, character: 7 } }, virtualRange: { start: { line: 3, character: 4 }, end: { line: 3, character: 9 } } }],",
    "      symbols: []",
    "    };",
    "  }",
    "function resultForDefault(text) {",
    "  if (text.includes('foo = 1')) {",
    "    return {",
    "      text: 'from typing import Any\\n\\ndef __kedi_scope_x() -> str:\\n    def __kedi_block_foo() -> int:\\n        foo = 1\\n        foo\\n',",
    "      ranges: [{ kind: 'fenced', range: { start: { line: 2, character: 0 }, end: { line: 4, character: 0 } }, sourceRange: { start: { line: 2, character: 0 }, end: { line: 4, character: 0 } }, virtualRange: { start: { line: 4, character: 8 }, end: { line: 5, character: 11 } }, text: 'foo = 1\\nfoo' }],",
    "      mappings: [",
    "        { kind: 'fenced', sourceRange: { start: { line: 2, character: 2 }, end: { line: 2, character: 9 } }, virtualRange: { start: { line: 4, character: 8 }, end: { line: 4, character: 15 } } },",
    "        { kind: 'fenced', sourceRange: { start: { line: 3, character: 2 }, end: { line: 3, character: 5 } }, virtualRange: { start: { line: 5, character: 8 }, end: { line: 5, character: 11 } } }",
    "      ],",
    "      symbols: []",
    "    };",
    "  }",
    "  return {",
    "    text: 'from typing import Any\\n\\ndef __kedi_scope_x() -> str:\\n    foo: int = ...\\n    foo\\n',",
    "    ranges: [{ kind: 'inline', range: { start: { line: 2, character: 7 }, end: { line: 2, character: 10 } }, sourceRange: { start: { line: 2, character: 7 }, end: { line: 2, character: 10 } }, virtualRange: { start: { line: 4, character: 4 }, end: { line: 4, character: 7 } }, text: 'foo' }],",
    "    mappings: [{ kind: 'inline', sourceRange: { start: { line: 2, character: 7 }, end: { line: 2, character: 10 } }, virtualRange: { start: { line: 4, character: 4 }, end: { line: 4, character: 7 } } }],",
    "    symbols: [{ kind: 'local', name: 'foo', sourceRange: { start: { line: 1, character: 3 }, end: { line: 1, character: 6 } }, virtualRange: { start: { line: 3, character: 4 }, end: { line: 3, character: 7 } } }]",
    "  };",
    "}",
    "  return resultForDefault(text);",
    "}",
    "function handleLine(line) {",
    "  if (!line.trim()) return;",
    "  const payload = JSON.parse(line);",
    "  increment(requestsPath);",
    "  append(focusPath, String(payload.focusLine));",
    "  const text = payload.text || '';",
    "  if (text.includes('crash_once') && !fs.existsSync(crashPath)) {",
    "    fs.writeFileSync(crashPath, '1');",
    "    process.exit(2);",
    "  }",
    "  process.stdout.write(JSON.stringify({ id: payload.id, ok: true, result: resultFor(text, payload.focusLine) }) + '\\n');",
    "}",
    "increment(startsPath);",
    "let data = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => {",
    "  data += chunk;",
    "  while (true) {",
    "    const newline = data.indexOf('\\n');",
    "    if (newline === -1) break;",
    "    const line = data.slice(0, newline);",
    "    data = data.slice(newline + 1);",
    "    handleLine(line);",
    "  }",
    "});",
    "process.stdin.on('end', () => {",
    "  if (data.trim()) handleLine(data);",
    "});",
  ].join("\n"),
);

fs.writeFileSync(
  fakePyrightPath,
  [
    "import fs from 'node:fs';",
    `const changesPath = ${JSON.stringify(pyrightChangesPath)};`,
    "let buffer = Buffer.alloc(0);",
    "let openedText = '';",
    "let answeredServerRequest = false;",
    "function increment(file) {",
    "  let value = 0;",
    "  try { value = Number(fs.readFileSync(file, 'utf8')) || 0; } catch {}",
    "  fs.writeFileSync(file, String(value + 1));",
    "}",
    "function write(msg) {",
    "  const body = JSON.stringify(msg);",
    "  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\\r\\n\\r\\n${body}`);",
    "}",
    "function handle(msg) {",
    "  if (msg.method === 'initialize') {",
    "    write({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { hoverProvider: true, definitionProvider: true, referencesProvider: true } } });",
    "    write({ jsonrpc: '2.0', id: 9001, method: 'client/registerCapability', params: { registrations: [] } });",
    "    return;",
    "  }",
    "  if (msg.id === 9001 && Object.prototype.hasOwnProperty.call(msg, 'result')) {",
    "    answeredServerRequest = true;",
    "    return;",
    "  }",
    "  if (msg.method === 'textDocument/didOpen') {",
    "    openedText = msg.params.textDocument.text;",
    "    return;",
    "  }",
    "  if (msg.method === 'textDocument/didChange') {",
    "    openedText = msg.params.contentChanges[0].text;",
    "    increment(changesPath);",
    "    return;",
    "  }",
    "  if (msg.method === 'textDocument/hover') {",
    "    const pos = msg.params.position;",
    "    const ok = (openedText.includes('def __kedi_scope_x') || openedText.includes('def __kedi_module_scope')) && (openedText.includes('foo') || openedText.includes('limit: int')) && answeredServerRequest && ((pos.line === 5 && pos.character === 9) || (pos.line === 4 && pos.character === 4) || (pos.line === 3 && pos.character === 5));",
    "    write({ jsonrpc: '2.0', id: msg.id, result: { contents: { kind: 'plaintext', value: ok ? 'py-hover' : openedText } } });",
    "    return;",
    "  }",
    "  if (msg.method === 'textDocument/definition' || msg.method === 'textDocument/references') {",
    "    const pos = msg.params.position;",
    "    if (pos.line === 4) {",
    "      write({ jsonrpc: '2.0', id: msg.id, result: [] });",
    "      return;",
    "    }",
    "    const range = pos.line === 4 ? { start: { line: 3, character: 4 }, end: { line: 3, character: 7 } } : { start: { line: 5, character: 8 }, end: { line: 5, character: 11 } };",
    "    write({ jsonrpc: '2.0', id: msg.id, result: [{ uri: msg.params.textDocument.uri, range }] });",
    "  }",
    "}",
    "process.stdin.on('data', chunk => {",
    "  buffer = Buffer.concat([buffer, chunk]);",
    "  while (true) {",
    "    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');",
    "    if (headerEnd === -1) break;",
    "    const header = buffer.slice(0, headerEnd).toString('utf8');",
    "    const match = header.match(/Content-Length:\\s*(\\d+)/i);",
    "    if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }",
    "    const length = Number(match[1]);",
    "    const messageEnd = headerEnd + 4 + length;",
    "    if (buffer.length < messageEnd) break;",
    "    const body = buffer.slice(headerEnd + 4, messageEnd).toString('utf8');",
    "    buffer = buffer.slice(messageEnd);",
    "    handle(JSON.parse(body));",
    "  }",
    "});",
  ].join("\n"),
);

const proxy = spawn(process.execPath, [proxyPath, fakePyrightPath], {
  cwd: root,
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    KEDI_PYTHON_VIRTUALIZER_COMMAND: process.execPath,
    KEDI_PYTHON_VIRTUALIZER_ARGS: JSON.stringify([fakeVirtualizerPath]),
  },
});

let buffer = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();

function write(message) {
  const body = JSON.stringify(message);
  proxy.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 3000);
    pending.set(id, { resolve, reject, timeout });
    write({ jsonrpc: "2.0", id, method, params });
  });
}

proxy.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }

    const length = Number(match[1]);
    const messageEnd = headerEnd + 4 + length;
    if (buffer.length < messageEnd) break;

    const body = buffer.slice(headerEnd + 4, messageEnd).toString("utf8");
    buffer = buffer.slice(messageEnd);

    const message = JSON.parse(body);
    if (typeof message.id !== "undefined" && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(waiter.timeout);
      waiter.resolve(message.result);
    }
  }
});

function readCount(file) {
  try {
    return Number(fs.readFileSync(file, "utf8")) || 0;
  } catch {
    return 0;
  }
}

function readLines(file) {
  try {
    return fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function assertPythonReturnHover(hover, label) {
  const value = hover?.contents?.value ?? "";
  if (!value.includes("py-hover") || !value.includes("Python return")) {
    throw new Error(`${label}: expected Python symbol and Kedi return context, got ${value}`);
  }
}

try {
  const init = await request("initialize", {
    processId: null,
    rootUri: "file:///tmp",
    capabilities: {},
  });

  if (
    !init.capabilities?.hoverProvider ||
    !init.capabilities?.definitionProvider ||
    !init.capabilities?.referencesProvider
  ) {
    throw new Error("Proxy did not advertise embedded Python capabilities");
  }

  write({ jsonrpc: "2.0", method: "initialized", params: {} });
  const fencedText = "@x():\n  = ```\n  foo = 1\n  foo\n  ```\n";
  write({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: "file:///tmp/test.kedi",
        languageId: "kedi",
        version: 1,
        text: fencedText,
      },
    },
  });

  const hover = await request("textDocument/hover", {
    textDocument: { uri: "file:///tmp/test.kedi" },
    position: { line: 3, character: 3 },
  });
  assertPythonReturnHover(hover, "Hover forwarding failed");
  if (readCount(virtualizerStartsPath) !== 1) {
    throw new Error("Persistent virtualizer should stay alive after initial sync");
  }

  write({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: "file:///tmp/test-focused-range.kedi",
        languageId: "kedi",
        version: 1,
        text: "@x(limit: int):\n  = ```\n  focus_existing_range\n  limit\n  ```\n",
      },
    },
  });

  const focusedRangeHover = await request("textDocument/hover", {
    textDocument: { uri: "file:///tmp/test-focused-range.kedi" },
    position: { line: 3, character: 3 },
  });
  assertPythonReturnHover(
    focusedRangeHover,
    "Existing background range should be rebuilt for focused hover",
  );
  const focusedRangeRequests = readLines(virtualizerFocusPath);
  if (!focusedRangeRequests.includes("-1") || !focusedRangeRequests.includes("3")) {
    throw new Error("Proxy should replace a background range with its focused virtual document");
  }

  const requestsAfterFirstHover = readCount(virtualizerRequestsPath);
  const changesAfterFirstHover = readCount(pyrightChangesPath);
  write({
    jsonrpc: "2.0",
    method: "textDocument/didChange",
    params: {
      textDocument: { uri: "file:///tmp/test.kedi", version: 2 },
      contentChanges: [{ text: fencedText }],
    },
  });

  const cachedHover = await request("textDocument/hover", {
    textDocument: { uri: "file:///tmp/test.kedi" },
    position: { line: 3, character: 3 },
  });
  assertPythonReturnHover(cachedHover, "Cached hover forwarding failed");
  if (readCount(virtualizerRequestsPath) !== requestsAfterFirstHover) {
    throw new Error("Same-source virtual document cache missed");
  }
  if (readCount(pyrightChangesPath) !== changesAfterFirstHover) {
    throw new Error("Unchanged virtual document should not be resent to Pyright");
  }

  write({
    jsonrpc: "2.0",
    method: "textDocument/didChange",
    params: {
      textDocument: { uri: "file:///tmp/test.kedi", version: 3 },
      contentChanges: [{ text: "@x():\n  = ```\n  foo = 1\n  foo\n  # crash_once\n  ```\n" }],
    },
  });

  const restartedHover = await request("textDocument/hover", {
    textDocument: { uri: "file:///tmp/test.kedi" },
    position: { line: 3, character: 3 },
  });
  assertPythonReturnHover(
    restartedHover,
    "Hover forwarding failed after virtualizer restart",
  );
  if (readCount(virtualizerStartsPath) !== 2) {
    throw new Error("Persistent virtualizer should restart after a failed request");
  }

  write({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: "file:///tmp/test-inline.kedi",
        languageId: "kedi",
        version: 1,
        text: "@x():\n  [foo: int] = `1`\n  = <`foo`>\n",
      },
    },
  });

  const inlineHover = await request("textDocument/hover", {
    textDocument: { uri: "file:///tmp/test-inline.kedi" },
    position: { line: 2, character: 7 },
  });
  if (inlineHover.contents.value !== "py-hover") {
    throw new Error("Inline hover forwarding failed");
  }

  const inlineDefinition = await request("textDocument/definition", {
    textDocument: { uri: "file:///tmp/test-inline.kedi" },
    position: { line: 2, character: 7 },
  });
  if (
    inlineDefinition[0].uri !== "file:///tmp/test-inline.kedi" ||
    inlineDefinition[0].range.start.line !== 1 ||
    inlineDefinition[0].range.start.character !== 3
  ) {
    throw new Error("Synthetic symbol definition remap failed");
  }

  const inlineReferences = await request("textDocument/references", {
    textDocument: { uri: "file:///tmp/test-inline.kedi" },
    position: { line: 2, character: 7 },
    context: { includeDeclaration: true },
  });
  if (
    inlineReferences.length !== 2 ||
    inlineReferences[0].range.start.line !== 1 ||
    inlineReferences[0].range.start.character !== 3 ||
    inlineReferences[1].range.start.line !== 2 ||
    inlineReferences[1].range.start.character !== 7
  ) {
    throw new Error("Synthetic symbol references fallback failed");
  }

  const definition = await request("textDocument/definition", {
    textDocument: { uri: "file:///tmp/test.kedi" },
    position: { line: 3, character: 3 },
  });
  if (
    definition[0].uri !== "file:///tmp/test.kedi" ||
    definition[0].range.start.line !== 3 ||
    definition[0].range.start.character !== 2
  ) {
    throw new Error("Definition URI remap failed");
  }

  const references = await request("textDocument/references", {
    textDocument: { uri: "file:///tmp/test.kedi" },
    position: { line: 3, character: 3 },
    context: { includeDeclaration: true },
  });
  if (
    references[0].uri !== "file:///tmp/test.kedi" ||
    references[0].range.start.line !== 3 ||
    references[0].range.start.character !== 2
  ) {
    throw new Error("References URI remap failed");
  }

  write({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: "file:///tmp/test-module.kedi",
        languageId: "kedi",
        version: 1,
        text: "```\nmodule_scope = 1\nfoo = 1\n```\n\n= <`foo`>\n",
      },
    },
  });

  const moduleHover = await request("textDocument/hover", {
    textDocument: { uri: "file:///tmp/test-module.kedi" },
    position: { line: 2, character: 1 },
  });
  if (moduleHover.contents.value !== "py-hover") {
    throw new Error("Focused module-scope hover forwarding failed");
  }
  const focusRequests = readLines(virtualizerFocusPath);
  if (!focusRequests.includes("-1") || !focusRequests.includes("2")) {
    throw new Error("Proxy should use background sync and focused module sync");
  }

  const outsideHover = await request("textDocument/hover", {
    textDocument: { uri: "file:///tmp/test.kedi" },
    position: { line: 0, character: 0 },
  });
  if (outsideHover !== null) {
    throw new Error("Outside-Python hover should be null");
  }

  console.log("proxy-test: ok");
} finally {
  write({ jsonrpc: "2.0", method: "exit", params: {} });
  proxy.kill();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
