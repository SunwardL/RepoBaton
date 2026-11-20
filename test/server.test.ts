import assert from 'node:assert/strict';
import { promises as fs, realpathSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentRegistry } from '../src/agents/registry.ts';
import { defaultConfig } from '../src/config.ts';
import { git } from '../src/git.ts';
import { Pipeline } from '../src/pipeline.ts';
import { ProjectRegistry } from '../src/projects.ts';
import { startServer, type RunningServer } from '../src/server/server.ts';
import { isAllowedOrigin, isLoopbackHost, tokenMatches } from '../src/server/security.ts';
import { BusyError, ExecutionSlots } from '../src/server/slot.ts';
import type { Agent, AgentResult, AgentRunRequest, Config } from '../src/types.ts';

// ---------------------------------------------------------------- slots

test('slots: taken synchronously, so two starts in the same tick cannot both win', async () => {
  const slots = new ExecutionSlots();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const first = slots.run('repo-a', 'a', () => gate);
  await assert.rejects(slots.run('repo-a', 'b', async () => 1), BusyError);
  release();
  await first;
  assert.equal(slots.current('repo-a'), null);
  assert.equal(await slots.run('repo-a', 'c', async () => 'ok'), 'ok');
});

test('slots: different repositories are independent', async () => {
  const slots = new ExecutionSlots();
  let releaseA!: () => void;
  const a = slots.run('repo-a', 'a', () => new Promise<void>((r) => (releaseA = r)));
  assert.equal(await slots.run('repo-b', 'b', async () => 'b ran'), 'b ran');
  await assert.rejects(slots.run('repo-a', 'again', async () => 1), BusyError);
  releaseA();
  await a;
});

test('slots: released when the work throws; cancel only reaches the owning run', async () => {
  const slots = new ExecutionSlots();
  await assert.rejects(slots.run('r', 'x', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(slots.current('r'), null);
  let release!: () => void;
  const p = slots.run('r', 'x', async (h) => { h.runId = 'run-1'; await new Promise<void>((res) => (release = res)); });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(slots.cancel('r', 'other'), false);
  assert.equal(slots.cancel('other-repo', 'run-1'), false);
  assert.equal(slots.cancel('r', 'run-1'), true);
  assert.equal(slots.isExecuting('run-1'), true);
  release();
  await p;
  assert.equal(slots.isExecuting('run-1'), false);
});

// ---------------------------------------------------------------- security helpers

test('host, origin and token checks', () => {
  assert.ok(isLoopbackHost('127.0.0.1:8080', 8080));
  assert.ok(isLoopbackHost('LOCALHOST:8080', 8080));
  assert.ok(!isLoopbackHost('evil.example:8080', 8080));
  assert.ok(!isLoopbackHost(undefined, 8080));
  assert.ok(isAllowedOrigin(undefined, 8080));
  assert.ok(isAllowedOrigin('http://127.0.0.1:8080', 8080));
  assert.ok(!isAllowedOrigin('https://evil.example', 8080));
  assert.ok(tokenMatches('abc', 'abc'));
  assert.ok(!tokenMatches('abd', 'abc'));
  assert.ok(!tokenMatches(undefined, 'abc'));
});

// ---------------------------------------------------------------- server harness

class Fake implements Agent {
  type = 'command' as const;
  id: string;
  private fn: (req: AgentRunRequest) => Promise<unknown> | unknown;
  calls: AgentRunRequest[] = [];
  constructor(id: string, fn: (req: AgentRunRequest) => Promise<unknown> | unknown) {
    this.id = id;
    this.fn = fn;
  }
  describe(): string { return this.id; }
  async check(): Promise<{ ok: boolean; detail: string }> { return { ok: true, detail: '' }; }
  async run(req: AgentRunRequest): Promise<AgentResult> {
    this.calls.push(req);
    const out = await this.fn(req);
    return req.schema ? { text: JSON.stringify(out), structured: out, durationMs: 1 } : { text: String(out), durationMs: 1 };
  }
}

const plan = { summary: 'plan', steps: [{ title: 't', detail: 'd', files: ['value.txt'] }], acceptance: ['value is good'], risks: [], test_hints: [] };
const release = { version_bump: 'patch', suggested_version: '1.0.1', pr_title: 'x', pr_body: 'b', release_notes: 'n', risks: [] };

function realRoot(p: string): string {
  return realpathSync.native(p);
}

async function makeRepo(prefix = 'rb-srv-', withConfig = true): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 't@e.com']);
  await git(dir, ['config', 'user.name', 't']);
  await fs.writeFile(path.join(dir, 'value.txt'), 'old\n');
  if (withConfig) {
    // A per-project config: every stage uses one command agent. Each project has its own file.
    await fs.writeFile(
      path.join(dir, 'repobaton.yaml'),
      [
        'agents:', '  a: { type: command, command: x }',
        'stages:', '  plan: { agent: a, requireApproval: true, retries: 0 }', '  implement: { agent: a, retries: 0 }',
        '  review: { agent: a }', '  release: { agent: a }',
        'test: { setup: "", command: "node -e \\"process.exit(0)\\"" }',
        '',
      ].join('\n'),
    );
  }
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

