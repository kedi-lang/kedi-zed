export class PythonCompletions {
  constructor(project) {
    this.project = project;
    this.items = new Map();
    this.nextId = 1;
  }

  original(item) {
    return this.items.get(item.data?.kediCompletionId);
  }

  async map(result, doc, position, resolving = false) {
    const defaults = result?.itemDefaults ?? {};
    const candidates = resolving ? [result] : Array.isArray(result) ? result : result?.items ?? [];
    const items = candidates.map((candidate, index) => {
      const item = { ...candidate, kediIndex: index };
      for (const key of ["commitCharacters", "insertTextFormat", "insertTextMode", "data"]) {
        if (!(key in item) && key in defaults) item[key] = defaults[key];
      }
      if (!item.textEdit && defaults.editRange) {
        item.textEdit = {
          ...(defaults.editRange.start ? { range: defaults.editRange } : defaults.editRange),
          newText: item.textEditText ?? item.insertText ?? item.label,
        };
      }
      return item;
    });
    const mapped = await this.project(doc, items);
    for (const item of mapped) {
      const original = { ...items[item.kediIndex] };
      delete original.kediIndex;
      delete item.kediIndex;
      if (!resolving) {
        const id = this.nextId++;
        this.items.set(id, { doc, position, item: original });
        item.data = { kediCompletionId: id };
      }
    }
    while (this.items.size > 2048) this.items.delete(this.items.keys().next().value);
    if (resolving) return mapped[0] ?? null;
    return { isIncomplete: result?.isIncomplete ?? false, items: mapped };
  }

  clear(uri) {
    for (const [key, value] of this.items) {
      if (value.doc.uri === uri) this.items.delete(key);
    }
  }
}
