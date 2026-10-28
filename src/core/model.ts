import { isValidKey } from './dotenv';

export interface Schema { version: 1; target: string; environments: string[]; keys: string[] }
export interface Values {
  version: 1;
  selected: Record<string, string>;
  values: Record<string, Record<string, string>>;
  unregistered: string[];
}
export interface Project { schema: Schema; values: Values }

export function emptyProject(environments: string[] = ['dev', 'qa', 'main']): Project {
  return {
    schema: { version: 1, target: '.env', environments: [...environments], keys: [] },
    values: { version: 1, selected: {}, values: {}, unregistered: [] },
  };
}

const clone = (p: Project): Project => structuredClone(p);

function assertEnv(p: Project, env: string): void {
  if (!p.schema.environments.includes(env)) throw new Error(`Unknown environment: ${env}`);
}
function assertKey(p: Project, key: string): void {
  if (!p.schema.keys.includes(key)) throw new Error(`Unknown key: ${key}`);
}
function assertNewEnvName(p: Project, env: string): void {
  if (!env.trim()) throw new Error('Environment name must not be empty');
  if (p.schema.environments.includes(env)) throw new Error(`Environment already exists: ${env}`);
}

export function defaultEnv(p: Project): string {
  const envs = p.schema.environments;
  const counts = new Map<string, number>();
  for (const e of Object.values(p.values.selected)) if (envs.includes(e)) counts.set(e, (counts.get(e) ?? 0) + 1);
  let best = envs[0];
  let max = 0;
  for (const e of envs) {
    const c = counts.get(e) ?? 0;
    if (c > max) { best = e; max = c; }
  }
  return best;
}

export function selectEnv(p: Project, key: string, env: string): Project {
  assertKey(p, key);
  assertEnv(p, env);
  const n = clone(p);
  n.values.selected[key] = env;
  return n;
}

export function selectAll(p: Project, env: string): Project {
  assertEnv(p, env);
  const n = clone(p);
  for (const k of n.schema.keys) n.values.selected[k] = env;
  return n;
}

export function setKeyValues(p: Project, key: string, byEnv: Record<string, string>): Project {
  assertKey(p, key);
  for (const e of Object.keys(byEnv)) assertEnv(p, e);
  const n = clone(p);
  const cur = { ...(n.values.values[key] ?? {}) };
  for (const [e, v] of Object.entries(byEnv)) {
    if (v === '') delete cur[e];
    else cur[e] = v;
  }
  n.values.values[key] = cur;
  n.values.unregistered = n.values.unregistered.filter(k => k !== key);
  return n;
}

export function addKey(p: Project, key: string, value: string, env: string, unregistered = false): Project {
  if (!isValidKey(key)) throw new Error(`Invalid key name: ${key}`);
  if (p.schema.keys.includes(key)) throw new Error(`Key already exists: ${key}`);
  assertEnv(p, env);
  const n = clone(p);
  n.schema.keys.push(key);
  n.values.selected[key] = env;
  n.values.values[key] = value === '' ? {} : { [env]: value };
  if (unregistered) n.values.unregistered.push(key);
  return n;
}

export function removeKey(p: Project, key: string): Project {
  const n = clone(p);
  n.schema.keys = n.schema.keys.filter(k => k !== key);
  delete n.values.selected[key];
  delete n.values.values[key];
  n.values.unregistered = n.values.unregistered.filter(k => k !== key);
  return n;
}

export function addEnv(p: Project, env: string): Project {
  assertNewEnvName(p, env);
  const n = clone(p);
  n.schema.environments.push(env);
  return n;
}

export function renameEnv(p: Project, from: string, to: string): Project {
  assertEnv(p, from);
  assertNewEnvName(p, to);
  const n = clone(p);
  n.schema.environments = n.schema.environments.map(e => (e === from ? to : e));
  for (const k of Object.keys(n.values.selected)) if (n.values.selected[k] === from) n.values.selected[k] = to;
  for (const byEnv of Object.values(n.values.values)) {
    if (from in byEnv) { byEnv[to] = byEnv[from]; delete byEnv[from]; }
  }
  return n;
}

export function removeEnv(p: Project, env: string): Project {
  assertEnv(p, env);
  if (p.schema.environments.length === 1) throw new Error('Cannot remove the last environment');
  const n = clone(p);
  n.schema.environments = n.schema.environments.filter(e => e !== env);
  for (const byEnv of Object.values(n.values.values)) delete byEnv[env];
  const removed = Object.keys(n.values.selected).filter(k => n.values.selected[k] === env);
  for (const k of removed) delete n.values.selected[k];
  const fallback = defaultEnv(n);
  for (const k of removed) n.values.selected[k] = fallback;
  return n;
}

export function resolve(p: Project): { values: Map<string, string>; missing: string[] } {
  const values = new Map<string, string>();
  const missing: string[] = [];
  for (const k of p.schema.keys) {
    const env = p.values.selected[k];
    const v = env === undefined ? undefined : p.values.values[k]?.[env];
    if (v === undefined) missing.push(k);
    else values.set(k, v);
  }
  return { values, missing };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStrArr = (x: unknown): x is string[] => Array.isArray(x) && x.every(s => typeof s === 'string');
const isStrRec = (x: unknown): boolean => isObj(x) && Object.values(x).every(s => typeof s === 'string');

export function validate(raw: unknown, kind: 'schema' | 'values'): Schema | Values {
  const bad = (field: string): never => { throw new Error(`Invalid ${kind}: bad or missing "${field}"`); };
  if (!isObj(raw)) return bad('root');
  if (raw.version !== 1) bad('version');
  if (kind === 'schema') {
    if (typeof raw.target !== 'string' || !raw.target) bad('target');
    if (!isStrArr(raw.environments) || raw.environments.length === 0) bad('environments');
    if (!isStrArr(raw.keys)) bad('keys');
    return raw as unknown as Schema;
  }
  if (!isStrRec(raw.selected)) bad('selected');
  if (!isObj(raw.values) || !Object.values(raw.values).every(isStrRec)) bad('values');
  if (!isStrArr(raw.unregistered)) bad('unregistered');
  return raw as unknown as Values;
}
