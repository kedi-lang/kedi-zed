import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const proxyPath = path.join(root, "embedded-python-proxy", "server.mjs");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kedi-proxy-test-"));
const fakePyrightPath = path.join(tempDir, "fake-pyright.mjs");
const fakeVirtualizerPath = path.join(tempDir, "fake-virtualizer.mjs");

fs.writeFileSync(
  fakeVirtualizerPath,
  [
    "const payload = JSON.parse(await new Promise(resolve => {",
    "  let data = '';",
    "  process.stdin.setEncoding('utf8');",
    "  process.stdin.on('data', chunk => data += chunk);",
    "  process.stdin.on('end', () => resolve(data || '{}'));",
    "}));",
    "const text = payload.text || '';",
    "let result;",
    "if (text.includes('foo = 1')) {",
    "  result = {",
    "    text: 'from typing import Any\\n\\ndef __kedi_scope_x() -> str:\\n    def __kedi_block_foo() -> int:\\n        foo = 1\\n        foo\\n',",
    "    ranges: [{ kind: 'fenced', range: { start: { line: 2, character: 0 }, end: { line: 4, character: 0 } }, sourceRange: { start: { line: 2, character: 0 }, end: { line: 4, character: 0 } }, virtualRange: { start: { line: 4, character: 8 }, end: { line: 5, character: 11 } }, text: 'foo = 1\\nfoo' }],",
    "    mappings: [",
    "      { kind: 'fenced', sourceRange: { start: { line: 2, character: 2 }, end: { line: 2, character: 9 } }, virtualRange: { start: { line: 4, character: 8 }, end: { line: 4, character: 15 } } },",
    "      { kind: 'fenced', sourceRange: { start: { line: 3, character: 2 }, end: { line: 3, character: 5 } }, virtualRange: { start: { line: 5, character: 8 }, end: { line: 5, character: 11 } } }",
    "    ],",
    "    symbols: []",
    "  };",
    "} else {",
    "  result = {",
    "    text: 'from typing import Any\\n\\ndef __kedi_scope_x() -> str:\\n    foo: int = ...\\n    foo\\n',",
    "    ranges: [{ kind: 'inline', range: { start: { line: 2, character: 7 }, end: { line: 2, character: 10 } }, sourceRange: { start: { line: 2, character: 7 }, end: { line: 2, character: 10 } }, virtualRange: { start: { line: 4, character: 4 }, end: { line: 4, character: 7 } }, text: 'foo' }],",
    "    mappings: [{ kind: 'inline', sourceRange: { start: { line: 2, character: 7 }, end: { line: 2, character: 10 } }, virtualRange: { start: { line: 4, character: 4 }, end: { line: 4, character: 7 } } }],",
    "    symbols: [{ kind: 'local', name: 'foo', sourceRange: { start: { line: 1, character: 3 }, end: { line: 1, character: 6 } }, virtualRange: { start: { line: 3, character: 4 }, end: { line: 3, character: 7 } } }]",
    "  };",
    "}",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n"),
);

fs.writeFileSync(
  fakePyrightPath,
  [
    "let buffer = Buffer.alloc(0);",
    "let openedText = '';",
    "let answeredServerRequest = false;",
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
    "  if (msg.method === 'textDocument/hover') {",
    "    const pos = msg.params.position;",
    "    const ok = openedText.includes('def __kedi_scope_x') && openedText.includes('foo') && answeredServerRequest && ((pos.line === 5 && pos.character === 9) || (pos.line === 4 && pos.character === 4));",
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
  write({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: "file:///tmp/test.kedi",
        languageId: "kedi",
        version: 1,
        text: "@x():\n  = ```\n  foo = 1\n  foo\n  ```\n",
      },
    },
  });

  const hover = await request("textDocument/hover", {
    textDocument: { uri: "file:///tmp/test.kedi" },
    position: { line: 3, character: 3 },
  });
  if (hover.contents.value !== "py-hover") {
    throw new Error("Hover forwarding failed");
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