interface Gate { release: () => void; entered: Promise<void> }

interface Harness {
  srv: RunningServer;
  registry: ProjectRegistry;
  agent: Fake;
  projectIds: string[];
  call: (method: string, p: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: any }>;
  /** Make the planner wait until released, to hold a repository's slot open. */
  gatePlanner: (match?: (req: AgentRunRequest) => boolean) => Gate;
  close: () => Promise<void>;
}

async function harness(
  repos: string[],
  o: { serverId?: string; registryFile?: string; probe?: (pid: number) => Promise<{ alive: boolean; startedAt?: number }>; skipRecovery?: boolean } = {},
): Promise<Harness> {
  const regFile = o.registryFile ?? path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rb-home-')), 'projects.json');
  const registry = new ProjectRegistry(regFile);
  const gates: Array<{ match: (r: AgentRunRequest) => boolean; promise: Promise<void>; enter: () => void }> = [];
  const agent = new Fake('a', async (req) => {
    if (req.prompt.includes('PLANNER')) {
      for (const g of gates) {
        if (g.match(req)) {
          g.enter();
          await g.promise;
        }
      }
      return plan;
    }
    if (req.prompt.includes('IMPLEMENTER')) {
      await fs.writeFile(path.join(req.cwd, 'value.txt'), 'good\n');
      return 'done';
    }
    if (req.prompt.includes('RELEASE MANAGER')) return release;
    return { verdict: 'approve', summary: 'ok', issues: [] };
  });
  const agentRegistry = { get: () => agent } as unknown as AgentRegistry;
  const srv = await startServer({
    registry,
    seedProjects: repos,
    serverId: o.serverId,
    probe: o.probe,
    skipRecovery: o.skipRecovery,
    makePipeline: (ctx) => new Pipeline({ repo: ctx.repoRoot, config: ctx.config, registry: agentRegistry, signal: ctx.signal, owner: ctx.owner }),
  });
  const call: Harness['call'] = (method, p, body, headers) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        { host: '127.0.0.1', port: srv.port, path: p, method, headers: { authorization: `Bearer ${srv.token}`, ...(data ? { 'content-type': 'application/json' } : {}), ...(headers ?? {}) } },
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
  const list = await call('GET', '/api/projects');
  return {
    srv,
    registry,
    agent,
    projectIds: list.json.projects.map((p: any) => p.id),
    call,
    gatePlanner: (match = () => true) => {
      let release!: () => void;
      let enter!: () => void;
      const promise = new Promise<void>((r) => (release = r));
      const entered = new Promise<void>((r) => (enter = r));
      const g = { match, promise, enter };
      gates.push(g);
      return { release: () => { release(); gates.splice(gates.indexOf(g), 1); }, entered };
    },
    close: () => srv.close(),
  };
}

async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const runsPath = (pid: string, id?: string, tail = ''): string => `/api/projects/${pid}/runs${id ? `/${id}` : ''}${tail}`;
const statusOf = async (h: Harness, pid: string, id: string): Promise<string> => (await h.call('GET', runsPath(pid, id))).json.run.status;
const idle = async (h: Harness, pid: string): Promise<boolean> => !(await h.call('GET', '/api/projects')).json.projects.find((p: any) => p.id === pid).busy;

