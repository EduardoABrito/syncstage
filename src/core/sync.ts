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
  private last = new Map<string, string>();
  mark(path: string, content: string): void { this.last.set(path, content); }
  isSelfWrite(path: string, content: string): boolean { return this.last.get(path) === content; }
}
