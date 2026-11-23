import { promises as fs } from 'node:fs';
import path from 'node:path';

export const nowIso = (): string => new Date().toISOString();
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export async function readJson<T>(p: string): Promise<T> {
  // A reader can catch the file mid-replace (Windows) or momentarily empty; retry briefly.
  let lastErr: unknown;
  for (let i = 0; i < 8; i++) {
    try {
      return JSON.parse(await fs.readFile(p, 'utf8')) as T;
    } catch (e) {
      lastErr = e;
      const code = (e as NodeJS.ErrnoException).code;
      const transient = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || e instanceof SyntaxError;
      if (!transient) throw e;
      await new Promise((r) => setTimeout(r, 10 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * Atomic write so a crash never leaves a half-written state file.
 * On Windows, rename onto a file that another process or request has open fails
 * with EPERM/EBUSY/EACCES; that is transient, so retry a few times.
 */
export async function writeFileAtomic(p: string, content: string, mode?: number): Promise<void> {
  await ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, content, { encoding: 'utf8', mode });
  let lastErr: unknown;
  for (let i = 0; i < 12; i++) {
    try {
      await fs.rename(tmp, p);
      return;
    } catch (e) {
      lastErr = e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') break;
      await new Promise((r) => setTimeout(r, 15 * (i + 1)));
    }
  }
  await fs.rm(tmp, { force: true }).catch(() => undefined);
  throw lastErr;
}

export async function writeJson(p: string, value: unknown): Promise<void> {
  await writeFileAtomic(p, JSON.stringify(value, null, 2) + '\n');
}

export function slugify(text: string, max = 32): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'task';
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... [truncated ${text.length - max} chars]`;
}

export function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `[... ${text.length - max} chars omitted]\n` + text.slice(text.length - max);
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

/** Tiny {{var}} template renderer. Unknown variables render as empty text. */
export function renderTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k: string) =>
    k in vars ? String(vars[k]) : '',
  );
}

/** Pull a JSON value out of free-form model text (plain, fenced, or embedded). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  for (let i = 0; i < trimmed.length; i++) {
    const open = trimmed[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < trimmed.length; j++) {
      const c = trimmed[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(i, j + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error('no JSON value found in model output');
}

type Schema = Record<string, any>;

/** Minimal JSON-schema validator (type/enum/required/properties/items/additionalProperties). */
export function validateSchema(schema: Schema, value: unknown, at = '$'): string[] {
  const errs: string[] = [];
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null;
  if (types) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const ok = types.some((t: string) =>
      t === 'integer' ? typeof value === 'number' && Number.isInteger(value) : t === actual,
    );
    if (!ok) return [`${at}: expected ${types.join('|')}, got ${actual}`];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errs.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const k of schema.required ?? []) {
      if (!(k in obj)) errs.push(`${at}.${k}: missing`);
    }
    const props: Schema = schema.properties ?? {};
    for (const [k, sub] of Object.entries(props)) {
      if (k in obj) errs.push(...validateSchema(sub as Schema, obj[k], `${at}.${k}`));
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(obj)) if (!(k in props)) errs.push(`${at}.${k}: unexpected`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => errs.push(...validateSchema(schema.items, v, `${at}[${i}]`)));
  }
  return errs;
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
