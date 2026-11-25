import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentRegistry } from '../src/agents/registry.ts';
import { defaultConfig } from '../src/config.ts';
import { eventsFile, readEvents } from '../src/events.ts';
import { git } from '../src/git.ts';
import { Pipeline, PipelineError } from '../src/pipeline.ts';
import { ProjectRegistry } from '../src/projects.ts';
import { cleanupRun, CleanupRefused, ownerIsGone, recoverInterrupted } from '../src/recovery.ts';
import { startServer } from '../src/server/server.ts';
import { RunStore } from '../src/store.ts';
import type { Agent, AgentResult, AgentRunRequest, RunState } from '../src/types.ts';

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-rec-'));
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 't@e.com']);
  await git(dir, ['config', 'user.name', 't']);
  await fs.writeFile(path.join(dir, 'value.txt'), 'old\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function stateOf(over: Partial<RunState>): RunState {
  return {
    id: over.id ?? `run-${Math.random().toString(36).slice(2, 8)}`,
    task: 't',
    repo: '/x',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rounds: [],
    publish: {},
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, calls: 0 },
    ...over,
  };
}

const owner = (serverId: string, pid = 424242, startedAt = '2026-01-01T00:00:00.000Z') => ({ serverId, pid, startedAt });
const dead = async () => ({ alive: false });
const alive = (startedAt?: number) => async () => ({ alive: true, startedAt });

test('ownerIsGone: dead pid is gone; live pid is not; a reused pid (started later) is gone', async () => {
  assert.equal(await ownerIsGone(owner('s'), dead), true);
  assert.equal(await ownerIsGone(owner('s'), alive(Date.parse('2026-01-01T00:00:00.000Z'))), false);
  assert.equal(await ownerIsGone(owner('s'), alive(Date.parse('2026-01-01T00:00:02.000Z'))), false, 'within tolerance');
  assert.equal(await ownerIsGone(owner('s'), alive(Date.parse('2026-06-01T00:00:00.000Z'))), true, 'pid was reused by a newer process');
  assert.equal(await ownerIsGone(owner('s'), alive(undefined)), false, 'cannot tell: do not guess');
});

test('recovery marks only runs whose previous server is gone', async () => {
  const repo = await makeRepo();
  const store = new RunStore(repo);
  await store.save(stateOf({ id: 'old-server', status: 'running', stage: 'implement-r1', owner: owner('old') }));
  await store.save(stateOf({ id: 'cli-run', status: 'running', stage: 'review-r1' })); // no owner: a standalone CLI run
  await store.save(stateOf({ id: 'live-owner', status: 'running', owner: owner('other', 111) }));
  await store.save(stateOf({ id: 'finished', status: 'succeeded', owner: owner('old') }));
  await store.save(stateOf({ id: 'waiting', status: 'awaiting-plan-approval', owner: owner('old') }));

  const probe = async (pid: number) => (pid === 111 ? { alive: true, startedAt: Date.parse('2026-01-01T00:00:00.000Z') } : { alive: false });
  const r = await recoverInterrupted(store, { currentServerId: 'new', isExecuting: () => false, probe });

  assert.deepEqual(r.interrupted, ['old-server']);
  assert.equal((await store.load('old-server')).status, 'interrupted');
  assert.equal((await store.load('cli-run')).status, 'running', 'a standalone CLI run is never touched');
  assert.equal((await store.load('live-owner')).status, 'running', 'a live owner is left alone');
  assert.equal((await store.load('finished')).status, 'succeeded');
  assert.equal((await store.load('waiting')).status, 'awaiting-plan-approval');
  assert.ok(r.skipped.some((s) => s.id === 'cli-run'));
  assert.ok(r.skipped.some((s) => s.id === 'live-owner'));

  const events = await readEvents(eventsFile(store.dir('old-server')));
  assert.deepEqual(events.map((e) => e.type), ['run.interrupted', 'run.finished'], 'closing event is written before the status');
});

