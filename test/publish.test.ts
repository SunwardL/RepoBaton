import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentRegistry } from '../src/agents/registry.ts';
import { defaultConfig } from '../src/config.ts';
import { git, type PrInfo, type RemoteOps } from '../src/git.ts';
import { Pipeline } from '../src/pipeline.ts';
import { ProjectRegistry } from '../src/projects.ts';
import { acknowledgePublish, checkAndRecord } from '../src/publishcheck.ts';
import { startServer } from '../src/server/server.ts';
import { RunStore } from '../src/store.ts';
import type { Agent, AgentResult, AgentRunRequest, Config, RunState } from '../src/types.ts';

const APPROVED = 'a'.repeat(40);
const MERGED = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const REMOTE_URL = 'https://github.com/o/r.git';
const GH_REPO = 'github.com/o/r';

/** A fake remote + GitHub. Records every call; nothing leaves the process. */
class FakeRemote implements RemoteOps {
  calls: string[] = [];
  branchSha = '';
  tagSha = '';
  pr: PrInfo | null = null;
  fail: Record<string, string> = {};
  hang = new Set<string>();
  /** Where a push to each remote name writes; "origin" matches the one approvedRun configures. */
  pushes: Record<string, string[]> = { origin: [REMOTE_URL] };
  /** Addresses the read-only ls-remote checks were pointed at. */
  queried: string[] = [];
  /** The GitHub repository every gh call was told to use. */
  ghRepos: string[] = [];
  private count(name: string): void {
    this.calls.push(name);
    if (this.fail[name]) throw new Error(this.fail[name]);
  }
  n(name: string): number {
    return this.calls.filter((c) => c === name).length;
  }
  async push(): Promise<void> {
    this.count('push');
    this.branchSha = APPROVED;
  }
  async pushTag(): Promise<void> {
    this.count('pushTag');
  }
  async fetchRemote(): Promise<void> {
    this.count('fetch');
  }
  async ghAvailable(): Promise<boolean> {
    return true;
  }
  async ghCreatePr(_cwd: string, o: { repo: string }): Promise<string> {
    this.ghRepos.push(o.repo);
    this.count('createPr');
    this.pr = { url: 'https://github.com/o/r/pull/7', state: 'OPEN', headSha: APPROVED, mergeCommit: '' };
    return this.pr.url;
  }
  async ghMarkReady(_cwd: string, _pr: string, repo: string): Promise<void> {
    this.ghRepos.push(repo);
    this.count('ready');
  }
  async ghMergePr(_cwd: string, _pr: string, _sha: string, repo: string): Promise<void> {
    this.ghRepos.push(repo);
    this.count('merge');
    if (this.pr) this.pr = { ...this.pr, state: 'MERGED', mergeCommit: MERGED };
  }
  async ghMergeCommit(_cwd: string, _pr: string, repo: string): Promise<string> {
    this.ghRepos.push(repo);
    return this.pr?.mergeCommit ?? '';
  }
  async pushUrls(_cwd: string, remote: string): Promise<string[]> {
    if (this.fail.pushUrls) throw new Error(this.fail.pushUrls);
    return this.pushes[remote] ?? [];
  }
  async remoteBranchSha(_cwd: string, remote: string): Promise<string> {
    this.queried.push(remote);
    this.calls.push('lsBranch');
    if (this.fail.lsBranch) throw new Error(this.fail.lsBranch);
    return this.branchSha;
  }
  async remoteTagTarget(_cwd: string, remote: string): Promise<string> {
    this.queried.push(remote);
    this.calls.push('lsTag');
    if (this.fail.lsTag) throw new Error(this.fail.lsTag);
    return this.tagSha;
  }
  async ghPrView(_cwd: string, _ref: string, repo: string): Promise<PrInfo | null> {
    this.ghRepos.push(repo);
    this.calls.push('prView');
    if (this.fail.prView) throw new Error(this.fail.prView);
    return this.pr;
  }
}

