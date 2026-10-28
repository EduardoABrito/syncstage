import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, toMap, update, formatValue } from '../src/core/dotenv';

test('parses entries, comments, export, quotes', () => {
  const doc = parse('# c\nA=1\nexport B="x y"\nC=\'lit $x\'\nD=v # trailing\n\nE="l1\nl2"\n');
  assert.deepEqual([...toMap(doc)], [['A','1'],['B','x y'],['C','lit $x'],['D','v'],['E','l1\nl2']]);
});
test('update preserves unmanaged lines, export, CRLF; appends missing', () => {
  const doc = parse('# keep\r\nexport A=1\r\nX=raw\r\n');
  assert.equal(update(doc, new Map([['A','2'],['NEW','n']]), true), '# keep\r\nexport A=2\r\nX=raw\r\nNEW=n\r\n');
});
test('update without appendMissing ignores absent keys', () => {
  assert.equal(update(parse('A=1\n'), new Map([['B','2']]), false), 'A=1\n');
});
test('duplicate key: last wins, only last updated', () => {
  const doc = parse('A=1\nA=2\n');
  assert.equal(toMap(doc).get('A'), '2');
  assert.equal(update(doc, new Map([['A','3']]), false), 'A=1\nA=3\n');
});
test('round-trips awkward values', () => {
  for (const v of ['', 'a b', 'x#y', 'say "hi"', "it's", 'a=b', 'l1\nl2', 'back\\slash', ' lead']) {
    assert.equal(toMap(parse(update(parse(''), new Map([['K', v]]), true))).get('K'), v);
  }
});
test('formatValue leaves simple values bare', () => {
  assert.equal(formatValue('http://localhost:5002/a-b_c.d@e,f+g'), 'http://localhost:5002/a-b_c.d@e,f+g');
});

test('update never writes invalid keys', async () => {
  const { parse, update } = await import('../src/core/dotenv');
  const out = update(parse(''), new Map([['x\n[core]', ''], ['OK', '1']]), true);
  assert.equal(out, 'OK=1\n');
});

test('update keeps original text when the value is unchanged', () => {
  const src = "A = 1\nC='lit $x'\nD=\"q\"\n";
  assert.equal(update(parse(src), new Map([['A', '1'], ['C', 'lit $x'], ['D', 'q']]), false), src);
  assert.equal(update(parse(src), new Map([['A', '2'], ['C', 'lit $x']]), false), "A=2\nC='lit $x'\nD=\"q\"\n");
});
