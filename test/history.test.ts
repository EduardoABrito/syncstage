import { test } from 'node:test';
import assert from 'node:assert/strict';
import { History } from '../src/core/history';
import { addKey, emptyProject } from '../src/core/model';

const n = (i: number) => addKey(emptyProject(), `K${i}`, 'v', 'dev');

test('record/undo/redo sequence', () => {
  const h = new History();
  h.record(n(0)); h.record(n(1));
  assert.deepEqual([h.canUndo, h.canRedo], [true, false]);
  assert.deepEqual(h.undo(n(2)), n(1));
  assert.deepEqual(h.undo(n(1)), n(0));
  assert.equal(h.undo(n(0)), undefined);
  assert.deepEqual(h.redo(n(0)), n(1));
  assert.deepEqual(h.redo(n(1)), n(2));
  assert.equal(h.redo(n(2)), undefined);
  assert.deepEqual(h.undo(n(2)), n(1));
});

test('record clears redo; clear empties both', () => {
  const h = new History();
  h.record(n(0)); h.undo(n(1));
  assert.equal(h.canRedo, true);
  h.record(n(5));
  assert.equal(h.canRedo, false);
  h.clear();
  assert.deepEqual([h.canUndo, h.canRedo], [false, false]);
});

test('limit 50 drops oldest', () => {
  const h = new History();
  for (let i = 0; i < 60; i++) h.record(n(i));
  let last, cur = n(99), c = 0;
  for (let r = h.undo(cur); r; r = h.undo(cur)) { cur = r; last = r; c++; }
  assert.equal(c, 50);
  assert.deepEqual(last, n(10));
});

test('stored copies are independent of the original', () => {
  const h = new History();
  const p = n(0);
  h.record(p);
  p.schema.keys.push('X');
  assert.deepEqual(h.undo(n(1)), n(0));
});
