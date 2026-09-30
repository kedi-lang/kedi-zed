import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Python fence scaffolding uses an explicit name, not a backtick trigger', () => {
  const snippets = JSON.parse(readFileSync(new URL('../snippets/kedi.json', import.meta.url), 'utf8'));
  assert.equal(snippets['Python Block'].prefix, 'pyblock');
  assert.ok(Object.values(snippets).every(item => [item.prefix].flat().every(prefix => !prefix.includes('`'))));
});
