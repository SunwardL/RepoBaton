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
    agentsFile: path.join(path.dirname(regFile), 'agents.json'),
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
const planVer = async (h: Harness, pid: string, id: string): Promise<number> => (await h.call('GET', runsPath(pid, id))).json.run.planVersion;

test('project settings save only editable fields and protect credentials and external edits', async () => {
  const repo = await makeRepo();
  const file = path.join(repo, 'repobaton.yaml');
  const secret = 'sk-settings-fixture-secret';
  const original = (await fs.readFile(file, 'utf8')).replace(
    'agents:',
    `# Keep this comment\nagents:\n  extra: { type: openai-compatible, model: test, apiKey: ${secret} }`,
  );
  await fs.writeFile(file, original);
  const h = await harness([repo]);
  const endpoint = `/api/projects/${h.projectIds[0]}/settings`;
  try {
    const opened = await h.call('GET', endpoint);
    assert.equal(opened.status, 200);
    assert.doesNotMatch(JSON.stringify(opened.json), new RegExp(secret));
    const checked = await h.call('POST', endpoint + '/check', {});
    assert.equal(checked.status, 200);
    assert.equal(checked.json.agents.find((a: { id: string }) => a.id === 'extra').status, 'key-present');
    assert.doesNotMatch(JSON.stringify(checked.json), new RegExp(secret));

    const { revision } = opened.json;
    assert.equal((await h.call('PUT', endpoint, { revision, stages: { plan: { agent: 'missing' } } })).status, 422);
    assert.equal(await fs.readFile(file, 'utf8'), original);
    const saved = await h.call('PUT', endpoint, { revision, requireApproval: false, stages: { implement: { model: 'demo-model' } } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.requireApproval, false);
    assert.equal(saved.json.stages.find((s: { name: string }) => s.name === 'implement').model, 'demo-model');
    const source = await fs.readFile(file, 'utf8');
    assert.match(source, /# Keep this comment/);
    assert.match(source, new RegExp(secret));
    assert.match(source, /retries: 0/);

    await fs.appendFile(file, '# edited outside UI\n');
    const stale = await h.call('PUT', endpoint, { revision: saved.json.revision, requireApproval: true });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'stale-config');
    assert.equal(await fs.readFile(file, 'utf8'), source + '# edited outside UI\n');
  } finally {
    await h.close();
  }
});
test('command settings can be edited and YAML import stays a preview until saved', async () => {
  const repo = await makeRepo();
  const file = path.join(repo, 'repobaton.yaml');
  const secret = 'fixture-sensitive-value';
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace(
    'command: x', `command: x, args: ['--token', '${secret}'], timeoutMs: 5000`,
  ));
  const h = await harness([repo]);
  const endpoint = `/api/projects/${h.projectIds[0]}/settings`;
  const globalEndpoint = '/api/agents';
  try {
    const before = await h.call('GET', globalEndpoint);
    const preview = await h.call('POST', globalEndpoint + '/import', {
      yaml: [
        'agents:',
        '  local-tool:', '    type: command', '    command: node', '    args: [runner.mjs, "one argument"]', '    promptVia: arg',
        `  local-api: { type: openai-compatible, model: demo, apiKey: ${secret} }`,
      ].join('\n'),
    });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.json.agents.find((a: { id: string }) => a.id === 'local-tool').args, ['runner.mjs', 'one argument']);
    assert.equal(preview.json.agents.find((a: { id: string }) => a.id === 'local-api').apiKeyEnv, 'OPENAI_API_KEY');
    assert.ok(!JSON.stringify(preview.json).includes(secret));
    assert.deepEqual((await h.call('GET', globalEndpoint)).json, before.json);
    const saved = await h.call('PUT', globalEndpoint, { revision: before.json.revision, agents: [...before.json.agents, ...preview.json.agents] });
    assert.equal(saved.status, 200);
    assert.ok(!String(await fs.readFile(saved.json.file, 'utf8')).includes(secret));

    const project = await h.call('GET', endpoint);
    assert.deepEqual(project.json.commandAgents.map((a: { id: string }) => a.id), ['a']);
    assert.ok(project.json.agents.some((a: { id: string }) => a.id === 'local-tool'));
    assert.ok(!JSON.stringify(project.json).includes(secret));
    const payload = { revision: project.json.revision, commands: { a: { command: 'node', args: ['runner.mjs'], promptVia: 'arg', output: 'text' } } };
    assert.equal((await h.call('PUT', endpoint, {
      ...payload, commands: { a: { ...payload.commands.a, args: [`--token=${secret}`] } },
    })).status, 422);
    const edited = await h.call('PUT', endpoint, payload);
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.json.commandAgents, [{ id: 'a', ...payload.commands.a }]);
    assert.equal(edited.json.stages.find((s: { name: string }) => s.name === 'plan').agent, 'a');
    assert.match(await fs.readFile(file, 'utf8'), /timeoutMs: 5000/);
  } finally {
    await h.close();
  }
});
const idle = async (h: Harness, pid: string): Promise<boolean> => !(await h.call('GET', '/api/projects')).json.projects.find((p: any) => p.id === pid).busy;

