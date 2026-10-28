import { basename } from 'node:path';
import type { Change } from './diff';
import { Project, Schema, Values, addEnv, addKey, defaultEnv, setKeyValues, validate } from './model';

/** Shareable subset of a project: never the target path, never the unregistered flags. */
export interface Config {
  syncstage: 1;
  environments: string[];
  keys: string[];
  selected: Record<string, string>;
  values: Record<string, Record<string, string>>;
}

const MAX_KEYS = 2000; // mergeConfig clones the project per op: stay well under a UI freeze
const MAX_ENVS = 100;
const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

export function exportConfig(p: Project, withValues: boolean): string {
  const out: Record<string, unknown> = { syncstage: 1, environments: p.schema.environments, keys: p.schema.keys };
  const selected: Record<string, string> = {};
  const values: Record<string, Record<string, string>> = {};
  for (const k of p.schema.keys) {
    const s = own(p.values.selected, k);
    if (s !== undefined) selected[k] = s;
    const v = own(p.values.values, k);
    if (v && Object.keys(v).length) values[k] = v;
  }
  out.selected = selected;
  if (withValues) out.values = values;
  return JSON.stringify(out, null, 2) + '\n';
}

/** Validates untrusted parsed JSON; throws Error(message) on anything unexpected. */
export function parseConfig(raw: unknown): Config {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Not a syncstage config');
  const r = raw as Record<string, unknown>;
  if (r.syncstage !== 1) throw new Error('Unsupported or missing "syncstage" version');
  // reuse the model's rules for names and leaf values
  if (Array.isArray(r.keys) && r.keys.length > MAX_KEYS) throw new Error(`Too many keys (max ${MAX_KEYS})`);
  if (Array.isArray(r.environments) && r.environments.length > MAX_ENVS) throw new Error(`Too many environments (max ${MAX_ENVS})`);
  const { environments, keys } = validate({ version: 1, target: '-', environments: r.environments, keys: r.keys }, 'schema') as Schema;
  const { selected, values } = validate(
    { version: 1, selected: r.selected === undefined ? {} : r.selected, values: r.values === undefined ? {} : r.values, unregistered: [] }, 'values') as Values;
  for (const [k, e] of Object.entries(selected)) {
    if (!keys.includes(k) || !environments.includes(e)) throw new Error(`Invalid config: bad selection for "${k}"`);
  }
  for (const [k, byEnv] of Object.entries(values)) {
    if (!keys.includes(k) || !Object.keys(byEnv).every(e => environments.includes(e))) throw new Error(`Invalid config: bad values for "${k}"`);
  }
  return { syncstage: 1, environments: [...environments], keys: [...keys], selected: { ...selected }, values: structuredClone(values) };
}

/** Adds what the project lacks; differing values become conflicts, never overwrites. */
export function mergeConfig(p: Project, cfg: Config): { project: Project; conflicts: Change[] } {
  let project = p;
  for (const e of cfg.environments) if (!project.schema.environments.includes(e)) project = addEnv(project, e);
  const conflicts: Change[] = [];
  for (const key of cfg.keys) {
    if (!project.schema.keys.includes(key)) {
      const sel = own(cfg.selected, key);
      project = addKey(project, key, '', sel !== undefined && project.schema.environments.includes(sel) ? sel : defaultEnv(project));
    }
    const byEnv = own(cfg.values, key) ?? {};
    for (const [env, after] of Object.entries(byEnv)) {
      if (after === '') continue;
      const before = own(own(project.values.values, key) ?? {}, env);
      if (before === undefined) project = setKeyValues(project, key, { [env]: after });
      else if (before !== after) conflicts.push({ key, env, before, after, isNew: false });
    }
  }
  return { project, conflicts };
}

// ---- workspace-level file: { syncstage: 1, workspace: { <folder name>: <per-project body> } } ----

const MAX_PROJECTS = 200;
export interface WsProject { root: string; rel: string }
export type SkipReason = 'not found' | 'ambiguous';

/** Entry key per project: its folder name when unique among projects, else its relative path. */
export function workspaceKeys(projects: WsProject[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const p of projects) count.set(basename(p.root), (count.get(basename(p.root)) ?? 0) + 1);
  return new Map(projects.map(p => [p.root, (count.get(basename(p.root)) ?? 0) > 1 ? p.rel : basename(p.root)]));
}

/** Maps file entries onto projects: exact rel first, then unique folder name. A root is claimed once. */
export function matchWorkspace(entryKeys: string[], projects: WsProject[]):
  { matched: Map<string, string>; skipped: { key: string; reason: SkipReason }[] } {
  const matched = new Map<string, string>();
  const claimed = new Set<string>();
  for (const k of entryKeys) {
    const hit = projects.find(p => p.rel === k && !claimed.has(p.root));
    if (hit) { matched.set(k, hit.root); claimed.add(hit.root); }
  }
  const skipped: { key: string; reason: SkipReason }[] = [];
  for (const k of entryKeys) {
    if (matched.has(k)) continue;
    const name = k.split(/[\\/]/).pop() as string;
    const cands = projects.filter(p => basename(p.root) === name);
    if (cands.length === 0) skipped.push({ key: k, reason: 'not found' });
    else if (cands.length > 1 || claimed.has(cands[0].root)) skipped.push({ key: k, reason: 'ambiguous' });
    else { matched.set(k, cands[0].root); claimed.add(cands[0].root); }
  }
  return { matched, skipped };
}

/** One file for several projects; each body is exactly exportConfig's output minus the version tag. */
export function exportWorkspace(items: { key: string; project: Project }[], withValues: boolean): string {
  const workspace: Record<string, unknown> = {};
  for (const { key, project } of items) {
    const { syncstage: _v, ...rest } = JSON.parse(exportConfig(project, withValues)) as Record<string, unknown>;
    Object.defineProperty(workspace, key, { value: rest, enumerable: true, writable: true, configurable: true }); // key may be "__proto__"-like
  }
  return JSON.stringify({ syncstage: 1, workspace }, null, 2) + '\n';
}

/** Validates an untrusted workspace file; every body goes through parseConfig. */
export function parseWorkspaceConfig(raw: unknown): { key: string; config: Config }[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Not a syncstage workspace config');
  const r = raw as Record<string, unknown>;
  if (r.syncstage !== 1) throw new Error('Unsupported or missing "syncstage" version');
  const w = r.workspace;
  if (typeof w !== 'object' || w === null || Array.isArray(w)) throw new Error('Missing "workspace" object');
  const keys = Object.keys(w);
  if (keys.length > MAX_PROJECTS) throw new Error(`Too many projects (max ${MAX_PROJECTS})`);
  return keys.map(key => {
    if (key === '' || key.includes('\0') || key in Object.prototype) throw new Error(`Invalid project name: "${key.replace('\0', '')}"`);
    const body = (w as Record<string, unknown>)[key];
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error(`Invalid config for "${key}"`);
    try { return { key, config: parseConfig({ ...body, syncstage: 1 }) }; }
    catch (e) { throw new Error(`"${key}": ${e instanceof Error ? e.message : String(e)}`); }
  });
}