function stateWith(publish: RunState['publish'], over: Partial<RunState> = {}): RunState {
  // A marker written by the pipeline always carries the place it was aimed at.
  if (publish.inFlight && !publish.inFlightTarget) publish = { ...publish, inFlightTarget: { remote: 'origin', url: REMOTE_URL.replace(/\.git$/, '.git'), githubRepo: GH_REPO } };
  return {
    id: 'r1',
    task: 't',
    repo: '/x',
    status: 'needs-human',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    branch: 'repobaton/x',
    base: { branch: 'main', sha: 'f'.repeat(40) },
    rounds: [{ n: 1, decision: 'approved', implement: { agent: 'a', sha: APPROVED, summary: '', changedFiles: [], durationMs: 1 } }],
    publish,
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, calls: 0 },
    ...over,
  };
}

const ctx = (ops: RemoteOps) => ({ ops, repo: os.tmpdir(), remote: 'origin', branch: 'repobaton/x', approvedSha: APPROVED });

// ------------------------------------------------------------------ push

test('push: remote at the approved commit => recorded as pushed, whatever the user claimed', async () => {
  const ops = new FakeRemote();
  ops.branchSha = APPROVED;
  for (const completed of [true, false, undefined]) {
    const s = stateWith({ inFlight: 'push' });
    const r = await acknowledgePublish(s, ctx(ops), { completed });
    assert.ok(r.ok && r.recorded === 'done', JSON.stringify(r));
    assert.equal(s.publish.pushed, true);
    assert.equal(s.publish.inFlight, undefined);
  }
});

test('push: remote has no branch => "did not happen" is accepted, "completed" is refused as contradicting the remote', async () => {
  const ops = new FakeRemote();
  const a = stateWith({ inFlight: 'push' });
  const claimDone = await acknowledgePublish(a, ctx(ops), { completed: true });
  assert.ok(!claimDone.ok && claimDone.code === 'contradicts-remote');
  assert.equal(a.publish.inFlight, 'push', 'marker kept');
  assert.equal(a.publish.pushed, undefined);
  const b = stateWith({ inFlight: 'push' });
  const notDone = await acknowledgePublish(b, ctx(ops), { completed: false });
  assert.ok(notDone.ok && notDone.recorded === 'not-done');
  assert.equal(b.publish.inFlight, undefined);
  assert.equal(b.publish.pushed, undefined, 'nothing recorded, so the push will run');
});

test('push: remote branch at a different commit, or an unreachable remote, keeps the run paused', async () => {
  const ops = new FakeRemote();
  ops.branchSha = OTHER;
  const a = stateWith({ inFlight: 'push' });
  const r1 = await acknowledgePublish(a, ctx(ops), { completed: false });
  assert.ok(!r1.ok && r1.code === 'contradicts-remote', 'a branch found at another commit is a conflict, not a gap');
  assert.equal(a.publish.inFlight, 'push');

  const down = new FakeRemote();
  down.fail.lsBranch = 'could not resolve host';
  const b = stateWith({ inFlight: 'push' });
  const r2 = await acknowledgePublish(b, ctx(down), { completed: false });
  assert.ok(!r2.ok && r2.code === 'unconfirmed');
  assert.match((r2 as any).message, /could not be checked/);
  assert.equal(b.publish.inFlight, 'push');
});

test('push: with the remote unreachable, a claim of completion needs evidence that matches the approved commit', async () => {
  const down = new FakeRemote();
  down.fail.lsBranch = 'timeout';
  const none = stateWith({ inFlight: 'push' });
  const r0 = await acknowledgePublish(none, ctx(down), { completed: true });
  assert.ok(!r0.ok && r0.code === 'unconfirmed');
  assert.match((r0 as any).message, /commit the remote branch points at/);
  const wrong = await acknowledgePublish(stateWith({ inFlight: 'push' }), ctx(down), { completed: true, evidence: { remoteSha: OTHER } });
  assert.ok(!wrong.ok);
  const good = stateWith({ inFlight: 'push' });
  const r = await acknowledgePublish(good, ctx(down), { completed: true, evidence: { remoteSha: APPROVED } });
  assert.ok(r.ok);
  assert.equal(good.publish.pushed, true);
});

// ------------------------------------------------------------------ pull request

test('pr: an existing PR at the approved commit is recorded with its URL, so it is not created twice', async () => {
  const ops = new FakeRemote();
  ops.pr = { url: 'https://github.com/o/r/pull/7', state: 'OPEN', headSha: APPROVED, mergeCommit: '' };
  const s = stateWith({ inFlight: 'pr', pushed: true });
  const r = await acknowledgePublish(s, ctx(ops), { completed: false });
  assert.ok(r.ok && r.recorded === 'done');
  assert.equal(s.publish.prUrl, 'https://github.com/o/r/pull/7');
  assert.equal(s.publish.merged, undefined);
});