test('global API agents are available in existing projects and task models survive approval', async () => {
  const repo = await makeRepo();
  const h = await harness([repo]);
  const keyEnv = 'RB_GLOBAL_WORKFLOW_TEST_KEY';
  const secret = 'sk-fixture-global-only';
  process.env[keyEnv] = secret;
  try {
    const global = (await h.call('GET', '/api/agents')).json;
    const extra = { id: 'local-api', type: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: 'original-model', apiKeyEnv: keyEnv, apiKey: secret };
    const saved = await h.call('PUT', '/api/agents', { revision: global.revision, agents: [...global.agents, extra] });
    assert.equal(saved.status, 200);
    assert.doesNotMatch(JSON.stringify(saved.json), new RegExp(secret));
    assert.doesNotMatch(await fs.readFile(saved.json.file, 'utf8'), new RegExp(secret));
    const pid = h.projectIds[0];
    const setting = await h.call('GET', `/api/projects/${pid}/settings`);
    assert.ok(setting.json.agents.some((a: { id: string }) => a.id === 'local-api'));
    assert.ok(setting.json.agents.some((a: { id: string }) => a.id === 'a'), 'existing project agents remain available');

    const started = await h.call('POST', runsPath(pid), {
      task: 'use global pool',
      workflow: { plan: { agent: 'claude', model: 'planner-model' }, implement: { agent: 'local-api', model: '' } },
    });
    assert.equal(started.status, 202);
    const id = started.json.id;
    await waitFor(async () => (await statusOf(h, pid, id)) === 'awaiting-plan-approval' && await idle(h, pid), 45000);
    assert.equal(h.agent.calls.at(-1)?.model, 'planner-model');
    const changed = await h.call('PUT', '/api/agents', { revision: saved.json.revision, agents: [...global.agents, { ...extra, model: 'changed-model' }] });
    assert.equal(changed.status, 200);
    const approved = await h.call('POST', runsPath(pid, id, '/approve'), { expectPlanVersion: await planVer(h, pid, id) });
    assert.equal(approved.status, 202);
    await waitFor(async () => (await statusOf(h, pid, id)) === 'succeeded' && await idle(h, pid), 45000);
    assert.equal(h.agent.calls.find((call) => call.stage === 'implement')?.model, 'original-model');
    const run = (await h.call('GET', runsPath(pid, id))).json.run;
    assert.equal(run.workflow.implement.agent, 'local-api');
    assert.equal(run.rounds[0].implement.agent, 'local-api');
  } finally {
    delete process.env[keyEnv];
    await h.close();
  }
});

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

    assert.equal((await h.call('POST', runsPath(pid, id, '/approve'), { expectPlanVersion: await planVer(h, pid, id) })).status, 202);
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
    assert.equal((await h.call('POST', runsPath(pid, id, '/reject'), { expectPlanVersion: await planVer(h, pid, id) })).status, 400, 'feedback required');
    assert.equal((await h.call('POST', runsPath(pid, id, '/reject'), { feedback: 'add a rollback step', expectPlanVersion: await planVer(h, pid, id) })).status, 202);
    await waitFor(async () => (await h.call('GET', runsPath(pid, id))).json.run.usage.calls >= 2 && (await idle(h, pid)));
    const mid = (await h.call('GET', runsPath(pid, id))).json.run;
    assert.equal(mid.status, 'awaiting-plan-approval');
    assert.equal(mid.rounds.length, 0, 'implementation has not started');
    assert.ok(h.agent.calls.some((c) => c.prompt.includes('add a rollback step')), 'planner saw the feedback');
    await h.call('POST', runsPath(pid, id, '/approve'), { expectPlanVersion: await planVer(h, pid, id) });
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
    assert.equal((await h.call('POST', runsPath(pid, a, '/approve'), { expectPlanVersion: 1 })).status, 409, 'approve needs the slot too');
    assert.equal((await h.call('POST', runsPath(pid, a, '/reject'), { feedback: 'x', expectPlanVersion: 1 })).json.error.code, 'busy');
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
    const ver = await planVer(h, pid, id);
    const results = await Promise.all(Array.from({ length: 8 }, () => h.call('POST', runsPath(pid, id, '/approve'), { expectStatus: 'awaiting-plan-approval', expectPlanVersion: ver })));
    assert.equal(results.filter((r) => r.status === 202).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 7);
    await waitFor(async () => (await statusOf(h, pid, id)) === 'succeeded');
    assert.equal(h.agent.calls.filter((c) => c.prompt.includes('IMPLEMENTER')).length, 1, 'implemented exactly once');

    // A late, stale approval after the run finished is refused and starts nothing.
    const before = h.agent.calls.length;
    const stale = await h.call('POST', runsPath(pid, id, '/approve'), { expectStatus: 'awaiting-plan-approval', expectPlanVersion: ver });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'wrong-state');
    assert.equal(h.agent.calls.length, before);
    // A stale reject is refused the same way.
    assert.equal((await h.call('POST', runsPath(pid, id, '/reject'), { feedback: 'late', expectPlanVersion: ver })).json.error.code, 'wrong-state');
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
    const stale = await h.call('POST', runsPath(pid, id, '/approve'), { expectStatus: 'interrupted', expectPlanVersion: await planVer(h, pid, id) });
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

