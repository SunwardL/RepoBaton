import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { identifyRepo } from './repoid.ts';
import { exists, nowIso, readJson, writeJson } from './util.ts';

export interface ProjectEntry {
  /** Stable id derived from the repository identity. */
  id: string;
  name: string;
  /** Main working tree of the repository. */
  root: string;
  addedAt: string;
}

interface ProjectFile {
  version: 1;
  projects: Omit<ProjectEntry, 'id'>[];
}

/** Per-user config dir: %APPDATA%\repobaton on Windows, XDG/home elsewhere. */
export function userDataDir(): string {
  if (process.env.REPOBATON_HOME) return process.env.REPOBATON_HOME;
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'repobaton');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'repobaton');
}

export function idForKey(key: string): string {
  // Short, URL-safe, stable. Collisions are not a concern at the scale of one user's projects.
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(7, '0');
}

/** Small JSON file of the projects the user has opened. It never stores secrets. */
export class ProjectRegistry {
  private file: string;
  private writing: Promise<void> = Promise.resolve();

  constructor(file = path.join(userDataDir(), 'projects.json')) {
    this.file = file;
  }

  async list(): Promise<ProjectEntry[]> {
    if (!(await exists(this.file))) return [];
    let data: ProjectFile;
    try {
      data = await readJson<ProjectFile>(this.file);
    } catch {
      return [];
    }
    const out: ProjectEntry[] = [];
    const seen = new Set<string>();
    for (const p of data.projects ?? []) {
      if (!p?.root || typeof p.root !== 'string') continue;
      // Re-derive the identity: the folder may have moved, or been given a new casing.
      let key: string;
      try {
        key = (await identifyRepo(p.root)).key;
      } catch {
        // Keep entries whose folder is currently missing so the UI can show them as unavailable.
        key = `missing:${p.root.toLowerCase()}`;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: idForKey(key), name: p.name, root: p.root, addedAt: p.addedAt });
    }
    return out;
  }

  /** Add the repository containing `dir` (any subdirectory or linked worktree works). Idempotent. */
  async add(dir: string, name?: string): Promise<ProjectEntry> {
    const id = await identifyRepo(dir); // throws NotAGitRepoError
    return this.mutate(async (all) => {
      const existing = all.find((p) => p.id === idForKey(id.key));
      if (existing) return { next: all, result: existing };
      const entry: ProjectEntry = {
        id: idForKey(id.key),
        name: name?.trim() || path.basename(id.root),
        root: id.root,
        addedAt: nowIso(),
      };
      return { next: [...all, entry], result: entry };
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.mutate(async (all) => {
      const next = all.filter((p) => p.id !== id);
      return { next, result: next.length !== all.length };
    });
  }

  async get(id: string): Promise<ProjectEntry | undefined> {
    return (await this.list()).find((p) => p.id === id);
  }

  /** Read, change and write under one lock, so concurrent callers cannot overwrite each other. */
  private mutate<T>(fn: (all: ProjectEntry[]) => Promise<{ next: ProjectEntry[]; result: T }>): Promise<T> {
    const run = this.writing.then(async () => {
      const { next, result } = await fn(await this.list());
      const body: ProjectFile = { version: 1, projects: next.map(({ name, root, addedAt }) => ({ name, root, addedAt })) };
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await writeJson(this.file, body);
      return result;
    });
    this.writing = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
