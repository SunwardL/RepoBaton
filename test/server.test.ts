import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentRegistry } from '../src/agents/registry.ts';
import { defaultConfig } from '../src/config.ts';
import { git } from '../src/git.ts';
import { Pipeline } from '../src/pipeline.ts';
import { startServer, type RunningServer } from '../src/server/server.ts';
import { BusyError, ExecutionSlot } from '../src/server/slot.ts';
import { isAllowedOrigin, isLoopbackHost, tokenMatches } from '../src/server/security.ts';
import type { Agent, AgentResult, AgentRunRequest, Config } from '../src/types.ts';

// ---------------------------------------------------------------- slot

test('the slot is taken synchronously: two starts in the same tick cannot both win', async () => {
  const slot = new ExecutionSlot();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const first = slot.run('a', () => gate);
  // Second call happens before the first has awaited anything.
  await assert.rejects(slot.run('b', async () => 1), BusyError);
  release();
  await first;
  assert.equal(slot.current, null, 'released after the work settles');
  assert.equal(await slot.run('c', async () => 'ok'), 'ok');
});

test('the slot is released even when the work throws', async () => {
  const slot = new ExecutionSlot();
  await assert.rejects(slot.run('x', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(slot.current, null);
});

test('cancel only hits the run that holds the slot', async () => {
  const slot = new ExecutionSlot();
  let release!: () => void;
  const p = slot.run('x', async (h) => { h.runId = 'run-1'; await new Promise<void>((r) => (release = r)); });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(slot.cancel('other'), false);
  assert.equal(slot.cancel('run-1'), true);
  assert.equal(slot.current?.abort.signal.aborted, true);
  release();
  await p;
});

// ---------------------------------------------------------------- security helpers

test('host, origin and token checks', () => {
  assert.ok(isLoopbackHost('127.0.0.1:8080', 8080));
  assert.ok(isLoopbackHost('LOCALHOST:8080', 8080));
  assert.ok(!isLoopbackHost('evil.example:8080', 8080), 'DNS rebinding host is refused');
  assert.ok(!isLoopbackHost('127.0.0.1:9999', 8080));
  assert.ok(!isLoopbackHost(undefined, 8080));
  assert.ok(isAllowedOrigin(undefined, 8080), 'non-browser clients send no Origin');
  assert.ok(isAllowedOrigin('http://127.0.0.1:8080', 8080));
  assert.ok(!isAllowedOrigin('https://evil.example', 8080));
  assert.ok(!isAllowedOrigin('http://127.0.0.1:1', 8080));
  assert.ok(tokenMatches('abc', 'abc'));
  assert.ok(!tokenMatches('abd', 'abc'));
  assert.ok(!tokenMatches(undefined, 'abc'));
  assert.ok(!tokenMatches('abcd', 'abc'));
});

// ---------------------------------------------------------------- server

class Gated implements Agent {
  type = 'command' as const;
  id: string;
  private fn: (req: AgentRunRequest) => Promise<unknown> | unknown;
  constructor(id: string, fn: (req: AgentRunRequest) => Promise<unknown> | unknown) {
    this.id = id;
    this.fn = fn;
  }
  describe(): string { return this.id; }
  async check(): Promise<{ ok: boolean; detail: string }> { return { ok: true, detail: '' }; }
  async run(req: AgentRunRequest): Promise<AgentResult> {
    const out = await this.fn(req);
    return req.schema ? { text: JSON.stringify(out), structured: out, durationMs: 1 } : { text: String(out), durationMs: 1 };
  }
}

const plan = { summary: 's', steps: [{ title: 't', detail: 'd', files: ['value.txt'] }], acceptance: ['value is good'], risks: [], test_hints: [] };
const release = { version_bump: 'patch', suggested_version: '1.0.1', pr_title: 'x', pr_body: 'b', release_notes: 'n', risks: [] };

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-srv-'));
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 't@e.com']);
  await git(dir, ['config', 'user.name', 't']);
  await fs.writeFile(path.join(dir, 'value.txt'), 'old\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

interface Harness {
  repo: string;
  srv: RunningServer;
  call: (method: string, p: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: any }>;
  /** Make the planner wait until released, to hold the slot open. */
  holdPlanner: () => { release: () => void };
  close: () => Promise<void>;
}

async function harness(opts: { requireApproval?: boolean } = {}): Promise<Harness> {
  const repo = await makeRepo();
  const config: Config = defaultConfig();
  config.agents = { a: { type: 'command', command: 'x' } };
  for (const s of ['plan', 'implement', 'review', 'release'] as const) config.stages[s].agent = 'a';
  config.stages.plan.requireApproval = opts.requireApproval ?? true;
  config.stages.implement.retries = 0;
  config.stages.plan.retries = 0;
  config.test.setup = '';
  config.test.command = 'node -e "process.exit(0)"';

  let planGate: Promise<void> | null = null;
  const agent = new Gated('a', async (req) => {
    if (req.prompt.includes('PLANNER')) {
      if (planGate) await planGate;
      return plan;
    }
    if (req.prompt.includes('IMPLEMENTER')) {
      await fs.writeFile(path.join(req.cwd, 'value.txt'), 'good\n');
      return 'done';
    }
    if (req.prompt.includes('RELEASE MANAGER')) return release;
    return { verdict: 'approve', summary: 'ok', issues: [] };
  });
  const registry = { get: () => agent } as unknown as AgentRegistry;
  const srv = await startServer({
    repo,
    config,
    makePipeline: (signal) => new Pipeline({ repo, config, registry, signal }),
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
  return {
    repo,
    srv,
    call,
    holdPlanner: () => {
      let release!: () => void;
      planGate = new Promise<void>((r) => (release = r));
      return { release: () => { release(); planGate = null; } };
    },
    close: () => srv.close(),
  };
}

async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const statusOf = async (h: Harness, id: string): Promise<string> => (await h.call('GET', `/api/runs/${id}`)).json.run.status;

test('API: unauthenticated, wrong-host and foreign-origin requests are refused', async () => {
  const h = await harness();
  try {
    const noToken = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port: h.srv.port, path: '/api/runs' }, (r) => { r.resume(); resolve(r.statusCode ?? 0); });
    });
    assert.equal(noToken, 401);
    assert.equal((await h.call('GET', '/api/runs', undefined, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await h.call('GET', '/api/runs', undefined, { host: 'evil.example' })).status, 403);
    assert.equal((await h.call('GET', '/api/runs', undefined, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await h.call('GET', '/api/runs')).status, 200);
  } finally {
    await h.close();
  }
});

test('API: new task -> waits for approval -> approve -> result', async () => {
  const h = await harness();
  try {
    const created = await h.call('POST', '/api/runs', { task: 'make value good' });
    assert.equal(created.status, 202);
    const id = created.json.id as string;
    await waitFor(async () => (await statusOf(h, id)) === 'awaiting-plan-approval');

    const planRes = await h.call('GET', `/api/runs/${id}/plan`);
    assert.equal(planRes.json.plan.summary, 's');
    assert.equal(planRes.json.planApproved, false);
    // The slot is free while the run waits for a human.
    assert.equal((await h.call('GET', '/api/state')).json.busy, false);

    const approved = await h.call('POST', `/api/runs/${id}/approve`, {});
    assert.equal(approved.status, 202);
    await waitFor(async () => (await statusOf(h, id)) === 'succeeded');

    const diff = await h.call('GET', `/api/runs/${id}/diff`);
    assert.match(diff.json.diff, /\+good/);
    const events = await h.call('GET', `/api/runs/${id}/events`);
    assert.equal(events.json.settled, true);
    assert.ok(events.json.events.some((e: any) => e.type === 'run.finished'));
    assert.equal((await h.call('GET', `/api/runs/${id}/events?after=${events.json.events.length}`)).json.events.length, 0);
    assert.equal((await h.call('GET', '/api/runs')).json.runs.length, 1);
  } finally {
    await h.close();
  }
});

test('API: reject sends the plan back and pauses again', async () => {
  const h = await harness();
  try {
    const id = (await h.call('POST', '/api/runs', { task: 'make value good' })).json.id as string;
    await waitFor(async () => (await statusOf(h, id)) === 'awaiting-plan-approval');
    assert.equal((await h.call('POST', `/api/runs/${id}/reject`, {})).status, 400, 'feedback is required');
    const r = await h.call('POST', `/api/runs/${id}/reject`, { feedback: 'add a rollback step' });
    assert.equal(r.status, 202);
    await waitFor(async () => {
      const run = (await h.call('GET', `/api/runs/${id}`)).json.run;
      return run.status === 'awaiting-plan-approval' && run.usage.calls >= 2;
    });
    assert.equal((await h.call('GET', `/api/runs/${id}`)).json.run.rounds.length, 0, 'implementation has not started');
  } finally {
    await h.close();
  }
});

test('API: while one run executes, new/approve/reject/resume are refused with "busy", reads still work', async () => {
  const h = await harness();
  try {
    // Run A reaches the approval pause and releases the slot.
    const a = (await h.call('POST', '/api/runs', { task: 'task A' })).json.id as string;
    await waitFor(async () => (await statusOf(h, a)) === 'awaiting-plan-approval');

    // Run B is held inside the planner, so it holds the slot.
    const hold = h.holdPlanner();
    const b = (await h.call('POST', '/api/runs', { task: 'task B' })).json.id as string;
    await waitFor(async () => (await h.call('GET', '/api/state')).json.busy);

    const busy = await h.call('POST', '/api/runs', { task: 'task C' });
    assert.equal(busy.status, 409);
    assert.equal(busy.json.error.code, 'busy');
    assert.equal(busy.json.error.runId, b);
    assert.equal((await h.call('POST', `/api/runs/${a}/approve`, {})).status, 409);
    assert.equal((await h.call('POST', `/api/runs/${a}/reject`, { feedback: 'x' })).json.error.code, 'busy');

    // Reading is never blocked.
    assert.equal((await h.call('GET', '/api/runs')).json.runs.length, 2);
    assert.equal((await h.call('GET', `/api/runs/${a}`)).status, 200);
    assert.equal((await h.call('GET', `/api/runs/${b}/events`)).status, 200);

    hold.release();
    await waitFor(async () => (await h.call('GET', '/api/state')).json.busy === false);
    // After B pauses for approval the slot is free again.
    assert.equal((await h.call('POST', `/api/runs/${a}/approve`, {})).status, 202);
  } finally {
    await h.close();
  }
});

test('API: many simultaneous new-task requests start exactly one run', async () => {
  const h = await harness();
  try {
    const hold = h.holdPlanner();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => h.call('POST', '/api/runs', { task: `task ${i}` })));
    const accepted = results.filter((r) => r.status === 202);
    const busy = results.filter((r) => r.status === 409);
    assert.equal(accepted.length, 1);
    assert.equal(busy.length, 7);
    hold.release();
    await waitFor(async () => (await h.call('GET', '/api/state')).json.busy === false);
    assert.equal((await h.call('GET', '/api/runs')).json.runs.length, 1);
  } finally {
    await h.close();
  }
});

