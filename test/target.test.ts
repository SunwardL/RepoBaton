import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentRegistry } from '../src/agents/registry.ts';
import { defaultConfig } from '../src/config.ts';
import { git, githubRepoOf, githubRepoOfPr, realRemoteOps, sanitizeRemoteUrl, type PrInfo, type RemoteOps } from '../src/git.ts';
import { Pipeline } from '../src/pipeline.ts';
import { checkAndRecord } from '../src/publishcheck.ts';
import { RunStore } from '../src/store.ts';
import type { RunState } from '../src/types.ts';

/**
 * Recovery must look where the interrupted step actually wrote. These tests use real git with
 * local bare repositories (nothing leaves the machine) and a recording gh double.
 */

interface Fixture {
  tmp: string;
  repo: string;
  wt: string;
  sha: string;
  fetchRepo: string; // bare: what the "read" address points at
  pushRepo: string; // bare: what the push address points at
  otherRepo: string; // bare: somewhere neither points at
  store: RunStore;
  config: ReturnType<typeof defaultConfig>;
}

const GH = 'https://github.com/o/r.git';

async function bare(dir: string): Promise<string> {
  await git(path.dirname(dir), ['init', '-q', '--bare', dir]);
  return dir;
}

async function fixture(publish: Partial<ReturnType<typeof defaultConfig>['publish']>, seed: RunState['publish'] = {}): Promise<Fixture> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-tgt-'));
  const repo = path.join(tmp, 'repo');
  await fs.mkdir(repo);
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 't@e.com']);
  await git(repo, ['config', 'user.name', 't']);
  await fs.writeFile(path.join(repo, 'v.txt'), 'old\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  const fetchRepo = await bare(path.join(tmp, 'fetch.git'));
  const pushRepo = await bare(path.join(tmp, 'push.git'));
  const otherRepo = await bare(path.join(tmp, 'other.git'));
  await git(repo, ['remote', 'add', 'origin', fetchRepo]);
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
  config.publish = { ...config.publish, push: true, createPr: false, merge: false, tag: false, ...publish };
  const store = new RunStore(repo);
  await store.save({
    id: 'run1',
    task: 't',
    repo,
    status: 'interrupted',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    worktree: wt,
    branch: 'repobaton/x',
    base: { branch: 'main', sha: base },
    setupDone: true,
    planApproved: true,
    planVersion: 1,
    rounds: [{ n: 1, decision: 'approved', implement: { agent: 'a', sha, summary: '', changedFiles: ['v.txt'], durationMs: 1 }, test: { skipped: true, exitCode: null, durationMs: 0, sha, outputTail: '' } }],
    release: { version_bump: 'patch', suggested_version: '1.0.1', pr_title: 't', pr_body: 'b', release_notes: 'n', risks: [] },
    plan: { summary: 's', steps: [], acceptance: [], risks: [], test_hints: [] },
    publish: seed,
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, calls: 0 },
  } as RunState);
  return { tmp, repo, wt, sha, fetchRepo, pushRepo, otherRepo, store, config };
}

const registry = { get: () => ({}) } as unknown as AgentRegistry;
const refs = async (bareDir: string): Promise<string> => (await git(bareDir, ['for-each-ref', '--format=%(refname)'])).trim();

test('publishing refuses a branch switched by a release agent at the same SHA', async () => {
  const f = await fixture({ push: true });
  await git(f.repo, ['remote', 'set-url', '--push', 'origin', f.pushRepo]);
  const state = await f.store.load('run1');
  state.release = undefined;
  await f.store.save(state);
  const draft = { version_bump: 'patch', suggested_version: '1.0.1', pr_title: 't', pr_body: 'b', release_notes: 'n', risks: [] };
  const agent = { id: 'a', type: 'command', describe: () => 'fake', run: async () => {
    await git(f.wt, ['checkout', '-q', '-b', 'alternate-at-approved-sha']);
    return { text: JSON.stringify(draft), structured: draft, durationMs: 1 };
  } };
  const fakeRegistry = { get: () => agent } as unknown as AgentRegistry;
  const out = await new Pipeline({ repo: f.repo, config: f.config, registry: fakeRegistry }).resume('run1');
  assert.equal(out.status, 'needs-human');
  assert.match(out.error ?? '', /task branch.*not checked out/);
  assert.equal(await refs(f.pushRepo), '');
  assert.equal((await f.store.load('run1')).publish.inFlight, undefined);
});

