export type DotenvLine =
  | { kind: 'raw'; text: string }
  | { kind: 'entry'; key: string; value: string; text: string; exported: boolean };
export interface DotenvDoc { lines: DotenvLine[]; eol: '\n' | '\r\n' }

const KEY_RE = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;
const KEY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
export const isValidKey = (k: string): boolean => KEY_NAME_RE.test(k);
const BARE_RE = /^[A-Za-z0-9_./:@,+\-]*$/;
const UNESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

/** Reads a double-quoted value starting after the opening quote; returns null if unterminated. */
function readQuoted(rest: string): string | null {
  let out = '';
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '"') return out;
    if (c === '\\' && i + 1 < rest.length) {
      const n = rest[++i];
      out += UNESCAPES[n] ?? '\\' + n;
    } else out += c;
  }
  return null;
}

export function parse(text: string): DotenvDoc {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const src = text === '' ? [] : text.split(/\r?\n/);
  if (src.length && src[src.length - 1] === '') src.pop();
  const lines: DotenvLine[] = [];
  for (let i = 0; i < src.length; i++) {
    const m = KEY_RE.exec(src[i]);
    if (!m) { lines.push({ kind: 'raw', text: src[i] }); continue; }
    const [, exp, key, rawVal] = m;
    let value: string;
    let end = i;
    if (rawVal.startsWith('"')) {
      // accumulate following lines until the closing quote shows up
      let body = rawVal.slice(1);
      let v = readQuoted(body);
      while (v === null && end + 1 < src.length) {
        body += '\n' + src[++end];
        v = readQuoted(body);
      }
      if (v === null) { lines.push({ kind: 'raw', text: src[i] }); continue; }
      value = v;
    } else if (rawVal.startsWith("'")) {
      const close = rawVal.indexOf("'", 1);
      value = close < 0 ? rawVal.slice(1) : rawVal.slice(1, close);
    } else {
      const hash = rawVal.search(/\s#/);
      value = (hash < 0 ? rawVal : rawVal.slice(0, hash)).trim();
    }
    lines.push({ kind: 'entry', key, value, text: src.slice(i, end + 1).join(eol), exported: !!exp });
    i = end;
  }
  return { lines, eol };
}

export function toMap(doc: DotenvDoc): Map<string, string> {
  const map = new Map<string, string>();
  for (const l of doc.lines) if (l.kind === 'entry') map.set(l.key, l.value);
  return map;
}

export function formatValue(value: string): string {
  if (BARE_RE.test(value)) return value;
  const esc = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return `"${esc}"`;
}

export function update(doc: DotenvDoc, updates: Map<string, string>, appendMissing: boolean): string {
  const last = new Map<string, number>();
  doc.lines.forEach((l, i) => { if (l.kind === 'entry') last.set(l.key, i); });
  const out = doc.lines.map((l, i) => {
    if (l.kind === 'raw') return l.text;
    return last.get(l.key) === i && updates.has(l.key)
      ? `${l.exported ? 'export ' : ''}${l.key}=${formatValue(updates.get(l.key)!)}`
      : l.text;
  });
  if (appendMissing) for (const [k, v] of updates) if (!last.has(k)) out.push(`${k}=${formatValue(v)}`);
  return out.length ? out.join(doc.eol) + doc.eol : '';
}
