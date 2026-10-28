import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addKey, emptyProject } from '../src/core/model';
import { ensureGitignore, init, isTrackedByGit, load, readTarget, targetPath } from '../src/project';

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