/** A real push that completes on the remote, after which the process "dies" before recording it. */
const crashAfter = (name: 'push' | 'pushTag'): RemoteOps => ({
  ...realRemoteOps,
  [name]: async (cwd: string, remote: string, what: string) => {
    await realRemoteOps[name](cwd, remote, what);
    throw new Error('process killed');
  },
});

async function interrupted(f: Fixture): Promise<RunState> {
  const out = await new Pipeline({ repo: f.repo, config: f.config, registry, remote: crashAfter('push') }).resume('run1');
  assert.equal(out.status, 'failed');
  const st = await f.store.load('run1');
  assert.equal(st.publish.inFlight, 'push');
  return st;
}

// ------------------------------------------------------------------ push: the write address, not the read address

test('fetch and push addresses differ: the interruption records the push address, and a branch present only there is found', async () => {
  const f = await fixture({});
  await git(f.repo, ['remote', 'set-url', '--push', 'origin', f.pushRepo]);
  const st = await interrupted(f);
  assert.equal(st.publish.inFlightTarget?.url, f.pushRepo, 'the push address is recorded, not the fetch address');
  assert.match(await refs(f.pushRepo), /refs\/heads\/repobaton\/x/);
  assert.equal(await refs(f.fetchRepo), '', 'nothing was written to the read address');
  // Asking `origin` by name would read fetch.git, find no branch and call the push "not done".
  const r = await checkAndRecord(f.store, f.repo, f.config, 'run1', {});
  assert.ok(r.ok && r.recorded === 'done', JSON.stringify(r));
  assert.equal((await f.store.load('run1')).publish.pushed, true);
  const resumed = await new Pipeline({ repo: f.repo, config: f.config, registry, remote: realRemoteOps }).resume('run1');
  assert.equal(resumed.status, 'succeeded', resumed.error);
});

test('with only the push address lacking the branch, "did not happen" is accepted (the read address is irrelevant)', async () => {
  const f = await fixture({});
  await git(f.repo, ['remote', 'set-url', '--push', 'origin', f.pushRepo]);
  await interrupted(f);
  await git(f.pushRepo, ['update-ref', '-d', 'refs/heads/repobaton/x']);
  // A branch with the right name on the READ address must not make the push look done either.
  await git(f.wt, ['push', '-q', f.fetchRepo, 'repobaton/x:refs/heads/repobaton/x']);
  const claimed = await checkAndRecord(f.store, f.repo, f.config, 'run1', { completed: true });
  assert.ok(!claimed.ok && claimed.code === 'contradicts-remote', JSON.stringify(claimed));
  const r = await checkAndRecord(f.store, f.repo, f.config, 'run1', { completed: false });
  assert.ok(r.ok && r.recorded === 'not-done', JSON.stringify(r));
});

test('only the push address is changed after the interruption: nothing is queried and nothing can be recorded', async () => {
  const f = await fixture({});
  await git(f.repo, ['remote', 'set-url', '--push', 'origin', f.pushRepo]);
  await interrupted(f);
  await git(f.repo, ['remote', 'set-url', '--push', 'origin', f.otherRepo]);
  for (const claim of [{}, { completed: false }, { completed: true, evidence: { remoteSha: f.sha } }]) {
    const r = await checkAndRecord(f.store, f.repo, f.config, 'run1', claim);
    assert.ok(!r.ok && r.code === 'contradicts-remote', JSON.stringify(r));
    assert.ok(r.message.includes('now pushes to'), r.message);
  }
  assert.equal((await f.store.load('run1')).publish.inFlight, 'push');
  const blocked = await new Pipeline({ repo: f.repo, config: f.config, registry, remote: realRemoteOps }).resume('run1');
  assert.equal(blocked.status, 'needs-human');
  assert.equal(await refs(f.otherRepo), '', 'the new target was never written to');
});

