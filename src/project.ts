import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isValidKey } from './core/dotenv';
import { draftProject, emptyProject, validate, type Project, type Schema, type Values } from './core/model';

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

/** `.env` / `.syncstage/schema.json` paths inside workspace folder `base` -> sorted unique project roots.
 *  The folder itself is a project only when nothing nested was found. */
export function projectRoots(base: string, paths: string[]): string[] {
  const nested = paths
    .map(p => (basename(p) === 'schema.json' ? dirname(dirname(p)) : dirname(p)))
    .filter(r => r.startsWith(base + sep));
  return nested.length ? [...new Set(nested)].sort() : [base];
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

/** No .syncstage/values.json and a readable default target with keys → in-memory draft (nothing is written). */
export async function loadDraft(root: string): Promise<Project | undefined> {
  try {
    if ((await readOpt(join(root, DIR, 'values.json'))) !== undefined) return undefined;
    const st = await lstat(targetPath(root, emptyProject())).catch(() => undefined);
    if (!st?.isFile() || st.size > 1024 * 1024) return undefined; // regular file only: no symlink/FIFO/device, max 1 MB
    const d = draftProject(await readTarget(root, emptyProject()));
    return d.schema.keys.length ? d : undefined;
  } catch { return undefined; }
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
  const vf = join(root, DIR, 'values.json');
  const raw = await readOpt(vf);
  if (raw !== undefined) {
    // values.json exists without schema: rebuild schema from it, never overwrite the values
    let values: Values;
    try { values = validate(JSON.parse(raw), 'values') as Values; } catch (e) { throw new Error(`Invalid ${vf}: ${msg(e)}`); }
    const keys = [...new Set([...Object.keys(values.values), ...Object.keys(values.selected)])].filter(isValidKey).sort();
    const seen = [...Object.values(values.selected), ...Object.values(values.values).flatMap(Object.keys)];
    const environments = [...new Set([...p.schema.environments, ...seen])].filter(e => e.trim() && !(e in Object.prototype));
    p = { schema: { ...p.schema, environments, keys }, values };
    await writeFile(join(root, DIR, 'schema.json'), JSON.stringify(p.schema, null, 2) + '\n');
    await ensureGitignore(root);
    return p;
  }
  await save(root, p);
  await ensureGitignore(root);
  return p;
}

export function isTrackedByGit(root: string, relPath: string): Promise<boolean> {
  return new Promise(res => {
    execFile('git', ['ls-files', '--error-unmatch', '--', relPath], { cwd: root }, err => res(!err));
  });
}

/** False only when git says the path is not ignored (exit 1); outside a repo nothing can be committed. */
export function isIgnoredByGit(root: string, path: string): Promise<boolean> {
  return new Promise(res => {
    execFile('git', ['check-ignore', '-q', '--', path], { cwd: root }, err => res(!(err && (err as { code?: unknown }).code === 1)));
  });
}

/** Resolve schema.target under root; schema comes from a possibly untrusted repo. */
export function targetPath(root: string, p: Project): string {
  const t = p.schema.target;
  const abs = resolve(root, t);
  const rel = relative(resolve(root), abs);
  if (/[*?[\]{}]/.test(t) || /^(\.git|\.syncstage)$/i.test(rel.split(/[\\/]/)[0])) throw new Error(`Invalid target: ${t}`);
  if (isAbsolute(t) || rel === '' || rel === '..' || rel.startsWith('..' + '/') || rel.startsWith('..\\') || isAbsolute(rel)) {
    throw new Error(`Invalid target (must be a file inside the project): ${t}`);
  }
  return abs;
}

/** Real parent dir must be inside the real root (a repo can commit `sub -> ../..`). Missing parent: refuse unless `lenient`. */
async function checkParent(root: string, file: string, lenient: boolean): Promise<boolean> {
  let parent: string;
  try { parent = await realpath(dirname(file)); } catch (e) {
    if (isEnoent(e) && lenient) return false;
    throw isEnoent(e) ? new Error(`Target directory does not exist: ${dirname(file)}`) : e;
  }
  const r = await realpath(root);
  if (parent !== r && !parent.startsWith(r + sep)) throw new Error(`Target directory resolves outside the project: ${file}`);
  return true;
}

export async function readTarget(root: string, p: Project): Promise<string> {
  const file = targetPath(root, p);
  if (!(await checkParent(root, file, true))) return '';
  return (await readOpt(file)) ?? '';
}

/** Write the target file; refuses symlinks (a repo could ship `.env -> ~/.bashrc`). */
export async function writeTarget(root: string, p: Project, content: string): Promise<void> {
  const file = targetPath(root, p);
  await checkParent(root, file, false);
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error(`Refusing to write through symbolic link: ${p.schema.target}`);
  } catch (e) { if (!isEnoent(e)) throw e; }
  await writeFile(file, content);
}
