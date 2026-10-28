import type { Project } from './model';

const LIMIT = 50;

/** Per-project undo/redo stacks of deep-copied snapshots (session memory only). */
export class History {
  private undos: Project[] = [];
  private redos: Project[] = [];

  get canUndo(): boolean { return this.undos.length > 0; }
  get canRedo(): boolean { return this.redos.length > 0; }

  /** `before` = state prior to a new action; invalidates redo. */
  record(before: Project): void {
    this.push(this.undos, before);
    this.redos = [];
  }

  undo(current: Project): Project | undefined {
    const prev = this.undos.pop();
    if (prev) this.push(this.redos, current);
    return prev;
  }

  redo(current: Project): Project | undefined {
    const next = this.redos.pop();
    if (next) this.push(this.undos, current);
    return next;
  }

  clear(): void { this.undos = []; this.redos = []; }

  private push(stack: Project[], p: Project): void {
    stack.push(structuredClone(p));
    if (stack.length > LIMIT) stack.shift();
  }
}