test('recovery keeps the worktree, commits, approvals and report', async () => {
  const repo = await makeRepo();
  const store = new RunStore(repo);
  const wt = path.join(repo, '.repobaton', 'worktrees', 'r1');
  await fs.mkdir(wt, { recursive: true });
  await fs.mkdir(store.dir('r1'), { recursive: true });
  await fs.writeFile(path.join(store.dir('r1'), 'report.md'), '# report');
  await store.save(
    stateOf({
      id: 'r1',
      status: 'running',
      owner: owner('old'),
      worktree: wt,
      branch: 'repobaton/x',
      planApproved: true,
      plan: { summary: 's', steps: [], acceptance: ['a'], risks: [], test_hints: [] },
      rounds: [{ n: 1, implement: { agent: 'a', sha: 'abc', summary: '', changedFiles: [], durationMs: 1 } }],
    }),
  );
  await recoverInterrupted(store, { currentServerId: 'new', isExecuting: () => false, probe: dead });
  const s = await store.load('r1');
  assert.equal(s.status, 'interrupted');
  assert.equal(s.worktree, wt);
  assert.equal(s.branch, 'repobaton/x');
  assert.equal(s.planApproved, true);
  assert.equal(s.rounds[0].implement?.sha, 'abc');
  assert.equal(await fs.readFile(path.join(store.dir('r1'), 'report.md'), 'utf8'), '# report');
  assert.ok(await fs.stat(wt));
});

test('a run this server is executing is never marked interrupted', async () => {
  const repo = await makeRepo();
  const store = new RunStore(repo);
  await store.save(stateOf({ id: 'mine', status: 'running', owner: owner('me') }));
  const r = await recoverInterrupted(store, { currentServerId: 'me', isExecuting: (id) => id === 'mine', probe: dead });
  assert.deepEqual(r.interrupted, []);
  assert.equal((await store.load('mine')).status, 'running');
});

test('cleanup: refuses executing and running runs, removes only worktrees inside the repository', async () => {
  const repo = await makeRepo();
  const store = new RunStore(repo);
  const wtDir = path.join(repo, '.repobaton', 'worktrees', 'done');
  await git(repo, ['worktree', 'add', '-b', 'repobaton/done', wtDir, 'HEAD']);
  await store.save(stateOf({ id: 'done', status: 'succeeded', worktree: wtDir, branch: 'repobaton/done' }));
  await store.save(stateOf({ id: 'busy', status: 'interrupted', worktree: wtDir }));
  await store.save(stateOf({ id: 'live', status: 'running' }));
  await store.save(stateOf({ id: 'outside', status: 'failed', worktree: os.tmpdir() }));

  const removed: string[] = [];
  const rm = async (_r: string, d: string): Promise<void> => void removed.push(d);

  await assert.rejects(cleanupRun(store, repo, 'busy', (id) => id === 'busy', rm), CleanupRefused);
  await assert.rejects(cleanupRun(store, repo, 'live', () => false, rm), CleanupRefused);
  await assert.rejects(cleanupRun(store, repo, 'outside', () => false, rm), CleanupRefused);
  assert.deepEqual(removed, [], 'nothing was removed by the refused attempts');

  const r = await cleanupRun(store, repo, 'done', () => false, rm);
  assert.equal(r.removedWorktree, true);
  assert.equal(r.keptBranch, 'repobaton/done', 'the branch and its commits are kept');
  assert.deepEqual(removed, [wtDir]);
  assert.equal((await store.load('done')).worktree, undefined);
});

// ------------------------------------------------------------------ publish-step safety

