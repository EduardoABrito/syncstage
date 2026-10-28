import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { parse, toMap } from './core/dotenv';
import { Change, applyChanges, importDiff, manualDiff } from './core/diff';
import {
  Project, addEnv, emptyProject, addKey, defaultEnv, removeEnv, removeKey, renameEnv, resolve, selectAll, selectEnv, setKeyValues,
} from './core/model';
import type { FromWebview, ProjectView } from './core/protocol';
import { SelfWrites, renderTarget } from './core/sync';
import { gate } from './gate';
import { SyncPanel } from './panel';
import { LoadResult, init, isTrackedByGit, load, loadDraft, readTarget, save, targetPath, writeTarget } from './project';

const t = vscode.l10n.t;
type Pending = { kind: 'import' | 'manual'; changes: Change[] };
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function activate(ctx: vscode.ExtensionContext): void {
  const selfWrites = new SelfWrites();
  const states = new Map<string, LoadResult>();
  const pending = new Map<string, Pending>();
  const drafts = new Map<string, Project>(); // roots with a target but no .syncstage/: shown, not persisted
  const watchers = new Map<string, { target: string; w: vscode.FileSystemWatcher }>();
  const folders = (): readonly vscode.WorkspaceFolder[] => vscode.workspace.workspaceFolders ?? [];
  const fail = (e: unknown): void => { void vscode.window.showErrorMessage(errMsg(e)); };

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  status.command = 'syncstage.openPanel';

  const views = (): ProjectView[] => folders().map(f => {
    const root = f.uri.fsPath;
    const s = states.get(root) ?? { status: 'missing' as const };
    const base = { name: f.name, root, missing: [] as string[], pending: pending.get(root) };
    const d = s.status === 'missing' ? drafts.get(root) : undefined;
    if (d) return { ...base, status: 'ok', project: d, draft: true, missing: resolve(d).missing };
    if (s.status === 'ok') return { ...base, status: 'ok', project: s.project, missing: resolve(s.project).missing };
    if (s.status === 'invalid') return { ...base, status: 'invalid', error: `${s.file}: ${s.message}` };
    return { ...base, status: 'missing' };
  });

  const confirmed = new Set<string>(); // roots whose git-tracked target was confirmed this session
  let queue: Promise<void> = Promise.resolve();
  /** serialize every mutation so overlapping messages never start from a stale project */
  const enqueue = (f: () => Promise<void>): Promise<void> => (queue = queue.then(f).catch(fail));

  const panel = new SyncPanel(ctx, views, m => enqueue(() => handle(m)));

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
    for (const r of [...states.keys()]) if (!roots.includes(r)) { states.delete(r); pending.delete(r); drafts.delete(r); }
    for (const root of roots) {
      let s = await load(root);
      if (s.status === 'ok') {
        try { targetPath(root, s.project); } catch (e) { s = { status: 'invalid', file: '.syncstage/schema.json', message: errMsg(e) }; }
      }
      states.set(root, s);
      if (s.status !== 'ok') pending.delete(root); // stale review items must not follow a draft/missing root
      const d = s.status === 'missing' ? await loadDraft(root) : undefined;
      if (d) drafts.set(root, d); else drafts.delete(root);
    }
    syncWatchers();
    updateStatus();
    panel.post();
  }

  function syncWatchers(): void {
    for (const [root, w] of [...watchers]) {
      const s = states.get(root);
      const target = (s?.status === 'ok' ? s.project : drafts.get(root))?.schema.target;
      if (target !== w.target) { w.w.dispose(); watchers.delete(root); }
    }
    for (const f of folders()) {
      const root = f.uri.fsPath;
      const s = states.get(root);
      const p = s?.status === 'ok' ? s.project : drafts.get(root);
      if (!p || watchers.has(root)) continue;
      const target = p.schema.target;
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, target));
      const on = (): void => { void enqueue(() => onTargetChanged(root)); };
      w.onDidChange(on); w.onDidCreate(on);
      w.onDidDelete(() => { if (drafts.has(root)) on(); }); // a deleted draft source must disappear
      watchers.set(root, { target, w });
    }
  }

  async function onTargetChanged(root: string): Promise<void> {
    if (drafts.has(root)) return refresh(); // nothing stored yet: just rebuild the draft
    const s = states.get(root);
    if (s?.status !== 'ok') return;
    const content = await readTarget(root, s.project);
    if (selfWrites.isSelfWrite(targetPath(root, s.project), content)) return;
    const prev = selfWrites.last(targetPath(root, s.project));
    const changes = manualDiff(s.project, toMap(parse(content)), prev === undefined ? undefined : toMap(parse(prev)));
    if (changes.length === 0) pending.delete(root);
    else {
      pending.set(root, { kind: 'manual', changes });
      const target = s.project.schema.target;
      void vscode.window.showInformationMessage(t('{0} changed outside syncstage — {1} keys', target, changes.length), t('Review'))
        .then(c => { if (c) panel.show(); });
    }
    panel.post();
  }

  const gateDeps = (root: string) => ({
    isTracked: (target: string) => isTrackedByGit(root, target),
    ask: async (target: string) => {
      const cont = t('Continue'); const change = t('Change target');
      const a = await vscode.window.showWarningMessage(
        t('{0} is tracked by git — secret values would be committed. Continue?', target), { modal: true }, cont, change);
      return a === cont ? 'continue' as const : a === change ? 'change' as const : undefined;
    },
    changeTarget: () => Promise.resolve(vscode.window.showInputBox({ prompt: t('New target file'), value: '.env.local' })),
  });

  /** compute → skip if equal → git-tracked gate → mark self-write BEFORE writing → write. Undefined = cancelled. */
  async function syncTarget(root: string, p: Project, mode: 'sync' | 'generate' = 'sync'): Promise<Project | undefined> {
    let current = await readTarget(root, p);
    let next = renderTarget(p, current, mode);
    if (next === current) return p;
    const q = await gate(confirmed, root, p, gateDeps(root));
    if (!q) return undefined;
    if (q !== p) {
      await save(root, q);
      current = await readTarget(root, q);
      next = renderTarget(q, current, mode);
      if (next === current) return q;
    }
    selfWrites.mark(targetPath(root, q), next);
    await writeTarget(root, q, next);
    return q;
  }

  async function okProject(root: string): Promise<Project> {
    const s = await load(root);
    if (s.status !== 'ok') throw new Error(t('Project is not initialized or its syncstage files are invalid'));
    return s.project;
  }

  /** Project to mutate; a draft is persisted first (git-tracked gate, then init). Undefined = cancelled. */
  async function mutable(root: string): Promise<Project | undefined> {
    const d = (await load(root)).status === 'missing' ? await loadDraft(root) : undefined; // re-read: .syncstage/ may have appeared
    if (!d) return okProject(root);
    const q = await gate(confirmed, root, d, gateDeps(root));
    if (!q) return undefined;
    const p = await init(root, q);
    await refresh();
    return p;
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
    if ((await load(root)).status !== 'missing') return;
    const q = await gate(confirmed, root, emptyProject(), gateDeps(root));
    if (!q) return;
    const p = await init(root, q);
    const existing = await readTarget(root, p);
    await refresh();
    if (existing === '') return;
    const env = await pickEnv(p);
    if (!env) return;
    const yes = t('Import');
    const a = await vscode.window.showWarningMessage(t('Import existing {0} as {1}?', p.schema.target, env), { modal: true }, yes);
    if (a === yes) await importContent(root, p, existing, env);
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
    if (!states.has(m.root)) throw new Error(t('Unknown project folder'));
    if (m.type === 'init') return doInit(m.root);
    const p = await mutable(m.root); // never write for missing/invalid projects
    if (!p) return;
    switch (m.type) {
      case 'import': return doImport(m.root);
      case 'generate': {
        await syncTarget(m.root, p, 'generate');
        await refresh();
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
      case 'saveKey': {
        const v: unknown = m.values;
        if (typeof m.key !== 'string' || typeof v !== 'object' || v === null || Array.isArray(v) || !Object.values(v).every(x => typeof x === 'string')) {
          void vscode.window.showErrorMessage(t('Invalid message from panel'));
          return;
        }
        return commit(m.root, setKeyValues(p, m.key, m.values));
      }
      case 'addKey': {
        if (typeof m.key !== 'string' || typeof m.value !== 'string' || typeof m.env !== 'string') {
          void vscode.window.showErrorMessage(t('Invalid message from panel'));
          return;
        }
        return commit(m.root, addKey(p, m.key, m.value, m.env));
      }
      case 'removeKey': return commit(m.root, removeKey(p, m.key));
      case 'resolve': return doResolve(m.root, m.accepted);
    }
  }

  // empty tree: only the viewsWelcome button shows; opening the sidebar opens the panel tab
  const home = vscode.window.createTreeView<never>('syncstage.home', {
    treeDataProvider: { getChildren: () => [], getTreeItem: (x: never) => x },
  });
  // the first click activates the extension, so the view may already be visible
  if (home.visible) void vscode.commands.executeCommand('syncstage.openPanel');

  ctx.subscriptions.push(
    status,
    vscode.commands.registerCommand('syncstage.openPanel', () => { panel.show(); }),
    home,
    home.onDidChangeVisibility(e => { if (e.visible) void vscode.commands.executeCommand('syncstage.openPanel'); }),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void enqueue(async () => { await refresh(); rewatchState(); }); }),
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
      const on = (): void => { void enqueue(refresh); };
      w.onDidChange(on); w.onDidCreate(on); w.onDidDelete(on);
      stateWatchers.set(f.uri.fsPath, w);
    }
  }
  ctx.subscriptions.push({ dispose: () => { for (const w of stateWatchers.values()) w.dispose(); stateWatchers.clear(); } });

  rewatchState();
  void enqueue(refresh);
}

export function deactivate(): void {}