test('the read address is changed but the push address is not: the check is unaffected', async () => {
  const f = await fixture({});
  await git(f.repo, ['remote', 'set-url', '--push', 'origin', f.pushRepo]);
  await interrupted(f);
  await git(f.repo, ['remote', 'set-url', 'origin', f.otherRepo]);
  const r = await checkAndRecord(f.store, f.repo, f.config, 'run1', {});
  assert.ok(r.ok && r.recorded === 'done', JSON.stringify(r));
});

test('a remote with several push addresses stops before pushing anything', async () => {
  const f = await fixture({});
  await git(f.repo, ['remote', 'set-url', '--add', '--push', 'origin', f.pushRepo]);
  await git(f.repo, ['remote', 'set-url', '--add', '--push', 'origin', f.otherRepo]);
  const out = await new Pipeline({ repo: f.repo, config: f.config, registry, remote: realRemoteOps }).resume('run1');
  assert.equal(out.status, 'needs-human');
  assert.match(out.error ?? '', /2 push addresses/);
  assert.equal(await refs(f.pushRepo), '');
  assert.equal(await refs(f.otherRepo), '');
  assert.equal((await f.store.load('run1')).publish.inFlight, undefined, 'no marker: nothing was started');
});

test('push addresses that grow after the interruption keep the run paused', async () => {
  const f = await fixture({});
  await interrupted(f);
  await git(f.repo, ['remote', 'set-url', '--add', '--push', 'origin', f.fetchRepo]);
  await git(f.repo, ['remote', 'set-url', '--add', '--push', 'origin', f.otherRepo]);
  const r = await checkAndRecord(f.store, f.repo, f.config, 'run1', { completed: true, evidence: { remoteSha: f.sha } });
  assert.ok(!r.ok && r.code === 'contradicts-remote');
  assert.match(r.message, /2 push addresses/);
});

test('a tag step records and checks the tag push address as well', async () => {
  const f = await fixture({ push: false, createPr: false, merge: false, tag: true }, { pushed: true, merged: true, mergeSha: undefined });
  await git(f.repo, ['remote', 'set-url', '--push', 'origin', f.pushRepo]);
  // The tag points at the merge commit; here the base commit stands in for it.
  const merge = (await git(f.repo, ['rev-parse', 'main'])).trim();
  // The merge commit has to be on the base branch of the repository the tag is written to.
  await git(f.repo, ['push', '-q', f.pushRepo, 'main:refs/heads/main']);
  const st = await f.store.load('run1');
  st.publish.mergeSha = merge;
  await f.store.save(st);
  const out = await new Pipeline({ repo: f.repo, config: f.config, registry, remote: crashAfter('pushTag') }).resume('run1');
  assert.equal(out.status, 'failed');
  const after = await f.store.load('run1');
  assert.equal(after.publish.inFlight, 'tag');
  assert.equal(after.publish.inFlightTarget?.url, f.pushRepo);
  assert.match(await refs(f.pushRepo), /refs\/tags\/v1\.0\.1/);
  assert.equal(await refs(f.fetchRepo), '');
  const r = await checkAndRecord(f.store, f.repo, f.config, 'run1', {});
  assert.ok(r.ok && r.recorded === 'done', JSON.stringify(r));
  // Repointing only the push address afterwards is refused.
  const g = await fixture({ push: false, tag: true }, { pushed: true, merged: true, mergeSha: merge, inFlight: 'tag', pendingTag: 'v1.0.1', inFlightTarget: { remote: 'origin', url: f.pushRepo } });
  await git(g.repo, ['remote', 'set-url', '--push', 'origin', g.otherRepo]);
  const blocked = await checkAndRecord(g.store, g.repo, g.config, 'run1', { completed: true, evidence: { remoteSha: merge } });
  assert.ok(!blocked.ok && blocked.code === 'contradicts-remote');
});

