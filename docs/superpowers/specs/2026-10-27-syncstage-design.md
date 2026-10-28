# syncstage — Design

Date: 2026-10-27
Status: draft, awaiting approval

## Intent / why

When working with many projects open in one VS Code workspace (e.g. a web front-end plus several APIs), switching their `.env` files between environments (dev / qa / main) is manual: open each `.env`, remember which URL/credential belongs to which environment, edit by hand. One forgotten file breaks the flow between services.

syncstage is a VS Code extension (also running on compatible forks: Antigravity, Cursor, etc.) that keeps, per project, the value of every env key in every environment, lets the user choose — **per key** — which environment each key points to, and keeps the real `.env` file synced automatically.

Future direction (not in v1): also switch git branches per project to match the stage. The name was chosen to fit that.

## Goals (v1)

1. Work in single-folder and multi-root workspaces; each workspace folder is an independent project.
2. Per project: register environments (create / rename / remove) and keys, with a value per key per environment.
3. Per key, choose which environment it points to. The same `.env` can mix environments (one key on qa, another on dev).
4. Bulk action: point all keys of a project to one environment at once.
5. Every change made in the extension rewrites the target `.env` immediately.
6. Import an existing `.env` file into an environment the user selects.
7. Generate the `.env` from the schema, filled with the currently selected values.
8. Detect manual edits to the `.env` and let the user confirm them key by key.
9. Ship as a local `.vsix` first; later publish to VS Code Marketplace and Open VSX.

## Non-goals (v1)

- Git branch switching (future).
- Sharing values between machines/teammates (values stay local; only the schema is shared).
- Encryption / secret vault integration.
- Workspace-wide "everything to qa" across all projects (bulk action is per project).
- Multiple target files per project.

## Anti-goals (failure even if it "works")

- Secret values ever landing in git. The values file must be gitignored automatically.
- Silently losing data: overwriting values, dropping lines from `.env`, or discarding a manual edit without the user seeing it.
- A UI that needs many clicks to flip one key.

## Files per project

All inside `.syncstage/` at the root of each workspace folder.

