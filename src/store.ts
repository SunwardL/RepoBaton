import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RunState } from './types.ts';
import { ensureDir, exists, nowIso, readJson, writeFileAtomic, writeJson } from './util.ts';

export const STATE_DIR = '.repobaton';

export function newRunId(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export class RunStore {
  readonly root: string;
  constructor(repo: string) {
    this.root = path.join(repo, STATE_DIR, 'runs');
  }
  dir(id: string): string {
    return path.join(this.root, id);
  }
  async save(state: RunState): Promise<void> {
    state.updatedAt = nowIso();
    await writeJson(path.join(this.dir(state.id), 'state.json'), state);
  }
  async load(id: string): Promise<RunState> {
    const file = path.join(this.dir(id), 'state.json');
    if (!(await exists(file))) throw new Error(`run not found: ${id}`);
    return readJson<RunState>(file);
  }
  async list(): Promise<RunState[]> {
    if (!(await exists(this.root))) return [];
    const out: RunState[] = [];
    for (const id of await fs.readdir(this.root)) {
      try {
        out.push(await this.load(id));
      } catch {
        /* skip unreadable run */
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  /** Accepts a full id, a unique prefix, or "last". */
  async resolve(idOrPrefix: string): Promise<string> {
    const runs = await this.list();
    if (idOrPrefix === 'last' || idOrPrefix === 'latest') {
      if (!runs.length) throw new Error('no runs yet');
      return runs[0].id;
    }
    const hits = runs.filter((r) => r.id === idOrPrefix || r.id.startsWith(idOrPrefix));
    if (hits.length === 1) return hits[0].id;
    if (hits.length === 0) throw new Error(`run not found: ${idOrPrefix}`);
    throw new Error(`ambiguous run id "${idOrPrefix}": ${hits.map((h) => h.id).join(', ')}`);
  }
  async artifact(id: string, name: string, content: string): Promise<string> {
    const file = path.join(this.dir(id), 'artifacts', name);
    await ensureDir(path.dirname(file));
    await writeFileAtomic(file, content);
    return file;
  }
}
