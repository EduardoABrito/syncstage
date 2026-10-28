# syncstage

VS Code extension that keeps per-project `.env` values for each environment (dev, staging, prod…) and writes the selected one to your target file. No runtime dependencies.

## What it does

- Define environments and keys per project in a panel (command: `syncstage: Open panel`).
- Pick the active environment; the target file is rewritten immediately with every schema key set to that environment's value.
- Activates automatically when the workspace contains `.syncstage/schema.json`.

## Files in `.syncstage/`

| File | Git | Content |
|---|---|---|
| `schema.json` | committed | environments, keys, target file name. **No values.** |
| `values.json` | local only | the actual values. Auto-added to `.gitignore`. |

## Target file

The target defaults to `.env`; set it per project in `schema.json` (e.g. `.env.local` for Next.js).

> **Warning:** if the target file is tracked by git, its secrets would be committed. syncstage warns and asks before writing; consider switching the target to `.env.local`. It never edits `.gitignore` for the target itself.

## Install from .vsix

```bash
code --install-extension syncstage-0.1.0.vsix
```

Or: Extensions view → `…` menu → **Install from VSIX…**

## Build

```bash
pnpm install
pnpm build      # compile extension + webview
pnpm test       # compile + node --test
pnpm package    # build and produce syncstage-0.1.0.vsix
```

## License

MIT
