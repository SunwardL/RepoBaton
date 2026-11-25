import * as G from './git.ts';
import { fingerprintRemoteAddress } from './flow-config.ts';
import type { PublishState, RunState } from './types.ts';

/**
 * Recovery for publish steps (push, PR, merge, tag) that were interrupted half way.
 *
 * Before each remote operation the pipeline writes `publish.inFlight`; it clears it once the
 * result is recorded. A marker that is still set means "we started this and never saw the
 * result". Repeating the operation blindly could push twice, open a second PR or merge
 * something unreviewed, and ignoring it could skip a step, so a marker is only cleared when
 * the remote itself confirms what happened, or when the user supplies evidence that is
 * enough to continue safely (a PR URL, a merge commit, the commit a pushed ref points at).
 * Everything here is read-only against the remote; the remote operations come in through
 * RemoteOps so tests use fakes.
 */

export type PublishOp = NonNullable<PublishState['inFlight']>;

export type Verdict =
  /** The remote shows the operation happened. `apply` records its result. */
  | { outcome: 'done'; summary: string; apply: (p: PublishState) => void }
  /** The remote shows it did not happen (or only partly): safe to run it again. */
  | { outcome: 'not-done'; summary: string; apply?: (p: PublishState) => void }
  /** Cannot tell. The run must stay paused. */
  | { outcome: 'unknown'; reason: string }
  /** The remote shows something that contradicts the record (another commit, another remote). A claim by hand never overrides it. */
  | { outcome: 'conflict'; reason: string };

export interface CheckContext {
  ops: G.RemoteOps;
  /** Main working tree, where git and gh can run. */
  repo: string;
  /** Name of the remote the operation was aimed at (set from the run's recorded target). */
  remote: string;
  /** Where that remote's pushes go, as git reads it now. Read-only queries use this address, not the remote's name. */
  address?: string;
  /** The GitHub repository (github.com/owner/name) recorded for PR steps. */
  githubRepo?: string;
  branch: string;
  approvedSha: string;
}

