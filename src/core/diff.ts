import { isValidKey } from './dotenv';
import { Project, addKey, defaultEnv, resolve, setKeyValues } from './model';

export interface Change { key: string; env: string; before: string | undefined; after: string | undefined; isNew: boolean }

const existing = (p: Project, key: string, env: string): string | undefined => {
  const byEnv = Object.hasOwn(p.values.values, key) ? p.values.values[key] : undefined;
  return byEnv && Object.hasOwn(byEnv, env) ? byEnv[env] : undefined;
};

export function importDiff(p: Project, env: string, incoming: Map<string, string>): { project: Project; conflicts: Change[] } {
  let project = p;
  const conflicts: Change[] = [];
  for (const [key, value] of incoming) {
    if (!isValidKey(key)) continue;
    if (!p.schema.keys.includes(key)) {
      project = addKey(project, key, value, env, true);
      continue;
    }
    const before = existing(p, key, env);
    if (before === undefined) project = setKeyValues(project, key, { [env]: value });
    else if (before !== value) conflicts.push({ key, env, before, after: value, isNew: false });
  }
  return { project, conflicts };
}

export function manualDiff(p: Project, actual: Map<string, string>, lastWritten?: Map<string, string>): Change[] {
  const { values, missing } = resolve(p);
  const miss = new Set(missing);
  const changes: Change[] = [];
  for (const key of p.schema.keys) {
    if (miss.has(key)) {
      // no value in selected env: sync leaves the old line; only a change vs what we last wrote counts
      const prev = lastWritten?.get(key);
      const after = actual.get(key);
      if (prev !== undefined && after !== undefined && after !== prev) {
        const env = Object.hasOwn(p.values.selected, key) ? p.values.selected[key] : defaultEnv(p);
        changes.push({ key, env, before: prev, after, isNew: false });
      }
      continue;
    }
    const before = values.get(key);
    const after = actual.get(key);
    if (before === after || (before === undefined && after === '')) continue;
    const env = Object.hasOwn(p.values.selected, key) ? p.values.selected[key] : defaultEnv(p);
    changes.push({ key, env, before, after, isNew: false });
  }
  const env = defaultEnv(p);
  for (const [key, after] of actual) {
    if (isValidKey(key) && !p.schema.keys.includes(key)) changes.push({ key, env, before: undefined, after, isNew: true });
  }
  return changes;
}

export function applyChanges(p: Project, accepted: Change[]): Project {
  let n = p;
  for (const c of accepted) {
    if (c.isNew) n = addKey(n, c.key, c.after ?? '', c.env, true);
    else n = setKeyValues(n, c.key, { [c.env]: c.after ?? '' });
  }
  return n;
}

/** Change ids are `${key}\0${env}`: a key can have several pending envs. */
export const changeId = (c: Change): string => `${c.key}\0${c.env}`;
export function acceptedChanges(changes: Change[], ids: string[]): Change[] {
  const ok = new Set(ids);
  return changes.filter(c => ok.has(changeId(c)));
}
