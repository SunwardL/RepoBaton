import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runProcess } from './proc.ts';
import { ensureDir, exists } from './util.ts';

export class GitError extends Error {
  code: number | null;
  constructor(message: string, code: number | null) {
    super(message);
    this.name = 'GitError';
    this.code = code;
  }
}

export interface GitOptions {
  /** Do not throw on non-zero exit. */
  allowFail?: boolean;
  input?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  const r = await runProcess({
    command: 'git',
    args,
    cwd,
    input: opts.input,
    timeoutMs: opts.timeoutMs ?? 120_000,
    env: { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', LC_ALL: 'C', ...(opts.env ?? {}) },
  });
  if (r.error) throw new GitError(`cannot run git: ${r.error}`, null);
  if (r.code !== 0 && !opts.allowFail) {
    throw new GitError(`git ${args.join(' ')} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`, r.code);
  }
  return r.stdout;
}

export async function repoRoot(cwd: string): Promise<string> {
  const out = await git(cwd, ['rev-parse', '--show-toplevel']);
  return path.resolve(out.trim());
}

export async function currentBranch(cwd: string): Promise<string> {
  const out = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true });
  return out.trim();
}

export async function headSha(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim();
}

export async function revParse(cwd: string, rev: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--verify', `${rev}^{commit}`])).trim();
}

export async function hasCommits(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--verify', 'HEAD'], { allowFail: true });
  return r.trim().length > 0;
}

export async function isDirty(cwd: string): Promise<boolean> {
  const out = await git(cwd, ['status', '--porcelain', '--untracked-files=normal']);
  return out
    .split('\n')
    .filter(Boolean)
    .some((l) => !l.slice(3).startsWith('.repobaton'));
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true });
  return r.trim().length > 0;
}

export async function remoteUrl(cwd: string, remote: string): Promise<string | null> {
  const out = await git(cwd, ['remote', 'get-url', remote], { allowFail: true });
  return out.trim() || null;
}

/** Keep orchestrator state out of `git status` without touching the user's .gitignore. */
export async function excludeLocally(root: string, pattern: string): Promise<void> {
  const gitDir = (await git(root, ['rev-parse', '--git-common-dir'])).trim();
  const file = path.resolve(root, gitDir, 'info', 'exclude');
  await ensureDir(path.dirname(file));
  let text = '';
  if (await exists(file)) text = await fs.readFile(file, 'utf8');
  if (!text.split(/\r?\n/).includes(pattern)) {
    await fs.writeFile(file, text + (text && !text.endsWith('\n') ? '\n' : '') + pattern + '\n', 'utf8');
  }
}

export async function addWorktree(root: string, dir: string, branch: string, base: string): Promise<void> {
  await ensureDir(path.dirname(dir));
  if (await branchExists(root, branch)) {
    await git(root, ['worktree', 'add', dir, branch]);
  } else {
    await git(root, ['worktree', 'add', '-b', branch, dir, base]);
  }
}

export async function removeWorktree(root: string, dir: string): Promise<void> {
  await git(root, ['worktree', 'remove', '--force', dir], { allowFail: true });
  await git(root, ['worktree', 'prune'], { allowFail: true });
}

export interface CommitInfo {
  sha: string;
  created: boolean;
}

/** Stage everything and commit if there is anything to commit. */
export async function commitAll(
  cwd: string,
  message: string,
  opts: { noVerify?: boolean; name?: string; email?: string } = {},
): Promise<CommitInfo> {
  // Never commit dependency/cache directories that setup commands may have created.
  await git(cwd, [
    'add', '-A', '--', '.',
    ':(exclude,glob)**/node_modules/**',
    ':(exclude,glob)**/__pycache__/**',
    ':(exclude,glob)**/.venv/**',
    ':(exclude).repobaton',
  ]);
  const staged = await git(cwd, ['diff', '--cached', '--name-only']);
  if (!staged.trim()) return { sha: await headSha(cwd), created: false };
  const args: string[] = [];
  if (opts.name) args.push('-c', `user.name=${opts.name}`);
  if (opts.email) args.push('-c', `user.email=${opts.email}`);
  args.push('commit', '-q', '-F', '-');
  if (opts.noVerify) args.push('--no-verify');
  await git(cwd, args, { input: message });
  return { sha: await headSha(cwd), created: true };
}