test('a run without a recorded target (older record) never guesses from the current configuration', async () => {
  const f = await fixture({}, { inFlight: 'push' });
  await git(f.wt, ['push', '-q', f.fetchRepo, 'repobaton/x:refs/heads/repobaton/x']);
  const r = await checkAndRecord(f.store, f.repo, f.config, 'run1', {});
  assert.ok(!r.ok && r.code === 'unconfirmed', JSON.stringify(r));
  const ev = await checkAndRecord(f.store, f.repo, f.config, 'run1', { completed: true, evidence: { remoteSha: f.sha } });
  assert.ok(ev.ok, 'evidence from the user still settles an old record');
});

test('credentials in a push address never reach the run state', async () => {
  const f = await fixture({});
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  await git(f.repo, ['remote', 'set-url', '--push', 'origin', `https://user:${secret}@github.com/o/r.git`]);
  const fake: RemoteOps = { ...realRemoteOps, push: async () => { throw new Error('network down'); } };
  await new Pipeline({ repo: f.repo, config: f.config, registry, remote: fake }).resume('run1');
  const raw = await fs.readFile(path.join(f.store.dir('run1'), 'state.json'), 'utf8');
  assert.ok(!raw.includes(secret) && !raw.includes('user:'), 'no credential in state.json');
  assert.ok(raw.includes('https://github.com/o/r.git'));
});

// ------------------------------------------------------------------ pull requests: one explicit GitHub repository

class GhDouble implements RemoteOps {
  calls: { op: string; repo: string; ref?: string }[] = [];
  pr: PrInfo | null = null;
  prUrl = 'https://github.com/o/r/pull/7';
  head = '';
  push = realRemoteOps.push;
  pushTag = realRemoteOps.pushTag;
  fetchMergeCommit = realRemoteOps.fetchMergeCommit;
  pushUrls = realRemoteOps.pushUrls;
  remoteBranchSha = realRemoteOps.remoteBranchSha;
  remoteTagTarget = realRemoteOps.remoteTagTarget;
  ghAvailable = async (): Promise<boolean> => true;
  ghCreatePr = async (_c: string, o: { repo: string }): Promise<string> => {
    this.calls.push({ op: 'create', repo: o.repo });
    this.pr = { url: this.prUrl, state: 'OPEN', headSha: this.head, mergeCommit: '' };
    return this.prUrl;
  };
  ghMarkReady = async (_c: string, _p: string, repo: string): Promise<void> => void this.calls.push({ op: 'ready', repo });
  ghMergePr = async (_c: string, _p: string, _s: string, repo: string): Promise<void> => {
    this.calls.push({ op: 'merge', repo });
    if (this.pr) this.pr = { ...this.pr, state: 'MERGED', mergeCommit: 'b'.repeat(40) };
  };
  ghMergeCommit = async (_c: string, _p: string, repo: string): Promise<string> => {
    this.calls.push({ op: 'mergeCommit', repo });
    return this.pr?.mergeCommit ?? '';
  };
  ghPrView = async (_c: string, ref: string, repo: string): Promise<PrInfo | null> => {
    this.calls.push({ op: 'view', repo, ref });
    return this.pr;
  };
}

async function prFixture(url: string, publish: Partial<ReturnType<typeof defaultConfig>['publish']> = {}, seed: RunState['publish'] = {}): Promise<{ f: Fixture; gh: GhDouble }> {
  const f = await fixture({ push: false, createPr: true, merge: false, tag: false, ...publish }, { pushed: true, ...seed });
  await git(f.repo, ['remote', 'set-url', 'origin', url]);
  const gh = new GhDouble();
  gh.head = f.sha;
  const repoName = githubRepoOf(url);
  if (repoName) gh.prUrl = `https://${repoName}/pull/7`;
  return { f, gh };
}

