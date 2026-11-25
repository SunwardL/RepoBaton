import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runProcess } from './proc.ts';
import { redactDiagnostic } from './redact.ts';
import { ensureDir, exists } from './util.ts';

export class GitError extends Error {
  code: number | null;
  constructor(message: string, code: number | null) {
    super(redactDiagnostic(message));
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
  // A killed process may or may not have finished its work: code null marks the outcome as unknown.
  if ((r.timedOut || r.aborted) && !opts.allowFail) throw new GitError(`git ${args[0]} ${r.timedOut ? 'timed out' : 'was cancelled'}; its outcome is unknown`, null);
  if (r.code !== 0 && !opts.allowFail) {
    throw new GitError(`git ${args.join(' ')} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`, r.code);
  }
  return r.stdout;
}

/** Do not start or automatically confirm a commit while another Git operation may own the index. */
export async function unfinishedGitOperation(cwd: string): Promise<string | undefined> {
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'index.lock']) {
    const markerPath = (await git(cwd, ['rev-parse', '--git-path', marker])).trim();
    if (!markerPath) throw new Error('cannot locate Git operation marker');
    const present = await fs.lstat(path.resolve(cwd, markerPath)).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (present) return marker;
  }
  return undefined;
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

/**
 * Every address `git push <remote>` writes to: pushurl when set, else url, with insteadOf and
 * pushInsteadOf applied. It can differ from the fetch address, and there can be several.
 */
export async function pushUrls(cwd: string, remote: string): Promise<string[]> {
  const out = await git(cwd, ['remote', 'get-url', '--push', '--all', remote], { allowFail: true });
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

const GH_URL = /^(?:https?|ssh|git):\/\/(?:[^/@\s]+@)?github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;
const GH_SCP = /^[^/@\s]+@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;
const GH_PR = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+\/?$/i;

/** "github.com/owner/name" for an https, ssh or scp-style github.com address; null for anything else. */
export function githubRepoOf(address: string): string | null {
  const m = GH_URL.exec(address.trim()) ?? GH_SCP.exec(address.trim());
  return m ? `github.com/${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** "github.com/owner/name" for a github.com pull request URL, or null. */
export function githubRepoOfPr(url: string): string | null {
  const m = GH_PR.exec(url.trim());
  return m ? `github.com/${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** A remote address without credentials or query strings, safe to store in run state and compare later. */
export function sanitizeRemoteUrl(url: string): string {
  return url.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1').replace(/[?#].*$/, '');
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
  if (await exists(dir)) await git(root, ['worktree', 'remove', '--force', dir]);
  await git(root, ['worktree', 'prune'], { allowFail: true });
}

/** Is `dir` already a working tree with `branch` checked out? (Used to adopt a half-created worktree.) */
export async function isWorktreeOf(dir: string, branch: string): Promise<boolean> {
  if (!(await exists(path.join(dir, '.git')))) return false;
  const cur = (await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true })).trim();
  return cur === branch;
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

/** The commit a local tag points at, or '' when there is no such tag. */
export async function tagTarget(cwd: string, tag: string): Promise<string> {
  const out = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], { allowFail: true });
  return out.trim();
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
  o: { repo: string; base: string; head: string; title: string; body: string; draft: boolean },
): Promise<string> {
  const args = ['pr', 'create', '--repo', o.repo, '--base', o.base, '--head', o.head, '--title', o.title, '--body-file', '-'];
  if (o.draft) args.push('--draft');
  const r = await runProcess({ command: 'gh', args, cwd, input: o.body, timeoutMs: 120_000 });
  if (r.timedOut || r.aborted) throw new GitError(`gh pr create ${r.timedOut ? 'timed out' : 'was cancelled'}; its outcome is unknown`, null);
  if (r.code !== 0) {
    // An existing PR for the branch is fine: look it up instead of failing the run.
    const existing = await runProcess({
      command: 'gh',
      args: ['pr', 'view', o.head, '--repo', o.repo, '--json', 'url', '--jq', '.url'],
      cwd,
      timeoutMs: 30_000,
    });
    if (existing.code === 0 && existing.stdout.trim()) return existing.stdout.trim();
    throw new GitError(`gh pr create failed: ${(r.stderr || r.stdout).trim()}`, r.code);
  }
  const m = /https?:\/\/\S+/.exec(r.stdout);
  return m ? m[0] : r.stdout.trim();
}

export async function ghMergePr(cwd: string, pr: string, headSha: string, repo: string): Promise<void> {
  // --match-head-commit refuses to merge if the branch moved after approval.
  const r = await runProcess({
    command: 'gh',
    args: ['pr', 'merge', pr, '--repo', repo, '--squash', '--delete-branch', '--match-head-commit', headSha],
    cwd,
    timeoutMs: 180_000,
  });
  if (r.timedOut || r.aborted) throw new GitError(`gh pr merge ${r.timedOut ? 'timed out' : 'was cancelled'}; its outcome is unknown`, null);
  if (r.code !== 0) throw new GitError(`gh pr merge failed: ${(r.stderr || r.stdout).trim()}`, r.code);
}

export async function ghMarkReady(cwd: string, pr: string, repo: string): Promise<void> {
  await runProcess({ command: 'gh', args: ['pr', 'ready', pr, '--repo', repo], cwd, timeoutMs: 60_000 });
}

