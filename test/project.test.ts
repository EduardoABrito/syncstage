import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addKey, emptyProject } from '../src/core/model';
import { ensureGitignore, init, isTrackedByGit, load, readTarget, targetPath, writeTarget } from '../src/project';

test('init creates files and gitignore entry once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ss-'));
  await writeFile(join(dir, '.gitignore'), 'node_modules\n');
  await init(dir); await ensureGitignore(dir);
  assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), 'node_modules\n.syncstage/values.json\n');
  assert.equal((await load(dir)).status, 'ok');
});
test('schema.json never contains values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ss-'));
  await init(dir, addKey(emptyProject(), 'SECRET', 's3cr3t', 'dev'));
  assert.ok(!(await readFile(join(dir, '.syncstage/schema.json'), 'utf8')).includes('s3cr3t'));
});
test('load reports missing and invalid without throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ss-'));
  assert.equal((await load(dir)).status, 'missing');
  await mkdir(join(dir, '.syncstage')); await writeFile(join(dir, '.syncstage/schema.json'), '{bad');
  const r = await load(dir);
  assert.equal(r.status, 'invalid');
  assert.match((r as any).file, /schema\.json$/);
});
test('isTrackedByGit false outside a repo', async () => {
  assert.equal(await isTrackedByGit(await mkdtemp(join(tmpdir(), 'ss-')), '.env'), false);
});
test('load with absent values.json gives empty values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ss-'));
  await init(dir);
  await (await import('node:fs/promises')).rm(join(dir, '.syncstage/values.json'));
  const r = await load(dir);
  assert.equal(r.status, 'ok');
  assert.deepEqual((r as any).project.values, { version: 1, selected: {}, values: {}, unregistered: [] });
});
test('targetPath rejects escaping and absolute targets; readTarget works', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ss-'));
  const p = emptyProject();
  assert.equal(await readTarget(dir, p), '');
  await writeFile(join(dir, '.env'), 'A=1\n');
  assert.equal(await readTarget(dir, p), 'A=1\n');
  for (const target of ['../x', join(tmpdir(), 'x'), 'a/../../x', '.']) {
    const bad = { ...p, schema: { ...p.schema, target } };
    assert.throws(() => targetPath(dir, bad), /target/i, target);
    await assert.rejects(readTarget(dir, bad));
  }
});

test('writeTarget refuses symlinks and writes regular files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ss-'));
  const outside = join(await mkdtemp(join(tmpdir(), 'ss-out-')), 'victim');
  await writeFile(outside, 'safe');
  await symlink(outside, join(dir, '.env'));
  await assert.rejects(writeTarget(dir, emptyProject(), 'pwn'), /symbolic link/);
  assert.equal(await readFile(outside, 'utf8'), 'safe');
  const dir2 = await mkdtemp(join(tmpdir(), 'ss-'));
  await writeTarget(dir2, emptyProject(), 'A=1\n');
  assert.equal(await readFile(join(dir2, '.env'), 'utf8'), 'A=1\n');
});

test('targetPath rejects .git, .syncstage and glob targets', () => {
  const p = emptyProject();
  for (const target of ['.git/config', '.GIT/config', '.syncstage/x', 'a*', 'a?', 'a[b]', 'a{b}']) {
    assert.throws(() => targetPath('/x', { ...p, schema: { ...p.schema, target } }), /target/i, target);
  }
});
test('writeTarget refuses symlinked parent dir; missing parent refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ss-'));
  const out = await mkdtemp(join(tmpdir(), 'ss-out-'));
  await symlink(out, join(dir, 'sub'));
  const p = emptyProject(); p.schema.target = 'sub/.zshrc';
  await assert.rejects(writeTarget(dir, p, 'pwn'), /outside/);
  await assert.rejects(readTarget(dir, p), /outside/);
  assert.deepEqual(await (await import('node:fs/promises')).readdir(out), []);
  p.schema.target = 'nope/.env';
  await assert.rejects(writeTarget(dir, p, 'x'), /does not exist/);
});
test('init reuses existing values.json without schema', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ss-'));
  await mkdir(join(dir, '.syncstage'));
  const vals = { version: 1, selected: { SECRET: 'prod' }, values: { SECRET: { prod: 's3' }, A: { dev: '1' } }, unregistered: [] };
  await writeFile(join(dir, '.syncstage/values.json'), JSON.stringify(vals));
  const p = await init(dir);
  assert.deepEqual(p.schema.keys, ['A', 'SECRET']);
  assert.deepEqual(p.schema.environments, ['dev', 'qa', 'main', 'prod']);
  const r = await load(dir);
  assert.equal((r as any).project.values.values.SECRET.prod, 's3');
  await writeFile(join(dir, '.syncstage/values.json'), '{bad');
  await rm(join(dir, '.syncstage/schema.json'));
  await assert.rejects(init(dir), /values\.json/);
  assert.equal(await readFile(join(dir, '.syncstage/values.json'), 'utf8'), '{bad');
});

test('loadDraft: only for .env with keys and no values.json; writes nothing', async () => {
  const { loadDraft } = await import('../src/project');
  const dir = await mkdtemp(join(tmpdir(), 'ss-'));
  assert.equal(await loadDraft(dir), undefined);
  await writeFile(join(dir, '.env'), '# only a comment\n');
  assert.equal(await loadDraft(dir), undefined);
  await writeFile(join(dir, '.env'), 'A=1\n');
  assert.deepEqual((await loadDraft(dir))?.schema.keys, ['A']);
  assert.equal((await load(dir)).status, 'missing');
  await mkdir(join(dir, '.syncstage')); await writeFile(join(dir, '.syncstage/values.json'), '{}');
  assert.equal(await loadDraft(dir), undefined);
});
