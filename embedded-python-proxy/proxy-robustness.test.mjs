import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Proxy robustness tests (audit #215: Z2, Z3, Z4, Z5, Z6, Z7, Z10).
// Each test spawns the real server.mjs with a fake pyright and a fake
// virtualizer, drives it over LSP, and asserts the fixed behaviour.
// The fake pyright/virtualizer scripts are generated per test from the
// behaviour objects below, so each test controls exactly one failure mode.

const root = path.resolve(import.meta.dirname, "..");
const proxyPath = path.join(root, "embedded-python-proxy", "server.mjs");

const FENCED_TEXT = "@x():\n  = ```\n  foo = 1\n  foo\n  ```\n";
const INLINE_TEXT = "@x():\n  [foo: int] = `1`\n  = <`foo`>\n";

function fakePyrightScript(behavior) {
  return [
    `const behavior = ${JSON.stringify(behavior)};`,
    "import fs from 'node:fs';",
    "let buffer = Buffer.alloc(0);",
    "let heldHover = null;",
    "function log(event, extra = {}) {",
    "  if (!behavior.recordPath) return;",
    "  fs.appendFileSync(behavior.recordPath, JSON.stringify({ event, ...extra }) + '\\n');",
    "}",
    "function write(msg) {",
    "  const body = JSON.stringify(msg);",
    "  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\\r\\n\\r\\n${body}`);",
    "}",
    "if (behavior.pidPath) fs.writeFileSync(behavior.pidPath, String(process.pid));",
    "function handle(msg) {",
    "  if (msg.method === 'initialize') {",
    "    log('initialize-request');",
    "    if (behavior.errorOnInitialize) {",
    "      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'init-boom' } });",
    "      return;",
    "    }",
    "    const respond = () => {",
    "      log('initialize-response');",
    "      write({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { hoverProvider: true, definitionProvider: true, referencesProvider: true } } });",
    "      if (behavior.destroyStdinAfterInit) { fs.closeSync(0); setInterval(() => {}, 3600000); }",
    "    };",
    "    if (behavior.delayInitializeMs) setTimeout(respond, behavior.delayInitializeMs);",
    "    else respond();",
    "    return;",
    "  }",
    "  if (msg.method === 'textDocument/didOpen') {",
    "    log('didOpen', { version: msg.params.textDocument.version });",
    "    return;",
    "  }",
    "  if (msg.method === 'textDocument/didChange') {",
    "    log('didChange', { version: msg.params.textDocument.version });",
    "    if (heldHover) {",
    "      const held = heldHover;",
    "      heldHover = null;",
    "      setTimeout(() => write({ jsonrpc: '2.0', id: held.id, result: { contents: { kind: 'plaintext', value: 'held-hover' }, range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } } } }), 50);",
    "    }",
    "    return;",
    "  }",
    "  if (msg.method === 'textDocument/hover') {",
    "    log('hover', { position: msg.params.position });",
    "    if (behavior.exitOnHover) { process.exit(behavior.exitOnHover); return; }",
    "    if (behavior.errorOnHover) {",
    "      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'boom' } });",
    "      return;",
    "    }",
    "    if (behavior.holdHoverUntilDidChange) { heldHover = msg; return; }",
    "    if (behavior.hoverRange) {",
    "      write({ jsonrpc: '2.0', id: msg.id, result: { contents: { kind: 'plaintext', value: 'py-hover' }, range: behavior.hoverRange } });",
    "      return;",
    "    }",
    "    write({ jsonrpc: '2.0', id: msg.id, result: { contents: { kind: 'plaintext', value: 'py-hover' } } });",
    "    return;",
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
  ].join("\n");
}

function fakeVirtualizerScript(behavior) {
  return [
    `const behavior = ${JSON.stringify(behavior)};`,
    "import fs from 'node:fs';",
    "if (behavior.pidPath) fs.writeFileSync(behavior.pidPath, String(process.pid));",
    "function resultFor(text, focusLine) {",
    "  if (behavior.mode === 'hang') return null;",
    "  if (behavior.mode === 'multiline') {",
    "    return {",
    "      text: 'a = 1\\nb = 2\\nc = 3\\nd = 4\\n',",
    "      ranges: [{ kind: 'fenced', range: { start: { line: 2, character: 2 }, end: { line: 6, character: 0 } }, sourceRange: { start: { line: 2, character: 2 }, end: { line: 6, character: 0 } }, virtualRange: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } }, text: 'a = 1' }],",
    "      mappings: [{ kind: 'fenced', sourceRange: { start: { line: 2, character: 2 }, end: { line: 6, character: 0 } }, virtualRange: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } } }],",
    "      symbols: []",
    "    };",
    "  }",
    "  if (behavior.mode === 'shift') {",
    "    const shifted = text.includes('v2marker');",
    "    const sourceLine = shifted ? 5 : 3;",
    "    // The virtual text must differ too, or the proxy correctly sends",
    "    // no didChange and pyright never releases the held hover.",
    "    return {",
    "      text: shifted ? 'from typing import Any\\n\\nfoo: int = ...\\nfoo # v2\\n' : 'from typing import Any\\n\\nfoo: int = ...\\nfoo\\n',",
    "      ranges: [{ kind: 'fenced', range: { start: { line: 3, character: 2 }, end: { line: 3, character: 7 } }, sourceRange: { start: { line: 3, character: 2 }, end: { line: 3, character: 7 } }, virtualRange: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } }, text: 'foo' }],",
    "      mappings: [{ kind: 'fenced', sourceRange: { start: { line: sourceLine, character: 2 }, end: { line: sourceLine, character: 7 } }, virtualRange: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } } }],",
    "      symbols: []",
    "    };",
    "  }",
    "  if (behavior.mode === 'focus') {",
    "    const focused = focusLine !== -1;",
    "    return {",
    "      text: focused ? 'from typing import Any\\n\\nfoo: int = ...\\nfoo # focused\\n' : 'from typing import Any\\n\\nfoo: int = ...\\nfoo\\n',",
    "      ranges: [{ kind: 'fenced', range: { start: { line: 2, character: 0 }, end: { line: 4, character: 0 } }, sourceRange: { start: { line: 2, character: 0 }, end: { line: 4, character: 0 } }, virtualRange: { start: { line: 4, character: 8 }, end: { line: 5, character: 11 } }, text: 'foo = 1\\nfoo' }],",
    "      mappings: [",
    "        { kind: 'fenced', sourceRange: { start: { line: 2, character: 2 }, end: { line: 2, character: 9 } }, virtualRange: { start: { line: 4, character: 8 }, end: { line: 4, character: 15 } } },",
    "        { kind: 'fenced', sourceRange: { start: { line: 3, character: 2 }, end: { line: 3, character: 5 } }, virtualRange: { start: { line: 5, character: 8 }, end: { line: 5, character: 11 } } }",
    "      ],",
    "      symbols: []",
    "    };",
    "  }",
    "  return {",
    "    text: 'from typing import Any\\n\\nfoo: int = ...\\nfoo\\n',",
    "    ranges: [{ kind: 'inline', range: { start: { line: 2, character: 7 }, end: { line: 2, character: 10 } }, sourceRange: { start: { line: 2, character: 7 }, end: { line: 2, character: 10 } }, virtualRange: { start: { line: 4, character: 4 }, end: { line: 4, character: 7 } }, text: 'foo' }],",
    "    mappings: [{ kind: 'inline', sourceRange: { start: { line: 2, character: 7 }, end: { line: 2, character: 10 } }, virtualRange: { start: { line: 4, character: 4 }, end: { line: 4, character: 7 } } }],",
    "    symbols: []",
    "  };",
    "}",
    "let data = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => {",
    "  data += chunk;",
    "  while (true) {",
    "    const newline = data.indexOf('\\n');",
    "    if (newline === -1) break;",
    "    const line = data.slice(0, newline);",
    "    data = data.slice(newline + 1);",
    "    if (!line.trim()) continue;",
    "    const payload = JSON.parse(line);",
    "    if (behavior.recordPath) fs.appendFileSync(behavior.recordPath, JSON.stringify({ focusLine: payload.focusLine }) + '\\n');",
    "    const result = resultFor(payload.text || '', payload.focusLine);",
    "    if (result) process.stdout.write(JSON.stringify({ id: payload.id, ok: true, result }) + '\\n');",
    "  }",
    "});",
  ].join("\n");
}

class Client {
  constructor(child, stderr) {
    this.child = child;
    this.stderr = stderr;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.exitPromise = new Promise((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    // Writes after stdin ends (cleanup paths) must not crash the test.
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (true) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;
        const header = this.buffer.slice(0, headerEnd).toString("utf8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          this.buffer = this.buffer.slice(headerEnd + 4);
          continue;
        }
        const length = Number(match[1]);
        const messageEnd = headerEnd + 4 + length;
        if (this.buffer.length < messageEnd) break;
        const body = this.buffer.slice(headerEnd + 4, messageEnd).toString("utf8");
        this.buffer = this.buffer.slice(messageEnd);
        const message = JSON.parse(body);
        if (typeof message.id !== "undefined" && this.pending.has(message.id)) {
          const waiter = this.pending.get(message.id);
          this.pending.delete(message.id);
          clearTimeout(waiter.timeout);
          waiter.resolve(message);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      this.stderr.push(chunk.toString("utf8"));
    });
  }

  write(message) {
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  request(method, params, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async initialize() {
    const response = await this.request("initialize", {
      processId: null,
      rootUri: "file:///tmp",
      capabilities: {},
    });
    this.write({ jsonrpc: "2.0", method: "initialized", params: {} });
    return response;
  }

  didOpen(uri, text, version = 1) {
    this.write({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "kedi", version, text } },
    });
  }

  didChange(uri, text, version) {
    this.write({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      },
    });
  }

  assertNoCrash() {
    const output = this.stderr.join("");
    assert.ok(
      !output.includes("uncaughtException") &&
        !output.includes("ERR_UNHANDLED_ERROR") &&
        !output.includes("Error: write EPIPE") &&
        !output.includes("Error [ERR_STREAM"),
      `proxy crashed: ${output}`,
    );
  }
}

async function withProxy(t, options, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kedi-proxy-robustness-"));
  const recordPath = path.join(tempDir, "pyright-log.jsonl");
  const pyrightPath = path.join(tempDir, "fake-pyright.mjs");
  const virtualizerPath = path.join(tempDir, "fake-virtualizer.mjs");
  const pyrightPidPath = path.join(tempDir, "pyright.pid");
  const virtualizerPidPath = path.join(tempDir, "virtualizer.pid");
  const pyrightBehavior = { ...options.pyright, recordPath, pidPath: pyrightPidPath };
  const virtualizerBehavior = {
    ...(options.virtualizer ?? {}),
    pidPath: virtualizerPidPath,
  };
  fs.writeFileSync(pyrightPath, fakePyrightScript(pyrightBehavior));
  fs.writeFileSync(virtualizerPath, fakeVirtualizerScript(virtualizerBehavior));
  const stderr = [];
  const child = spawn(process.execPath, [proxyPath, pyrightPath], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      KEDI_DEBUG_EMBEDDED_PYTHON: "1",
      KEDI_PYTHON_VIRTUALIZER_COMMAND: options.virtualizerCommand ?? process.execPath,
      KEDI_PYTHON_VIRTUALIZER_ARGS: JSON.stringify(
        options.virtualizerArgs ?? [virtualizerPath],
      ),
      ...(options.timeoutMs
        ? { KEDI_VIRTUALIZER_TIMEOUT_MS: String(options.timeoutMs) }
        : {}),
    },
  });
  const client = new Client(child, stderr);
  const ctx = { tempDir, recordPath, pyrightPidPath, virtualizerPidPath, client, child };
  try {
    await fn(ctx);
  } finally {
    try {
      client.write({ jsonrpc: "2.0", method: "exit", params: {} });
    } catch {}
    child.kill();
    await Promise.race([
      client.exitPromise,
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    // Children the proxy did not kill (e.g. a fake that keeps itself alive
    // after destroying its stdin) must not leak.
    for (const pidPath of [pyrightPidPath, virtualizerPidPath]) {
      try {
        process.kill(Number(fs.readFileSync(pidPath, "utf8")), "SIGKILL");
      } catch {}
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function readLog(recordPath) {
  try {
    return fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function pidAlive(pidPath) {
  try {
    const pid = Number(fs.readFileSync(pidPath, "utf8"));
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(fn, timeoutMs = 3000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// Z2: a broken pyright stdin pipe must not crash the proxy.
test("pyright stdin EPIPE shuts the proxy down instead of crashing it", async (t) => {
  await withProxy(
    t,
    { pyright: { destroyStdinAfterInit: true } },
    async ({ client, child }) => {
      await client.initialize();
      // The next write to pyright's destroyed stdin raises EPIPE inside the
      // proxy. With no error listener the process dies with an uncaught
      // exception; with one it exits 1 after rejecting pending work.
      client.didOpen("file:///tmp/test.kedi", INLINE_TEXT);
      const exit = await Promise.race([
        client.exitPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      assert.ok(exit, "proxy should exit after the pyright stdin failure");
      assert.equal(exit.code, 1);
      assert.ok(
        client.stderr.join("").includes("pyright stdin failed"),
        `proxy should log the deliberate shutdown, got: ${client.stderr.join("")}`,
      );
      client.assertNoCrash();
    },
  );
});

test("pending requests are rejected when pyright exits mid-request", async (t) => {
  await withProxy(
    t,
    { pyright: { exitOnHover: 3 } },
    async ({ client }) => {
      await client.initialize();
      client.didOpen("file:///tmp/test.kedi", INLINE_TEXT);
      // The pending hover must be rejected with a JSON-RPC error, not left
      // hanging until the proxy exits: on the base commit the proxy exits
      // without answering, so this request times out.
      const message = await client.request("textDocument/hover", {
        textDocument: { uri: "file:///tmp/test.kedi" },
        position: { line: 2, character: 8 },
      });
      assert.ok(message.error, `expected a JSON-RPC error, got ${JSON.stringify(message)}`);
      assert.equal(message.error.code, -32603);
      await Promise.race([
        client.exitPromise,
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      client.assertNoCrash();
    },
  );
});

test("virtualizer spawn failure falls back to the blanked document", async (t) => {
  await withProxy(
    t,
    { virtualizerCommand: "/nonexistent/kedi-virtualizer" },
    async ({ client }) => {
      await client.initialize();
      client.didOpen("file:///tmp/test.kedi", FENCED_TEXT);
      const hover = await client.request("textDocument/hover", {
        textDocument: { uri: "file:///tmp/test.kedi" },
        position: { line: 3, character: 3 },
      });
      assert.ok(hover.result, `expected a hover result, got ${JSON.stringify(hover)}`);
      client.assertNoCrash();
    },
  );
});

// Z3: pyright answers for the virtual document as it was when the request
// was sent, so the reply must be mapped with that snapshot, not the
// document as edited since.
test("pyright replies are mapped with the request-time document snapshot", async (t) => {
  await withProxy(
    t,
    { pyright: { holdHoverUntilDidChange: true }, virtualizer: { mode: "shift" } },
    async ({ client, recordPath }) => {
      await client.initialize();
      client.didOpen("file:///tmp/test.kedi", FENCED_TEXT);
      const hoverPromise = client.request(
        "textDocument/hover",
        {
          textDocument: { uri: "file:///tmp/test.kedi" },
          position: { line: 3, character: 3 },
        },
        // Cold virtualizer startup is slow; the hover waits for it, then
        // for the held pyright reply after the edit.
        15000,
      );
      // Wait until the hover has reached pyright (so it was resolved
      // against the v1 snapshot), then edit the document while pyright is
      // still working on it: the new virtual document maps the same
      // virtual range to source line 5 instead of line 3.
      await waitFor(
        () => readLog(recordPath).some((entry) => entry.event === "hover"),
        5000,
        "hover to reach pyright",
      );
      client.didChange(
        "file:///tmp/test.kedi",
        "@x():\n  = ```\n  foo = 1\n  foo\n  # v2marker\n  ```\n",
        2,
      );
      const hover = await hoverPromise;
      assert.ok(hover.result, `expected a hover result, got ${JSON.stringify(hover)}`);
      assert.equal(hover.result.range.start.line, 3);
      assert.equal(hover.result.range.start.character, 2);
      assert.equal(hover.result.range.end.line, 3);
      assert.equal(hover.result.range.end.character, 7);
      client.assertNoCrash();
    },
  );
});

test("pyright JSON-RPC errors are forwarded to the client", async (t) => {
  await withProxy(
    t,
    { pyright: { errorOnHover: true } },
    async ({ client }) => {
      await client.initialize();
      client.didOpen("file:///tmp/test.kedi", INLINE_TEXT);
      const hover = await client.request("textDocument/hover", {
        textDocument: { uri: "file:///tmp/test.kedi" },
        position: { line: 2, character: 8 },
      });
      assert.ok(hover.error, `expected a JSON-RPC error, got ${JSON.stringify(hover)}`);
      assert.equal(hover.error.message, "boom");
      client.assertNoCrash();
    },
  );
});

test("pyright initialize errors are forwarded to the client", async (t) => {
  await withProxy(
    t,
    { pyright: { errorOnInitialize: true } },
    async ({ client }) => {
      const response = await client.request("initialize", {
        processId: null,
        rootUri: "file:///tmp",
        capabilities: {},
      });
      assert.ok(response.error, `expected a JSON-RPC error, got ${JSON.stringify(response)}`);
      assert.equal(response.error.message, "init-boom");
      client.assertNoCrash();
    },
  );
});

// Z4: a hung virtualizer must not block the event loop forever. The
// persistent path times out, and the spawnSync fallback must time out too
// instead of hanging indefinitely (on the base commit it does).
// Z5: a focus change rebuilds the virtual text for the same client
// version; the didChange sent for it must carry a strictly larger version
// than the didOpen, or pyright sees two versions with the same number.
test("didChange versions increase strictly across focus resyncs", async (t) => {
  await withProxy(
    t,
    { virtualizer: { mode: "focus" } },
    async ({ client, recordPath }) => {
      await client.initialize();
      client.didOpen("file:///tmp/test.kedi", FENCED_TEXT);
      const hover = await client.request(
        "textDocument/hover",
        {
          textDocument: { uri: "file:///tmp/test.kedi" },
          position: { line: 3, character: 3 },
        },
        15000,
      );
      assert.ok(hover.result, `expected a hover result, got ${JSON.stringify(hover)}`);
      await waitFor(
        () => readLog(recordPath).some((entry) => entry.event === "didChange"),
        5000,
        "didChange to reach pyright",
      );
      const events = readLog(recordPath);
      const didOpen = events.find((entry) => entry.event === "didOpen");
      const didChange = events.find((entry) => entry.event === "didChange");
      assert.ok(didOpen, "expected pyright to receive didOpen");
      assert.ok(didChange, "expected pyright to receive didChange after the focus resync");
      assert.ok(
        didChange.version > didOpen.version,
        `didChange version ${didChange.version} must exceed didOpen version ${didOpen.version}`,
      );
      client.assertNoCrash();
    },
  );
});

// Z6: when Zed exits abnormally there is no `exit` notification, but
// stdin closes; pyright and the virtualizer must not be orphaned.
test("closing stdin kills pyright and the virtualizer", async (t) => {
  await withProxy(
    t,
    {},
    async ({ client, child, pyrightPidPath, virtualizerPidPath }) => {
      await client.initialize();
      client.didOpen("file:///tmp/test.kedi", INLINE_TEXT);
      await waitFor(
        () => fs.existsSync(virtualizerPidPath) && fs.existsSync(pyrightPidPath),
        5000,
        "children to spawn",
      );
      child.stdin.end();
      const exit = await Promise.race([
        client.exitPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      assert.ok(exit, "proxy should exit when stdin closes");
      assert.equal(exit.code, 0);
      await waitFor(
        () => !pidAlive(pyrightPidPath) && !pidAlive(virtualizerPidPath),
        3000,
        "children to die",
      );
      client.assertNoCrash();
    },
  );
});

test("hung virtualizer does not block the proxy forever (spawnSync timeout)", async (t) => {
  await withProxy(
    t,
    { virtualizer: { mode: "hang" }, timeoutMs: 250 },
    async ({ client }) => {
      await client.initialize();
      client.didOpen("file:///tmp/test.kedi", FENCED_TEXT);
      const start = Date.now();
      const hover = await client.request(
        "textDocument/hover",
        {
          textDocument: { uri: "file:///tmp/test.kedi" },
          position: { line: 3, character: 3 },
        },
        15000,
      );
      const elapsed = Date.now() - start;
      assert.ok(hover.result, `expected a hover result, got ${JSON.stringify(hover)}`);
      assert.ok(
        hover.result.contents.value.includes("py-hover"),
        `expected pyright hover content, got ${JSON.stringify(hover.result.contents)}`,
      );
      assert.ok(elapsed < 12000, `hover took ${elapsed}ms; spawnSync must time out`);
      client.assertNoCrash();
    },
  );
});