// ---------------------------------------------------------------- plan versions

test('two windows: after plan A is rejected and plan B is pending, the old window cannot approve or reject A', async () => {
  const h = await harness([await makeRepo()]);
  const [pid] = h.projectIds;
  try {
    const id = (await h.call('POST', runsPath(pid), { task: 'make value good' })).json.id as string;
    await waitFor(async () => (await statusOf(h, pid, id)) === 'awaiting-plan-approval');
    await waitFor(() => idle(h, pid));
    const versionA = await planVer(h, pid, id);

    // Window 1 and window 2 both show plan A. Window 2 rejects it; plan B appears.
    const rejected = await h.call('POST', runsPath(pid, id, '/reject'), { feedback: 'add a rollback step', expectPlanVersion: versionA });
    assert.equal(rejected.status, 202);
    await waitFor(async () => (await planVer(h, pid, id)) > versionA && (await statusOf(h, pid, id)) === 'awaiting-plan-approval' && (await idle(h, pid)));
    const versionB = await planVer(h, pid, id);
    assert.ok(versionB > versionA);

    // Window 1 is still looking at A. Neither action may take effect.
    const before = h.agent.calls.length;
    const oldApprove = await h.call('POST', runsPath(pid, id, '/approve'), { expectStatus: 'awaiting-plan-approval', expectPlanVersion: versionA });
    assert.equal(oldApprove.status, 409);
    assert.equal(oldApprove.json.error.code, 'stale-plan');
    assert.match(oldApprove.json.error.message, /refresh/i);
    assert.equal(oldApprove.json.error.planVersion, versionB);
    const oldReject = await h.call('POST', runsPath(pid, id, '/reject'), { feedback: 'from the old page', expectStatus: 'awaiting-plan-approval', expectPlanVersion: versionA });
    assert.equal(oldReject.json.error.code, 'stale-plan');
    assert.equal(h.agent.calls.length, before, 'a stale decision starts nothing');
    assert.equal((await h.call('GET', runsPath(pid, id))).json.run.planApproved, false);
    assert.equal(h.agent.calls.filter((c) => c.prompt.includes('IMPLEMENTER')).length, 0);

    // The refreshed window approves B; a double click on B runs exactly once.
    const both = await Promise.all([1, 2, 3].map(() => h.call('POST', runsPath(pid, id, '/approve'), { expectStatus: 'awaiting-plan-approval', expectPlanVersion: versionB })));
    assert.equal(both.filter((r) => r.status === 202).length, 1);
    await waitFor(async () => (await statusOf(h, pid, id)) === 'succeeded');
    assert.equal(h.agent.calls.filter((c) => c.prompt.includes('IMPLEMENTER')).length, 1);
  } finally {
    await h.close();
  }
});

