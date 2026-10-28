import type { FromWebview, ProjectView, ToWebview } from '../core/protocol';

declare function acquireVsCodeApi(): {
  postMessage(m: FromWebview): void;
  getState(): { tab?: string; eye?: boolean } | undefined;
  setState(s: { tab?: string; eye?: boolean }): void;
};

const vscode = acquireVsCodeApi();
const app = document.getElementById('app') as HTMLElement;

let projects: ProjectView[] = [];
let strings: Record<string, string> = {};
let tab = vscode.getState()?.tab;
let eye = vscode.getState()?.eye ?? false;
const editing = new Set<string>(); // `${root}\0${key}`
const unchecked = new Set<string>(); // pending rows the user unticked, `${root}\0${key}`

const t = (s: string): string => strings[s] ?? s;
const send = (m: FromWebview): void => vscode.postMessage(m);
const save = (): void => vscode.setState({ tab, eye });
const MASK = '••••••';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
function envSelect(envs: string[], current: string | undefined, onChange?: (env: string) => void): HTMLSelectElement {
  const s = el('select');
  for (const e of envs) {
    const o = el('option', undefined, e);
    o.value = e;
    s.append(o);
  }
  if (current !== undefined) s.value = current;
  if (onChange) s.addEventListener('change', () => onChange(s.value));
  return s;
}
const field = <T extends HTMLElement>(e: T): T => { e.classList.add('field'); return e; };
const show = (v: string | undefined): string => (v === undefined ? '' : eye ? v : MASK);

// Re-render replaces the DOM; carry over an in-progress edit (value, focus, caret) of the focused
// inline input, matched by its data-ss id. `rendering` mutes blur handlers fired by the teardown.
let rendering = false;
function render(): void {
  const f = document.activeElement;
  const kept = f instanceof HTMLInputElement && f.dataset.ss
    ? { id: f.dataset.ss, value: f.value !== f.defaultValue ? f.value : undefined, a: f.selectionStart, b: f.selectionEnd } : undefined;
  rendering = true;
  app.replaceChildren();
  if (projects.length) {
    if (!projects.some((p) => p.root === tab)) tab = projects[0].root;
    const active = projects.find((p) => p.root === tab) as ProjectView;
    app.append(renderPicker(active), renderProject(active));
  }
  if (kept) {
    const n = Array.from(app.querySelectorAll('input')).find((i) => i.dataset.ss === kept.id);
    if (n) {
      if (kept.value !== undefined) n.value = kept.value; // only user-typed text; never a stale untouched value
      n.focus();
      try { n.setSelectionRange(kept.a, kept.b); } catch { /* input type without selection */ }
    }
  }
  rendering = false;
}

function renderPicker(active: ProjectView): HTMLElement {
  const wrap = el('div', 'picker');
  const input = field(el('input'));
  input.type = 'text';
  input.setAttribute('list', 'ss-projects');
  input.placeholder = t('Search project');
  input.dataset.ss = 'picker';
  input.defaultValue = active.name;
  input.value = active.name;
  const list = el('datalist');
  list.id = 'ss-projects';
  for (const p of [...projects].sort((a, b) => a.name.localeCompare(b.name))) {
    const o = el('option');
    o.value = p.name;
    list.append(o);
  }
  input.addEventListener('focus', () => input.select());
  input.addEventListener('change', () => {
    const hit = projects.find((p) => p.name === input.value);
    if (hit && hit.root !== tab) { tab = hit.root; save(); render(); }
  });
  input.addEventListener('blur', () => {
    if (!rendering && !projects.some((p) => p.name === input.value)) input.value = (projects.find((p) => p.root === tab) ?? active).name;
  });
  wrap.append(input, list);
  return wrap;
}