test('resuming after an interrupted external step stops for a human instead of repeating it', async () => {
  const repo = await makeRepo();
  const config = defaultConfig();
  config.agents = { a: { type: 'command', command: 'x' } };
  for (const s of ['plan', 'implement', 'review', 'release'] as const) config.stages[s].agent = 'a';
  config.publish.push = true;
  config.test.setup = '';
  const pipe = new Pipeline({ repo, config, registry: { get: () => ({}) } as unknown as AgentRegistry });
  const publish = (pipe as unknown as { publish: (s: RunState, sha: string) => Promise<void> }).publish.bind(pipe);
  const state = stateOf({ id: 'p1', repo, worktree: repo, branch: 'b', publish: { inFlight: 'push' } });
  await assert.rejects(publish(state, 'abc'), (e: unknown) => e instanceof PipelineError && e.status === 'needs-human' && /push/.test(e.message));
});

// ------------------------------------------------------------------ through the server

class Fake implements Agent {
  type = 'command' as const;
  id = 'a';
  describe(): string {
    return 'a';
  }
  async check(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: '' };
  }
  async run(req: AgentRunRequest): Promise<AgentResult> {
    let out: unknown;
    if (req.prompt.includes('PLANNER')) {
      out = { summary: 's', steps: [{ title: 't', detail: 'd', files: [] }], acceptance: ['x'], risks: [], test_hints: [] };
    } else if (req.prompt.includes('IMPLEMENTER')) {
      await fs.writeFile(path.join(req.cwd, 'value.txt'), 'good\n');
      out = 'done';
    } else if (req.prompt.includes('RELEASE MANAGER')) {
      out = { version_bump: 'patch', suggested_version: '1.0.1', pr_title: 'x', pr_body: 'b', release_notes: 'n', risks: [] };
    } else {
      out = { verdict: 'approve', summary: 'ok', issues: [] };
    }
    return req.schema ? { text: JSON.stringify(out), structured: out, durationMs: 1 } : { text: String(out), durationMs: 1 };
  }
}

async function bootServer(repo: string, regFile: string, serverId: string, probe = dead) {
  const registry = new ProjectRegistry(regFile);
  const agentRegistry = { get: () => new Fake() } as unknown as AgentRegistry;
  const srv = await startServer({
    registry,
    seedProjects: [repo],
    serverId,
    probe,
    makePipeline: (ctx) =>
      new Pipeline({
        repo: ctx.repoRoot,
        config: { ...ctx.config, test: { ...ctx.config.test, setup: '', command: 'node -e "process.exit(0)"' } },
        registry: agentRegistry,
        signal: ctx.signal,
        owner: ctx.owner,
      }),
  });
  const call = (method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        { host: '127.0.0.1', port: srv.port, path: p, method, headers: { authorization: `Bearer ${srv.token}`, ...(data ? { 'content-type': 'application/json' } : {}) } },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
        },
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  const projects = (await call('GET', '/api/projects')).json.projects;
  return { srv, call, projectId: projects[0].id as string };
}