test('create, merge and the recovery query all name the same GitHub repository explicitly', async () => {
  const { f, gh } = await prFixture('git@github.com:Owner/Repo.git', { merge: true });
  const out = await new Pipeline({ repo: f.repo, config: f.config, registry, remote: gh }).resume('run1');
  assert.equal(out.status, 'succeeded', out.error);
  assert.deepEqual([...new Set(gh.calls.map((c) => c.repo))], ['github.com/owner/repo']);
  assert.deepEqual(gh.calls.map((c) => c.op), ['create', 'ready', 'merge', 'mergeCommit']);
  // And the recovery query uses the repository recorded, not one gh guesses from the directory.
  const st = await f.store.load('run1');
  st.publish = { pushed: true, inFlight: 'pr', inFlightTarget: { remote: 'origin', url: 'ssh://github.com/Owner/Repo.git', githubRepo: 'github.com/owner/repo' } };
  st.status = 'interrupted';
  await f.store.save(st);
  gh.calls = [];
  gh.pr = { url: 'https://github.com/owner/repo/pull/7', state: 'OPEN', headSha: f.sha, mergeCommit: '' };
  await git(f.repo, ['remote', 'set-url', 'origin', 'ssh://git@github.com/Owner/Repo.git']);
  const r = await checkAndRecord(f.store, f.repo, f.config, 'run1', {}, gh);
  assert.ok(r.ok && r.recorded === 'done', JSON.stringify(r));
  assert.deepEqual(gh.calls, [{ op: 'view', repo: 'github.com/owner/repo', ref: 'repobaton/x' }]);
});

test('a merged PR with an unreadable merge commit remains in-flight for remote recovery', async () => {
  const { f, gh } = await prFixture('https://github.com/o/r.git', { merge: true });
  gh.ghMergeCommit = async () => '';
  const pipeline = new Pipeline({ repo: f.repo, config: f.config, registry, remote: gh });
  const paused = await pipeline.resume('run1');
  assert.equal(paused.status, 'needs-human');
  assert.equal(paused.publish.inFlight, 'merge');
  assert.equal(paused.publish.merged, undefined);
  const checked = await checkAndRecord(f.store, f.repo, f.config, 'run1', {}, gh);
  assert.equal(checked.ok, true);
  if (checked.ok) assert.equal(checked.recorded, 'done');
  const resumed = await pipeline.resume('run1');
  assert.equal(resumed.status, 'succeeded', resumed.error);
  assert.equal(resumed.publish.mergeSha, 'b'.repeat(40));
  assert.equal(gh.calls.filter((call) => call.op === 'merge').length, 1);
});

test('a pull request answer from another repository is a conflict that no evidence overrides', async () => {
  const { f, gh } = await prFixture('https://github.com/o/r.git', {}, { inFlight: 'pr', inFlightTarget: { remote: 'origin', url: 'https://github.com/o/r.git', githubRepo: 'github.com/o/r' } });
  gh.pr = { url: 'https://github.com/someone/else/pull/7', state: 'OPEN', headSha: f.sha, mergeCommit: '' };
  for (const claim of [{ completed: false }, { completed: true, evidence: { prUrl: 'https://github.com/o/r/pull/7' } }]) {
    const r = await checkAndRecord(f.store, f.repo, f.config, 'run1', claim, gh);
    assert.ok(!r.ok && r.code === 'contradicts-remote', JSON.stringify(r));
    assert.match(r.message, /someone\/else/);
  }
  assert.equal((await f.store.load('run1')).publish.prUrl, undefined);
});

test('a merge step whose recorded pull request lives in another repository is refused, before and after the interruption', async () => {
  const stray = 'https://github.com/someone/else/pull/7';
  const { f, gh } = await prFixture('https://github.com/o/r.git', { merge: true, createPr: false }, { prUrl: stray });
  const out = await new Pipeline({ repo: f.repo, config: f.config, registry, remote: gh }).resume('run1');
  assert.equal(out.status, 'needs-human');
  assert.match(out.error ?? '', /not in github\.com\/o\/r/);
  assert.deepEqual(gh.calls, [], 'gh was never called');
  assert.equal((await f.store.load('run1')).publish.inFlight, undefined);
  const st = await f.store.load('run1');
  st.publish = { pushed: true, prUrl: stray, inFlight: 'merge', inFlightTarget: { remote: 'origin', url: 'https://github.com/o/r.git', githubRepo: 'github.com/o/r' } };
  await f.store.save(st);
  gh.pr = { url: stray, state: 'MERGED', headSha: f.sha, mergeCommit: 'b'.repeat(40) };
  const r = await checkAndRecord(f.store, f.repo, f.config, 'run1', { completed: true, evidence: { mergeSha: 'b'.repeat(40) } }, gh);
  assert.ok(!r.ok && r.code === 'contradicts-remote', JSON.stringify(r));
  assert.deepEqual(gh.calls, [], 'the foreign pull request was not even queried');
});

