# syncstage v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** VS Code extension that stores per-project env values for every environment, lets the user point each key at an environment from a webview panel, and keeps the target `.env` synced; delivered as a local `.vsix`.

**Architecture:** Pure logic (dotenv parse/write, project model ops, diffs) lives in `src/core/` with no `vscode` import and is unit-tested with `node:test`. A thin `vscode` shell (`src/extension.ts`, `src/project.ts`, `src/panel.ts`) loads/saves `.syncstage/` files, writes the target file, watches it, and hosts a plain-TS webview (`src/webview/main.ts`) that renders state sent by the extension and posts user actions back.

**Tech Stack:** TypeScript 5, VS Code Extension API (`engines.vscode ^1.90.0`), `node:test` + `node:assert/strict`, `tsc` (no bundler), `@vscode/vsce`, pnpm. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-syncstage-design.md` (mockup: `docs/superpowers/specs/2026-10-27-syncstage-mockup.html`, option B)

## Global Constraints

- Extension name/id `syncstage`; display name `syncstage`; per-project folder `.syncstage/` with `schema.json` (committed, **no values**) and `values.json` (local).
- `values.json` path `.syncstage/values.json` is appended to the project `.gitignore` automatically on creation.
- Target file default `.env`, configurable via `schema.json` `target`.
- Never edit `.gitignore` for the target automatically.
- Standard VS Code Extension API only (must run on Antigravity/Cursor). No proposed APIs.
- No runtime dependencies. Dev deps only: `typescript`, `@types/vscode`, `@types/node`, `@vscode/vsce`.
- Webview: plain HTML/CSS/TS, no framework; CSP with nonce; colors from VS Code theme variables (`--vscode-*`).
- UI strings in en-US (default) and pt-BR from the first commit: `vscode.l10n.t` + `l10n/bundle.l10n.pt-br.json`; manifest strings via `package.nls.json` / `package.nls.pt-br.json`. Webview gets translated strings from the extension (no strings hardcoded in `main.ts`).
- pt-BR copy fixed by spec: "não cadastrado", "Inicializar syncstage", "Todas as chaves →", "Importar .env", "Gerar .env", "syncstage: Abrir painel", "`.env` alterado fora do syncstage — {0} chaves".
- `core/` never imports `vscode`.

## Review Focus

- **Writes by syncstage firing the watcher** → must not open the manual-edit flow. Pinned in Task 5 (`isSelfWrite`) test.
- **Values with spaces, `#`, quotes, `=` or newlines** → round-trip unchanged through write+parse. Pinned in Task 1 (`round-trips awkward values`).
- **CRLF `.env` files and `export KEY=` lines** → line endings and `export ` prefix preserved on rewrite. Pinned in Task 1.
- **Duplicate key in `.env`** → dotenv semantics (last wins) on read; writer updates the last occurrence only. Pinned in Task 1.
- **Key deleted from `.env` by hand** → shows in the manual-edit list as removed; discard restores it, confirm clears that env's value. Pinned in Task 3 (`manualDiff detects removed key`).

---

## File Structure

```
package.json                 manifest, scripts, contributes (commands, l10n)
package.nls.json             manifest strings en
package.nls.pt-br.json       manifest strings pt-BR
l10n/bundle.l10n.pt-br.json  runtime strings pt-BR (keys = en source strings)
tsconfig.json                extension + core + tests  → out/
tsconfig.webview.json        src/webview (lib DOM)     → out/web/
.vscodeignore  .gitignore  README.md
media/panel.css
src/core/dotenv.ts           parse + write .env text
src/core/model.ts            Schema/Values types, pure ops, resolve
src/core/diff.ts             importDiff, manualDiff
src/core/sync.ts             renderTarget, isSelfWrite
src/core/protocol.ts         webview message types (no vscode import)
src/project.ts               fs load/save, init, gitignore, git-tracked check
src/panel.ts                 webview host + message handling
src/extension.ts             activate: commands, status bar, watchers
src/webview/main.ts          webview UI
test/*.test.ts               node:test suites for core + project
```

---

