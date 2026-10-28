import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addKey, emptyProject, selectAll, setKeyValues } from '../src/core/model';
import { renderTarget, SelfWrites } from '../src/core/sync';

const p = () => selectAll(setKeyValues(addKey(addKey(emptyProject(), 'A', 'd', 'dev'), 'B', 'b', 'dev'), 'A', { dev: 'd', qa: 'q' }), 'qa');
test('sync keeps current value for key missing in selected env', () => {
  assert.equal(renderTarget(p(), '# c\nA=d\nB=old\n', 'sync'), '# c\nA=q\nB=old\n');
});
test('generate appends missing keys as empty', () => {
  assert.equal(renderTarget(p(), '', 'generate'), 'A=q\nB=\n');
});
test('SelfWrites recognises own content only', () => {
  const s = new SelfWrites(); s.mark('/x/.env', 'A=1\n');
  assert.equal(s.isSelfWrite('/x/.env', 'A=1\n'), true);
  assert.equal(s.isSelfWrite('/x/.env', 'A=2\n'), false);
});