test('pr: no PR on the remote => safe to create; a PR at another commit or a closed PR => paused', async () => {
  const none = await acknowledgePublish(stateWith({ inFlight: 'pr' }), ctx(new FakeRemote()), { completed: false });
  assert.ok(none.ok && none.recorded === 'not-done');

  const other = new FakeRemote();
  other.pr = { url: 'https://github.com/o/r/pull/7', state: 'OPEN', headSha: OTHER, mergeCommit: '' };
  const s1 = stateWith({ inFlight: 'pr' });
  assert.ok(!(await acknowledgePublish(s1, ctx(other), { completed: false })).ok);
  assert.equal(s1.publish.inFlight, 'pr');

  const closed = new FakeRemote();
  closed.pr = { url: 'https://github.com/o/r/pull/7', state: 'CLOSED', headSha: APPROVED, mergeCommit: '' };
  assert.ok(!(await acknowledgePublish(stateWith({ inFlight: 'pr' }), ctx(closed), { completed: false })).ok);
});

test('pr: when GitHub cannot be reached, only a well-formed PR URL settles it', async () => {
  const down = new FakeRemote();
  down.fail.prView = 'gh: not logged in';
  assert.ok(!(await acknowledgePublish(stateWith({ inFlight: 'pr' }), ctx(down), { completed: true })).ok);
  assert.ok(!(await acknowledgePublish(stateWith({ inFlight: 'pr' }), ctx(down), { completed: true, evidence: { prUrl: 'not a url' } })).ok);
  const s = stateWith({ inFlight: 'pr' });
  assert.ok((await acknowledgePublish(s, ctx(down), { completed: true, evidence: { prUrl: 'https://github.com/o/r/pull/9' } })).ok);
  assert.equal(s.publish.prUrl, 'https://github.com/o/r/pull/9');
});

// ------------------------------------------------------------------ merge

test('merge: a merged PR records the merge commit; an open PR means it is safe to merge again', async () => {
  const merged = new FakeRemote();
  merged.pr = { url: 'https://github.com/o/r/pull/7', state: 'MERGED', headSha: APPROVED, mergeCommit: MERGED };
  const s = stateWith({ inFlight: 'merge', prUrl: 'https://github.com/o/r/pull/7' });
  const r = await acknowledgePublish(s, ctx(merged), { completed: false });
  assert.ok(r.ok && r.recorded === 'done');
  assert.equal(s.publish.merged, true);
  assert.equal(s.publish.mergeSha, MERGED);

  const open = new FakeRemote();
  open.pr = { url: 'https://github.com/o/r/pull/7', state: 'OPEN', headSha: APPROVED, mergeCommit: '' };
  const s2 = stateWith({ inFlight: 'merge', prUrl: 'https://github.com/o/r/pull/7' });
  const r2 = await acknowledgePublish(s2, ctx(open), { completed: false });
  assert.ok(r2.ok && r2.recorded === 'not-done');
  assert.equal(s2.publish.merged, undefined);
});

test('merge: merged but the merge commit is unreadable, or the PR moved to another commit => paused, nothing recorded', async () => {
  const noSha = new FakeRemote();
  noSha.pr = { url: 'https://github.com/o/r/pull/7', state: 'MERGED', headSha: APPROVED, mergeCommit: '' };
  const s = stateWith({ inFlight: 'merge', prUrl: 'https://github.com/o/r/pull/7' });
  assert.ok(!(await acknowledgePublish(s, ctx(noSha), { completed: true })).ok);
  assert.equal(s.publish.merged, undefined);
  assert.equal(s.publish.inFlight, 'merge');

  const moved = new FakeRemote();
  moved.pr = { url: 'https://github.com/o/r/pull/7', state: 'MERGED', headSha: OTHER, mergeCommit: MERGED };
  assert.ok(!(await acknowledgePublish(stateWith({ inFlight: 'merge', prUrl: 'https://github.com/o/r/pull/7' }), ctx(moved), { completed: true })).ok);
});

