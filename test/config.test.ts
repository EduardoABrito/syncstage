import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEnv, addKey, emptyProject, selectEnv, setKeyValues } from '../src/core/model';
import { exportConfig, exportWorkspace, matchWorkspace, mergeConfig, parseConfig, parseWorkspaceConfig, workspaceKeys } from '../src/core/config';

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

const P = (root: string, rel: string) => ({ root, rel });
const ws = [P('/a/wfe-admin-api', 'wfe-admin-api'), P('/a/Admin/api', 'Admin/api'), P('/a/Shop/api', 'Shop/api'), P('/a/web', 'web')];

test('workspaceKeys: unique basename, else rel only for duplicates', () => {
  const k = workspaceKeys(ws);
  assert.equal(k.get('/a/wfe-admin-api'), 'wfe-admin-api');
  assert.equal(k.get('/a/web'), 'web');
  assert.equal(k.get('/a/Admin/api'), 'Admin/api');
  assert.equal(k.get('/a/Shop/api'), 'Shop/api');
});

test('matchWorkspace: exact rel, unique basename, ambiguous, not found', () => {
  const r = matchWorkspace(['Admin/api', 'web', 'api', 'ghost', 'x/web'], ws);
  assert.equal(r.matched.get('Admin/api'), '/a/Admin/api');
  assert.equal(r.matched.get('web'), '/a/web');
  assert.equal(r.matched.get('x/web'), undefined); // same root already taken by 'web'
  assert.deepEqual(r.skipped, [
    { key: 'api', reason: 'ambiguous' }, { key: 'ghost', reason: 'not found' }, { key: 'x/web', reason: 'ambiguous' }]);
});

test('matchWorkspace: renamed parent folder still matches by basename', () => {
  const r = matchWorkspace(['Old/wfe-admin-api'], ws);
  assert.equal(r.matched.get('Old/wfe-admin-api'), '/a/wfe-admin-api');
});

test('matchWorkspace: exact rel wins over a fuzzy claim on the same root', () => {
  const r = matchWorkspace(['x/web', 'web'], ws);
  assert.equal(r.matched.get('web'), '/a/web');
  assert.deepEqual(r.skipped, [{ key: 'x/web', reason: 'ambiguous' }]);
});

const body = (o: object = {}) => ({ environments: ['dev'], keys: ['A'], selected: {}, values: { A: { dev: '1' } }, ...o });
const wsFile = (workspace: unknown, extra: object = {}) => ({ syncstage: 1, workspace, ...extra });

test('parseWorkspaceConfig: valid', () => {
  const r = parseWorkspaceConfig(wsFile({ api: body() }));
  assert.equal(r.length, 1);
  assert.equal(r[0].key, 'api');
  assert.deepEqual(r[0].config.keys, ['A']);
});

test('parseWorkspaceConfig: rejects bad input', () => {
  assert.throws(() => parseWorkspaceConfig(null));
  assert.throws(() => parseWorkspaceConfig({ syncstage: 2, workspace: {} }));
  assert.throws(() => parseWorkspaceConfig({ workspace: {} }));
  assert.throws(() => parseWorkspaceConfig(wsFile([])));
  assert.throws(() => parseWorkspaceConfig(wsFile('x')));
  assert.throws(() => parseWorkspaceConfig(JSON.parse('{"syncstage":1,"workspace":{"__proto__":{}}}')));
  assert.throws(() => parseWorkspaceConfig(wsFile({ toString: body() })));
  assert.throws(() => parseWorkspaceConfig(wsFile({ '': body() })));
  assert.throws(() => parseWorkspaceConfig(wsFile({ 'a\0b': body() })));
  assert.throws(() => parseWorkspaceConfig(wsFile({ api: body({ keys: ['bad key!'] }) })));
});

test('parseWorkspaceConfig: caps entries at 200', () => {
  const mk = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, body()]));
  assert.equal(parseWorkspaceConfig(wsFile(mk(200))).length, 200);
  assert.throws(() => parseWorkspaceConfig(wsFile(mk(201))));
});

test('workspace round trip: export 2 projects, parse, match all', () => {
  const projects = [P('/r/one', 'one'), P('/r/two', 'two')];
  const keys = workspaceKeys(projects);
  const out = exportWorkspace([
    { key: keys.get('/r/one') as string, project: sample() }, { key: keys.get('/r/two') as string, project: emptyProject() }], true);
  const parsed = parseWorkspaceConfig(JSON.parse(out));
  const m = matchWorkspace(parsed.map(e => e.key), projects);
  assert.equal(m.matched.size, 2);
  assert.equal(m.skipped.length, 0);
  assert.deepEqual(parsed[0].config.keys, sample().schema.keys);
  assert.equal(JSON.parse(exportWorkspace([{ key: 'one', project: sample() }], false)).workspace.one.values, undefined);
});

test('workspaceKeys: keys are always unique (same name and rel falls back to root)', () => {
  const k = workspaceKeys([P('/x/app', 'app'), P('/y/app', 'app'), P('/z/web', 'web')]);
  assert.equal(new Set(k.values()).size, 3);
  assert.equal(k.get('/y/app'), '/y/app');
  assert.equal(k.get('/z/web'), 'web');
});

test('matchWorkspace: duplicate rel is ambiguous', () => {
  const r = matchWorkspace(['app'], [P('/x/app', 'app'), P('/y/app', 'app')]);
  assert.equal(r.matched.size, 0);
  assert.deepEqual(r.skipped, [{ key: 'app', reason: 'ambiguous' }]);
});
