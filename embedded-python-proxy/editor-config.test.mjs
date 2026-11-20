import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Python fence scaffolding uses an explicit name, not a backtick trigger', () => {
  const snippets = JSON.parse(readFileSync(new URL('../snippets/kedi.json', import.meta.url), 'utf8'));
  assert.equal(snippets['Python Block'].prefix, 'pyblock');
  assert.ok(Object.values(snippets).every(item => [item.prefix].flat().every(prefix => !prefix.includes('`'))));
});

// Z11: assignment blocks open a fenced Python block like the other
// block statements, so they indent and dedent the same way.
test('indents.scm covers assignment_block_stmt', () => {
  const indents = readFileSync(new URL('../languages/kedi/indents.scm', import.meta.url), 'utf8');
  assert.ok(indents.includes('(assignment_block_stmt)'));
  assert.ok(indents.includes('(assignment_block_stmt "```" "```" @end)'));
});
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

// Z8: every task has a Unix (sh) and a Windows (PowerShell) variant.
// Zed has no per-OS override, so both sets are listed on every
// platform and the Windows labels carry a " (Windows)" suffix. Both
// variants share the same fallback — `kedi` on PATH, else the managed
// Python with `-I` — so a user-installed Python or `PYTHONPATH` can
// never shadow the managed environment.
test('tasks.json has Unix and Windows variants with the same fallback and -I', () => {
  const tasks = JSON.parse(readFileSync(new URL('../languages/kedi/tasks.json', import.meta.url), 'utf8'));
  const unix = tasks.filter(task => !task.label.endsWith(' (Windows)'));
  const windows = tasks.filter(task => task.label.endsWith(' (Windows)'));
  assert.equal(unix.length, 3);
  assert.equal(windows.length, 3);
  const expected = [
    { label: 'kedi: run $ZED_FILENAME', tag: 'kedi-file', extra: [] },
    { label: 'kedi: test $ZED_FILENAME', tag: 'kedi-test', extra: ['--test'] },
    { label: 'kedi: eval $ZED_FILENAME', tag: 'kedi-eval', extra: ['--eval'] },
  ];
  for (let i = 0; i < expected.length; i++) {
    const unixTask = unix[i];
    const windowsTask = windows[i];
    assert.equal(unixTask.label, expected[i].label);
    assert.equal(windowsTask.label, `${expected[i].label} (Windows)`);
    assert.deepEqual(unixTask.tags, [expected[i].tag]);
    assert.deepEqual(windowsTask.tags, [expected[i].tag]);
    assert.equal(unixTask.cwd, '$ZED_WORKTREE_ROOT');
    assert.equal(windowsTask.cwd, '$ZED_WORKTREE_ROOT');

    // Unix: `sh -c <script> kedi <file> [extra]`; the script prefers
    // `kedi` on PATH and falls back to the managed Python with `-I`.
    assert.equal(unixTask.command, 'sh');
    assert.equal(unixTask.args[0], '-c');
    const unixScript = unixTask.args[1];
    assert.ok(unixScript.indexOf('command -v kedi') !== -1, 'Unix script must check PATH for kedi');
    assert.ok(unixScript.indexOf('exec "$home/editor-venv/bin/python" -I -m kedi') !== -1,
      'Unix script must run the managed Python with -I');
    assert.ok(unixScript.indexOf('command -v kedi') < unixScript.indexOf('editor-venv/bin/python'),
      'Unix script must try PATH kedi before the managed Python');
    assert.deepEqual(unixTask.args.slice(2), ['kedi', '$ZED_FILE', ...expected[i].extra]);

    // Windows: `powershell -NoProfile -Command <script> <file>
    // [extra]`; same fallback, via Get-Command and Scripts\python.exe.
    assert.equal(windowsTask.command, 'powershell');
    assert.deepEqual(windowsTask.args.slice(0, 2), ['-NoProfile', '-Command']);
    const windowsScript = windowsTask.args[2];
    assert.ok(windowsScript.includes('Get-Command kedi -ErrorAction SilentlyContinue'),
      'Windows script must check PATH for kedi');
    assert.ok(windowsScript.includes("editor-venv\\Scripts\\python.exe"),
      'Windows script must use the managed venv Scripts\\python.exe');
    assert.ok(windowsScript.includes('-I -m kedi'),
      'Windows script must run the managed Python with -I');
    assert.ok(windowsScript.indexOf('Get-Command kedi') < windowsScript.indexOf('editor-venv'),
      'Windows script must try PATH kedi before the managed Python');
    assert.deepEqual(windowsTask.args.slice(3), ['$ZED_FILE', ...expected[i].extra]);
  }
});