test('merge: with GitHub unreachable the user must give a full merge SHA, and the PR URL must already be recorded', async () => {
  const down = new FakeRemote();
  down.fail.prView = 'timeout';
  const withUrl = () => stateWith({ inFlight: 'merge', prUrl: 'https://github.com/o/r/pull/7' });
  assert.ok(!(await acknowledgePublish(withUrl(), ctx(down), { completed: true, evidence: { mergeSha: 'abc123' } })).ok, 'short sha is not enough');
  assert.ok(!(await acknowledgePublish(stateWith({ inFlight: 'merge' }), ctx(down), { completed: true, evidence: { mergeSha: MERGED } })).ok, 'no PR on record');
  const s = withUrl();
  assert.ok((await acknowledgePublish(s, ctx(down), { completed: true, evidence: { mergeSha: MERGED } })).ok);
  assert.equal(s.publish.mergeSha, MERGED);
});

// ------------------------------------------------------------------ tag

async function repoWithTag(tag: string | null, sha: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-tag-'));
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 't@e.com']);
  await git(dir, ['config', 'user.name', 't']);
  await fs.writeFile(path.join(dir, 'f'), 'x');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'i']);
  const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  if (tag) await git(dir, ['tag', '-a', tag, head, '-m', 'm']);
  void sha;
  return dir;
}

test('tag: pushed at the merge commit => recorded; absent everywhere => safe to run; wrong target => paused', async () => {
  const pub = { inFlight: 'tag' as const, pendingTag: 'v1.0.1', mergeSha: MERGED, merged: true };
  const pushed = new FakeRemote();
  pushed.tagSha = MERGED;
  const s = stateWith({ ...pub });
  assert.ok((await acknowledgePublish(s, ctx(pushed), { completed: false })).ok);
  assert.equal(s.publish.tag, 'v1.0.1');
  assert.equal(s.publish.tagPushed, true);

  const repo = await repoWithTag(null, MERGED);
  const none = await acknowledgePublish(stateWith({ ...pub }), { ...ctx(new FakeRemote()), repo }, { completed: false });
  assert.ok(none.ok && none.recorded === 'not-done');

  const wrong = new FakeRemote();
  wrong.tagSha = OTHER;
  const s2 = stateWith({ ...pub });
  assert.ok(!(await acknowledgePublish(s2, ctx(wrong), { completed: false })).ok);
  assert.equal(s2.publish.inFlight, 'tag');
});

test('tag: a local tag at another commit is never accepted as "did not happen"', async () => {
  const repo = await repoWithTag('v1.0.1', MERGED); // points at the repo HEAD, not MERGED
  const s = stateWith({ inFlight: 'tag', pendingTag: 'v1.0.1', mergeSha: MERGED, merged: true });
  const r = await acknowledgePublish(s, { ...ctx(new FakeRemote()), repo }, { completed: false });
  assert.ok(!r.ok && r.code === 'contradicts-remote');
  assert.equal(s.publish.inFlight, 'tag');
});

test('tag: nothing recorded about the tag name or target means it cannot be settled by looking', async () => {
  const s = stateWith({ inFlight: 'tag' });
  const r = await acknowledgePublish(s, ctx(new FakeRemote()), { completed: false });
  assert.ok(!r.ok);
  assert.equal(s.publish.inFlight, 'tag');
});

// ------------------------------------------------------------------ the pipeline itself never repeats

