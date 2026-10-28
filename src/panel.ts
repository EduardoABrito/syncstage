import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { FromWebview, ProjectView, ToWebview } from './core/protocol';

const STRINGS = [
  'All keys →', '(mixed)', 'Export config', 'Import config', 'Import .env', 'Generate .env', 'Environment', 'Key', 'Value', 'Initialize syncstage',
  'not registered', 'missing in {0}', 'Show values', 'Save', 'Cancel', 'Delete key', 'new key', 'value',
  'Apply', 'Discard all', '(removed)', '(new)', 'Changes to review', '+ Environment', 'Rename', 'Remove', 'Search project', 'No projects found',
  'Loaded from {0} as {1} — not saved yet. Your first change creates .syncstage/.',
];

function strings(): Record<string, string> {
  const out: Record<string, string> = {};
  // the webview substitutes {0} itself, so keep the placeholder intact
  for (const s of STRINGS) out[s] = vscode.l10n.t(s, '{0}', '{1}');
  return out;
}

export class SyncPanel {
  private panel?: vscode.WebviewPanel;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly views: () => ProjectView[],
    private readonly handle: (m: FromWebview) => Promise<void>,
  ) {}

  show(): void {
    if (this.panel) { this.panel.reveal(); return; }
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    const web = vscode.Uri.joinPath(this.ctx.extensionUri, 'out', 'web');
    const panel = vscode.window.createWebviewPanel('syncstage', 'syncstage', vscode.ViewColumn.Active, {
      enableScripts: true, localResourceRoots: [media, web],
    });
    this.panel = panel;
    panel.webview.html = this.html(panel.webview, media, web);
    panel.webview.onDidReceiveMessage((m: FromWebview) => {
      const run = m.type === 'ready' ? Promise.resolve(this.post()) : this.handle(m);
      run.catch(e => vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e)));
    });
    panel.onDidDispose(() => { this.panel = undefined; });
  }

  post(): void {
    const msg: ToWebview = { type: 'state', projects: this.views(), strings: strings() };
    void this.panel?.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview, media: vscode.Uri, web: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(web, 'webview', 'main.js'));
    const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'`;
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${css}"></head>
<body><div id="app"></div><script type="module" nonce="${nonce}" src="${js}"></script></body></html>`;
  }
}
