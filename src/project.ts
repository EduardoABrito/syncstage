import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { emptyProject, validate, type Project, type Schema, type Values } from './core/model';

export type LoadResult =
  | { status: 'ok'; project: Project }
  | { status: 'missing' }
  | { status: 'invalid'; file: string; message: string };

const DIR = '.syncstage';
const IGNORE_LINE = '.syncstage/values.json';

const isEnoent = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === 'ENOENT';
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function readOpt(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); } catch (e) { if (isEnoent(e)) return undefined; throw e; }
}

export async function load(root: string): Promise<LoadResult> {
  const schemaFile = join(root, DIR, 'schema.json');
  const valuesFile = join(root, DIR, 'values.json');
  let file = schemaFile;
  try {
    const s = await readOpt(schemaFile);
    if (s === undefined) return { status: 'missing' };
    const schema = validate(JSON.parse(s), 'schema') as Schema;
    file = valuesFile;
    const v = await readOpt(valuesFile);
    const values = v === undefined
      ? emptyProject().values
      : (validate(JSON.parse(v), 'values') as Values);
    return { status: 'ok', project: { schema, values } };
  } catch (e) {
    return { status: 'invalid', file, message: msg(e) };
  }
}

export async function save(root: string, p: Project): Promise<void> {
  await mkdir(join(root, DIR), { recursive: true });
  const out = (x: unknown): string => JSON.stringify(x, null, 2) + '\n';
  await writeFile(join(root, DIR, 'schema.json'), out(p.schema));
  await writeFile(join(root, DIR, 'values.json'), out(p.values));
}

export async function ensureGitignore(root: string): Promise<void> {
  const file = join(root, '.gitignore');
  const cur = (await readOpt(file)) ?? '';
  if (cur.split(/\r?\n/).some(l => l.trim() === IGNORE_LINE)) return;
  await writeFile(file, cur + (cur === '' || cur.endsWith('\n') ? '' : '\n') + IGNORE_LINE + '\n');
}

export async function init(root: string, p: Project = emptyProject()): Promise<Project> {
  await mkdir(join(root, DIR), { recursive: true });
  await save(root, p);
  await ensureGitignore(root);
  return p;
}

export function isTrackedByGit(root: string, relPath: string): Promise<boolean> {
  return new Promise(res => {
    execFile('git', ['ls-files', '--error-unmatch', relPath], { cwd: root }, err => res(!err));
  });
}

/** Resolve schema.target under root; schema comes from a possibly untrusted repo. */
export function targetPath(root: string, p: Project): string {
  const t = p.schema.target;
  const abs = resolve(root, t);
  const rel = relative(resolve(root), abs);
  if (isAbsolute(t) || rel === '' || rel === '..' || rel.startsWith('..' + '/') || rel.startsWith('..\\') || isAbsolute(rel)) {
    throw new Error(`Invalid target (must be a file inside the project): ${t}`);
  }
  return abs;
}

export async function readTarget(root: string, p: Project): Promise<string> {
  return (await readOpt(targetPath(root, p))) ?? '';
}