export async function diffRange(cwd: string, base: string, head: string): Promise<string> {
  return git(cwd, ['diff', '--no-color', '--find-renames', `${base}...${head}`]);
}

export async function diffStat(cwd: string, base: string, head: string): Promise<string> {
  return git(cwd, ['diff', '--no-color', '--stat', `${base}...${head}`]);
}

export async function changedFiles(cwd: string, base: string, head: string): Promise<string[]> {
  const out = await git(cwd, ['diff', '--name-only', `${base}...${head}`]);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

export async function commitLog(cwd: string, base: string, head: string): Promise<string> {
  return git(cwd, ['log', '--no-color', '--format=%h %s', `${base}..${head}`]);
}

export async function latestTag(cwd: string): Promise<string> {
  const out = await git(cwd, ['describe', '--tags', '--abbrev=0'], { allowFail: true });
  return out.trim();
}

export async function tagExists(cwd: string, tag: string): Promise<boolean> {
  const out = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { allowFail: true });
  return out.trim().length > 0;
}

export async function push(cwd: string, remote: string, branch: string): Promise<void> {
  await git(cwd, ['push', '--set-upstream', remote, `${branch}:${branch}`], { timeoutMs: 300_000 });
}

export async function createTag(cwd: string, tag: string, sha: string, message: string): Promise<void> {
  await git(cwd, ['tag', '-a', tag, sha, '-m', message]);
}

export async function pushTag(cwd: string, remote: string, tag: string): Promise<void> {
  await git(cwd, ['push', remote, `refs/tags/${tag}`], { timeoutMs: 300_000 });
}

/** Best guess at the default branch: origin/HEAD, then main/master, then current. */
export async function guessBaseBranch(cwd: string): Promise<string> {
  const head = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true })).trim();
  if (head) return head.replace(/^origin\//, '');
  for (const b of ['main', 'master']) if (await branchExists(cwd, b)) return b;
  return (await currentBranch(cwd)) || 'main';
}

// ---- gh (GitHub CLI) ----

export async function ghAvailable(cwd: string): Promise<boolean> {
  const r = await runProcess({ command: 'gh', args: ['--version'], cwd, timeoutMs: 15_000 });
  return r.code === 0;
}

export async function ghCreatePr(
  cwd: string,
  o: { base: string; head: string; title: string; body: string; draft: boolean },
): Promise<string> {
  const args = ['pr', 'create', '--base', o.base, '--head', o.head, '--title', o.title, '--body-file', '-'];
  if (o.draft) args.push('--draft');
  const r = await runProcess({ command: 'gh', args, cwd, input: o.body, timeoutMs: 120_000 });
  if (r.code !== 0) {
    // An existing PR for the branch is fine: look it up instead of failing the run.
    const existing = await runProcess({
      command: 'gh',
      args: ['pr', 'view', o.head, '--json', 'url', '--jq', '.url'],
      cwd,
      timeoutMs: 30_000,
    });
    if (existing.code === 0 && existing.stdout.trim()) return existing.stdout.trim();
    throw new GitError(`gh pr create failed: ${(r.stderr || r.stdout).trim()}`, r.code);
  }
  const m = /https?:\/\/\S+/.exec(r.stdout);
  return m ? m[0] : r.stdout.trim();
}

export async function ghMergePr(cwd: string, pr: string, headSha: string): Promise<void> {
  // --match-head-commit refuses to merge if the branch moved after approval.
  const r = await runProcess({
    command: 'gh',
    args: ['pr', 'merge', pr, '--squash', '--delete-branch', '--match-head-commit', headSha],
    cwd,
    timeoutMs: 180_000,
  });
  if (r.code !== 0) throw new GitError(`gh pr merge failed: ${(r.stderr || r.stdout).trim()}`, r.code);
}

export async function ghMarkReady(cwd: string, pr: string): Promise<void> {
  await runProcess({ command: 'gh', args: ['pr', 'ready', pr], cwd, timeoutMs: 60_000 });
}

export async function ghMergeCommit(cwd: string, pr: string): Promise<string> {
  const r = await runProcess({
    command: 'gh',
    args: ['pr', 'view', pr, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid'],
    cwd,
    timeoutMs: 30_000,
  });
  return r.code === 0 ? r.stdout.trim() : '';
}

export async function fetchRemote(cwd: string, remote: string): Promise<void> {
  await git(cwd, ['fetch', remote, '--tags'], { timeoutMs: 300_000 });
}