test('a PR created in a different repository than the one pushed to leaves the marker set', async () => {
  const { f, gh } = await prFixture('https://github.com/o/r.git');
  gh.prUrl = 'https://github.com/someone/else/pull/9';
  const out = await new Pipeline({ repo: f.repo, config: f.config, registry, remote: gh }).resume('run1');
  assert.equal(out.status, 'needs-human');
  const st = await f.store.load('run1');
  assert.equal(st.publish.inFlight, 'pr');
  assert.equal(st.publish.prUrl, undefined);
});

test('a PR step on an address that is not github.com stops before calling gh', async () => {
  for (const url of ['https://gitlab.com/o/r.git', 'https://ghe.example.com/o/r.git']) {
    const { f, gh } = await prFixture(url);
    const out = await new Pipeline({ repo: f.repo, config: f.config, registry, remote: gh }).resume('run1');
    assert.equal(out.status, 'needs-human');
    assert.match(out.error ?? '', /not a github\.com address/);
    assert.deepEqual(gh.calls, []);
    assert.equal((await f.store.load('run1')).publish.inFlight, undefined);
  }
});

test('a PR record without a GitHub repository (older record) cannot be settled by looking', async () => {
  const { f, gh } = await prFixture('https://github.com/o/r.git', {}, { inFlight: 'pr', inFlightTarget: { remote: 'origin', url: 'https://github.com/o/r.git' } });
  gh.pr = { url: 'https://github.com/o/r/pull/7', state: 'OPEN', headSha: f.sha, mergeCommit: '' };
  const r = await checkAndRecord(f.store, f.repo, f.config, 'run1', {}, gh);
  assert.ok(!r.ok && r.code === 'unconfirmed', JSON.stringify(r));
  assert.deepEqual(gh.calls, []);
});

// ------------------------------------------------------------------ address helpers

test('GitHub repository identification accepts the usual forms and nothing else', () => {
  for (const a of ['https://github.com/Owner/Repo.git', 'https://user:tok@github.com/owner/repo', 'git@github.com:owner/repo.git', 'ssh://git@github.com/owner/repo.git', 'ssh://git@github.com:22/owner/repo/']) {
    assert.equal(githubRepoOf(a), 'github.com/owner/repo', a);
  }
  for (const a of ['https://gitlab.com/o/r.git', 'https://github.com.evil.example/o/r.git', 'https://github.com/o', 'C:\\repos\\x.git', '/tmp/x.git', '../x.git', 'https://github.com/o/r/extra']) {
    assert.equal(githubRepoOf(a), null, a);
  }
  assert.equal(githubRepoOfPr('https://github.com/Owner/Repo/pull/12'), 'github.com/owner/repo');
  assert.equal(githubRepoOfPr('https://github.com/owner/repo/issues/12'), null);
  assert.equal(sanitizeRemoteUrl('https://user:tok@github.com/o/r.git?x=1'), 'https://github.com/o/r.git');
});

// ------------------------------------------------------------------ tag: the merge commit comes from the write repository

/**
 * A commit that exists only where it is pushed: the stand-in for a PR merge commit. It is built in
 * a scratch clone so the repository under test never holds it locally and has to fetch it.
 */