async function approvedRun(publish: Partial<Config['publish']>, seed: Partial<RunState['publish']>, fake: FakeRemote): Promise<{ state: RunState; pipe: Pipeline; store: RunStore; repo: string }> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-pub-'));
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 't@e.com']);
  await git(repo, ['config', 'user.name', 't']);
  await fs.writeFile(path.join(repo, 'v.txt'), 'old\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  // A configured URL so the pipeline's "is there a remote?" check passes; it is never contacted:
  // every remote operation goes through the fake.
  await git(repo, ['remote', 'add', 'origin', REMOTE_URL]);
  await git(repo, ['worktree', 'add', '-q', '-b', 'repobaton/x', path.join(repo, '.repobaton', 'wt'), base]);
  const wt = path.join(repo, '.repobaton', 'wt');
  await fs.writeFile(path.join(wt, 'v.txt'), 'good\n');
  await git(wt, ['add', '-A']);
  await git(wt, ['commit', '-q', '-m', 'work']);
  const sha = (await git(wt, ['rev-parse', 'HEAD'])).trim();
  const config = defaultConfig();
  config.agents = { a: { type: 'command', command: 'x' } };
  for (const s of ['plan', 'implement', 'review', 'release'] as const) config.stages[s].agent = 'a';
  config.test.setup = '';
  config.publish = { ...config.publish, push: false, createPr: false, merge: false, tag: false, ...publish };
  const store = new RunStore(repo);
  const state: RunState = {
    ...stateWith({ ...seed }, { id: 'run1', repo, status: 'interrupted', worktree: wt, branch: 'repobaton/x', base: { branch: 'main', sha: base }, setupDone: true, planApproved: true }),
    rounds: [{ n: 1, decision: 'approved', implement: { agent: 'a', sha, summary: '', changedFiles: ['v.txt'], durationMs: 1 }, test: { skipped: true, exitCode: null, durationMs: 0, sha, outputTail: '' } }],
    release: { version_bump: 'patch', suggested_version: '1.0.1', pr_title: 't', pr_body: 'b', release_notes: 'n', risks: [] },
    plan: { summary: 's', steps: [], acceptance: [], risks: [], test_hints: [] },
    planVersion: 1,
  };
  await store.save(state);
  const registry = { get: () => ({}) } as unknown as AgentRegistry;
  const pipe = new Pipeline({ repo, config, registry, remote: fake });
  return { state, pipe, store, repo };
}

test('resuming with an in-flight marker performs no remote operation at all and says how to continue', async () => {
  const fake = new FakeRemote();
  const { pipe, store } = await approvedRun({ push: true, createPr: true, merge: true, tag: true }, { inFlight: 'push' }, fake);
  const out = await pipe.resume('run1');
  assert.equal(out.status, 'needs-human');
  assert.match(out.error ?? '', /repobaton check run1/, 'the standalone CLI is pointed at a command that exists');
  assert.deepEqual(fake.calls.filter((c) => !c.startsWith('ls') && c !== 'prView'), [], 'no push / PR / merge / tag was issued');
  assert.equal((await store.load('run1')).publish.inFlight, 'push', 'marker stays until the remote is checked');
});

test('after the remote confirms the push, resume skips it and continues with the next step only', async () => {
  const fake = new FakeRemote();
  fake.branchSha = APPROVED; // placeholder: replaced below with the real approved sha
  const { pipe, store, repo } = await approvedRun({ push: true, createPr: true }, { inFlight: 'push' }, fake);
  const sha = (await store.load('run1')).rounds[0].implement!.sha;
  fake.branchSha = sha;
  const cfg = defaultConfig();
  const checked = await checkAndRecord(store, repo, cfg, 'run1', {}, fake);
  assert.ok(checked.ok && checked.recorded === 'done', JSON.stringify(checked));
  fake.calls = [];
  const out = await pipe.resume('run1');
  assert.equal(out.status, 'succeeded', out.error);
  assert.equal(fake.n('push'), 0, 'the push is not repeated');
  assert.equal(fake.n('createPr'), 1, 'the next step runs once');
  assert.equal(out.publish.prUrl, 'https://github.com/o/r/pull/7');
});

test('a PR created before the interruption is adopted from the remote, not created a second time', async () => {
  const fake = new FakeRemote();
  const { pipe, store, repo } = await approvedRun({ push: true, createPr: true, merge: true }, { inFlight: 'pr', pushed: true }, fake);
  const sha = (await store.load('run1')).rounds[0].implement!.sha;
  fake.pr = { url: 'https://github.com/o/r/pull/7', state: 'OPEN', headSha: sha, mergeCommit: '' };
  assert.ok((await checkAndRecord(store, repo, defaultConfig(), 'run1', {}, fake)).ok);
  fake.calls = [];
  fake.pr = { ...fake.pr, state: 'OPEN' };
  const out = await pipe.resume('run1');
  assert.equal(out.status, 'succeeded', out.error);
  assert.equal(fake.n('createPr'), 0, 'no second PR');
  assert.equal(fake.n('push'), 0);
  assert.equal(fake.n('merge'), 1);
  assert.equal(out.publish.merged, true);
  assert.equal(out.publish.mergeSha, MERGED);
});