// ---------------------------------------------------------------- tests

test('API: unauthenticated, wrong-host and foreign-origin requests are refused', async () => {
  const h = await harness([await makeRepo()]);
  try {
    const noToken = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port: h.srv.port, path: '/api/projects' }, (r) => { r.resume(); resolve(r.statusCode ?? 0); });
    });
    assert.equal(noToken, 401);
    assert.equal((await h.call('GET', '/api/projects', undefined, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await h.call('GET', '/api/projects', undefined, { host: 'evil.example' })).status, 403);
    assert.equal((await h.call('GET', '/api/projects', undefined, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await h.call('GET', '/api/projects')).status, 200);
  } finally {
    await h.close();
  }
});

test('projects: add by path (subfolder or worktree resolves to the repository), list, reject non-repos', async () => {
  const repo = await makeRepo();
  await fs.mkdir(path.join(repo, 'sub'), { recursive: true });
  const h = await harness([]);
  try {
    assert.equal((await h.call('GET', '/api/projects')).json.projects.length, 0);
    const added = await h.call('POST', '/api/projects', { path: path.join(repo, 'sub') });
    assert.equal(added.status, 201);
    const again = await h.call('POST', '/api/projects', { path: repo });
    assert.equal(again.json.project.id, added.json.project.id, 'same repository, same project');
    assert.equal((await h.call('GET', '/api/projects')).json.projects.length, 1);
    const notRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-plain-'));
    assert.equal((await h.call('POST', '/api/projects', { path: notRepo })).json.error.code, 'not-a-repo');
    assert.equal((await h.call('POST', '/api/projects', {})).status, 400);
  } finally {
    await h.close();
  }
});

test('flow: new task -> waits for approval -> approve -> result', async () => {
  const h = await harness([await makeRepo()]);
  const [pid] = h.projectIds;
  try {
    const created = await h.call('POST', runsPath(pid), { task: 'make value good' });
    assert.equal(created.status, 202);
    const id = created.json.id as string;
    await waitFor(async () => (await statusOf(h, pid, id)) === 'awaiting-plan-approval');
    await waitFor(() => idle(h, pid));
    assert.equal((await h.call('GET', runsPath(pid, id))).json.run.plan.summary, 'plan');

    assert.equal((await h.call('POST', runsPath(pid, id, '/approve'), {})).status, 202);
    await waitFor(async () => (await statusOf(h, pid, id)) === 'succeeded');

    assert.match((await h.call('GET', runsPath(pid, id, '/diff'))).json.diff, /\+good/);
    const events = (await h.call('GET', runsPath(pid, id, '/events'))).json;
    assert.equal(events.settled, true);
    assert.ok(events.events.some((e: any) => e.type === 'run.finished'));
    assert.match((await h.call('GET', runsPath(pid, id, '/report'))).json.report, /succeeded/);
  } finally {
    await h.close();
  }
});

test('flow: reject with feedback re-plans, pauses again, then approve completes', async () => {
  const h = await harness([await makeRepo()]);
  const [pid] = h.projectIds;
  try {
    const id = (await h.call('POST', runsPath(pid), { task: 'make value good' })).json.id as string;
    await waitFor(async () => (await statusOf(h, pid, id)) === 'awaiting-plan-approval');
    await waitFor(() => idle(h, pid));
    assert.equal((await h.call('POST', runsPath(pid, id, '/reject'), {})).status, 400, 'feedback required');
    assert.equal((await h.call('POST', runsPath(pid, id, '/reject'), { feedback: 'add a rollback step' })).status, 202);
    await waitFor(async () => (await h.call('GET', runsPath(pid, id))).json.run.usage.calls >= 2 && (await idle(h, pid)));
    const mid = (await h.call('GET', runsPath(pid, id))).json.run;
    assert.equal(mid.status, 'awaiting-plan-approval');
    assert.equal(mid.rounds.length, 0, 'implementation has not started');
    assert.ok(h.agent.calls.some((c) => c.prompt.includes('add a rollback step')), 'planner saw the feedback');
    await h.call('POST', runsPath(pid, id, '/approve'), {});
    await waitFor(async () => (await statusOf(h, pid, id)) === 'succeeded');
  } finally {
    await h.close();
  }
});