### Task 1: Scaffold + dotenv parse/write

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore` (`node_modules/`, `out/`, `*.vsix`), `.vscodeignore`, `src/core/dotenv.ts`
- Test: `test/dotenv.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type DotenvLine =
    | { kind: 'raw'; text: string }                       // blank, comment, unparseable
    | { kind: 'entry'; key: string; value: string; text: string; exported: boolean };
  export interface DotenvDoc { lines: DotenvLine[]; eol: '\n' | '\r\n' }
  export function parse(text: string): DotenvDoc;
  export function toMap(doc: DotenvDoc): Map<string, string>;         // last occurrence wins
  export function update(doc: DotenvDoc, updates: Map<string, string>, appendMissing: boolean): string;
  export function formatValue(value: string): string;
  ```
  `entry.text` is the original source text of the entry (may span several lines for multi-line double-quoted values).

- [ ] **Step 1: Scaffold**

`package.json`: `"name": "syncstage"`, `"publisher": "eduardoabrito"`, `"version": "0.1.0"`, `"engines": {"vscode": "^1.90.0"}`, `"main": "./out/src/extension.js"`, `"l10n": "./l10n"`, `"activationEvents": ["workspaceContains:.syncstage/schema.json", "onCommand:syncstage.openPanel"]`, scripts:
```json
"build": "tsc -p . && tsc -p tsconfig.webview.json",
"test": "tsc -p . && node --test out/test/",
"package": "pnpm build && vsce package --no-dependencies"
```
`tsconfig.json`: `strict`, `target ES2022`, `module commonjs`, `rootDir "."`, `outDir "out"`, `include ["src", "test"]`, `exclude ["src/webview"]`. Then `pnpm add -D typescript @types/vscode@1.90.0 @types/node @vscode/vsce`.

- [ ] **Step 2: Write failing tests** in `test/dotenv.test.ts`

```ts
test('parses entries, comments, export, quotes', () => {
  const doc = parse('# c\nA=1\nexport B="x y"\nC=\'lit $x\'\nD=v # trailing\n\nE="l1\nl2"\n');
  assert.deepEqual([...toMap(doc)], [['A','1'],['B','x y'],['C','lit $x'],['D','v'],['E','l1\nl2']]);
});
test('update preserves unmanaged lines, export, CRLF; appends missing', () => {
  const doc = parse('# keep\r\nexport A=1\r\nX=raw\r\n');
  assert.equal(update(doc, new Map([['A','2'],['NEW','n']]), true), '# keep\r\nexport A=2\r\nX=raw\r\nNEW=n\r\n');
});
test('update without appendMissing ignores absent keys', () => {
  assert.equal(update(parse('A=1\n'), new Map([['B','2']]), false), 'A=1\n');
});
test('duplicate key: last wins, only last updated', () => {
  const doc = parse('A=1\nA=2\n');
  assert.equal(toMap(doc).get('A'), '2');
  assert.equal(update(doc, new Map([['A','3']]), false), 'A=1\nA=3\n');
});
test('round-trips awkward values', () => {
  for (const v of ['', 'a b', 'x#y', 'say "hi"', "it's", 'a=b', 'l1\nl2', 'back\\slash', ' lead']) {
    assert.equal(toMap(parse(update(parse(''), new Map([['K', v]]), true))).get('K'), v);
  }
});
test('formatValue leaves simple values bare', () => {
  assert.equal(formatValue('http://localhost:5002/a-b_c.d@e,f+g'), 'http://localhost:5002/a-b_c.d@e,f+g');
});
```

- [ ] **Step 3: Run** `pnpm test` → FAIL (`parse` not exported).

- [ ] **Step 4: Implement `src/core/dotenv.ts`**

Parse rules: key regex `^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$`. Value: `"…"` → may continue over following lines until an unescaped closing `"`; unescape `\n` `\r` `\t` `\"` `\\`. `'…'` → literal. Unquoted → cut at first ` #`, trim. Anything not matching → `raw`. `eol` = `'\r\n'` if text contains `\r\n`, else `'\n'`. Output always ends with one `eol` when non-empty.
`formatValue`: bare if `/^[A-Za-z0-9_./:@,+\-]*$/` matches (empty string → `''` bare, i.e. `KEY=`); else double-quoted escaping `\` `"` and newline as `\n`.
`update`: for each key in `updates`, replace the **last** entry with that key (keep `export ` prefix); append missing keys in `updates` iteration order when `appendMissing`.

- [ ] **Step 5: Run** `pnpm test` → all PASS.

- [ ] **Step 6: Commit** `git add -A && git commit -m "feat(core): scaffold and dotenv parse/update"`

---

### Task 2: Project model

**Files:**
- Create: `src/core/model.ts`
- Test: `test/model.test.ts`