test('a merge that already happened is not merged again', async () => {
  const fake = new FakeRemote();
  const { pipe, store, repo } = await approvedRun({ push: true, createPr: true, merge: true }, { inFlight: 'merge', pushed: true, prUrl: 'https://github.com/o/r/pull/7' }, fake);
  const sha = (await store.load('run1')).rounds[0].implement!.sha;
  fake.pr = { url: 'https://github.com/o/r/pull/7', state: 'MERGED', headSha: sha, mergeCommit: MERGED };
  assert.ok((await checkAndRecord(store, repo, defaultConfig(), 'run1', {}, fake)).ok);
  fake.calls = [];
  const out = await pipe.resume('run1');
  assert.equal(out.status, 'succeeded', out.error);
  assert.equal(fake.n('merge'), 0);
  assert.equal(fake.n('createPr'), 0);
  assert.equal(out.publish.mergeSha, MERGED);
});

test('a normal run records its progress step by step and clears the marker each time', async () => {
  const fake = new FakeRemote();
  const { pipe, store } = await approvedRun({ push: true, createPr: true, merge: true }, {}, fake);
  const out = await pipe.resume('run1');
  assert.equal(out.status, 'succeeded', out.error);
  assert.deepEqual(fake.calls.filter((c) => ['push', 'createPr', 'merge'].includes(c)), ['push', 'createPr', 'merge']);
  const disk = (await store.load('run1')).publish;
  assert.equal(disk.inFlight, undefined);
  assert.equal(disk.pushed, true);
  assert.equal(disk.merged, true);
});

test('a failing remote operation leaves the marker set, so the next resume refuses to guess', async () => {
  const fake = new FakeRemote();
  fake.fail.push = 'connection reset';
  const { pipe, store } = await approvedRun({ push: true, createPr: true }, {}, fake);
  const first = await pipe.resume('run1');
  assert.equal(first.status, 'failed');
  assert.equal((await store.load('run1')).publish.inFlight, 'push');
  fake.calls = [];
  fake.fail = {};
  const second = await pipe.resume('run1');
  assert.equal(second.status, 'needs-human');
  assert.equal(fake.n('push'), 0, 'the push is not retried blindly');
});

// ------------------------------------------------------------------ through the server

class StubAgent implements Agent {
  type = 'command' as const;
  id = 'a';
  describe(): string {
    return 'a';
  }
  async check(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: '' };
  }
  async run(_req: AgentRunRequest): Promise<AgentResult> {
    return { text: '', durationMs: 1 };
  }
}

test('server: "check" asks the remote, refuses claims the remote contradicts, and then continuing works', async () => {
  const fake = new FakeRemote();
  const { store, repo } = await approvedRun({}, { inFlight: 'push' }, fake);
  const sha = (await store.load('run1')).rounds[0].implement!.sha;
  await fs.writeFile(path.join(repo, 'repobaton.yaml'), ['agents:', '  a: { type: command, command: x }', 'stages:', '  plan: { agent: a }', '  implement: { agent: a }', '  review: { agent: a }', '  release: { agent: a }', 'publish:', '  push: true', 'test: { setup: "" }', ''].join('\n'));
  const regFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rb-home-')), 'projects.json');
  const registry = new ProjectRegistry(regFile);
  const agentRegistry = { get: () => new StubAgent() } as unknown as AgentRegistry;
  const srv = await startServer({
    registry,
    seedProjects: [repo],
    serverId: 'srv-check',
    probe: async () => ({ alive: false }),
    remote: fake,
    makePipeline: (c) => new Pipeline({ repo: c.repoRoot, config: c.config, registry: agentRegistry, signal: c.signal, owner: c.owner, remote: fake }),
  });
  const call = (method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        { host: '127.0.0.1', port: srv.port, path: p, method, headers: { authorization: `Bearer ${srv.token}`, ...(data ? { 'content-type': 'application/json' } : {}) } },
        (res) => {
          let t = '';
          res.on('data', (c) => (t += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : null }));
        },
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  try {
    const pid = (await call('GET', '/api/projects')).json.projects[0].id as string;
    const base = `/api/projects/${pid}/runs/run1`;
    // The remote has nothing: "it completed" is refused and the marker stays.
    const lie = await call('POST', `${base}/check`, { completed: true });
    assert.equal(lie.status, 422);
    assert.equal(lie.json.error.code, 'contradicts-remote');
    assert.equal((await store.load('run1')).publish.inFlight, 'push');
    // Resume is still blocked.
    assert.equal((await call('POST', `${base}/resume`, { expectStatus: 'interrupted' })).json.error.code, 'wrong-state');
    // Unreachable remote: paused, with a reason.
    fake.fail.lsBranch = 'network unreachable';
    const unk = await call('POST', `${base}/check`, {});
    assert.equal(unk.status, 422);
    assert.equal(unk.json.error.code, 'unconfirmed');
    fake.fail = {};
    // The remote now shows the push: recorded as done, regardless of the earlier claim.
    fake.branchSha = sha;
    const ok = await call('POST', `${base}/check`, {});
    assert.equal(ok.status, 200);
    assert.equal(ok.json.recorded, 'done');
    const after = (await store.load('run1')).publish;
    assert.equal(after.pushed, true);
    assert.equal(after.inFlight, undefined);
    // Nothing to check any more.
    assert.equal((await call('POST', `${base}/check`, {})).status, 409);
    assert.equal(fake.n('push'), 0, 'checking never pushes');
  } finally {
    await srv.close();
  }
});