test('parallel: two different repositories each run a task at the same time', async () => {
  const repoA = await makeRepo();
  const repoB = await makeRepo();
  const h = await harness([repoA, repoB]);
  const [p1, p2] = h.projectIds;
  try {
    // Each gate only holds the planner of its own repository (the worktree lives inside the repo).
    const inRepo = (root: string) => (r: AgentRunRequest) => r.cwd.toLowerCase().startsWith(realRoot(root).toLowerCase());
    const g1 = h.gatePlanner(inRepo(repoA));
    const first = await h.call('POST', runsPath(p1), { task: 'task in repo 1' });
    assert.equal(first.status, 202);
    await g1.entered;
    // Repo 1 is mid-execution (held in the planner). Repo 2 must still be able to start.
    const g2 = h.gatePlanner(inRepo(repoB));
    const second = await h.call('POST', runsPath(p2), { task: 'task in repo 2' });
    assert.equal(second.status, 202, 'a different repository is not blocked');
    await g2.entered;
    const projects = (await h.call('GET', '/api/projects')).json.projects;
    assert.equal(projects.filter((p: any) => p.busy).length, 2, 'both repositories are executing at once');
    g1.release();
    g2.release();
    await waitFor(async () => (await idle(h, p1)) && (await idle(h, p2)));
  } finally {
    await h.close();
  }
});

test('same repository: the same project, a subfolder and a linked worktree all share one slot', async () => {
  const repo = await makeRepo();
  const wt = `${repo}-linked`;
  await git(repo, ['worktree', 'add', '-q', wt, '-b', 'linked']);
  await fs.mkdir(path.join(repo, 'sub'), { recursive: true });
  const h = await harness([repo]);
  const [pid] = h.projectIds;
  try {
    // Register the same repository under two more paths. They resolve to one project.
    const viaSub = (await h.call('POST', '/api/projects', { path: path.join(repo, 'sub') })).json.project.id;
    const viaWt = (await h.call('POST', '/api/projects', { path: wt })).json.project.id;
    assert.equal(viaSub, pid);
    assert.equal(viaWt, pid);
    assert.equal((await h.call('GET', '/api/projects')).json.projects.length, 1);

    const gate = h.gatePlanner();
    const first = await h.call('POST', runsPath(pid), { task: 'first' });
    assert.equal(first.status, 202);
    await gate.entered;
    for (const via of [pid, viaSub, viaWt]) {
      const busy = await h.call('POST', runsPath(via), { task: 'second' });
      assert.equal(busy.status, 409);
      assert.equal(busy.json.error.code, 'busy');
      assert.equal(busy.json.error.runId, first.json.id);
    }
    gate.release();
    await waitFor(() => idle(h, pid));
  } finally {
    await h.close();
  }
});

test('while a repository executes: starts are refused "busy", reads still work', async () => {
  const h = await harness([await makeRepo()]);
  const [pid] = h.projectIds;
  try {
    const a = (await h.call('POST', runsPath(pid), { task: 'A' })).json.id as string;
    await waitFor(async () => (await statusOf(h, pid, a)) === 'awaiting-plan-approval');
    await waitFor(() => idle(h, pid));

    const gate = h.gatePlanner();
    const b = (await h.call('POST', runsPath(pid), { task: 'B' })).json.id as string;
    await gate.entered;
    assert.equal((await h.call('POST', runsPath(pid), { task: 'C' })).json.error.code, 'busy');
    assert.equal((await h.call('POST', runsPath(pid, a, '/approve'), {})).status, 409, 'approve needs the slot too');
    assert.equal((await h.call('POST', runsPath(pid, a, '/reject'), { feedback: 'x' })).json.error.code, 'busy');
    assert.equal((await h.call('GET', runsPath(pid))).json.runs.length, 2);
    assert.equal((await h.call('GET', runsPath(pid, a))).status, 200);
    assert.equal((await h.call('GET', runsPath(pid, b, '/events'))).status, 200);
    const exec = (await h.call('GET', runsPath(pid))).json.runs.find((r: any) => r.id === b);
    assert.equal(exec.executing, true);
    gate.release();
    await waitFor(() => idle(h, pid));
  } finally {
    await h.close();
  }
});