**Interfaces:**
- Consumes: none.
- Produces:
  ```ts
  export interface Schema { version: 1; target: string; environments: string[]; keys: string[] }
  export interface Values {
    version: 1;
    selected: Record<string, string>;                  // key -> env
    values: Record<string, Record<string, string>>;    // key -> env -> value
    unregistered: string[];
  }
  export interface Project { schema: Schema; values: Values }
  export function emptyProject(environments?: string[]): Project;   // default ['dev','qa','main'], target '.env'
  export function defaultEnv(p: Project): string;                    // most common selected env, else environments[0]
  export function selectEnv(p: Project, key: string, env: string): Project;
  export function selectAll(p: Project, env: string): Project;
  export function setKeyValues(p: Project, key: string, byEnv: Record<string, string>): Project; // clears ⚠ for key
  export function addKey(p: Project, key: string, value: string, env: string, unregistered?: boolean): Project;
  export function removeKey(p: Project, key: string): Project;
  export function addEnv(p: Project, env: string): Project;
  export function renameEnv(p: Project, from: string, to: string): Project;
  export function removeEnv(p: Project, env: string): Project;
  export function resolve(p: Project): { values: Map<string, string>; missing: string[] };
  export function validate(raw: unknown, kind: 'schema' | 'values'): Schema | Values; // throws Error(message)
  ```
  All ops are immutable (return a new `Project`). `resolve.values` holds only keys that have a value in their selected env; `missing` lists the rest (in schema order).

- [ ] **Step 1: Write failing tests** in `test/model.test.ts`

```ts
test('selectEnv then resolve picks env value; missing key reported', () => {
  let p = addKey(emptyProject(), 'API', 'd', 'dev');
  p = setKeyValues(p, 'API', { dev: 'd', qa: 'q' });
  p = addKey(p, 'DB', 'x', 'dev');
  p = selectAll(p, 'qa');
  assert.deepEqual([...resolve(p).values], [['API', 'q']]);
  assert.deepEqual(resolve(p).missing, ['DB']);
});
test('addKey unregistered flags; setKeyValues clears flag', () => {
  let p = addKey(emptyProject(), 'N', 'v', 'dev', true);
  assert.deepEqual(p.values.unregistered, ['N']);
  assert.deepEqual(setKeyValues(p, 'N', { dev: 'v' }).values.unregistered, []);
});
test('setKeyValues with empty string removes that env value', () => {
  const p = setKeyValues(addKey(emptyProject(), 'A', 'v', 'dev'), 'A', { dev: '' });
  assert.equal(p.values.values.A.dev, undefined);
});
test('renameEnv moves values and selection', () => {
  const p = renameEnv(addKey(emptyProject(), 'A', 'v', 'qa'), 'qa', 'stage');
  assert.deepEqual(p.schema.environments, ['dev', 'stage', 'main']);
  assert.equal(p.values.selected.A, 'stage');
  assert.equal(p.values.values.A.stage, 'v');
});
test('removeEnv drops values, reselects defaultEnv; refuses last env', () => {
  const p = removeEnv(addKey(emptyProject(), 'A', 'v', 'qa'), 'qa');
  assert.equal(p.values.selected.A, 'dev');
  assert.equal(p.values.values.A.qa, undefined);
  assert.throws(() => removeEnv(emptyProject(['dev']), 'dev'));
});
test('addKey/addEnv reject duplicates and invalid key names', () => {
  const p = addKey(emptyProject(), 'A', 'v', 'dev');
  assert.throws(() => addKey(p, 'A', 'v', 'dev'));
  assert.throws(() => addKey(p, '1BAD', 'v', 'dev'));
  assert.throws(() => addEnv(p, 'dev'));
});
test('validate rejects wrong shapes', () => {
  assert.throws(() => validate({ version: 1, environments: 'x' }, 'schema'));
  assert.ok(validate(emptyProject().schema, 'schema'));
});
```

- [ ] **Step 2: Run** `pnpm test` → FAIL.
- [ ] **Step 3: Implement `src/core/model.ts`** per Interfaces. Key name regex shared with dotenv (`^[A-Za-z_][A-Za-z0-9_.-]*$`). `selectEnv`/`selectAll` throw on unknown env. `removeKey` deletes from schema keys, selected, values, unregistered.
- [ ] **Step 4: Run** `pnpm test` → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(core): project model ops"` (add new files first).

---

### Task 3: Import and manual-edit diffs

