import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyProject } from '../src/core/model';
import { gate, type GateDeps } from '../src/gate';

const deps = (tracked: string[], choices: Array<'continue' | 'change' | undefined>, newTarget?: string): GateDeps => ({
  isTracked: async t => tracked.includes(t),
  ask: async () => choices.shift(),
  changeTarget: async () => newTarget,
});

test('untracked passes and is remembered', async () => {
  const c = new Set<string>(); const p = emptyProject();
  assert.equal(await gate(c, '/r', p, deps([], [])), p);
  assert.ok(c.has('/r'));
  assert.equal(await gate(c, '/r', p, deps(['.env'], [])), p); // no second check
});
test('tracked: cancel means no write', async () => {
  const c = new Set<string>();
  assert.equal(await gate(c, '/r', emptyProject(), deps(['.env'], [undefined])), undefined);
  assert.ok(!c.has('/r'));
});
test('tracked: continue proceeds', async () => {
  const p = emptyProject();
  assert.equal(await gate(new Set(), '/r', p, deps(['.env'], ['continue'])), p);
});
test('tracked: change target retargets; escaping target throws', async () => {
  const q = await gate(new Set(), '/r', emptyProject(), deps(['.env'], ['change'], '.env.local'));
  assert.equal(q?.schema.target, '.env.local');
  await assert.rejects(gate(new Set(), '/r', emptyProject(), deps(['.env'], ['change'], '../x')));
});