test('approve and reject without a plan version are refused', async () => {
  const h = await harness([await makeRepo()]);
  const [pid] = h.projectIds;
  try {
    const id = (await h.call('POST', runsPath(pid), { task: 'x' })).json.id as string;
    await waitFor(async () => (await statusOf(h, pid, id)) === 'awaiting-plan-approval');
    await waitFor(() => idle(h, pid));
    const a = await h.call('POST', runsPath(pid, id, '/approve'), { expectStatus: 'awaiting-plan-approval' });
    assert.equal(a.status, 400);
    assert.match(a.json.error.message, /expectPlanVersion/);
    const r = await h.call('POST', runsPath(pid, id, '/reject'), { feedback: 'x' });
    assert.equal(r.status, 400);
    assert.equal(h.agent.calls.filter((c) => c.prompt.includes('IMPLEMENTER')).length, 0);
    assert.equal(await statusOf(h, pid, id), 'awaiting-plan-approval');
  } finally {
    await h.close();
  }
});

test('the plan version is checked after the slot is held: a request racing a running replan is refused as busy, not applied', async () => {
  const h = await harness([await makeRepo()]);
  const [pid] = h.projectIds;
  try {
    const id = (await h.call('POST', runsPath(pid), { task: 'x' })).json.id as string;
    await waitFor(async () => (await statusOf(h, pid, id)) === 'awaiting-plan-approval');
    await waitFor(() => idle(h, pid));
    const v1 = await planVer(h, pid, id);
    const gate = h.gatePlanner();
    assert.equal((await h.call('POST', runsPath(pid, id, '/reject'), { feedback: 'again', expectPlanVersion: v1 })).status, 202);
    await gate.entered; // the replan is running and holds the slot
    const during = await h.call('POST', runsPath(pid, id, '/approve'), { expectPlanVersion: v1 });
    assert.equal(during.json.error.code, 'busy');
    gate.release();
    await waitFor(async () => (await planVer(h, pid, id)) === v1 + 1 && (await idle(h, pid)));
    assert.equal((await h.call('POST', runsPath(pid, id, '/approve'), { expectPlanVersion: v1 })).json.error.code, 'stale-plan');
  } finally {
    await h.close();
  }
});