**Files:**
- Create: `src/core/diff.ts`
- Test: `test/diff.test.ts`

**Interfaces:**
- Consumes: `Project`, `resolve`, `addKey`, `setKeyValues`, `defaultEnv` (Task 2).
- Produces:
  ```ts
  export interface Change { key: string; env: string; before: string | undefined; after: string | undefined; isNew: boolean }
  export function importDiff(p: Project, env: string, incoming: Map<string, string>): { project: Project; conflicts: Change[] };
  export function manualDiff(p: Project, actual: Map<string, string>): Change[];
  export function applyChanges(p: Project, accepted: Change[]): Project;
  ```
  `importDiff` returns the project with **new keys already added** (unregistered, value in `env`, selected = `env`) and same-value keys untouched; `conflicts` are only keys with a different existing value in `env`.
  `manualDiff` compares `actual` against `resolve(p).values` for schema keys (`env` = key's selected env): changed value → `after` = new value; key in schema with a resolved value but absent from `actual` → `after: undefined`; key in `actual` not in schema → `isNew: true`, `env = defaultEnv(p)`. Keys listed in `resolve(p).missing` and absent from `actual` are not changes.
  `applyChanges`: `isNew` → `addKey(..., unregistered=true)`; `after === undefined` → remove that env's value; else set value for `env`.

- [ ] **Step 1: Write failing tests** in `test/diff.test.ts`

```ts
const base = () => addKey(addKey(emptyProject(), 'A', '1', 'dev'), 'B', '2', 'dev');
test('importDiff: new keys added flagged, same skipped, conflicts listed', () => {
  const { project, conflicts } = importDiff(base(), 'dev', new Map([['A', '1'], ['B', '9'], ['N', 'n']]));
  assert.deepEqual(project.values.unregistered, ['N']);
  assert.equal(project.values.values.N.dev, 'n');
  assert.equal(project.values.values.B.dev, '2');
  assert.deepEqual(conflicts, [{ key: 'B', env: 'dev', before: '2', after: '9', isNew: false }]);
});
test('importDiff into other env with no existing value is not a conflict', () => {
  const { project, conflicts } = importDiff(base(), 'qa', new Map([['A', 'q']]));
  assert.equal(conflicts.length, 0);
  assert.equal(project.values.values.A.qa, 'q');
});
test('manualDiff detects changed and new keys', () => {
  const changes = manualDiff(base(), new Map([['A', '1'], ['B', 'x'], ['N', 'n']]));
  assert.deepEqual(changes.map(c => [c.key, c.after, c.isNew]), [['B', 'x', false], ['N', 'n', true]]);
});
test('manualDiff detects removed key', () => {
  const changes = manualDiff(base(), new Map([['A', '1']]));
  assert.deepEqual(changes, [{ key: 'B', env: 'dev', before: '2', after: undefined, isNew: false }]);
});
test('applyChanges writes accepted values into the key env', () => {
  const p = applyChanges(base(), manualDiff(base(), new Map([['A', '1'], ['B', 'x']])));
  assert.equal(p.values.values.B.dev, 'x');
});
```

- [ ] **Step 2: Run** `pnpm test` → FAIL.
- [ ] **Step 3: Implement `src/core/diff.ts`** per Interfaces.
- [ ] **Step 4: Run** `pnpm test` → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(core): import and manual-edit diffs"`

---

### Task 4: Target rendering + self-write detection

**Files:**
- Create: `src/core/sync.ts`
- Test: `test/sync.test.ts`

**Interfaces:**
- Consumes: `parse`, `update` (Task 1); `Project`, `resolve` (Task 2).
- Produces:
  ```ts
  export function renderTarget(p: Project, current: string, mode: 'sync' | 'generate'): string;
  export class SelfWrites { mark(path: string, content: string): void; isSelfWrite(path: string, content: string): boolean }
  ```
  `sync`: update keys in `resolve(p).values`, append those not yet in the file; missing keys untouched (keep current file value). `generate`: same, plus every `missing` key not present in the file is appended as `KEY=`.
  `SelfWrites` stores the last content written per path; `isSelfWrite` is true when content equals it.

- [ ] **Step 1: Write failing tests** in `test/sync.test.ts`

```ts
const p = () => selectAll(setKeyValues(addKey(addKey(emptyProject(), 'A', 'd', 'dev'), 'B', 'b', 'dev'), 'A', { dev: 'd', qa: 'q' }), 'qa');
test('sync keeps current value for key missing in selected env', () => {
  assert.equal(renderTarget(p(), '# c\nA=d\nB=old\n', 'sync'), '# c\nA=q\nB=old\n');
});
test('generate appends missing keys as empty', () => {
  assert.equal(renderTarget(p(), '', 'generate'), 'A=q\nB=\n');
});
test('SelfWrites recognises own content only', () => {
  const s = new SelfWrites(); s.mark('/x/.env', 'A=1\n');
  assert.equal(s.isSelfWrite('/x/.env', 'A=1\n'), true);
  assert.equal(s.isSelfWrite('/x/.env', 'A=2\n'), false);
});
```

- [ ] **Step 2: Run** `pnpm test` → FAIL.
- [ ] **Step 3: Implement `src/core/sync.ts`.**
- [ ] **Step 4: Run** `pnpm test` → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(core): render target and self-write tracking"`

---

### Task 5: Project files on disk

**Files:**
- Create: `src/project.ts`
- Test: `test/project.test.ts` (uses `fs.mkdtemp` temp dirs)

**Interfaces:**
- Consumes: `Project`, `emptyProject`, `validate` (Task 2).
- Produces (Node `fs/promises` + `child_process.execFile` only, **no `vscode` import**, so it is testable):
  ```ts
  export type LoadResult = { status: 'ok'; project: Project } | { status: 'missing' } | { status: 'invalid'; file: string; message: string };
  export function load(root: string): Promise<LoadResult>;        // values.json missing but schema ok → empty values
  export function save(root: string, p: Project): Promise<void>;  // writes both JSON files, 2-space indent, trailing newline
  export function init(root: string, p?: Project): Promise<Project>; // creates .syncstage/, saves, ensures gitignore entry
  export function ensureGitignore(root: string): Promise<void>;   // appends ".syncstage/values.json" once; creates file if absent
  export function isTrackedByGit(root: string, relPath: string): Promise<boolean>; // false when git missing / not a repo
  export function readTarget(root: string, p: Project): Promise<string>; // '' when absent
  ```

- [ ] **Step 1: Write failing tests**

```ts
test('init creates files and gitignore entry once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ss-'));
  await writeFile(join(dir, '.gitignore'), 'node_modules\n');
  await init(dir); await ensureGitignore(dir);
  assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), 'node_modules\n.syncstage/values.json\n');
  assert.equal((await load(dir)).status, 'ok');
});
test('schema.json never contains values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ss-'));
  await init(dir, addKey(emptyProject(), 'SECRET', 's3cr3t', 'dev'));
  assert.ok(!(await readFile(join(dir, '.syncstage/schema.json'), 'utf8')).includes('s3cr3t'));
});
test('load reports missing and invalid without throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ss-'));
  assert.equal((await load(dir)).status, 'missing');
  await mkdir(join(dir, '.syncstage')); await writeFile(join(dir, '.syncstage/schema.json'), '{bad');
  const r = await load(dir);
  assert.equal(r.status, 'invalid');
  assert.match((r as any).file, /schema\.json$/);
});
test('isTrackedByGit false outside a repo', async () => {
  assert.equal(await isTrackedByGit(await mkdtemp(join(tmpdir(), 'ss-')), '.env'), false);
});
```

- [ ] **Step 2: Run** `pnpm test` → FAIL.
- [ ] **Step 3: Implement `src/project.ts`.** `ensureGitignore` matches existing line exactly (trimmed) and adds a leading newline if the file doesn't end with one. `isTrackedByGit`: `execFile('git', ['ls-files', '--error-unmatch', relPath], { cwd: root })`, resolve true on exit 0, false on any error.
- [ ] **Step 4: Run** `pnpm test` → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: project file storage, gitignore and git check"`

---

### Task 6: Extension shell (commands, sync, watcher, l10n, status bar)

**Files:**
- Create: `src/extension.ts`, `src/panel.ts` (host only; UI in Task 7), `src/core/protocol.ts`, `package.nls.json`, `package.nls.pt-br.json`, `l10n/bundle.l10n.pt-br.json`
- Modify: `package.json` (`contributes`)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces the webview message protocol used by Task 7 (in `src/core/protocol.ts`, types only, imports `Project` from `./model` and `Change` from `./diff`):
  ```ts
  export interface ProjectView {
    name: string; root: string;
    status: 'ok' | 'missing' | 'invalid'; error?: string;
    project?: Project; missing: string[];               // missing from resolve()
    pending?: { kind: 'import' | 'manual'; changes: Change[] };
  }
  export type ToWebview = { type: 'state'; projects: ProjectView[]; strings: Record<string, string> };
  export type FromWebview =
    | { type: 'ready' }
    | { type: 'init' | 'import' | 'generate' | 'addEnv'; root: string }
    | { type: 'renameEnv' | 'removeEnv'; root: string; env: string }
    | { type: 'select'; root: string; key: string; env: string }
    | { type: 'selectAll'; root: string; env: string }
    | { type: 'saveKey'; root: string; key: string; values: Record<string, string> }
    | { type: 'addKey'; root: string; key: string; value: string; env: string }
    | { type: 'removeKey'; root: string; key: string }
    | { type: 'resolve'; root: string; accepted: string[] };   // keys accepted from pending; others rejected
  ```

Behavior decisions for this task:
- Projects = `vscode.workspace.workspaceFolders`; refresh on `onDidChangeWorkspaceFolders`.
- Every mutating message: apply core op → `save` → if target content changes, write target via `renderTarget(...,'sync')` → `SelfWrites.mark` → post new state. Errors from core ops → `showErrorMessage(err.message)`.
- Before the **first target write per project per session** and in `init`: if `isTrackedByGit(root, target)` → modal warning (`"{0} is tracked by git — secret values would be committed. Continue?"`, buttons Continue / Change target). Change target → `showInputBox` (default `.env.local`) and save to schema. Cancel → no write.
- `addEnv`/`renameEnv` prompt with `showInputBox`; `removeEnv`/`removeKey` confirm with modal `showWarningMessage`.
- `import`: `showOpenDialog` (single file) → `showQuickPick(environments)` → `importDiff`; save project; conflicts non-empty → set `pending` (kind `import`), else sync.
- `generate`: `renderTarget(...,'generate')` and write.
- `init`: `init(root)`; if target exists, ask (modal) "Import existing {0} as {1}?" with env quick pick → same path as import.
- Watcher: one `createFileSystemWatcher(new RelativePattern(folder, target))` per project; on change/create, read file; ignore if `isSelfWrite`; else `manualDiff`; non-empty → set `pending` (kind `manual`) and `showInformationMessage(l10n.t('{0} changed outside syncstage — {1} keys', target, n), 'Review')` → Review opens the panel. Also watch `.syncstage/*.json` to reload state.
- `resolve`: `applyChanges(p, accepted)`; save; then **always** sync target (rejected manual changes are restored immediately); clear `pending`.
- Commands: `syncstage.openPanel` (title `%command.openPanel%` → en "syncstage: Open panel", pt-BR "syncstage: Abrir painel").
- Status bar (left): `$(layers) {defaultEnv}` of the project owning the active editor (fallback first ok project, else `$(layers) syncstage`), command `syncstage.openPanel`.
- Strings: all extension-side text via `vscode.l10n.t`; the webview strings object is built in `panel.ts` from `l10n.t` calls on a fixed list of en source strings (Task 7 lists them). pt-BR translations of every string go in `l10n/bundle.l10n.pt-br.json`, including the fixed copy from Global Constraints.

- [ ] **Step 1: Implement `src/extension.ts`, `src/panel.ts`, manifest `contributes`, nls/l10n files** per the decisions above. Panel HTML: CSP `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'`, loads `media/panel.css` and `out/web/webview/main.js` as `<script type="module">`; single panel instance (`reveal` if open).
- [ ] **Step 2: Run** `pnpm build && pnpm test` → compiles, all tests PASS.
- [ ] **Step 3: Smoke in Extension Development Host** (`code --extensionDevelopmentPath=$PWD <tmp workspace with 2 folders>`): command palette lists "syncstage: Open panel"; with VS Code display language pt-BR it reads "syncstage: Abrir painel".
- [ ] **Step 4: Commit** `git add -A && git commit -m "feat: extension shell, sync, watcher, l10n"`

---

### Task 7: Webview UI (option B)

**Files:**
- Create: `tsconfig.webview.json` (`lib ["ES2022","DOM"]`, `module "ES2022"`, `rootDir "src"`, `outDir "out/web"`, `include ["src/webview"]`), `src/webview/main.ts`, `media/panel.css`

**Interfaces:**
- Consumes: `ToWebview` / `FromWebview` / `ProjectView` from `src/core/protocol.ts` (Task 6) via `import type` only. Get the API with `acquireVsCodeApi()` (declare it in `main.ts`).

Layout (matches mockup option B):
- Inner tabs, one per `ProjectView` (single tab when one folder). Remember active tab via `vscode.setState`.
- `status: 'missing'` → centered button "Initialize syncstage"; `'invalid'` → error text with file path, no table.
- Header: "All keys →" env `<select>` (posts `selectAll`), buttons "Import .env", "Generate .env", "+ Environment", and per-env rename/remove (small menu or buttons next to env names), eye toggle "Show values".
- Table columns: Key | Value | Environment | ✎.
  - Value is read-only text of the selected env value, masked (`••••••`) unless eye toggle on; ⚠ "not registered" badge for `unregistered`; "missing in {env}" badge for keys in `missing`.
  - Environment `<select>` → posts `select`.
  - ✎ → row expands to one labeled input per environment (type `password` unless eye on) + Save (posts `saveKey`) / Cancel / Delete key (posts `removeKey`).
- Last row: key input, value input, env select, ＋ (posts `addKey`; client-side ignore empty key).
- `pending` present → banner above table listing changes: key, env, before × after (`(removed)` / `(new)` labels), checkbox per row (default checked for import new-value, checked for manual), buttons Apply (posts `resolve` with checked keys) / Discard all (posts `resolve` with `[]`).
- Styling uses `--vscode-*` variables only; env badge colors not required.

Webview strings (en source → also in pt-BR bundle): "All keys →", "Import .env", "Generate .env", "Environment", "Key", "Value", "Initialize syncstage", "not registered", "missing in {0}", "Show values", "Save", "Cancel", "Delete key", "new key", "value", "Apply", "Discard all", "(removed)", "(new)", "Changes to review".

- [ ] **Step 1: Implement** `tsconfig.webview.json`, `src/webview/main.ts`, `media/panel.css`. Render = full re-render on each `state` message (state is small); post `ready` on load.
- [ ] **Step 2: Run** `pnpm build` → no errors.
- [ ] **Step 3: Manual check in Extension Development Host** with a 2-folder workspace (one with `.env`, one without):
  1. Folder without `.syncstage` shows "Initialize syncstage"; init offers to import existing `.env`; `.gitignore` gains `.syncstage/values.json`.
  2. Change one key's env combo → `.env` line updates, other lines/comments untouched, no "changed outside" notification.
  3. ✎ fill qa/main for a key → `.env` unchanged when active env value unchanged; ⚠ cleared.
  4. "All keys → qa" → every key with a qa value switches; keys without keep their value and show "missing in qa".
  5. Edit `.env` by hand (change one value, add one key, delete one key) → notification with count 3 → panel banner → reject one → `.env` restored for that key immediately.
  6. Import a `.env` with one conflicting value → conflict banner, choose per key.
  7. Delete `.env`, Generate → file recreated with all keys, missing as `KEY=`.
  8. Make `.env` tracked by git in a repo → first write shows the warning.
  9. Display language pt-BR → panel texts in Portuguese.
- [ ] **Step 4: Commit** `git add -A && git commit -m "feat: webview panel"`

---

### Task 8: Package `.vsix`

**Files:**
- Create: `README.md` (what it does, `.syncstage/` files, gitignore note, install from `.vsix`), `LICENSE` (MIT), `.vscodeignore` final (`src/**`, `test/**`, `out/test/**`, `docs/**`, `tsconfig*.json`, `**/*.map`, `node_modules/**`)
- Modify: `package.json` (`repository`, `license`, `categories: ["Other"]`, `displayName`, `description`)

- [ ] **Step 1: Run** `pnpm package` → produces `syncstage-0.1.0.vsix` without warnings that block packaging.
- [ ] **Step 2: Verify contents** `unzip -l syncstage-0.1.0.vsix` → contains `extension/out/src/extension.js`, `extension/out/web/webview/main.js`, `extension/media/panel.css`, `extension/l10n/bundle.l10n.pt-br.json`, `extension/package.nls.pt-br.json`; no `src/`, `test/`, `docs/`.
- [ ] **Step 3: Install** `code --install-extension syncstage-0.1.0.vsix` (and Antigravity's CLI equivalent if available) → panel opens in a real window.
- [ ] **Step 4: Commit** `git add -A && git commit -m "chore: packaging and README"`

---

Out of this plan (later): Marketplace/Open VSX publish (check name availability first), git branch switching.