function renderProject(v: ProjectView): HTMLElement {
  const box = el('div', 'project');
  if (v.status === 'missing') {
    const c = el('div', 'center');
    c.append(button(t('Initialize syncstage'), () => send({ type: 'init', root: v.root }), 'primary'));
    box.append(c);
    return box;
  }
  if (v.status === 'invalid' || !v.project) {
    const err = el('div', 'error');
    err.append(el('div', undefined, v.error ?? ''), el('code', undefined, v.root));
    box.append(err);
    return box;
  }
  const p = v.project;
  const envs = p.schema.environments;
  box.append(renderHeader(v, envs));
  if (v.draft) box.append(el('div', 'banner', t('Loaded from {0} as {1} — not saved yet. Your first change creates .syncstage/.')
    .replace('{0}', p.schema.target).replace('{1}', envs[0])));
  if (v.pending?.changes.length) box.append(renderPending(v));

  const table = el('table');
  const head = el('tr');
  for (const h of ['Key', 'Value', 'Environment']) head.append(el('th', undefined, t(h)));
  head.append(el('th'));
  head.children[0].className = 'c-key';
  head.children[1].className = 'c-value';
  head.children[2].className = 'c-env';
  head.children[3].className = 'c-act';
  const thead = el('thead');
  thead.append(head);
  table.append(thead);
  const body = el('tbody');
  for (const key of p.schema.keys) {
    const sel = Object.hasOwn(p.values.selected, key) ? p.values.selected[key] : envs[0];
    const byEnv = Object.hasOwn(p.values.values, key) ? p.values.values[key] : {};
    body.append(renderRow(v, key, sel, byEnv, envs));
    if (editing.has(`${v.root}\0${key}`)) body.append(renderEditor(v, key, byEnv, envs));
  }
  body.append(renderAddRow(v, envs));
  table.append(body);
  box.append(table);
  return box;
}

function renderHeader(v: ProjectView, envs: string[]): HTMLElement {
  const h = el('div', 'header');
  const all = el('label', 'all', t('All keys →'));
  all.append(envSelect(envs, undefined, (env) => send({ type: 'selectAll', root: v.root, env })));
  // placeholder-less select: nothing chosen until the user picks
  (all.querySelector('select') as HTMLSelectElement).selectedIndex = -1;
  h.append(all);
  h.append(button(t('Import .env'), () => send({ type: 'import', root: v.root })));
  h.append(button(t('Generate .env'), () => send({ type: 'generate', root: v.root })));
  h.append(button(t('+ Environment'), () => send({ type: 'addEnv', root: v.root })));

  const eyeLabel = el('label', 'eye');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = eye;
  cb.addEventListener('change', () => { eye = cb.checked; save(); render(); });
  eyeLabel.append(cb, document.createTextNode(' ' + t('Show values')));
  h.append(eyeLabel);

  const list = el('div', 'envs');
  for (const env of envs) {
    const chip = el('span', 'env-chip');
    chip.append(el('span', 'env-name', env));
    chip.append(button(t('Rename'), () => send({ type: 'renameEnv', root: v.root, env }), 'small'));
    chip.append(button(t('Remove'), () => send({ type: 'removeEnv', root: v.root, env }), 'small'));
    list.append(chip);
  }
  h.append(list);
  return h;
}

function renderPending(v: ProjectView): HTMLElement {
  const pending = v.pending!;
  const box = el('div', 'banner');
  box.append(el('div', 'banner-title', t('Changes to review')));
  const rows: { key: string; cb: HTMLInputElement }[] = [];
  for (const c of pending.changes) {
    const row = el('label', 'change');
    const cb = el('input');
    cb.type = 'checkbox';
    const id = `${v.root}\0${c.key}`;
    cb.checked = !unchecked.has(id);
    cb.addEventListener('change', () => { if (cb.checked) unchecked.delete(id); else unchecked.add(id); });
    rows.push({ key: c.key, cb });
    const before = c.isNew || c.before === undefined ? t('(new)') : show(c.before);
    const after = c.after === undefined ? t('(removed)') : show(c.after);
    row.append(cb, el('code', 'change-key', c.key), el('span', 'change-env', c.env),
      el('span', 'change-before', before), document.createTextNode(' × '), el('span', 'change-after', after));
    box.append(row);
  }
  const actions = el('div', 'actions');
  actions.append(button(t('Apply'), () => {
    for (const r of rows) unchecked.delete(`${v.root}\0${r.key}`);
    send({ type: 'resolve', root: v.root, accepted: rows.filter((r) => r.cb.checked).map((r) => r.key) });
  }, 'primary'));
  actions.append(button(t('Discard all'), () => {
    for (const r of rows) unchecked.delete(`${v.root}\0${r.key}`);
    send({ type: 'resolve', root: v.root, accepted: [] });
  }));
  box.append(actions);
  return box;
}

