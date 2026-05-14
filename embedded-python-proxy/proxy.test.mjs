import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const proxyPath = path.join(root, "embedded-python-proxy", "server.mjs");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kedi-proxy-test-"));
const fakePyrightPath = path.join(tempDir, "fake-pyright.mjs");

fs.writeFileSync(
  fakePyrightPath,
  [
    "let buffer = Buffer.alloc(0);",
    "function write(msg) {",
    "  const body = JSON.stringify(msg);",
    "  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\\r\\n\\r\\n${body}`);",
    "}",
    "function handle(msg) {",
    "  if (msg.method === 'initialize') {",
    "    write({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { hoverProvider: true, definitionProvider: true, referencesProvider: true } } });",
    "    return;",
    "  }",
    "  if (msg.method === 'textDocument/hover') {",
    "    write({ jsonrpc: '2.0', id: msg.id, result: { contents: { kind: 'plaintext', value: 'py-hover' } } });",
    "    return;",
    "  }",
    "  if (msg.method === 'textDocument/definition' || msg.method === 'textDocument/references') {",
    "    write({ jsonrpc: '2.0', id: msg.id, result: [{ uri: msg.params.textDocument.uri, range: { start: { line: 1, character: 4 }, end: { line: 1, character: 7 } } }] });",
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
        text: "@x():\n  = <`foo`>\n",
      },
    },
  });

  const hover = await request("textDocument/hover", {
    textDocument: { uri: "file:///tmp/test.kedi" },
    position: { line: 1, character: 7 },
  });
  if (hover.contents.value !== "py-hover") {
    throw new Error("Hover forwarding failed");
  }

  const definition = await request("textDocument/definition", {
    textDocument: { uri: "file:///tmp/test.kedi" },
    position: { line: 1, character: 7 },
  });
  if (definition[0].uri !== "file:///tmp/test.kedi") {
    throw new Error("Definition URI remap failed");
  }

  const references = await request("textDocument/references", {
    textDocument: { uri: "file:///tmp/test.kedi" },
    position: { line: 1, character: 7 },
    context: { includeDeclaration: true },
  });
  if (references[0].uri !== "file:///tmp/test.kedi") {
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