test('cleanup shares the repository slot: refused while a replan runs, worktree kept, allowed afterwards', async () => {
  const h = await harness([await makeRepo()]);
  const [pid] = h.projectIds;
  try {
    const id = (await h.call('POST', runsPath(pid), { task: 'x' })).json.id as string;
    await waitFor(async () => (await statusOf(h, pid, id)) === 'awaiting-plan-approval');
    await waitFor(() => idle(h, pid));
    const v1 = await planVer(h, pid, id);
    const gate = h.gatePlanner();
    assert.equal((await h.call('POST', runsPath(pid, id, '/reject'), { feedback: 'again', expectPlanVersion: v1 })).status, 202);
    await gate.entered;
    const during = await h.call('POST', runsPath(pid, id, '/cleanup'), {});
    assert.equal(during.status, 409);
    assert.equal(during.json.error.code, 'busy');
    assert.equal((await h.call('GET', runsPath(pid))).json.runs.find((r: any) => r.id === id).hasWorktree, true, 'worktree untouched');
    gate.release();
    await waitFor(() => idle(h, pid));
    assert.equal((await h.call('POST', runsPath(pid, id, '/cleanup'), {})).status, 200);
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------------------ native sessions through the API

test('sessions: recorded per stage, returned by the detail API and still readable after a server restart', async () => {
  const repo = await makeRepo();
  const regFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rb-home-')), 'projects.json');
  const h = await harness([repo], { registryFile: regFile });
  const [pid] = h.projectIds;
  let id = '';
  try {
    const created = await h.call('POST', runsPath(pid), { task: 'make value good' });
    assert.equal(created.status, 202);
    id = created.json.id as string;
    await waitFor(async () => (await statusOf(h, pid, id)) === 'awaiting-plan-approval');
    await waitFor(() => idle(h, pid));
    assert.equal((await h.call('POST', runsPath(pid, id, '/approve'), { expectPlanVersion: await planVer(h, pid, id) })).status, 202);
    await waitFor(async () => (await statusOf(h, pid, id)) === 'succeeded');
    const run = (await h.call('GET', runsPath(pid, id))).json.run;
    const labels = (run.sessions ?? []).map((s: any) => s.label);
    assert.deepEqual(labels, ['plan', 'implement-r1', 'review-r1', 'release']);
    for (const s of run.sessions) {
      assert.equal(s.status, 'completed');
      assert.equal(typeof s.cwd, 'string');
    }
  } finally {
    await h.close();
  }
  // A new server over the same projects reads the same records from disk.
  const again = await harness([], { registryFile: regFile });
  try {
    const [pid2] = again.projectIds;
    const run = (await again.call('GET', runsPath(pid2, id))).json.run;
    assert.equal(run.status, 'succeeded');
    assert.deepEqual((run.sessions ?? []).map((s: any) => s.label), ['plan', 'implement-r1', 'review-r1', 'release']);
  } finally {
    await again.close();
  }
});

test('sessions: a run saved before sessions were recorded still opens normally', async () => {
  const repo = await makeRepo();
  const h = await harness([repo]);
  const [pid] = h.projectIds;
  try {
    const dir = path.join(repo, '.repobaton', 'runs', 'old1');
    await fs.mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(dir, 'state.json'),
      JSON.stringify({
        id: 'old1',
        task: 'an older task',
        repo,
        status: 'failed',
        createdAt: now,
        updatedAt: now,
        rounds: [],
        publish: {},
        usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, calls: 0 },
      }),
    );
    const got = await h.call('GET', runsPath(pid, 'old1'));
    assert.equal(got.status, 200);
    assert.equal(got.json.run.task, 'an older task');
    assert.equal(got.json.run.sessions, undefined);
    const list = await h.call('GET', runsPath(pid));
    assert.ok(list.json.runs.some((r: any) => r.id === 'old1'));
  } finally {
    await h.close();
  }
});

test('sessions: the detail API builds the continue command from how the CLI was launched, and keeps old records usable', async () => {
  const repo = await makeRepo();
  const h = await harness([repo]);
  const [pid] = h.projectIds;
  try {
    const dir = path.join(repo, '.repobaton', 'runs', 'cmd1');
    await fs.mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    const base = { persisted: true, cwd: 'D:\\work space\\wt', startedAt: now, finishedAt: now, status: 'completed' };
    await fs.writeFile(
      path.join(dir, 'state.json'),
      JSON.stringify({
        id: 'cmd1',
        task: 't',
        repo,
        status: 'failed',
        createdAt: now,
        updatedAt: now,
        rounds: [],
        publish: {},
        usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, calls: 0 },
        sessions: [
          { ...base, label: 'implement-r1', stage: 'implement', agent: 'codex', agentType: 'codex-cli', sessionId: '01a2079f-2f6f-7041-b8b9-c1620698f68b', cli: { path: 'C:\\Program Files\\Codex\\codex.exe' } },
          { ...base, label: 'plan', stage: 'plan', agent: 'claude', agentType: 'claude-cli', sessionId: 'b19ca7e5-0ff1-40c4-b003-8c1f1bd93472' },
          { ...base, label: 'release', stage: 'release', agent: 'api', agentType: 'openai-compatible' },
        ],
      }),
    );
    const sessions = (await h.call('GET', runsPath(pid, 'cmd1'))).json.run.sessions;
    assert.equal(sessions[0].resumeCommand, 'cd /d "D:\\work space\\wt" && "C:\\Program Files\\Codex\\codex.exe" resume 01a2079f-2f6f-7041-b8b9-c1620698f68b');
    assert.equal(sessions[1].resumeCommand, 'cd /d "D:\\work space\\wt" && claude --resume b19ca7e5-0ff1-40c4-b003-8c1f1bd93472', 'an old record keeps the bare name');
    assert.equal(sessions[2].resumeCommand, null, 'an agent without native sessions gets no command');
  } finally {
    await h.close();
  }
});