test('duplicate and stale approvals start exactly one execution', async () => {
  const h = await harness([await makeRepo()]);
  const [pid] = h.projectIds;
  try {
    const id = (await h.call('POST', runsPath(pid), { task: 'make value good' })).json.id as string;
    await waitFor(async () => (await statusOf(h, pid, id)) === 'awaiting-plan-approval');
    await waitFor(() => idle(h, pid));

    // Eight clicks on "approve" at once: one wins, the rest are refused.
    const results = await Promise.all(Array.from({ length: 8 }, () => h.call('POST', runsPath(pid, id, '/approve'), { expectStatus: 'awaiting-plan-approval' })));
    assert.equal(results.filter((r) => r.status === 202).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 7);
    await waitFor(async () => (await statusOf(h, pid, id)) === 'succeeded');
    assert.equal(h.agent.calls.filter((c) => c.prompt.includes('IMPLEMENTER')).length, 1, 'implemented exactly once');

    // A late, stale approval after the run finished is refused and starts nothing.
    const before = h.agent.calls.length;
    const stale = await h.call('POST', runsPath(pid, id, '/approve'), { expectStatus: 'awaiting-plan-approval' });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'wrong-state');
    assert.equal(h.agent.calls.length, before);
    // A stale reject is refused the same way.
    assert.equal((await h.call('POST', runsPath(pid, id, '/reject'), { feedback: 'late' })).json.error.code, 'wrong-state');
    assert.equal(h.agent.calls.length, before);
  } finally {
    await h.close();
  }
});

test('a request carrying an outdated expected status is refused even when the run state moved on', async () => {
  const h = await harness([await makeRepo()]);
  const [pid] = h.projectIds;
  try {
    const id = (await h.call('POST', runsPath(pid), { task: 'x' })).json.id as string;
    await waitFor(async () => (await statusOf(h, pid, id)) === 'awaiting-plan-approval');
    await waitFor(() => idle(h, pid));
    const stale = await h.call('POST', runsPath(pid, id, '/approve'), { expectStatus: 'interrupted' });
    assert.equal(stale.status, 409);
    assert.match(stale.json.error.message, /now awaiting-plan-approval/);
    assert.equal(h.agent.calls.filter((c) => c.prompt.includes('IMPLEMENTER')).length, 0);
  } finally {
    await h.close();
  }
});

test('cancel stops the executing run; cancelling an idle one is refused', async () => {
  const h = await harness([await makeRepo()]);
  const [pid] = h.projectIds;
  try {
    const gate = h.gatePlanner();
    const id = (await h.call('POST', runsPath(pid), { task: 'slow' })).json.id as string;
    await gate.entered;
    assert.equal((await h.call('POST', runsPath(pid, id, '/cancel'), {})).status, 202);
    gate.release();
    await waitFor(() => idle(h, pid));
    assert.equal((await h.call('POST', runsPath(pid, id, '/cancel'), {})).json.error.code, 'not-running');
  } finally {
    await h.close();
  }
});