async function mergeCommitOn(f: Fixture, where: string[]): Promise<string> {
  const scratch = path.join(f.tmp, 'scratch-' + Math.random().toString(36).slice(2, 8));
  await git(f.tmp, ['clone', '-q', f.repo, scratch]);
  await git(scratch, ['config', 'user.email', 't@e.com']);
  await git(scratch, ['config', 'user.name', 't']);
  await fs.writeFile(path.join(scratch, 'merged.txt'), 'merged\n');
  await git(scratch, ['add', 'merged.txt']);
  await git(scratch, ['commit', '-q', '-m', 'merge commit']);
  const sha = (await git(scratch, ['rev-parse', 'HEAD'])).trim();
  for (const w of where) await git(scratch, ['push', '-q', w, 'HEAD:refs/heads/main']);
  return sha;
}

async function tagFixture(): Promise<Fixture> {
  const f = await fixture({ push: false, createPr: false, merge: false, tag: true }, { pushed: true, merged: true });
  await git(f.repo, ['remote', 'set-url', '--push', 'origin', f.pushRepo]);
  return f;
}

test('tag: a merge commit that exists only in the write repository is fetched from there and tagged, and only there', async () => {
  const f = await tagFixture();
  const merge = await mergeCommitOn(f, [f.pushRepo]);
  assert.equal(await refs(f.fetchRepo), '', 'the read repository has nothing');
  await assert.rejects(git(f.repo, ['cat-file', '-e', merge + '^{commit}']), 'the commit is not local before the tag step');
  const st = await f.store.load('run1');
  st.publish.mergeSha = merge;
  await f.store.save(st);
  const out = await new Pipeline({ repo: f.repo, config: f.config, registry, remote: realRemoteOps }).resume('run1');
  assert.equal(out.status, 'succeeded', out.error);
  assert.equal((await git(f.pushRepo, ['rev-parse', 'refs/tags/v1.0.1^{commit}'])).trim(), merge, 'the tag points at the merge commit');
  assert.match(await refs(f.pushRepo), /refs\/tags\/v1\.0\.1/);
  assert.equal(await refs(f.fetchRepo), '', 'the tag never reached the read repository');
  assert.equal(await refs(f.otherRepo), '');
  const after = await f.store.load('run1');
  assert.equal(after.publish.tagPushed, true);
  assert.equal(after.publish.inFlight, undefined);
});

test('tag: a merge commit that only the read repository has is refused, and nothing is tagged anywhere', async () => {
  const f = await tagFixture();
  const merge = await mergeCommitOn(f, [f.fetchRepo]);
  const st = await f.store.load('run1');
  st.publish.mergeSha = merge;
  await f.store.save(st);
  const out = await new Pipeline({ repo: f.repo, config: f.config, registry, remote: realRemoteOps }).resume('run1');
  assert.equal(out.status, 'needs-human');
  assert.match(out.error ?? '', /refusing to tag/);
  const after = await f.store.load('run1');
  assert.equal(after.publish.inFlight, undefined, 'nothing was started');
  assert.equal(after.publish.tagPushed, undefined);
  assert.equal((await git(f.repo, ['tag', '--list'])).trim(), '', 'no local tag was created');
  assert.equal(await refs(f.pushRepo), '');
  assert.doesNotMatch(await refs(f.fetchRepo), /refs\/tags\//);
});

test('tag: a write repository whose base branch does not contain the merge commit is refused', async () => {
  const f = await tagFixture();
  const merge = await mergeCommitOn(f, [f.otherRepo]);
  await git(f.repo, ['push', '-q', f.pushRepo, 'main:refs/heads/main']); // the write side has a main, but not that commit
  const st = await f.store.load('run1');
  st.publish.mergeSha = merge;
  await f.store.save(st);
  const out = await new Pipeline({ repo: f.repo, config: f.config, registry, remote: realRemoteOps }).resume('run1');
  assert.equal(out.status, 'needs-human');
  assert.match(out.error ?? '', /refusing to tag/);
  assert.equal((await f.store.load('run1')).publish.inFlight, undefined);
  assert.equal((await git(f.repo, ['tag', '--list'])).trim(), '');
  assert.doesNotMatch(await refs(f.pushRepo), /refs\/tags\//);
});