| File | Committed? | Content |
|---|---|---|
| `.syncstage/schema.json` | yes | environment list, key list, target file name. **No values.** |
| `.syncstage/values.json` | no — added to the project `.gitignore` automatically on creation | value of each key in each environment + currently selected environment per key |
| target `.env` | (project's own choice, normally ignored) | generated output |

Target file defaults to `.env`, configurable per project in `schema.json` (e.g. `.env.local` for Next.js). *(Claude's call.)*

Shapes below are a starting point; builder may adjust field names.

```jsonc
// .syncstage/schema.json
{
  "version": 1,
  "target": ".env",
  "environments": ["dev", "qa", "main"],
  "keys": ["API_URL", "KEYCLOAK_URL", "NEW_FLAG"]
}

// .syncstage/values.json
{
  "version": 1,
  "selected": { "API_URL": "qa", "KEYCLOAK_URL": "dev" },
  "values": {
    "API_URL": { "dev": "http://localhost:5002", "qa": "https://qa.api…", "main": "https://api…" },
    "KEYCLOAK_URL": { "dev": "http://localhost:8080" }
  },
  "unregistered": ["NEW_FLAG"]
}
```

## Behavior

### Switching
- Changing a key's environment in the UI → `.env` rewritten with that environment's value.
- "All keys → [env]" sets `selected` for every key of that project, then rewrites.
- Key with no value in the chosen environment: keeps its current `.env` value and is flagged in the UI as missing for that env. *(Claude's call — never blank a working value silently.)*

### Writing the `.env`
- Preserve lines syncstage doesn't manage (comments, keys not in schema, blank lines, ordering) — update managed keys in place, append new managed keys at the end. *(Claude's call.)*
- Quote values when needed (spaces, `#`, quotes, newlines) using standard dotenv rules.
- Writes made by syncstage itself must not trigger the manual-edit flow.

### Generate `.env` from schema
- Produces the target file with every schema key, using the value of its currently selected environment.
- Keys with no value → written as `KEY=` and shown as pending in the UI. *(Claude's call.)*
- Typical use: fresh clone / new machine has `schema.json` (committed) but no values; generate creates the file, user fills values in the panel.

### Import `.env` into an environment
- User picks a file and a target environment.
- Keys not in schema → added to schema, flagged **"não cadastrado"** (⚠) in the UI.
- Keys already present with the **same** value → nothing.
- Keys with a **different** value in that environment → shown as a diff list (current × imported), user chooses per key which wins. Never overwrite silently.
- The ⚠ flag clears when the user confirms the key in the UI / fills it for other environments. *(Claude's call on exact rule.)*

### Manual edits to `.env`
- File watcher detects external changes to the target file.
- Notification: "`.env` alterado fora do syncstage — N chaves". Opens a list: key → old value × new value (in the key's currently selected environment), with **confirm** / **discard** per key.
- Confirm → new value saved into the key's current environment.
- Discard → `.env` is rewritten immediately with the stored value. *(Claude's call.)*
- New key added by hand → same as import: added with ⚠ "não cadastrado". *(Claude's call.)*

### Missing / broken files
- Project with no `.syncstage/` → panel shows an "Inicializar syncstage" action (creates `schema.json`, `values.json`, gitignore entry; offers to import the existing `.env` as the first environment). *(Claude's call.)*
- Invalid JSON → show error with file path; do not overwrite the file.
- Target file tracked by git (`git ls-files --error-unmatch <target>` succeeds) → on init and on first write, warn that secrets would be committed and ask before continuing; suggest switching target to e.g. `.env.local`. Never edit `.gitignore` for the target automatically. If git is not available, skip the check. *(Claude's call.)*

## UI (chosen: option B — panel with table)

Opens as an editor tab (webview), via command palette ("syncstage: Abrir painel") and a status-bar item. *(Entry points are Claude's call.)*

- **One inner tab per workspace folder** (single tab for single-folder workspace).
- **Header:** "Todas as chaves → [env ▾]", buttons **Importar .env** and **Gerar .env**, plus environment management (add / rename / remove).
- **Table:** Key | Value (value of the selected env) | Environment (combo) | ✎ edit button.
  - Changing the combo = switch the key's active environment → shown value swaps and `.env` syncs.
  - ✎ opens edit mode on that row: **one input per environment** (dev / qa / main …), save/cancel. Saving only rewrites `.env` if the active environment's value changed. This is how values of non-active environments are filled (fresh clone, clearing ⚠).
- **Last row:** new key input + value input + env combo + ＋ button.
- ⚠ marker on unregistered keys; distinct marker on keys missing a value in the selected env.
- Diff dialogs (import conflicts, manual edits) list keys with old × new and per-key confirm/discard.
- Values may be secrets: display masked by default with a reveal toggle. *(Claude's call.)*

Mockup reference: `docs/superpowers/specs/2026-10-27-syncstage-mockup.html` (option B).

## Language

- UI in **en-US (default) and pt-BR** from the first commit: `vscode.l10n` + `package.nls.json` / `package.nls.pt-br.json` for the extension side, and the same bundle passed to the webview. Portuguese strings in this doc are the pt-BR copy.

## How it gets made (Claude's calls, user didn't object)

- TypeScript, standard VS Code Extension API only (works on Antigravity/Cursor/other forks).
- Webview with plain HTML/CSS/TS, no UI framework.
- No runtime dependencies unless clearly needed (dotenv parsing/writing is small enough to hand-write, but a well-known parser is acceptable).
- Repo: `/Volumes/Projects/Personal/syncstage`, standalone.
- Packaging with `@vscode/vsce` to `.vsix`; later `vsce publish` + `ovsx publish`. Check name availability on both registries before publishing.
- Tests: unit tests for the pure parts (dotenv parse/write preserving lines, import diff, manual-edit diff); the VS Code shell stays thin.

## Left to the builder

- Exact JSON field names and migration via `version`.
- Webview ↔ extension message protocol.
- Debounce/timing of file watcher and how self-writes are ignored.
- Test framework choice.
- Status-bar item content (e.g. dominant environment of the active project).
