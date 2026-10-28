import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addKey, emptyProject, setKeyValues } from '../src/core/model';
import { acceptedChanges, applyChanges, changeId, importDiff, manualDiff } from '../src/core/diff';

const base = () => addKey(addKey(emptyProject(), 'A', '1', 'dev'), 'B', '2', 'dev');
test('importDiff: new keys added flagged, same skipped, conflicts listed', () => {
  const { project, conflicts } = importDiff(base(), 'dev', new Map([['A', '1'], ['B', '9'], ['N', 'n']]));
  assert.deepEqual(project.values.unregistered, ['N']);
  assert.equal(project.values.values.N.dev, 'n');
  assert.equal(project.values.values.B.dev, '2');
  assert.deepEqual(conflicts, [{ key: 'B', env: 'dev', before: '2', after: '9', isNew: false }]);
});
test('importDiff into other env with no existing value is not a conflict', () => {
  const { project, conflicts } = importDiff(base(), 'qa', new Map([['A', 'q']]));
  assert.equal(conflicts.length, 0);
  assert.equal(project.values.values.A.qa, 'q');
});
test('manualDiff detects changed and new keys', () => {
  const changes = manualDiff(base(), new Map([['A', '1'], ['B', 'x'], ['N', 'n']]));
  assert.deepEqual(changes.map(c => [c.key, c.after, c.isNew]), [['B', 'x', false], ['N', 'n', true]]);
});
test('manualDiff detects removed key', () => {
  const changes = manualDiff(base(), new Map([['A', '1']]));
  assert.deepEqual(changes, [{ key: 'B', env: 'dev', before: '2', after: undefined, isNew: false }]);
});
test('applyChanges writes accepted values into the key env', () => {
  const p = applyChanges(base(), manualDiff(base(), new Map([['A', '1'], ['B', 'x']])));
  assert.equal(p.values.values.B.dev, 'x');
});
test('invalid/proto keys ignored; removal and new apply', () => {
  const act = new Map([['A', '1'], ['__proto__', 'x'], ['bad key', 'y'], ['N', 'n']]);
  const ch = manualDiff(base(), act);
  assert.deepEqual(ch.map(c => c.key), ['B', 'N']);
  const p = applyChanges(base(), ch);
  assert.equal(p.values.values.B.dev, undefined);
  assert.deepEqual(p.values.unregistered, ['N']);
  assert.equal(importDiff(base(), 'dev', new Map([['__proto__', 'x']])).project.schema.keys.length, 2);
});
test('manualDiff: key missing in its env only counts when changed vs lastWritten', () => {
  const p = setKeyValues(base(), 'B', { dev: '' }); // B has no dev value
  const act = new Map([['A', '1'], ['B', 'old']]);
  assert.deepEqual(manualDiff(p, act), []);
  assert.deepEqual(manualDiff(p, act, new Map([['A', '1'], ['B', 'old']])), []);
  assert.deepEqual(manualDiff(p, act, new Map([['B', 'older']])), [{ key: 'B', env: 'dev', before: 'older', after: 'old', isNew: false }]);
});
test('acceptedChanges filters by key AND env', () => {
  const cs = [
    { key: 'A', env: 'dev', before: '1', after: '2', isNew: false },
    { key: 'A', env: 'qa', before: '3', after: '4', isNew: false },
  ];
  const got = acceptedChanges(cs, [changeId(cs[0])]);
  assert.deepEqual(got, [cs[0]]);
  assert.deepEqual(acceptedChanges(cs, []), []);
});