test('server: a check cannot run while the repository is executing something else', async () => {
  const fake = new FakeRemote();
  const { repo } = await approvedRun({}, { inFlight: 'push' }, fake);
  await fs.writeFile(path.join(repo, 'repobaton.yaml'), ['agents:', '  a: { type: command, command: x }', 'stages:', '  plan: { agent: a }', '  implement: { agent: a }', '  review: { agent: a }', '  release: { agent: a }', 'test: { setup: "" }', ''].join('\n'));
  const regFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rb-home-')), 'projects.json');
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow: Agent = { ...new StubAgent(), type: 'command', id: 'a', describe: () => 'a', check: async () => ({ ok: true, detail: '' }), run: async () => { await gate; return { text: '', durationMs: 1 }; } };
  const srv = await startServer({
    registry: new ProjectRegistry(regFile),
    seedProjects: [repo],
    serverId: 'srv-busy',
    probe: async () => ({ alive: false }),
    remote: fake,
    makePipeline: (c) => new Pipeline({ repo: c.repoRoot, config: c.config, registry: { get: () => slow } as unknown as AgentRegistry, signal: c.signal, owner: c.owner, remote: fake }),
  });
  const call = (method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: srv.port, path: p, method, headers: { authorization: `Bearer ${srv.token}`, ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : null }));
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  try {
    const pid = (await call('GET', '/api/projects')).json.projects[0].id as string;
    const started = await call('POST', `/api/projects/${pid}/runs`, { task: 'hold the slot' });
    assert.equal(started.status, 202);
    const busy = await call('POST', `/api/projects/${pid}/runs/run1/check`, {});
    assert.equal(busy.json.error.code, 'busy');
    release();
  } finally {
    release();
    await srv.close();
  }
});

// ------------------------------------------------------------------ the remote the operation was aimed at

test('a remote that changed since the interruption is never queried, and no claim or evidence overrides that', async () => {
  const ops = new FakeRemote();
  ops.pushes.origin = ['https://github.com/someone/else.git']; // same name, different repository
  ops.branchSha = ''; // the other repository has no such branch: reading it as "not pushed" would be wrong
  for (const claim of [{ completed: false }, { completed: true }, { completed: true, evidence: { remoteSha: APPROVED } }]) {
    const s = stateWith({ inFlight: 'push' });
    const r = await acknowledgePublish(s, ctx(ops), claim);
    assert.ok(!r.ok && r.code === 'contradicts-remote', JSON.stringify(r));
    assert.ok((r as any).message.includes('https://github.com/o/r.git'), 'names the address recorded at interruption');
    assert.ok((r as any).message.includes('https://github.com/someone/else.git'), 'and the one configured now');
    assert.equal(s.publish.inFlight, 'push', 'the marker stays');
    assert.equal(s.publish.pushed, undefined);
  }
  assert.deepEqual(ops.queried, [], 'the changed remote was not asked about the branch');
  assert.equal(ops.n('prView'), 0);
});

test('a remote that was removed or renamed since the interruption keeps the run paused', async () => {
  const ops = new FakeRemote();
  delete ops.pushes.origin;
  const s = stateWith({ inFlight: 'push' });
  const r = await acknowledgePublish(s, ctx(ops), { completed: false });
  assert.ok(!r.ok && r.code === 'contradicts-remote');
  assert.match((r as any).message, /no longer configured/);
  assert.equal(s.publish.inFlight, 'push');
});

