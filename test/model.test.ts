import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyProject, addKey, setKeyValues, selectAll, resolve, renameEnv, removeEnv, addEnv, validate,
} from '../src/core/model';

test('selectEnv then resolve picks env value; missing key reported', () => {
  let p = addKey(emptyProject(), 'API', 'd', 'dev');
  p = setKeyValues(p, 'API', { dev: 'd', qa: 'q' });
  p = addKey(p, 'DB', 'x', 'dev');
  p = selectAll(p, 'qa');
  assert.deepEqual([...resolve(p).values], [['API', 'q']]);
  assert.deepEqual(resolve(p).missing, ['DB']);
});
test('addKey unregistered flags; setKeyValues clears flag', () => {
  let p = addKey(emptyProject(), 'N', 'v', 'dev', true);
  assert.deepEqual(p.values.unregistered, ['N']);
  assert.deepEqual(setKeyValues(p, 'N', { dev: 'v' }).values.unregistered, []);
});
test('setKeyValues with empty string removes that env value', () => {
  const p = setKeyValues(addKey(emptyProject(), 'A', 'v', 'dev'), 'A', { dev: '' });
  assert.equal(p.values.values.A.dev, undefined);
});
test('renameEnv moves values and selection', () => {
  const p = renameEnv(addKey(emptyProject(), 'A', 'v', 'qa'), 'qa', 'stage');
  assert.deepEqual(p.schema.environments, ['dev', 'stage', 'main']);
  assert.equal(p.values.selected.A, 'stage');
  assert.equal(p.values.values.A.stage, 'v');
});
test('removeEnv drops values, reselects defaultEnv; refuses last env', () => {
  const p = removeEnv(addKey(emptyProject(), 'A', 'v', 'qa'), 'qa');
  assert.equal(p.values.selected.A, 'dev');
  assert.equal(p.values.values.A.qa, undefined);
  assert.throws(() => removeEnv(emptyProject(['dev']), 'dev'));
});
test('addKey/addEnv reject duplicates and invalid key names', () => {
  const p = addKey(emptyProject(), 'A', 'v', 'dev');
  assert.throws(() => addKey(p, 'A', 'v', 'dev'));
  assert.throws(() => addKey(p, '1BAD', 'v', 'dev'));
  assert.throws(() => addEnv(p, 'dev'));
});
test('validate rejects wrong shapes', () => {
  assert.throws(() => validate({ version: 1, environments: 'x' }, 'schema'));
  assert.ok(validate(emptyProject().schema, 'schema'));
});
test('prototype members do not leak through env/key maps', () => {
  const base = addKey(emptyProject(['dev', 'constructor']), 'A', 'v', 'dev');
  const r = renameEnv(base, 'constructor', 'x');
  assert.equal(Object.hasOwn(r.values.values.A, 'x'), false);
  assert.doesNotThrow(() => addKey(r, 'B', 'w', 'dev'));
  const sel = selectAll(base, 'constructor');
  assert.deepEqual(resolve(sel).missing, ['A']);
  assert.equal(resolve(sel).values.size, 0);
});
test('rejects __proto__ key and prototype-member env names', () => {
  assert.throws(() => addKey(emptyProject(), '__proto__', 'v', 'dev'));
  assert.throws(() => addEnv(emptyProject(), 'toString'));
  assert.throws(() => renameEnv(emptyProject(), 'dev', 'constructor'));
});

test('validate rejects hostile schema/values and renderTarget cannot inject lines', () => {
  const s = (o: object) => ({ version: 1, target: '.env', environments: ['dev'], keys: [], ...o });
  const payload = 'x\n[core]\n\tfsmonitor = touch /tmp/pwned #';
  assert.throws(() => validate(s({ target: '.git/config', keys: [payload] }), 'schema'), /keys/);
  assert.throws(() => validate(s({ keys: ['A', 'A'] }), 'schema'), /keys/);
  assert.throws(() => validate(s({ environments: ['dev', 'dev'] }), 'schema'), /environments/);
  assert.throws(() => validate(s({ environments: [' '] }), 'schema'), /environments/);
  assert.throws(() => validate(s({ environments: ['constructor'] }), 'schema'), /environments/);
  const v = (o: object) => ({ version: 1, selected: {}, values: {}, unregistered: [], ...o });
  assert.throws(() => validate(v({ selected: { [payload]: 'dev' } }), 'values'), /selected/);
  assert.throws(() => validate(v({ values: { [payload]: { dev: 'a' } } }), 'values'), /values/);
  assert.throws(() => validate(v({ values: { A: { dev: 1 } } }), 'values'), /values/);
});

test('draftProject: file-order keys in dev, comments/invalid skipped, nothing unregistered', async () => {
  const { draftProject } = await import('../src/core/model');
  const p = draftProject('# c\n\nB=2\nbad key=x\nA=1\nE=\n');
  assert.deepEqual(p.schema.keys, ['B', 'A', 'E']);
  assert.deepEqual(p.values.values, { B: { dev: '2' }, A: { dev: '1' }, E: { dev: '' } });
  assert.deepEqual(p.values.selected, { B: 'dev', A: 'dev', E: 'dev' });
  assert.deepEqual(p.values.unregistered, []);
});
