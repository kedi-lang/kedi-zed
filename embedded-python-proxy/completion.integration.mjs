// Run with a real Kedi virtualizer and Pyright: node completion.integration.mjs <pyright-entrypoint>.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = spawn(process.execPath, [fileURLToPath(new URL("server.mjs", import.meta.url)), process.argv[2]], {
  env: process.env, stdio: ["pipe", "pipe", "pipe"],
});
let buffer = Buffer.alloc(0), id = 1, errors = "";
const pending = new Map();
child.stderr.on("data", data => { errors += data; });
child.stdout.on("data", data => {
  buffer = Buffer.concat([buffer, data]);
  while (true) {
    const boundary = buffer.indexOf("\r\n\r\n");
    if (boundary < 0) return;
    const size = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, boundary).toString())[1]);
    if (buffer.length < boundary + 4 + size) return;
    const message = JSON.parse(buffer.subarray(boundary + 4, boundary + 4 + size));
    buffer = buffer.subarray(boundary + 4 + size);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter(message); }
  }
});
function send(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
function request(method, params) {
  return new Promise((resolve, reject) => {
    const key = id++;
    const timeout = setTimeout(() => { pending.delete(key); reject(new Error(`${method} timed out: ${errors}`)); }, 15000);
    pending.set(key, message => {
      clearTimeout(timeout);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    });
    send({ id: key, method, params });
  });
}
try {
  const initialized = await request("initialize", {
    processId: process.pid, rootUri: null,
    capabilities: { workspace: { configuration: true }, textDocument: { completion: { completionItem: { snippetSupport: true, resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] } } } } },
  });
  assert.equal(initialized.capabilities.completionProvider.resolveProvider, true);
  send({ method: "initialized", params: {} });
  send({ method: "workspace/didChangeConfiguration", params: { settings: { python: { analysis: { autoImportCompletions: true, indexing: true } } } } });
  const cases = [
    { text: "```\nvalue = 'sample'\nvalue.upp\n```\n", line: 2, character: 9 },
    { text: "@name(value: str) -> str:\n  = `value.upp`\n", line: 1, character: 14 },
    { text: "@name(value: str) -> str:\n  [result] = ```\n  return value.upp\n  ```\n  = result\n", line: 2, character: 18 },
    { text: "[capital: str] = Ankara\n> show: `capital.upp", line: 1, character: 20 },
    { text: "[capital: str] = Ankara\n> show: <`capital.upp", line: 1, character: 21 },
    { text: "@name(value: str) -> str:\n  = `value.upp", line: 1, character: 14 },
    { text: "```\nimport pathlib\npathlib.Path('.').as_p\n```\n", line: 2, character: 21, label: "as_posix" },
  ];
  for (const [index, fixture] of cases.entries()) {
    const uri = `file:///tmp/kedi-completion-${index}.kedi`;
    send({ method: "textDocument/didOpen", params: { textDocument: { uri, version: 1, languageId: "kedi", text: fixture.text } } });
    const list = await request("textDocument/completion", { textDocument: { uri }, position: { line: fixture.line, character: fixture.character } });
    const label = fixture.label ?? "upper";
    const item = list?.items.find(item => item.label === label);
    assert.ok(item, `${label} missing in case ${index}: ${JSON.stringify(list)}`);
    if (item.textEdit) assert.equal(item.textEdit.range.start.line, fixture.line);
    const resolved = await request("completionItem/resolve", item);
    assert.equal(resolved.label, label);
    send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: fixture.text + "\n" }] } });
    await assert.rejects(request("completionItem/resolve", item), /expired|changed/);
    send({ method: "textDocument/didClose", params: { textDocument: { uri } } });
  }
  // Pyright offers auto-imports from its indexed module graph. Keep a document
  // using pathlib open so this test does not depend on background indexing.
  const seedUri = "file:///tmp/kedi-completion-index.kedi";
  send({ method: "textDocument/didOpen", params: { textDocument: {
    uri: seedUri, version: 1, languageId: "kedi", text: "```\nimport pathlib\npathlib.Path\n```\n",
  } } });
  await request("textDocument/hover", { textDocument: { uri: seedUri }, position: { line: 2, character: 10 } });
  const uri = "file:///tmp/kedi-completion-import.kedi";
  send({ method: "textDocument/didOpen", params: { textDocument: { uri, version: 1, languageId: "kedi", text: "= `Path`\n" } } });
  let imports, pathItem;
  const deadline = Date.now() + 5000;
  do {
    imports = await request("textDocument/completion", { textDocument: { uri }, position: { line: 0, character: 7 } });
    pathItem = imports?.items.find(item => item.label === "Path");
    if (pathItem || !imports?.isIncomplete) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.ok(pathItem, `Path auto-import missing: ${JSON.stringify(imports)}; ${errors}`);
  const pathResolved = await request("completionItem/resolve", pathItem);
  assert.ok(pathResolved.additionalTextEdits.some(edit => /from pathlib import Path/.test(edit.newText)));
  assert.ok(pathResolved.additionalTextEdits.some(edit => edit.newText.startsWith("```\n")));
  console.log(`real-pyright: ${cases.length} scoped completion/resolve cases passed; stale resolution rejected`);
  console.log("real-pyright: Path auto-import projected into a new Kedi prelude");
  await request("shutdown", null);
} finally {
  send({ method: "exit" });
  child.stdin.end();
  await new Promise(resolve => child.once("exit", resolve));
}
