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
