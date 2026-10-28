import type { Project } from './core/model';
import { targetPath } from './project';

export interface GateDeps {
  isTracked(target: string): Promise<boolean>;
  /** modal: 'continue' | 'change' | undefined (cancel) */
  ask(target: string): Promise<'continue' | 'change' | undefined>;
  /** new target name, undefined = cancel */
  changeTarget(): Promise<string | undefined>;
}

/**
 * Before the first target write per root per session: if the target is git-tracked, confirm.
 * Returns the (possibly retargeted) project, or undefined when the user cancelled.
 */
export async function gate(confirmed: Set<string>, root: string, p: Project, deps: GateDeps): Promise<Project | undefined> {
  if (confirmed.has(root)) return p;
  let cur = p;
  for (;;) {
    if (!(await deps.isTracked(cur.schema.target))) { confirmed.add(root); return cur; }
    const choice = await deps.ask(cur.schema.target);
    if (choice === 'continue') { confirmed.add(root); return cur; }
    if (choice !== 'change') return undefined;
    const target = await deps.changeTarget();
    if (target === undefined) return undefined;
    const next = { ...cur, schema: { ...cur.schema, target } };
    targetPath(root, next); // throws if outside project
    cur = next;
  }
}
