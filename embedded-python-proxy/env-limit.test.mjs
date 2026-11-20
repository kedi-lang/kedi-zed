import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Z1 (audit #215): server.mjs (~40 KB) was passed to the proxy through an
// environment variable, over the Windows 32,767-character per-variable
// limit, so the embedded-Python server could not start on Windows.
// The extension must run the proxy (and the ~28 KB bootstrap installer)
// by path instead, with no environment value over 32,000 characters.

const root = path.resolve(import.meta.dirname, "..");
const libRs = fs.readFileSync(path.join(root, "src", "lib.rs"), "utf8");
const runtimeRs = fs.readFileSync(path.join(root, "src", "runtime.rs"), "utf8");
const serverMjs = fs.readFileSync(
  path.join(root, "embedded-python-proxy", "server.mjs"),
  "utf8",
);
const bootstrapCjs = fs.readFileSync(
  path.join(root, "runtime", "bootstrap.cjs"),
  "utf8",
);

test("proxy sources are not passed through the environment", () => {
  // The reason the old route could not work: server.mjs alone is over the
  // Windows limit, and the bootstrap installer is close to it.
  assert.ok(serverMjs.length > 32_767, `server.mjs is ${serverMjs.length} chars`);
  assert.ok(bootstrapCjs.length > 20_000, `bootstrap.cjs is ${bootstrapCjs.length} chars`);
  for (const [file, source] of [
    ["src/lib.rs", libRs],
    ["src/runtime.rs", runtimeRs],
  ]) {
    // No `.env(...)` call may set the proxy/completion sources: the Rust
    // tests still name them in string literals when asserting exactly that.
    assert.ok(
      !/\.env\(\s*EMBEDDED_PYTHON_PROXY_ENV/.test(source),
      `${file} still passes the proxy source through the environment`,
    );
    assert.ok(
      !/\.env\(\s*"KEDI_(EMBEDDED_PYTHON_PROXY|PYTHON_COMPLETION)_SOURCE"/.test(source),
      `${file} still passes a proxy source through the environment`,
    );
    assert.ok(
      !source.includes("EMBEDDED_PYTHON_PROXY_LOADER"),
      `${file} still loads the proxy from an environment data URL`,
    );
  }
  assert.ok(libRs.includes("write_proxy_scripts"), "lib.rs must write the proxy to disk");
  assert.ok(
    runtimeRs.includes("bootstrap-run.cjs"),
    "runtime.rs must run the installer from a driver file, not --eval",
  );
  assert.ok(
    !/\.args\(\["--eval"/.test(runtimeRs),
    "runtime.rs must not pass the installer via --eval",
  );
});

test("proxy starts by path without the proxy sources in the environment", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kedi-env-limit-test-"));
  const fakePyrightPath = path.join(tempDir, "fake-pyright.mjs");
  fs.writeFileSync(
    fakePyrightPath,
    [
      "let buffer = Buffer.alloc(0);",
      "function write(msg) {",
      "  const body = JSON.stringify(msg);",
      "  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\\r\\n\\r\\n${body}`);",
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
      "    const msg = JSON.parse(body);",
      "    if (msg.method === 'initialize') {",
      "      write({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } });",
      "    }",
      "  }",
      "});",
    ].join("\n"),
  );

  const proxyPath = path.join(root, "embedded-python-proxy", "server.mjs");
  const proxyEnv = { ...process.env, KEDI_DEBUG_EMBEDDED_PYTHON: "0" };
  // The proxy is spawned with no environment value over the Windows limit.
  for (const [name, value] of Object.entries(proxyEnv)) {
    assert.ok(value.length < 32_000, `env ${name} is ${value.length} chars`);
  }
  const proxy = spawn(process.execPath, [proxyPath, fakePyrightPath], {
    stdio: ["pipe", "pipe", "inherit"],
    env: proxyEnv,
  });

  try {
    const response = await new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for initialize")),
        5000,
      );
      proxy.stdout.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const length = Number(
          buffer
            .slice(0, headerEnd)
            .toString("utf8")
            .match(/Content-Length:\s*(\d+)/i)?.[1],
        );
        if (buffer.length < headerEnd + 4 + length) return;
        clearTimeout(timeout);
        resolve(
          JSON.parse(buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString("utf8")),
        );
      });
      proxy.on("error", reject);
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { processId: null, rootUri: "file:///tmp", capabilities: {} },
      });
      proxy.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
    assert.equal(response.id, 1);
    assert.ok(response.result?.capabilities, "expected initialize capabilities");
  } finally {
    proxy.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