test('server restart: an orphaned run shows as interrupted, keeps its work, and can be resumed', async () => {
  const repo = await makeRepo();
  const regFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rb-home-')), 'projects.json');

  // First server: leave a run mid-flight, as if the process was killed.
  const first = await bootServer(repo, regFile, 'server-one');
  const store = new RunStore((await new ProjectRegistry(regFile).list())[0].root);
  const wt = path.join(store.root, '..', 'worktrees', 'orphan');
  await fs.mkdir(path.dirname(wt), { recursive: true });
  await git(repo, ['worktree', 'add', '-b', 'repobaton/orphan', wt, 'HEAD']);
  await store.save(
    stateOf({
      id: 'orphan',
      task: 'make value good',
      repo,
      status: 'running',
      stage: 'implement-r1',
      owner: owner('server-one'),
      worktree: wt,
      base: { branch: 'main', sha: (await git(repo, ['rev-parse', 'HEAD'])).trim() },
      branch: 'repobaton/orphan',
      planApproved: true,
      plan: { summary: 's', steps: [], acceptance: ['x'], risks: [], test_hints: [] },
    }),
  );
  await first.srv.close();

  // Second server: starts up and finds nobody executing it.
  const second = await bootServer(repo, regFile, 'server-two');
  try {
    const run = (await second.call('GET', `/api/projects/${second.projectId}/runs`)).json.runs.find((r: any) => r.id === 'orphan');
    assert.equal(run.status, 'interrupted');
    assert.equal(run.executing, false);
    assert.equal(run.hasWorktree, true, 'worktree is kept');
    const projects = (await second.call('GET', '/api/projects')).json.projects;
    assert.equal(projects[0].needsAttention, 1, 'it shows up as needing attention');

    // Resuming is the explicit way back in, and is allowed from "interrupted".
    const resumed = await second.call('POST', `/api/projects/${second.projectId}/runs/orphan/resume`, { expectStatus: 'interrupted' });
    assert.equal(resumed.status, 202, JSON.stringify(resumed.json));
    // The 202 arrives as soon as the run id is known; the execution carries on afterwards.
    let events = await readEvents(eventsFile(store.dir('orphan')));
    for (let i = 0; i < 200 && !events.some((e) => e.type === 'run.resumed'); i++) {
      await new Promise((r) => setTimeout(r, 25));
      events = await readEvents(eventsFile(store.dir('orphan')));
    }
    assert.ok(events.some((e) => e.type === 'run.interrupted'));
    assert.ok(events.some((e) => e.type === 'run.resumed'));
    // Let the resumed run finish so the server can shut down cleanly.
    for (let i = 0; i < 400; i++) {
      const rows = (await second.call('GET', `/api/projects/${second.projectId}/runs`)).json.runs;
      if (!rows.find((r: any) => r.id === 'orphan').executing) break;
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    await second.srv.close();
  }
});

test('restart leaves a CLI-started run alone and refuses to resume a run that is not interrupted', async () => {
  const repo = await makeRepo();
  const regFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rb-home-')), 'projects.json');
  await new ProjectRegistry(regFile).add(repo);
  const store = new RunStore((await new ProjectRegistry(regFile).list())[0].root);
  await store.save(stateOf({ id: 'cli', status: 'running', stage: 'review-r1' }));
  const s = await bootServer(repo, regFile, 'server-x');
  try {
    const rows = (await s.call('GET', `/api/projects/${s.projectId}/runs`)).json.runs;
    assert.equal(rows.find((r: any) => r.id === 'cli').status, 'running');
    const r = await s.call('POST', `/api/projects/${s.projectId}/runs/cli/resume`, {});
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'wrong-state');
  } finally {
    await s.srv.close();
  }
});

test('an interrupted publish step blocks resume, and a bare claim without remote proof cannot clear it', async () => {
  const repo = await makeRepo();
  const regFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rb-home-')), 'projects.json');
  await new ProjectRegistry(regFile).add(repo);
  const store = new RunStore((await new ProjectRegistry(regFile).list())[0].root);
  await store.save(stateOf({ id: 'pub', status: 'interrupted', owner: owner('old'), publish: { inFlight: 'push' } }));
  const s = await bootServer(repo, regFile, 'server-y');
  try {
    const blocked = await s.call('POST', `/api/projects/${s.projectId}/runs/pub/resume`, {});
    assert.equal(blocked.status, 409);
    assert.match(blocked.json.error.message, /external step/);
    const row = (await s.call('GET', `/api/projects/${s.projectId}/runs`)).json.runs.find((r: any) => r.id === 'pub');
    assert.equal(row.publishInFlight, 'push', 'the UI can warn about it');

    // This run has no approved commit, so there is nothing to compare a remote against: refused, marker kept.
    const claim = await s.call('POST', `/api/projects/${s.projectId}/runs/pub/check`, { completed: false });
    assert.equal(claim.status, 409);
    assert.equal(claim.json.error.code, 'no-commit');
    assert.equal((await store.load('pub')).publish.inFlight, 'push', 'the marker is still there');
  } finally {
    await s.srv.close();
  }
});
