import { parse, toMap, update } from './dotenv';
import { Project, resolve } from './model';

export function renderTarget(p: Project, current: string, mode: 'sync' | 'generate'): string {
  const doc = parse(current);
  const { values, missing } = resolve(p);
  const updates = new Map(values);
  if (mode === 'generate') {
    const present = toMap(doc);
    for (const k of missing) if (!present.has(k)) updates.set(k, '');
  }
  return update(doc, updates, true);
}

export class SelfWrites {
  private lastByPath = new Map<string, string>();
  mark(path: string, content: string): void { this.lastByPath.set(path, content); }
  last(path: string): string | undefined { return this.lastByPath.get(path); }
  isSelfWrite(path: string, content: string): boolean { return this.lastByPath.get(path) === content; }
}
