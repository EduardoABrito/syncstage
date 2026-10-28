import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEnv, addKey, emptyProject, selectEnv, setKeyValues } from '../src/core/model';
import { exportConfig, mergeConfig, parseConfig } from '../src/core/config';

const sample = () => {
  let p = addEnv(emptyProject(), 'prod');
  p = addKey(p, 'A', '1', 'dev');
  p = addKey(p, 'B', 'b-main', 'main');
  p = setKeyValues(p, 'A', { qa: 'a-qa' });
  return selectEnv(p, 'A', 'qa');
};
const roundTrip = (p = sample()) => mergeConfig(emptyProject(), parseConfig(JSON.parse(exportConfig(p, true))));

test('exportConfig: values included or omitted, never target, trailing newline', () => {
  const full = exportConfig(sample(), true);
  assert.ok(full.endsWith('}\n'));
  assert.ok(full.includes('\n  "syncstage": 1'));
  const o = JSON.parse(full);
  assert.equal(o.syncstage, 1);
  assert.deepEqual(o.keys, ['A', 'B']);
  assert.deepEqual(o.selected, { A: 'qa', B: 'main' });
  assert.deepEqual(o.values, { A: { dev: '1', qa: 'a-qa' }, B: { main: 'b-main' } });
  assert.ok(!('target' in o));
  const bare = JSON.parse(exportConfig(sample(), false));
  assert.ok(!('values' in bare));
  assert.deepEqual(bare.selected, { A: 'qa', B: 'main' });
  assert.ok(!exportConfig(sample(), false).includes('b-main'));
});

test('round-trip reproduces envs, keys, values and selection', () => {
  const p = sample();
  const { project, conflicts } = roundTrip(p);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(project.schema.environments.sort(), p.schema.environments.sort());
  assert.deepEqual(project.schema.keys, p.schema.keys);
  assert.deepEqual(project.values.values, p.values.values);
  assert.deepEqual(project.values.selected, p.values.selected);
  assert.deepEqual(project.values.unregistered, []);
});

const base = { syncstage: 1, environments: ['dev'], keys: ['A'], selected: { A: 'dev' }, values: { A: { dev: 'x' } } };
const bad = (patch: object, re: RegExp = /./) => assert.throws(() => parseConfig({ ...base, ...patch }), re);

test('parseConfig accepts valid and rejects malformed input', () => {
  assert.doesNotThrow(() => parseConfig(base));
  assert.doesNotThrow(() => parseConfig({ ...base, values: undefined }));
  for (const raw of [null, [], 'x', 3]) assert.throws(() => parseConfig(raw));
  bad({ syncstage: 2 });
  bad({ syncstage: undefined });
  bad({ keys: ['x\n[core]'], selected: {}, values: {} });
  bad({ keys: ['__proto__'], selected: {}, values: {} });
  bad({ keys: ['A', 'A'] });
  bad({ environments: [] });
  bad({ environments: ['__proto__'], selected: {}, values: {} });
  bad({ environments: ['dev', 'constructor'] });
  bad({ environments: ['dev', 'dev'] });
  bad({ environments: ['dev', ' '] });
  bad({ values: { A: { dev: 1 } } });
  bad({ values: { Z: { dev: 'x' } } }); // unlisted key
  bad({ values: { A: { qa: 'x' } } }); // unlisted env
  bad({ selected: { A: 'qa' } });
  bad({ selected: { Z: 'dev' } });
  bad({ selected: { A: 3 } });
});

test('parseConfig survives a JSON.parse-d __proto__ own key', () => {
  assert.throws(() => parseConfig(JSON.parse('{"syncstage":1,"environments":["dev"],"keys":["A"],"selected":{"__proto__":"dev"}}')));
  assert.throws(() => parseConfig(JSON.parse('{"syncstage":1,"environments":["dev"],"keys":["A"],"selected":{},"values":{"A":{"__proto__":"x"}}}')));
});

test('mergeConfig adds new env, adds new keys unflagged with their selection', () => {
  const cfg = parseConfig({ syncstage: 1, environments: ['dev', 'stage'], keys: ['N'], selected: { N: 'stage' }, values: { N: { stage: 's' } } });
  const { project, conflicts } = mergeConfig(sample(), cfg);
  assert.deepEqual(conflicts, []);
  assert.ok(project.schema.environments.includes('stage'));
  assert.deepEqual(project.schema.keys, ['A', 'B', 'N']);
  assert.equal(project.values.selected.N, 'stage');
  assert.equal(project.values.values.N.stage, 's');
  assert.deepEqual(project.values.unregistered, []);
});

test('mergeConfig: same value skipped, different value is a conflict and project keeps its value', () => {
  const cfg = parseConfig({
    syncstage: 1, environments: ['dev', 'qa'], keys: ['A'], selected: { A: 'dev' },
    values: { A: { dev: '1', qa: 'other' } },
  });
  const { project, conflicts } = mergeConfig(sample(), cfg);
  assert.deepEqual(conflicts, [{ key: 'A', env: 'qa', before: 'a-qa', after: 'other', isNew: false }]);
  assert.equal(project.values.values.A.qa, 'a-qa');
  assert.equal(project.values.selected.A, 'qa'); // existing selection kept
});

test('mergeConfig fills missing values and leaves project-only keys/envs alone', () => {
  const cfg = parseConfig({ syncstage: 1, environments: ['dev'], keys: ['B'], selected: { B: 'dev' }, values: { B: { dev: 'd' } } });
  const p = sample();
  const { project, conflicts } = mergeConfig(p, cfg);
  assert.deepEqual(conflicts, []);
  assert.equal(project.values.values.B.dev, 'd');
  assert.equal(project.values.values.B.main, 'b-main');
  assert.deepEqual(project.values.values.A, p.values.values.A);
  assert.deepEqual(project.schema.environments, p.schema.environments);
  assert.equal(project.values.selected.B, 'main');
});

test('mergeConfig without values only adds structure', () => {
  const cfg = parseConfig(JSON.parse(exportConfig(sample(), false)));
  const { project, conflicts } = mergeConfig(emptyProject(), cfg);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(project.schema.keys, ['A', 'B']);
  assert.deepEqual(project.values.values, { A: {}, B: {} });
});

test('parseConfig: size limits and null selected/values', () => {
  assert.throws(() => parseConfig({ ...base, keys: Array.from({ length: 2001 }, (_, i) => `K${i}`), selected: {}, values: {} }), /Too many keys/);
  assert.throws(() => parseConfig({ ...base, environments: Array.from({ length: 101 }, (_, i) => `e${i}`), selected: {}, values: {} }), /Too many environments/);
  bad({ selected: null });
  bad({ values: null });
});
