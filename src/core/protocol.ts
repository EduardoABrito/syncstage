import type { Change } from './diff';
import type { Project } from './model';

export interface ProjectView {
  name: string; root: string;
  status: 'ok' | 'missing' | 'invalid'; error?: string;
  project?: Project; draft?: boolean; // draft: loaded from the target, not saved yet
  missing: string[]; // missing resolve()
  pending?: { kind: 'import' | 'manual'; changes: Change[] };
}
export type ToWebview = { type: 'state'; projects: ProjectView[]; strings: Record<string, string> };
export type FromWebview =
  | { type: 'ready' }
  | { type: 'init' | 'import' | 'generate' | 'addEnv' | 'exportConfig' | 'importConfig'; root: string }
  | { type: 'renameEnv' | 'removeEnv'; root: string; env: string }
  | { type: 'select'; root: string; key: string; env: string }
  | { type: 'selectAll'; root: string; env: string }
  | { type: 'saveKey'; root: string; key: string; values: Record<string, string> }
  | { type: 'addKey'; root: string; key: string; value: string; env: string }
  | { type: 'removeKey'; root: string; key: string }
  | { type: 'resolve'; root: string; accepted: string[] }; // keys accepted pending; others rejected