export async function ghMergeCommit(cwd: string, pr: string, repo: string): Promise<string> {
  const r = await runProcess({
    command: 'gh',
    args: ['pr', 'view', pr, '--repo', repo, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid'],
    cwd,
    timeoutMs: 30_000,
  });
  return r.code === 0 ? r.stdout.trim() : '';
}

/**
 * Fetch the base branch from the address a push writes to (not the read address, which can be a
 * different repository) and report whether `sha` is now a local commit reachable from that
 * branch. Only a merge commit confirmed this way is safe to tag.
 */
export async function fetchMergeCommit(cwd: string, address: string, branch: string, sha: string): Promise<boolean> {
  // A write repository with no such branch cannot contain the commit. Ask first, so that only a
  // branch that is really absent counts as "not on it"; a failed lookup still throws.
  const listed = await git(cwd, ['ls-remote', '--heads', address, `refs/heads/${branch}`], { timeoutMs: 60_000 });
  if (!listed.trim()) return false;
  await git(cwd, ['fetch', '--no-tags', address, `refs/heads/${branch}`], { timeoutMs: 300_000 });
  const tip = (await git(cwd, ['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}'], { allowFail: true })).trim();
  if (!tip) return false;
  const have = (await git(cwd, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { allowFail: true })).trim();
  if (!have || have !== sha.toLowerCase()) return false;
  const common = (await git(cwd, ['merge-base', have, tip], { allowFail: true })).trim();
  return common === have;
}

export interface PrInfo {
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  /** Head commit of the PR branch. */
  headSha: string;
  /** Merge commit on the base branch, when merged. */
  mergeCommit: string;
}

/** Read-only: the commit a branch points at on the remote (a name or an address),  or '' when the remote has no such branch. */
export async function remoteBranchSha(cwd: string, remote: string, branch: string): Promise<string> {
  const out = await git(cwd, ['ls-remote', '--heads', remote, `refs/heads/${branch}`], { timeoutMs: 60_000 });
  return out.trim().split(/\s+/)[0] ?? '';
}

/** Read-only: the commit a tag resolves to on the remote (annotated tags are peeled), or ''. */
export async function remoteTagTarget(cwd: string, remote: string, tag: string): Promise<string> {
  const out = await git(cwd, ['ls-remote', '--tags', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { timeoutMs: 60_000 });
  const rows = out.trim().split(/\r?\n/).filter(Boolean).map((l) => l.split(/\s+/));
  const peeled = rows.find((r) => r[1]?.endsWith('^{}'));
  return (peeled ?? rows[0])?.[0] ?? '';
}

/** Read-only: the PR for a branch or URL. null means "no such PR"; any other failure throws. */
export async function ghPrView(cwd: string, ref: string, repo: string): Promise<PrInfo | null> {
  const r = await runProcess({
    command: 'gh',
    args: ['pr', 'view', ref, '--repo', repo, '--json', 'url,state,headRefOid,mergeCommit'],
    cwd,
    timeoutMs: 30_000,
  });
  if (r.timedOut || r.aborted || r.error) throw new GitError('gh pr view did not complete', null);
  if (r.code !== 0) {
    if (/no pull requests? found/i.test(r.stderr + r.stdout)) return null;
    throw new GitError(`gh pr view failed: ${(r.stderr || r.stdout).trim()}`, r.code);
  }
  try {
    const j = JSON.parse(r.stdout) as { url: string; state: PrInfo['state']; headRefOid: string; mergeCommit?: { oid?: string } | null };
    return { url: j.url, state: j.state, headSha: j.headRefOid, mergeCommit: j.mergeCommit?.oid ?? '' };
  } catch {
    throw new GitError('gh pr view returned something unreadable', null);
  }
}

/**
 * Every operation that talks to a remote. The pipeline and the recovery checks call these
 * through one object so tests can substitute fakes and never reach a real remote or GitHub.
 */
export interface RemoteOps {
  push(cwd: string, remote: string, branch: string): Promise<void>;
  pushTag(cwd: string, remote: string, tag: string): Promise<void>;
  /** Fetch the base branch from the push address and confirm `sha` is a commit on it. */
  fetchMergeCommit(cwd: string, address: string, branch: string, sha: string): Promise<boolean>;
  ghAvailable(cwd: string): Promise<boolean>;
  ghCreatePr(cwd: string, o: { repo: string; base: string; head: string; title: string; body: string; draft: boolean }): Promise<string>;
  ghMarkReady(cwd: string, pr: string, repo: string): Promise<void>;
  ghMergePr(cwd: string, pr: string, headSha: string, repo: string): Promise<void>;
  ghMergeCommit(cwd: string, pr: string, repo: string): Promise<string>;
  /** Read-only: the addresses a push to this remote writes to (credentials may be included; sanitize before storing). */
  pushUrls(cwd: string, remote: string): Promise<string[]>;
  remoteBranchSha(cwd: string, remote: string, branch: string): Promise<string>;
  remoteTagTarget(cwd: string, remote: string, tag: string): Promise<string>;
  ghPrView(cwd: string, ref: string, repo: string): Promise<PrInfo | null>;
}

export const realRemoteOps: RemoteOps = {
  push, pushTag, fetchMergeCommit, ghAvailable, ghCreatePr, ghMarkReady, ghMergePr, ghMergeCommit, pushUrls, remoteBranchSha, remoteTagTarget, ghPrView,
};
