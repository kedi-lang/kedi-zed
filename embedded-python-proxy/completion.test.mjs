import assert from "node:assert/strict";
import test from "node:test";
import { PythonCompletions } from "./completion.mjs";

test("completion defaults and lazy resolution retain provider data", async () => {
  const calls = [];
  const service = new PythonCompletions(async (doc, items) => {
    calls.push({ doc, items });
    return structuredClone(items);
  });
  const range = { start: { line: 2, character: 1 }, end: { line: 2, character: 3 } };
  const doc = { uri: "file:///sample.kedi", version: 1 };
  const result = await service.map({
    isIncomplete: true,
    itemDefaults: { data: { provider: "pyright" }, editRange: range, insertTextFormat: 2 },
    items: [{ label: "upper", textEditText: "upper($0)" }],
  }, doc, range.end);
  assert.equal(result.isIncomplete, true);
  assert.equal(result.items[0].insertTextFormat, 2);
  assert.deepEqual(result.items[0].textEdit, { range, newText: "upper($0)" });
  const saved = service.original(result.items[0]);
  assert.deepEqual(saved.item.data, { provider: "pyright" });
  assert.equal(saved.doc, doc);
  assert.equal(saved.item.kediIndex, undefined);
  const resolved = await service.map({ ...saved.item, detail: "resolved" }, doc, range.end, true);
  assert.equal(resolved.detail, "resolved");
  service.clear(doc.uri);
  assert.equal(service.original(result.items[0]), undefined);
});

test("unsafe resolved edits fail closed and the resolver cache is bounded", async () => {
  const service = new PythonCompletions(async (_doc, items) => items.filter(item => item.label !== "unsafe"));
  const doc = { uri: "file:///sample.kedi" };
  const result = await service.map(Array.from({ length: 2050 }, (_, i) => ({ label: String(i) })), doc, {});
  assert.equal(service.items.size, 2048);
  assert.equal(service.original(result.items[0]), undefined);
  assert.equal(await service.map({ label: "unsafe" }, doc, {}, true), null);
});