function renderRow(v: ProjectView, key: string, sel: string, byEnv: Record<string, string>, envs: string[]): HTMLElement {
  const tr = el('tr');
  tr.append(el('td', 'key', key));
  const val = el('td', 'value');
  const wrap = el('div', 'value-wrap');
  let old = Object.hasOwn(byEnv, sel) ? byEnv[sel] : '';
  const input = field(el('input'));
  input.type = eye ? 'text' : 'password';
  input.defaultValue = old;
  input.value = old;
  input.dataset.ss = `value\0${v.root}\0${key}\0${sel}`;
  const commit = (): void => {
    if (rendering || input.value === old) return;
    if (input.value === '' && old !== '') { input.value = old; return; } // clearing lives in the editor
    old = input.value;
    input.defaultValue = old;
    send({ type: 'saveKey', root: v.root, key, values: { [sel]: old } });
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') input.value = old;
  });
  input.addEventListener('blur', commit);
  wrap.append(input);
  if (v.project!.values.unregistered.includes(key)) wrap.append(el('span', 'badge warn', '⚠ ' + t('not registered')));
  if (v.missing.includes(key)) wrap.append(el('span', 'badge', t('missing in {0}').replace('{0}', sel)));
  val.append(wrap);
  tr.append(val);
  const envTd = el('td');
  envTd.append(field(envSelect(envs, sel, (env) => send({ type: 'select', root: v.root, key, env }))));
  tr.append(envTd);
  const id = `${v.root}\0${key}`;
  const edit = el('td');
  edit.append(button('✎', () => { if (editing.has(id)) editing.delete(id); else editing.add(id); render(); }, 'icon'));
  tr.append(edit);
  return tr;
}

function renderEditor(v: ProjectView, key: string, byEnv: Record<string, string>, envs: string[]): HTMLElement {
  const id = `${v.root}\0${key}`;
  const tr = el('tr', 'editor');
  const td = el('td');
  td.colSpan = 4;
  const inputs = new Map<string, HTMLInputElement>();
  for (const env of envs) {
    const label = el('label', 'editor-field', env);
    const input = field(el('input'));
    input.type = eye ? 'text' : 'password';
    input.value = Object.hasOwn(byEnv, env) ? byEnv[env] : '';
    inputs.set(env, input);
    label.append(input);
    td.append(label);
  }
  const actions = el('div', 'actions');
  actions.append(button(t('Save'), () => {
    const values: Record<string, string> = {};
    for (const [env, i] of inputs) values[env] = i.value;
    editing.delete(id);
    send({ type: 'saveKey', root: v.root, key, values });
  }, 'primary'));
  actions.append(button(t('Cancel'), () => { editing.delete(id); render(); }));
  actions.append(button(t('Delete key'), () => { editing.delete(id); send({ type: 'removeKey', root: v.root, key }); }, 'danger'));
  td.append(actions);
  tr.append(td);
  return tr;
}

function renderAddRow(v: ProjectView, envs: string[]): HTMLElement {
  const tr = el('tr', 'add');
  const k = field(el('input'));
  k.placeholder = t('new key');
  const val = field(el('input'));
  val.placeholder = t('value');
  val.type = eye ? 'text' : 'password';
  const env = field(envSelect(envs, envs[0]));
  const add = (): void => {
    const key = k.value.trim();
    if (!key) return;
    send({ type: 'addKey', root: v.root, key, value: val.value, env: env.value });
  };
  for (const i of [k, val]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  const cell = (n: Node): HTMLElement => { const td = el('td'); td.append(n); return td; };
  tr.append(cell(k), cell(val), cell(env), cell(button('＋', add, 'icon')));
  return tr;
}

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  if (e.data.type !== 'state') return;
  projects = e.data.projects;
  strings = e.data.strings;
  render();
});
send({ type: 'ready' });