test('API: cancel stops the running run; cancel of an idle run is refused', async () => {
  const h = await harness();
  try {
    const hold = h.holdPlanner();
    const id = (await h.call('POST', '/api/runs', { task: 'slow task' })).json.id as string;
    await waitFor(async () => (await h.call('GET', '/api/state')).json.busy);
    assert.equal((await h.call('POST', `/api/runs/${id}/cancel`, {})).status, 202);
    hold.release();
    await waitFor(async () => (await h.call('GET', '/api/state')).json.busy === false);
    assert.equal((await h.call('POST', `/api/runs/${id}/cancel`, {})).json.error.code, 'not-running');
  } finally {
    await h.close();
  }
});

test('API: input validation and unknown things', async () => {
  const h = await harness();
  try {
    assert.equal((await h.call('POST', '/api/runs', {})).status, 400);
    assert.equal((await h.call('POST', '/api/runs', { task: '   ' })).status, 400);
    assert.equal((await h.call('GET', '/api/runs/no-such-run')).status, 404);
    assert.equal((await h.call('GET', '/api/nothing')).status, 404);
    const id = (await h.call('POST', '/api/runs', { task: 'x' })).json.id as string;
    await waitFor(async () => (await statusOf(h, id)) === 'awaiting-plan-approval');
    assert.equal((await h.call('POST', `/api/runs/${id}/resume`, {})).json.error.code, 'wrong-state');
  } finally {
    await h.close();
  }
});
