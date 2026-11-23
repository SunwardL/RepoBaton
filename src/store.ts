import { promises as fs } from 'node:fs';
import path from 'node:path';
import { redactDeep, redactDiagnostic } from './redact.ts';
import type { RunState } from './types.ts';
import { ensureDir, exists, nowIso, readJson, writeFileAtomic, writeJson } from './util.ts';

export const STATE_DIR = '.repobaton';

export function newRunId(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * One write queue per state file, shared by every RunStore in the process. Atomic rename makes a
 * single write complete, but says nothing about the order of two writes that overlap: an older
 * snapshot that is slow to publish could land after a newer one and move the run backwards. Writes
 * to the same file therefore run one after another, in the order they were requested.
 */
const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite(file: string, write: () => Promise<void>): Promise<void> {
  const key = path.resolve(file).toLowerCase();
  const previous = writeQueues.get(key) ?? Promise.resolve();
  // A failed write must not stop the ones behind it; its own caller still sees the failure.
  const run = previous.catch(() => undefined).then(write);
  const tail = run.catch(() => undefined);
  writeQueues.set(key, tail);
  void tail.then(() => {
    if (writeQueues.get(key) === tail) writeQueues.delete(key);
  });
  return run;
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
    // The snapshot is taken now, at the moment of the request, not when its turn in the queue comes.
    const snapshot = redactDeep(state, { assignments: true });
    const file = path.join(this.dir(state.id), 'state.json');
    await enqueueWrite(file, () => writeJson(file, snapshot));
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
    await writeFileAtomic(file, redactDiagnostic(content));
    return file;
  }
}
