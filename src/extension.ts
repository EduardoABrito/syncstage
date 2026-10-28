import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { parse, toMap } from './core/dotenv';
import { Change, applyChanges, importDiff, manualDiff } from './core/diff';
import {
  Project, addEnv, addKey, defaultEnv, removeEnv, removeKey, renameEnv, resolve, selectAll, selectEnv, setKeyValues,
} from './core/model';
import type { FromWebview, ProjectView } from './core/protocol';
import { SelfWrites, renderTarget } from './core/sync';
import { SyncPanel } from './panel';
import { LoadResult, init, isTrackedByGit, load, readTarget, save, targetPath, writeTarget } from './project';

const t = vscode.l10n.t;
type Pending = { kind: 'import' | 'manual'; changes: Change[] };
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function activate(ctx: vscode.ExtensionContext): void {
  const selfWrites = new SelfWrites();
  const states = new Map<string, LoadResult>();
  const pending = new Map<string, Pending>();
  const watchers = new Map<string, { target: string; w: vscode.FileSystemWatcher }>();
  const folders = (): readonly vscode.WorkspaceFolder[] => vscode.workspace.workspaceFolders ?? [];
  const fail = (e: unknown): void => { void vscode.window.showErrorMessage(errMsg(e)); };
  const guard = <A extends unknown[]>(f: (...a: A) => Promise<void>) => (...a: A): void => { f(...a).catch(fail); };

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  status.command = 'syncstage.openPanel';

  const views = (): ProjectView[] => folders().map(f => {
    const root = f.uri.fsPath;
    const s = states.get(root) ?? { status: 'missing' as const };
    const base = { name: f.name, root, missing: [] as string[], pending: pending.get(root) };
    if (s.status === 'ok') return { ...base, status: 'ok', project: s.project, missing: resolve(s.project).missing };
    if (s.status === 'invalid') return { ...base, status: 'invalid', error: `${s.file}: ${s.message}` };
    return { ...base, status: 'missing' };
  });

  const panel = new SyncPanel(ctx, views, m => handle(m));

  function updateStatus(): void {
    const ed = vscode.window.activeTextEditor;
    const owner = ed && vscode.workspace.getWorkspaceFolder(ed.document.uri)?.uri.fsPath;
    const okOf = (root?: string): Project | undefined => {
      const s = root === undefined ? undefined : states.get(root);
      return s?.status === 'ok' ? s.project : undefined;
    };
    let p = okOf(owner);
    if (!p) for (const f of folders()) { p = okOf(f.uri.fsPath); if (p) break; }
    status.text = p ? `$(layers) ${defaultEnv(p)}` : '$(layers) syncstage';
    status.show();
  }

  async function refresh(): Promise<void> {
    const roots = folders().map(f => f.uri.fsPath);
    for (const r of [...states.keys()]) if (!roots.includes(r)) { states.delete(r); pending.delete(r); }
    for (const root of roots) {
      let s = await load(root);
      if (s.status === 'ok') {
        try { targetPath(root, s.project); } catch (e) { s = { status: 'invalid', file: '.syncstage/schema.json', message: errMsg(e) }; }
      }
      states.set(root, s);
    }
    syncWatchers();
    updateStatus();
    panel.post();
  }

  function syncWatchers(): void {
    for (const [root, w] of [...watchers]) {
      const s = states.get(root);
      const target = s?.status === 'ok' ? s.project.schema.target : undefined;
      if (target !== w.target) { w.w.dispose(); watchers.delete(root); }
    }
    for (const f of folders()) {
      const root = f.uri.fsPath;
      const s = states.get(root);
      if (s?.status !== 'ok' || watchers.has(root)) continue;
      const target = s.project.schema.target;
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, target));
      const on = (): void => { onTargetChanged(root).catch(fail); };
      w.onDidChange(on); w.onDidCreate(on);
      watchers.set(root, { target, w });
    }
  }

  async function onTargetChanged(root: string): Promise<void> {
    const s = states.get(root);
    if (s?.status !== 'ok') return;
    const content = await readTarget(root, s.project);
    if (selfWrites.isSelfWrite(targetPath(root, s.project), content)) return;
    const changes = manualDiff(s.project, toMap(parse(content)));
    if (changes.length === 0) pending.delete(root);
    else {
      pending.set(root, { kind: 'manual', changes });
      const target = s.project.schema.target;
      void vscode.window.showInformationMessage(t('{0} changed outside syncstage — {1} keys', target, changes.length), t('Review'))
        .then(c => { if (c) panel.show(); });
    }
    panel.post();
  }

  /** compute → skip if equal → mark self-write BEFORE writing → write */
  async function syncTarget(root: string, p: Project, mode: 'sync' | 'generate' = 'sync'): Promise<void> {
    const current = await readTarget(root, p);
    const next = renderTarget(p, current, mode);
    if (next === current) return;
    selfWrites.mark(targetPath(root, p), next);
    await writeTarget(root, p, next);
  }

  async function okProject(root: string): Promise<Project> {
    const s = states.get(root) ?? await load(root);
    if (s.status !== 'ok') throw new Error(t('Project is not initialized or its syncstage files are invalid'));
    return s.project;
  }

  async function commit(root: string, p: Project): Promise<void> {
    await save(root, p);
    await syncTarget(root, p);
    await refresh();
  }

  async function pickEnv(p: Project): Promise<string | undefined> {
    return vscode.window.showQuickPick(p.schema.environments, { placeHolder: t('Environment') });
  }

  async function importContent(root: string, p: Project, content: string, env: string): Promise<void> {
    const { project, conflicts } = importDiff(p, env, toMap(parse(content)));
    await save(root, project);
    if (conflicts.length) {
      pending.set(root, { kind: 'import', changes: conflicts });
      await refresh();
    } else {
      pending.delete(root);
      await commit(root, project);
    }
  }

  async function warnIfTracked(root: string, p: Project): Promise<void> {
    const target = p.schema.target;
    if (await isTrackedByGit(root, target)) {
      void vscode.window.showWarningMessage(t('{0} is tracked by git — secrets may be committed', target));
    }
  }

  async function doImport(root: string): Promise<void> {
    const p = await okProject(root);
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false, defaultUri: vscode.Uri.file(root), title: t('Import .env'),
    });
    if (!uris?.length) return;
    const env = await pickEnv(p);
    if (!env) return;
    await importContent(root, p, await readFile(uris[0].fsPath, 'utf8'), env);
  }

  async function doInit(root: string): Promise<void> {
    if ((states.get(root) ?? await load(root)).status !== 'missing') return;
    const p = await init(root);
    const existing = await readTarget(root, p);
    await refresh();
    await warnIfTracked(root, p);
    if (existing === '') return;
    const yes = t('Import');
    const a = await vscode.window.showWarningMessage(t('Import existing {0}?', p.schema.target), { modal: true }, yes);
    if (a !== yes) return;
    const env = await pickEnv(p);
    if (env) await importContent(root, p, existing, env);
  }

  async function doResolve(root: string, accepted: string[]): Promise<void> {
    const pend = pending.get(root);
    if (!pend) return;
    const p = await okProject(root);
    const ok = new Set(accepted);
    const next = applyChanges(p, pend.changes.filter(c => ok.has(c.key)));
    pending.delete(root);
    await commit(root, next); // always sync: rejected manual changes are restored
  }

  async function handle(m: FromWebview): Promise<void> {
    if (m.type === 'ready') { panel.post(); return; }
    if (m.type === 'init') return doInit(m.root);
    const p = await okProject(m.root); // never write for missing/invalid projects
    switch (m.type) {
      case 'import': return doImport(m.root);
      case 'generate': {
        await syncTarget(m.root, p, 'generate');
        await warnIfTracked(m.root, p);
        return;
      }
      case 'addEnv': {
        const name = await vscode.window.showInputBox({ prompt: t('Environment') });
        if (name !== undefined) await commit(m.root, addEnv(p, name));
        return;
      }
      case 'renameEnv': {
        const name = await vscode.window.showInputBox({ prompt: t('New name for {0}', m.env), value: m.env });
        if (name !== undefined && name !== m.env) await commit(m.root, renameEnv(p, m.env, name));
        return;
      }
      case 'removeEnv': {
        const yes = t('Remove');
        const a = await vscode.window.showWarningMessage(
          t('Remove environment {0}? Its values will be deleted.', m.env), { modal: true }, yes);
        if (a === yes) await commit(m.root, removeEnv(p, m.env));
        return;
      }
      case 'select': return commit(m.root, selectEnv(p, m.key, m.env));
      case 'selectAll': return commit(m.root, selectAll(p, m.env));
      case 'saveKey': return commit(m.root, setKeyValues(p, m.key, m.values));
      case 'addKey': return commit(m.root, addKey(p, m.key, m.value, m.env));
      case 'removeKey': return commit(m.root, removeKey(p, m.key));
      case 'resolve': return doResolve(m.root, m.accepted);
    }
  }

  ctx.subscriptions.push(
    status,
    vscode.commands.registerCommand('syncstage.openPanel', () => { panel.show(); }),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidChangeWorkspaceFolders(guard(async () => { await refresh(); rewatchState(); })),
    { dispose: () => { for (const w of watchers.values()) w.w.dispose(); watchers.clear(); } },
  );

  // `.syncstage/*.json` watchers: reload state (our own saves trigger this too — harmless)
  const stateWatchers = new Map<string, vscode.FileSystemWatcher>();
  function rewatchState(): void {
    const roots = new Set(folders().map(f => f.uri.fsPath));
    for (const [r, w] of [...stateWatchers]) if (!roots.has(r)) { w.dispose(); stateWatchers.delete(r); }
    for (const f of folders()) {
      if (stateWatchers.has(f.uri.fsPath)) continue;
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, '.syncstage/*.json'));
      const on = guard(refresh);
      w.onDidChange(on); w.onDidCreate(on); w.onDidDelete(on);
      stateWatchers.set(f.uri.fsPath, w);
    }
  }
  ctx.subscriptions.push({ dispose: () => { for (const w of stateWatchers.values()) w.dispose(); stateWatchers.clear(); } });

  rewatchState();
  guard(refresh)();
}

export function deactivate(): void {}
