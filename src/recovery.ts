import { execFile } from 'node:child_process';
import path from 'node:path';
import { FileEventSink } from './events.ts';
import { exists, nowIso } from './util.ts';
import { RunStore } from './store.ts';
import type { RunState } from './types.ts';

export type OwnerInfo = NonNullable<RunState['owner']>;

/** What we know about a process that once owned a run. */
export interface ProcessProbe {
  alive: boolean;
  /** Start time of the live process, when the OS can tell us. Used to detect pid reuse. */
  startedAt?: number;
}

export type Prober = (pid: number) => Promise<ProcessProbe>;

/** Ask the OS whether a pid is alive and, if possible, when it started. */
export const osProbe: Prober = async (pid) => {
  try {
    process.kill(pid, 0); // throws ESRCH when gone; EPERM means alive but not ours
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return { alive: false };
  }
  const startedAt = await processStartTime(pid);
  return { alive: true, startedAt };
};

function processStartTime(pid: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
        { timeout: 8000, windowsHide: true },
        (err, stdout) => {
          const t = Date.parse(String(stdout).trim());
          resolve(err || Number.isNaN(t) ? undefined : t);
        },
      );
    } else {
      execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 5000 }, (err, stdout) => {
        const t = Date.parse(String(stdout).trim());
        resolve(err || Number.isNaN(t) ? undefined : t);
      });
    }
  });
}

/** Allow for clock/rounding differences between "when the server said it started" and the OS. */
const START_TOLERANCE_MS = 5000;

/**
 * Is the owner of this run definitely gone? Returns false whenever there is doubt:
 * a wrongly-interrupted run could be resumed and run twice; a wrongly-left-alone
 * one is merely shown as "running" until the user looks.
 */
export async function ownerIsGone(owner: OwnerInfo, probe: Prober = osProbe): Promise<boolean> {
  const p = await probe(owner.pid);
  if (!p.alive) return true;
  if (p.startedAt === undefined) return false; // alive and cannot compare: assume it is still the owner
  // The pid is alive but belongs to a process that started after the owner claimed to: pid reuse.
  return p.startedAt - Date.parse(owner.startedAt) > START_TOLERANCE_MS;
}

export interface RecoveryOptions {
  /** The serverId of the server doing the check: its own runs are never "gone". */
  currentServerId: string;
  /** Runs this server is executing right now, regardless of what the file says. */
  isExecuting: (runId: string) => boolean;
  probe?: Prober;
}

export interface RecoveryResult {
  interrupted: string[];
  /** Runs that look stale but were left alone, with the reason. */
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Mark runs that a previous server left in "running" and that nothing executes any more.
 * Only runs with an owner can be judged; a run with no owner was started by a standalone
 * CLI, which this server cannot see, so it is never touched.
 */
export async function recoverInterrupted(store: RunStore, opts: RecoveryOptions): Promise<RecoveryResult> {
  const result: RecoveryResult = { interrupted: [], skipped: [] };
  for (const run of await store.list()) {
    if (run.status !== 'running') continue;
    if (opts.isExecuting(run.id)) continue;
    if (!run.owner) {
      result.skipped.push({ id: run.id, reason: 'no server owner (started by the CLI); left alone' });
      continue;
    }
    if (run.owner.serverId === opts.currentServerId) {
      // Ours, but not executing: the launch failed before it began. Safe to mark.
    } else if (!(await ownerIsGone(run.owner, opts.probe))) {
      result.skipped.push({ id: run.id, reason: `owner process ${run.owner.pid} is still alive` });
      continue;
    }
    // Re-read: the owner may have finished it between listing and now.
    const fresh = await store.load(run.id);
    if (fresh.status !== 'running') continue;
    fresh.status = 'interrupted';
    fresh.interruptedAt = nowIso();
    // A call that was in flight when the server stopped is over. Close its record (keeping any session
    // id it had reported) so the page does not show it as running forever.
    for (const s of fresh.sessions ?? []) {
      if (s.status !== 'running') continue;
      s.status = 'interrupted';
      s.finishedAt = fresh.interruptedAt;
      if (!s.sessionId) s.noSessionReason = 'the server stopped before the agent reported a session id';
      // sessionConfirmed stays as recorded: an id the CLI never confirmed is still unconfirmed.
    }
    fresh.error = `the server that was running this stopped while it was in "${fresh.stage ?? 'progress'}"`;
    // Events first, status second, same order as a normal finish, so followers never miss the last event.
    const sink = await FileEventSink.open(store.dir(fresh.id), fresh.id);
    sink.emit('run.interrupted', fresh.error, { stage: fresh.stage, data: { owner: run.owner } });
    sink.emit('run.finished', fresh.error, { data: { status: 'interrupted', rounds: fresh.rounds.length, usage: fresh.usage } });
    await sink.flush();
    await store.save(fresh);
    result.interrupted.push(fresh.id);
  }
  return result;
}

export interface CleanupResult {
  removedWorktree: boolean;
  keptBranch?: string;
}

/**
 * Remove the worktree of a finished run. Never touches a run that is executing, and never
 * deletes the branch (its commits are the user's result) unless asked.
 */
export async function cleanupRun(
  store: RunStore,
  repoRoot: string,
  runId: string,
  isExecuting: (id: string) => boolean,
  removeWorktree: (root: string, dir: string) => Promise<void>,
): Promise<CleanupResult> {
  if (isExecuting(runId)) throw new CleanupRefused('this run is executing right now; cancel it first');
  const state = await store.load(runId);
  if (state.status === 'running') throw new CleanupRefused('this run is marked as running; wait for it or recover it first');
  if (state.worktree && (await exists(state.worktree))) {
    // Only remove worktrees that live under this repository's own worktree directory.
    const root = path.resolve(repoRoot);
    const wt = path.resolve(state.worktree);
    if (!wt.toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
      throw new CleanupRefused('the worktree is outside the repository; refusing to delete it');
    }
    await removeWorktree(repoRoot, state.worktree);
  }
  const had = !!state.worktree;
  state.worktree = undefined;
  await store.save(state);
  return { removedWorktree: had, keptBranch: state.branch };
}

export class CleanupRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CleanupRefused';
  }
}