export function approvedShaOf(state: RunState): string | undefined {
  if (state.flow?.kind === 'custom') {
    const last = state.flow.workflow.steps.at(-1);
    return last?.type === 'approval' && state.steps?.[last.id]?.status === 'succeeded'
      ? state.steps[last.id].approval?.approvedHead : undefined;
  }
  return [...state.rounds].reverse().find((r) => r.decision === 'approved' && r.implement)?.implement?.sha;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;
const PR_URL = /^https:\/\/[^\s/]+\/[^\s]+\/pull\/\d+\/?$/;

/** Ask the remote what happened to the operation named by `state.publish.inFlight`. */
export async function checkInFlight(state: RunState, ctx: CheckContext): Promise<Verdict> {
  const op = state.publish.inFlight;
  if (!op) return { outcome: 'unknown', reason: 'no operation is marked as in flight' };
  // The check must look at the place the operation wrote to, not at whatever is configured now.
  const rec = state.publish.inFlightTarget;
  if (!rec) return { outcome: 'unknown', reason: 'the run did not record where the interrupted operation was writing, so the current configuration cannot be trusted to be the same place' };
  let urls: string[];
  try {
    urls = await ctx.ops.pushUrls(ctx.repo, rec.remote);
  } catch (e) {
    return { outcome: 'unknown', reason: `the push address of remote "${rec.remote}" could not be read: ${(e as Error).message}` };
  }
  if (urls.length > 1) {
    return { outcome: 'conflict', reason: `remote "${rec.remote}" now has ${urls.length} push addresses (${urls.map(G.sanitizeRemoteUrl).join(', ')}); it pushed to ${rec.url || '(no address)'} when the operation started` };
  }
  const now = G.sanitizeRemoteUrl(urls[0] ?? '');
  if (!now || now !== rec.url) {
    return { outcome: 'conflict', reason: `remote "${rec.remote}" pushed to ${rec.url || '(no address)'} when the operation started but ${now ? `now pushes to ${now}` : 'is no longer configured'}, so it cannot be checked against the original target` };
  }
  ctx = { ...ctx, remote: rec.remote, address: urls[0], githubRepo: rec.githubRepo };
  try {
    switch (op) {
      case 'push':
        return await checkPush(ctx);
      case 'pr':
        return await checkPr(ctx);
      case 'merge':
        return await checkMerge(state, ctx);
      case 'tag':
        return await checkTag(state, ctx);
    }
  } catch (e) {
    // A failed or timed-out check is not an answer. The message is already free of credentials.
    return { outcome: 'unknown', reason: `the remote could not be checked: ${(e as Error).message}` };
  }
}

async function checkPush(ctx: CheckContext): Promise<Verdict> {
  const sha = await ctx.ops.remoteBranchSha(ctx.repo, ctx.address ?? ctx.remote, ctx.branch);
  if (sha === ctx.approvedSha) {
    return { outcome: 'done', summary: `branch ${ctx.branch} is on ${ctx.remote} at the approved commit`, apply: (p) => void (p.pushed = true) };
  }
  if (!sha) return { outcome: 'not-done', summary: `branch ${ctx.branch} is not on ${ctx.remote}` };
  return { outcome: 'conflict', reason: `${ctx.remote}/${ctx.branch} is at ${sha.slice(0, 8)}, not the approved commit ${ctx.approvedSha.slice(0, 8)}` };
}

/** A PR view must name the recorded repository: the answer of another one is a conflict, not a gap. */
function prElsewhere(ctx: CheckContext, pr: G.PrInfo): Verdict | null {
  return G.githubRepoOfPr(pr.url) === ctx.githubRepo
    ? null
    : { outcome: 'conflict', reason: `the pull request ${pr.url} is not in ${ctx.githubRepo}, the repository this run writes to` };
}

async function checkPr(ctx: CheckContext): Promise<Verdict> {
  if (!ctx.githubRepo) return { outcome: 'unknown', reason: 'the GitHub repository of the pull request was not recorded' };
  const pr = await ctx.ops.ghPrView(ctx.repo, ctx.branch, ctx.githubRepo);
  if (!pr) return { outcome: 'not-done', summary: `no pull request exists for ${ctx.branch} in ${ctx.githubRepo}` };
  const elsewhere = prElsewhere(ctx, pr);
  if (elsewhere) return elsewhere;
  if (pr.headSha !== ctx.approvedSha) {
    return { outcome: 'conflict', reason: `a pull request exists (${pr.url}) but its head ${pr.headSha.slice(0, 8)} is not the approved commit ${ctx.approvedSha.slice(0, 8)}` };
  }
  if (pr.state === 'CLOSED') return { outcome: 'unknown', reason: `the pull request ${pr.url} was closed without merging` };
  if (pr.state === 'MERGED' && !pr.mergeCommit) return { outcome: 'unknown', reason: `${pr.url} is merged but its merge commit could not be read` };
  return {
    outcome: 'done',
    summary: `pull request ${pr.url} exists at the approved commit${pr.state === 'MERGED' ? ' and is already merged' : ''}`,
    apply: (p) => {
      p.prUrl = pr.url;
      if (pr.state === 'MERGED') {
        p.merged = true;
        p.mergeSha = pr.mergeCommit;
      }
    },
  };
}

async function checkMerge(state: RunState, ctx: CheckContext): Promise<Verdict> {
  if (!ctx.githubRepo) return { outcome: 'unknown', reason: 'the GitHub repository of the pull request was not recorded' };
  const ref = state.publish.prUrl ?? ctx.branch;
  if (state.publish.prUrl && G.githubRepoOfPr(state.publish.prUrl) !== ctx.githubRepo) {
    return { outcome: 'conflict', reason: `the recorded pull request ${state.publish.prUrl} is not in ${ctx.githubRepo}, the repository this run writes to` };
  }
  const pr = await ctx.ops.ghPrView(ctx.repo, ref, ctx.githubRepo);
  if (!pr) return { outcome: 'unknown', reason: `the pull request ${ref} could not be found` };
  const elsewhere = prElsewhere(ctx, pr);
  if (elsewhere) return elsewhere;
  if (pr.headSha !== ctx.approvedSha) {
    return { outcome: 'conflict', reason: `${pr.url} has head ${pr.headSha.slice(0, 8)}, not the approved commit ${ctx.approvedSha.slice(0, 8)}` };
  }
  if (pr.state === 'MERGED') {
    if (!FULL_SHA.test(pr.mergeCommit)) return { outcome: 'unknown', reason: `${pr.url} is merged but its merge commit could not be read` };
    return {
      outcome: 'done',
      summary: `${pr.url} is merged as ${pr.mergeCommit.slice(0, 8)}`,
      apply: (p) => {
        p.merged = true;
        p.mergeSha = pr.mergeCommit;
      },
    };
  }
  if (pr.state === 'OPEN') return { outcome: 'not-done', summary: `${pr.url} is still open` };
  return { outcome: 'unknown', reason: `${pr.url} was closed without merging` };
}

async function checkTag(state: RunState, ctx: CheckContext): Promise<Verdict> {
  const tag = state.publish.pendingTag;
  const target = state.publish.mergeSha;
  if (!tag || !target) return { outcome: 'unknown', reason: 'the tag name or the commit it should point at was not recorded' };
  const remote = await ctx.ops.remoteTagTarget(ctx.repo, ctx.address ?? ctx.remote, tag);
  if (remote) {
    if (remote === target) {
      return {
        outcome: 'done',
        summary: `tag ${tag} is on ${ctx.remote} at the merge commit`,
        apply: (p) => {
          p.tag = tag;
          p.tagPushed = true;
        },
      };
    }
    return { outcome: 'conflict', reason: `tag ${tag} exists on ${ctx.remote} but points at ${remote.slice(0, 8)}, not the merge commit ${target.slice(0, 8)}` };
  }
  const local = await G.tagTarget(ctx.repo, tag);
  if (!local) return { outcome: 'not-done', summary: `tag ${tag} exists neither locally nor on ${ctx.remote}` };
  if (local === target) {
    // Created locally, never pushed: only the push is left.
    return { outcome: 'not-done', summary: `tag ${tag} exists locally but was not pushed`, apply: (p) => void (p.tag = tag) };
  }
  return { outcome: 'conflict', reason: `a local tag ${tag} exists but points at ${local.slice(0, 8)}, not the merge commit ${target.slice(0, 8)}` };
}

// ------------------------------------------------------------------ manual acknowledgement

export interface Evidence {
  /** push / tag: the commit the pushed ref points at. */
  remoteSha?: string;
  /** pr: the pull request URL. */
  prUrl?: string;
  /** merge: the merge commit on the base branch. */
  mergeSha?: string;
}

/** Is the user's evidence enough to record "it happened"? */
function evidenceVerdict(op: PublishOp, state: RunState, approvedSha: string, ev: Evidence): Verdict | null {
  switch (op) {
    case 'push':
      return ev.remoteSha?.toLowerCase() === approvedSha.toLowerCase()
        ? { outcome: 'done', summary: 'recorded from the commit you reported', apply: (p) => void (p.pushed = true) }
        : null;
    case 'pr':
      return ev.prUrl && PR_URL.test(ev.prUrl.trim())
        ? { outcome: 'done', summary: 'recorded from the pull request URL you reported', apply: (p) => void (p.prUrl = ev.prUrl!.trim()) }
        : null;
    case 'merge':
      return state.publish.prUrl && ev.mergeSha && FULL_SHA.test(ev.mergeSha.trim())
        ? {
            outcome: 'done',
            summary: 'recorded from the merge commit you reported',
            apply: (p) => {
              p.merged = true;
              p.mergeSha = ev.mergeSha!.trim().toLowerCase();
            },
          }
        : null;
    case 'tag':
      return state.publish.pendingTag && state.publish.mergeSha && ev.remoteSha?.toLowerCase() === state.publish.mergeSha.toLowerCase()
        ? {
            outcome: 'done',
            summary: 'recorded from the tag target you reported',
            apply: (p) => {
              p.tag = p.pendingTag;
              p.tagPushed = true;
            },
          }
        : null;
  }
}

/** What to look at and what to report, per operation. Used in refusals so the user knows the way out. */
export function evidenceHelp(op: PublishOp): string {
  switch (op) {
    case 'push':
      return 'give the commit the remote branch points at (it must be the approved commit)';
    case 'pr':
      return 'give the pull request URL';
    case 'merge':
      return 'give the merge commit (full 40-character SHA) of the merged pull request';
    case 'tag':
      return 'give the commit the pushed tag points at (it must be the merge commit)';
  }
}

export type AckResult =
  | { ok: true; recorded: 'done' | 'not-done'; summary: string }
  | { ok: false; code: 'unconfirmed' | 'contradicts-remote' | 'nothing-to-ack'; message: string };

/**
 * The user says what they found. The remote is asked first and wins over the claim: "completed"
 * is accepted only when the remote confirms it or evidence is given, and "did not happen" only
 * when the remote shows it did not. On success the marker is cleared and the result recorded in
 * `state.publish`; the caller saves.
 */
export async function acknowledgePublish(state: RunState, ctx: CheckContext, rawClaim: { completed?: boolean; evidence?: Evidence }): Promise<AckResult> {
  const claim = { completed: rawClaim.completed ?? !!rawClaim.evidence, evidence: rawClaim.evidence };
  const op = state.publish.inFlight;
  if (!op) return { ok: false, code: 'nothing-to-ack', message: 'nothing is waiting to be checked on this run' };
  const verdict = await checkInFlight(state, ctx);
  const finish = (v: Extract<Verdict, { outcome: 'done' | 'not-done' }>): AckResult => {
    v.apply?.(state.publish);
    state.publish.inFlight = undefined;
    return { ok: true, recorded: v.outcome, summary: v.summary };
  };

  if (verdict.outcome === 'done') {
    // The remote shows it happened, whatever the user said: record the truth so it is not repeated.
    return finish(verdict);
  }
  if (verdict.outcome === 'not-done') {
    if (claim.completed) {
      return {
        ok: false,
        code: 'contradicts-remote',
        message: `You said "${op}" completed, but the remote shows it did not: ${verdict.summary}. If that is wrong, wait for the remote to catch up and try again.`,
      };
    }
    return finish(verdict);
  }
  if (verdict.outcome === 'conflict') {
    // The remote shows something different from what was approved or recorded; a claim from the user does not settle that.
    return {
      ok: false,
      code: 'contradicts-remote',
      message: `The remote contradicts the record for "${op}": ${verdict.reason}. Recording it by hand would hide the conflict, so the run stays paused. Resolve the difference on the remote, then check again.`,
    };
  }
  // unknown: the remote cannot settle it.
  if (claim.completed) {
    const ev = evidenceVerdict(op, state, ctx.approvedSha, claim.evidence ?? {});
    if (ev && ev.outcome === 'done') return finish(ev);
    return {
      ok: false,
      code: 'unconfirmed',
      message: `Cannot confirm that "${op}" completed (${verdict.reason}). To record it as completed, ${evidenceHelp(op)}.`,
    };
  }
  return {
    ok: false,
    code: 'unconfirmed',
    message: `Cannot confirm that "${op}" did not happen (${verdict.reason}). Making it run again could repeat it, so the run stays paused. Fix the access problem and try again, or report the evidence that it completed.`,
  };
}

// ------------------------------------------------------------------ shared by the server and the CLI

import type { Config } from './types.ts';
import type { RunStore } from './store.ts';

export class AckRefused extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AckRefused';
    this.code = code;
  }
}

