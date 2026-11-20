import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Python fence scaffolding uses an explicit name, not a backtick trigger', () => {
  const snippets = JSON.parse(readFileSync(new URL('../snippets/kedi.json', import.meta.url), 'utf8'));
  assert.equal(snippets['Python Block'].prefix, 'pyblock');
  assert.ok(Object.values(snippets).every(item => [item.prefix].flat().every(prefix => !prefix.includes('`'))));
});

// Z9: tree-sitter queries are last-match-wins, so the generic captures
// must come before the specific node rules, or they override them.
test('highlights.scm puts generic captures before specific rules', () => {
  const highlights = readFileSync(new URL('../languages/kedi/highlights.scm', import.meta.url), 'utf8');
  const genericKeyword = highlights.indexOf('"auto"');
  const genericOperator = highlights.indexOf('"import"');
  const genericDelimiter = highlights.indexOf('@punctuation.delimiter');
  assert.ok(genericKeyword !== -1 && genericOperator !== -1 && genericDelimiter !== -1);
  for (const specific of [
    '(procedure_def',
    '(module_import',
    '(hooks_directive',
    '(reference_segment',
  ]) {
    const at = highlights.indexOf(specific);
    assert.ok(at !== -1, `missing ${specific}`);
    assert.ok(genericKeyword < at, `generic keywords must precede ${specific}`);
    assert.ok(genericOperator < at, `generic operators must precede ${specific}`);
    assert.ok(genericDelimiter < at, `generic delimiters must precede ${specific}`);
  }
  // The generic blocks must appear exactly once.
  assert.equal(highlights.split('"auto"').length - 1, 1);
  // `*` is a delimiter (multiplication in type expressions).
  const delimiterList = highlights.slice(genericDelimiter - 200, genericDelimiter);
  assert.ok(delimiterList.includes('"*"'), 'punctuation.delimiter must include "*"');
});

// Z9: the hooks directive and type literals were unhighlighted.
test('highlights.scm covers hooks directives and type literals', () => {
  const highlights = readFileSync(new URL('../languages/kedi/highlights.scm', import.meta.url), 'utf8');
  for (const rule of [
    '(hooks_directive\n  ">" @operator)',
    '(hooks_directive "hooks" @keyword)',
    '(hooks_plain_value) @constant',
    '(hooks_field',
    'name: (identifier) @property',
    'value: (inline_python_expr) @embedded',
    '(type_number) @number',
    '(type_ellipsis) @constant',
  ]) {
    assert.ok(highlights.includes(rule), `missing highlight rule: ${rule}`);
  }
});

// Z9: the managed runtime must pin the same tree-sitter-kedi the
// stable Kedi release pins.
test('bootstrap pins tree-sitter-kedi 0.4.9', () => {
  const bootstrap = readFileSync(new URL('../runtime/bootstrap.cjs', import.meta.url), 'utf8');
  assert.ok(bootstrap.includes('tree-sitter-kedi==0.4.9'));
  assert.ok(!bootstrap.includes('tree-sitter-kedi==0.4.6'));
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('tree-sitter-kedi==0.4.9'));
  assert.ok(!readme.includes('tree-sitter-kedi==0.4.6'));
});