test('missing API key: refused before starting, naming the agent and variable but never a value', async () => {
  const repo = await makeRepo('rb-key-', false);
  await fs.writeFile(
    path.join(repo, 'repobaton.yaml'),
    ['agents:', '  qwen: { type: openai-compatible, baseUrl: "http://127.0.0.1:1/v1", model: m, apiKeyEnv: RB_TEST_NO_SUCH_KEY }', '  other: { type: openai-compatible, model: m, apiKeyEnv: RB_TEST_UNUSED_KEY }',
     'stages:', '  plan: { agent: qwen }', '  implement: { agent: qwen }', '  review: { agent: qwen }', '  release: { agent: qwen }', ''].join('\n'),
  );
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'cfg']);
  delete process.env.RB_TEST_NO_SUCH_KEY;
  delete process.env.RB_TEST_UNUSED_KEY;
  const h = await harness([repo]);
  const [pid] = h.projectIds;
  try {
    const status = (await h.call('GET', `/api/projects/${pid}/status`)).json;
    const names = status.missingSecrets.map((m: any) => `${m.agent}:${m.variable}`).sort();
    assert.deepEqual(names, ['other:RB_TEST_UNUSED_KEY', 'qwen:RB_TEST_NO_SUCH_KEY']);
    const refused = await h.call('POST', runsPath(pid), { task: 'anything' });
    assert.equal(refused.status, 422);
    assert.equal(refused.json.error.code, 'missing-secret');
    assert.deepEqual(refused.json.error.missing.map((m: any) => m.agent), ['qwen'], 'only agents the stages use block a run');
    assert.match(refused.json.error.message, /agent "qwen" needs the environment variable RB_TEST_NO_SUCH_KEY/);
    assert.equal((await h.call('GET', runsPath(pid))).json.runs.length, 0, 'nothing was started');

    // With the key present the value never appears in any response.
    process.env.RB_TEST_NO_SUCH_KEY = 'sk-SUPER-SECRET-VALUE-9876';
    const ok = await h.call('GET', `/api/projects/${pid}/status`);
    assert.equal(ok.json.missingSecrets.length, 1);
    assert.ok(!JSON.stringify(ok.json).includes('SUPER-SECRET'));
    delete process.env.RB_TEST_NO_SUCH_KEY;
  } finally {
    await h.close();
  }
});

test('a broken project config is reported, not crashed on', async () => {
  const repo = await makeRepo('rb-badcfg-', false);
  await fs.writeFile(path.join(repo, 'repobaton.yaml'), 'stages:\n  plan: { agent: nobody }\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'bad']);
  const h = await harness([repo]);
  try {
    const r = await h.call('POST', runsPath(h.projectIds[0]), { task: 'x' });
    assert.equal(r.status, 422);
    assert.equal(r.json.error.code, 'bad-config');
  } finally {
    await h.close();
  }
});

test('each project reads its own configuration', async () => {
  const a = await makeRepo('rb-cfga-');
  const b = await makeRepo('rb-cfgb-', false);
  await fs.writeFile(path.join(b, 'repobaton.yaml'), ['agents:', '  only-b: { type: command, command: x }', 'stages:', '  plan: { agent: only-b }', '  implement: { agent: only-b }', '  review: { agent: only-b }', '  release: { agent: only-b }', ''].join('\n'));
  await git(b, ['add', '-A']);
  await git(b, ['commit', '-q', '-m', 'cfg']);
  const h = await harness([a, b]);
  try {
    const st = await Promise.all(h.projectIds.map((id) => h.call('GET', `/api/projects/${id}/status`)));
    assert.ok(st.every((s) => s.status === 200));
    assert.ok(st[0].json.configFile.endsWith('repobaton.yaml'));
    assert.notEqual(st[0].json.configFile, st[1].json.configFile);
  } finally {
    await h.close();
  }
});

test('API: input validation and unknown things', async () => {
  const h = await harness([await makeRepo()]);
  const [pid] = h.projectIds;
  try {
    assert.equal((await h.call('POST', runsPath(pid), {})).status, 400);
    assert.equal((await h.call('POST', runsPath(pid), { task: '   ' })).status, 400);
    assert.equal((await h.call('GET', runsPath(pid, 'no-such-run'))).status, 404);
    assert.equal((await h.call('GET', '/api/projects/nope/runs')).json.error.code, 'no-project');
    assert.equal((await h.call('GET', '/api/nothing')).status, 404);
    const id = (await h.call('POST', runsPath(pid), { task: 'x' })).json.id as string;
    await waitFor(async () => (await statusOf(h, pid, id)) === 'awaiting-plan-approval');
    await waitFor(() => idle(h, pid));
    assert.equal((await h.call('POST', runsPath(pid, id, '/resume'), {})).json.error.code, 'wrong-state');
  } finally {
    await h.close();
  }
});
