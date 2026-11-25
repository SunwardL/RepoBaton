import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import { git } from './git.ts';

export interface RepoIdentity {
  /** Canonical key: real path of the common .git directory, lowercased on Windows. */
  key: string;
  /** Real path of the common git dir. */
  gitDir: string;
  /** Real path of the main working tree (parent of a non-bare common dir). */
  root: string;
}

export interface ProjectIdentity extends RepoIdentity {
  isGit: boolean;
  /** Stable while a normal directory is initialized as a Git repository. */
  slotKey: string;
}

/** Identify a Git repository or an existing ordinary project directory. */
export async function identifyProject(dir: string): Promise<ProjectIdentity> {
  const root = realPath(dir);
  const stat = await fs.stat(root).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(`project directory not found: ${dir}`);
  try {
    const repo = await identifyRepo(root);
    return { ...repo, isGit: true, slotKey: comparablePath(repo.root) };
  } catch (error) {
    if (!(error instanceof NotAGitRepoError)) throw error;
    // Do not silently treat a Git checkout as an ordinary directory when Git itself failed
    // (for example, because the executable is missing or the repository is untrusted).
    let parent = root;
    for (;;) {
      const marker = await fs.lstat(path.join(parent, '.git')).then(() => true).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
        throw err;
      });
      if (marker) throw new Error(`cannot identify the Git repository containing ${dir}`);
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    return { key: `folder:${comparablePath(root)}`, root, gitDir: '', isGit: false, slotKey: comparablePath(root) };
  }
}

/** True for Windows, where paths compare case-insensitively. */
const CASE_INSENSITIVE = process.platform === 'win32';

/** Resolve symlinks, junctions, 8.3 short names and drive-letter/folder casing to what is on disk. */
export function realPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

export function comparablePath(p: string): string {
  const real = realPath(p);
  return CASE_INSENSITIVE ? real.toLowerCase() : real;
}

export class NotAGitRepoError extends Error {
  constructor(dir: string) {
    super(`not a git repository: ${dir}`);
    this.name = 'NotAGitRepoError';
  }
}

/**
 * Identify the repository that contains `dir`.
 *
 * `git rev-parse --git-common-dir` is the same for the main checkout, every
 * subdirectory and every linked worktree, so all of them share one identity.
 * Git prints it relative to the working directory (".git", "../../.git"), so
 * it is resolved against `dir` before the real path is taken.
 */
export async function identifyRepo(dir: string): Promise<RepoIdentity> {
  const start = realPath(dir);
  let out: string;
  try {
    await fs.access(start);
    out = (await git(start, ['rev-parse', '--git-common-dir'])).trim();
  } catch {
    throw new NotAGitRepoError(dir);
  }
  if (!out) throw new NotAGitRepoError(dir);
  const gitDir = realPath(path.resolve(start, out));
  const bare = (await git(start, ['rev-parse', '--is-bare-repository'], { allowFail: true })).trim() === 'true';
  const root = bare ? gitDir : path.dirname(gitDir);
  return { key: CASE_INSENSITIVE ? gitDir.toLowerCase() : gitDir, gitDir, root };
}