/**
 * Check the remote for a run paused in the middle of a publish step, apply the user's claim
 * under the rules above, and save. Callers hold whatever exclusion they have (the server's
 * repository slot); a run that is executing is refused here as a last line of defence.
 */
export async function checkAndRecord(
  store: RunStore,
  repo: string,
  cfg: Config,
  runId: string,
  claim: { completed?: boolean; evidence?: Evidence },
  ops: G.RemoteOps = G.realRemoteOps,
): Promise<AckResult & { op?: PublishOp }> {
  const state = await store.load(runId);
  if (state.status === 'running') throw new AckRefused('running', 'this run is marked as running; wait for it or recover it first');
  const op = state.publish.inFlight;
  if (!op) return { ok: false, code: 'nothing-to-ack', message: 'nothing is waiting to be checked on this run' };
  const approvedSha = approvedShaOf(state);
  if (!approvedSha || !state.branch) throw new AckRefused('no-commit', 'this run has no approved commit, so there is nothing to compare the remote against');
  if (state.flow?.kind === 'custom') {
    const last = state.flow.workflow.steps.at(-1);
    const target = last ? state.steps?.[last.id]?.approval?.approvedTarget : undefined;
    if (!target?.fingerprint) throw new AckRefused('unconfirmed', 'the approved full destination cannot be verified; publication remains paused');
    let addresses: string[];
    try { addresses = await ops.pushUrls(repo, target.remote); }
    catch { return { ok: false, code: 'unconfirmed', message: 'the approved destination could not be read; publication remains paused', op }; }
    if (addresses.length !== 1) return { ok: false, code: 'contradicts-remote', message: 'the approved destination is missing or has multiple push addresses', op };
    let actual: string;
    try { actual = await fingerprintRemoteAddress(addresses[0], false); }
    catch { return { ok: false, code: 'unconfirmed', message: 'the destination fingerprint key is unavailable; publication remains paused', op }; }
    if (actual !== target.fingerprint) return { ok: false, code: 'contradicts-remote', message: 'the full push destination changed after approval; publication remains paused', op };
  }
  const result = await acknowledgePublish(state, { ops, repo, remote: cfg.publish.remote, branch: state.branch, approvedSha }, claim);
  if (result.ok) {
    state.error = 'the remote was checked; ready to continue';
    await store.save(state);
  }
  return { ...result, op };
}