test('the check uses the remote recorded at interruption, not the one named in the current configuration', async () => {
  const ops = new FakeRemote();
  ops.pushes.upstream = ['https://github.com/o/up.git'];
  ops.branchSha = APPROVED;
  const s = stateWith({ inFlight: 'push', inFlightTarget: { remote: 'upstream', url: 'https://github.com/o/up.git' } });
  const r = await acknowledgePublish(s, { ...ctx(ops), remote: 'origin' }, { completed: false });
  assert.ok(r.ok && r.recorded === 'done', JSON.stringify(r));
  assert.deepEqual(ops.queried, ['https://github.com/o/up.git'], 'asked at the push address itself');
});

test('a marker without a recorded remote cannot be settled by looking at the current configuration', async () => {
  const ops = new FakeRemote();
  ops.branchSha = APPROVED;
  const s = stateWith({ inFlight: 'push' });
  s.publish.inFlightTarget = undefined;
  const r = await acknowledgePublish(s, ctx(ops), { completed: false });
  assert.ok(!r.ok && r.code === 'unconfirmed');
  assert.equal(ops.queried.length, 0);
  // Evidence from the user is still accepted: it does not rely on a remote lookup.
  const ev = await acknowledgePublish(s, ctx(ops), { completed: true, evidence: { remoteSha: APPROVED } });
  assert.ok(ev.ok, JSON.stringify(ev));
});

// ------------------------------------------------------------------ explicit mismatch is not a gap

test('a pushed branch at another commit stays paused even when the user reports the approved commit', async () => {
  const ops = new FakeRemote();
  ops.branchSha = OTHER;
  const s = stateWith({ inFlight: 'push' });
  const r = await acknowledgePublish(s, ctx(ops), { completed: true, evidence: { remoteSha: APPROVED } });
  assert.ok(!r.ok && r.code === 'contradicts-remote', JSON.stringify(r));
  assert.match((r as any).message, /cccccccc/);
  assert.equal(s.publish.inFlight, 'push');
  assert.equal(s.publish.pushed, undefined);
});

test('a pull request with another head stays paused even with a PR URL as evidence', async () => {
  const ops = new FakeRemote();
  ops.pr = { url: 'https://github.com/o/r/pull/7', state: 'OPEN', headSha: OTHER, mergeCommit: '' };
  const s = stateWith({ inFlight: 'pr' });
  const r = await acknowledgePublish(s, ctx(ops), { completed: true, evidence: { prUrl: 'https://github.com/o/r/pull/7' } });
  assert.ok(!r.ok && r.code === 'contradicts-remote', JSON.stringify(r));
  assert.equal(s.publish.prUrl, undefined);
  assert.equal(s.publish.inFlight, 'pr');
});

test('a merge check on a pull request with another head stays paused even with a merge commit as evidence', async () => {
  const ops = new FakeRemote();
  ops.pr = { url: 'https://github.com/o/r/pull/7', state: 'MERGED', headSha: OTHER, mergeCommit: MERGED };
  const s = stateWith({ inFlight: 'merge', prUrl: 'https://github.com/o/r/pull/7' });
  const r = await acknowledgePublish(s, ctx(ops), { completed: true, evidence: { mergeSha: MERGED } });
  assert.ok(!r.ok && r.code === 'contradicts-remote', JSON.stringify(r));
  assert.equal(s.publish.merged, undefined);
});

test('a remote tag at another commit stays paused even when the user reports the merge commit', async () => {
  const ops = new FakeRemote();
  ops.tagSha = OTHER;
  const s = stateWith({ inFlight: 'tag', pendingTag: 'v1.0.1', mergeSha: MERGED, merged: true });
  const r = await acknowledgePublish(s, ctx(ops), { completed: true, evidence: { remoteSha: MERGED } });
  assert.ok(!r.ok && r.code === 'contradicts-remote', JSON.stringify(r));
  assert.equal(s.publish.tagPushed, undefined);
  assert.equal(s.publish.inFlight, 'tag');
});

test('a lookup that fails is still different from a mismatch: evidence settles it', async () => {
  const down = new FakeRemote();
  down.fail.lsBranch = 'timeout';
  const s = stateWith({ inFlight: 'push' });
  const r = await acknowledgePublish(s, ctx(down), { completed: true, evidence: { remoteSha: APPROVED } });
  assert.ok(r.ok, JSON.stringify(r));
});
