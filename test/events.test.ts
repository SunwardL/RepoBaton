import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { OpenAiCompatibleAgent } from '../src/agents/api.ts';
import type { AgentRegistry } from '../src/agents/registry.ts';
import { defaultConfig } from '../src/config.ts';
import { eventsFile, FileEventSink, readEvents } from '../src/events.ts';
import { git } from '../src/git.ts';
import { Pipeline } from '../src/pipeline.ts';
import { AgentError, type Agent, type AgentResult, type AgentRunRequest } from '../src/types.ts';

async function tmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('events get increasing seq numbers and survive a restart', async () => {
  const dir = await tmp('rb-ev-');
  const a = await FileEventSink.open(dir, 'run1');
  a.emit('run.started', 'one');
  a.emit('stage.started', 'two', { stage: 'plan' });
  await a.flush();
  const b = await FileEventSink.open(dir, 'run1');
  b.emit('run.resumed', 'three');
  await b.flush();
  const all = await readEvents(eventsFile(dir));
  assert.deepEqual(all.map((e) => e.seq), [1, 2, 3]);
  assert.equal(all[1].stage, 'plan');
  assert.deepEqual((await readEvents(eventsFile(dir), 2)).map((e) => e.seq), [3]);
});

test('many concurrent emits keep every line whole and ordered', async () => {
  const dir = await tmp('rb-ev-');
  const sink = await FileEventSink.open(dir, 'r');
  for (let i = 0; i < 200; i++) sink.emit('agent.progress', `line ${i}`, { data: { i } });
  await sink.flush();
  const all = await readEvents(eventsFile(dir));
  assert.equal(all.length, 200);
  assert.ok(all.every((e, i) => e.seq === i + 1 && e.message === `line ${i}`));
});

test('a torn last line is skipped instead of breaking the reader', async () => {
  const dir = await tmp('rb-ev-');
  const sink = await FileEventSink.open(dir, 'r');
  sink.emit('log.info', 'good');
  await sink.flush();
  await fs.appendFile(eventsFile(dir), '{"seq":2,"ts":"x","runId":"r","type":"log.in');
  const all = await readEvents(eventsFile(dir));
  assert.equal(all.length, 1);
  assert.equal(all[0].message, 'good');
});

async function serveStatus(status: number, body: unknown): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(() => r())) };
}

async function failureKind(status: number): Promise<AgentError> {
  const srv = await serveStatus(status, { error: { message: `status ${status}` } });
  process.env.RB_TEST_KEY = 'sk-test';
  const agent = new OpenAiCompatibleAgent('q', { type: 'openai-compatible', baseUrl: srv.base, model: 'm', apiKeyEnv: 'RB_TEST_KEY' });
  try {
    await agent.run({ stage: 'review', cwd: os.tmpdir(), access: 'read-only', timeoutMs: 5000, prompt: 'hi' });
  } catch (e) {
    return e as AgentError;
  } finally {
    await srv.close();
  }
  throw new Error('expected a failure');
}

test('API errors are classified so the UI can tell the user what to fix', async () => {
  const e401 = await failureKind(401);
  assert.equal(e401.kind, 'auth');
  assert.equal((await failureKind(403)).kind, 'auth');
  assert.equal((await failureKind(429)).kind, 'rate-limit');
  assert.equal((await failureKind(404)).kind, 'not-found');
  const e500 = await failureKind(500);
  assert.equal(e500.kind, 'unknown');
  assert.equal(e500.retryable, true);
});

test('a rejected key is not worth retrying, a rate limit is', async () => {
  assert.equal((await failureKind(401)).retryable, false);
  assert.equal((await failureKind(429)).retryable, true);
});

test('an unreachable server is a network error, and the key never appears in the message', async () => {
  process.env.RB_TEST_KEY = 'sk-SECRET-VALUE-123';
  const agent = new OpenAiCompatibleAgent('q', {
    type: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1/v1',
    model: 'm',
    apiKeyEnv: 'RB_TEST_KEY',
  });
  try {
    await agent.run({ stage: 'review', cwd: os.tmpdir(), access: 'read-only', timeoutMs: 5000, prompt: 'hi' });
    assert.fail('should have failed');
  } catch (e) {
    const err = e as AgentError;
    assert.equal(err.kind, 'network');
    assert.ok(!err.message.includes('SECRET-VALUE'));
  }
});

test('a missing key is an auth error and makes no request', async () => {
  delete process.env.RB_NO_KEY;
  const agent = new OpenAiCompatibleAgent('q', { type: 'openai-compatible', model: 'm', apiKeyEnv: 'RB_NO_KEY' });
  await assert.rejects(
    agent.run({ stage: 'review', cwd: os.tmpdir(), access: 'read-only', timeoutMs: 1000, prompt: 'hi' }),
    (e: unknown) => e instanceof AgentError && e.kind === 'auth' && e.retryable === false,
  );
});

class Scripted implements Agent {
  type = 'command' as const;
  id: string;
  private fn: (req: AgentRunRequest) => unknown;
  constructor(id: string, fn: (req: AgentRunRequest) => unknown) {
    this.id = id;
    this.fn = fn;
  }
  describe(): string {
    return this.id;
  }
  async check(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: '' };
  }
  async run(req: AgentRunRequest): Promise<AgentResult> {
    const out = await this.fn(req);
    return req.schema ? { text: JSON.stringify(out), structured: out, durationMs: 1 } : { text: String(out), durationMs: 1 };
  }
}

test('a run writes its own event stream, and an agent failure records its kind', async () => {
  const repo = await tmp('rb-evrun-');
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 't@e.com']);
  await git(repo, ['config', 'user.name', 't']);
  await fs.writeFile(path.join(repo, 'a.txt'), 'x\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'init']);

  const config = defaultConfig();
  config.agents = { p: { type: 'command', command: 'x' } };
  for (const s of ['plan', 'implement', 'review', 'release'] as const) config.stages[s].agent = 'p';
  config.stages.plan.retries = 0;
  config.test.setup = '';
  const planner = new Scripted('p', (req) => {
    req.onProgress?.('reading a.txt');
    throw new AgentError('HTTP 401 from https://x/v1: bad key', false, 'auth');
  });
  const registry = { get: () => planner } as unknown as AgentRegistry;
  const pipe = new Pipeline({ repo, config, registry });
  const state = await pipe.start('do a thing');

  assert.equal(state.status, 'failed');
  assert.equal(state.errorKind, 'auth');
  assert.equal(state.errorAgent, 'p');

  const events = await readEvents(eventsFile(pipe.store.dir(state.id)));
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'run.started');
  assert.equal(types[types.length - 1], 'run.finished');
  assert.ok(types.includes('stage.started'));
  assert.ok(types.includes('agent.started'));
  const failed = events.find((e) => e.type === 'agent.failed');
  assert.equal(failed?.data?.kind, 'auth');
  assert.equal(failed?.data?.retryable, false);
  assert.equal(failed?.stage, 'plan');
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
  const finished = events[events.length - 1];
  assert.equal(finished.data?.status, 'failed');
});

import { followEvents, formatEventLine, SETTLED_STATUSES } from '../src/events.ts';

test('followEvents delivers old events, then live ones, then stops when the run settles', async () => {
  const dir = await tmp('rb-follow-');
  const sink = await FileEventSink.open(dir, 'r');
  sink.emit('run.started', 'begin');
  await sink.flush();

  let settled = false;
  const seen: number[] = [];
  const done = followEvents(eventsFile(dir), {
    pollMs: 20,
    isSettled: async () => settled,
    onEvent: (e) => seen.push(e.seq),
  });
  await new Promise((r) => setTimeout(r, 60));
  sink.emit('stage.started', 'plan', { stage: 'plan' });
  await sink.flush();
  await new Promise((r) => setTimeout(r, 60));
  // The last event lands in the same instant the run is marked settled: it must not be lost.
  sink.emit('run.finished', 'done', { data: { status: 'succeeded' } });
  await sink.flush();
  settled = true;
  const last = await done;
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(last, 3);
});

test('followEvents can resume after a given seq and honours an abort signal', async () => {
  const dir = await tmp('rb-follow-');
  const sink = await FileEventSink.open(dir, 'r');
  for (let i = 0; i < 5; i++) sink.emit('log.info', `m${i}`);
  await sink.flush();
  const ctrl = new AbortController();
  const seen: number[] = [];
  const done = followEvents(eventsFile(dir), {
    afterSeq: 3,
    pollMs: 20,
    signal: ctrl.signal,
    isSettled: async () => false,
    onEvent: (e) => seen.push(e.seq),
  });
  setTimeout(() => ctrl.abort(), 80);
  await done;
  assert.deepEqual(seen, [4, 5]);
});

test('event lines are readable and statuses that stop a run are known', () => {
  const base = { seq: 1, ts: '2026-11-20T10:11:12.000Z', runId: 'r' } as const;
  assert.match(formatEventLine({ ...base, type: 'agent.failed', stage: 'plan', message: 'HTTP 401', data: { kind: 'auth' } }), /\[plan\] FAILED \(auth\): HTTP 401/);
  assert.match(formatEventLine({ ...base, type: 'run.finished', message: 'succeeded', data: { status: 'succeeded' } }), /== succeeded$/);
  assert.match(formatEventLine({ ...base, type: 'agent.progress', message: 'tool read_file' }), /^10:11:12 {5}tool read_file$/);
  assert.ok(SETTLED_STATUSES.includes('awaiting-plan-approval'));
  assert.ok(!SETTLED_STATUSES.includes('running'));
});

import { RunStore } from '../src/store.ts';

test('a settled status guarantees run.finished is already in the file', async () => {
  const repo = await tmp('rb-race-');
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 't@e.com']);
  await git(repo, ['config', 'user.name', 't']);
  await fs.writeFile(path.join(repo, 'a.txt'), 'x\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'init']);

  const config = defaultConfig();
  config.agents = { p: { type: 'command', command: 'x' } };
  for (const s of ['plan', 'implement', 'review', 'release'] as const) config.stages[s].agent = 'p';
  config.stages.plan.retries = 0;
  config.test.setup = '';
  const failing = new Scripted('p', () => {
    throw new AgentError('boom', false, 'unknown');
  });
  const registry = { get: () => failing } as unknown as AgentRegistry;
  const pipe = new Pipeline({ repo, config, registry });
  const store = new RunStore(repo);

  // Make appends slow, so any ordering bug shows up on every run rather than once in a while.
  const realAppend = fs.appendFile.bind(fs);
  let slow = true;
  (fs as { appendFile: typeof fs.appendFile }).appendFile = (async (...args: Parameters<typeof fs.appendFile>) => {
    if (slow) await new Promise((r) => setTimeout(r, 40));
    return realAppend(...args);
  }) as typeof fs.appendFile;

  const violations: string[] = [];
  let watching = true;
  const watcher = (async () => {
    while (watching) {
      for (const run of await store.list()) {
        if (!['succeeded', 'failed', 'cancelled', 'needs-human', 'awaiting-plan-approval'].includes(run.status)) continue;
        const events = await readEvents(eventsFile(store.dir(run.id)));
        if (!events.some((e) => e.type === 'run.finished')) violations.push(`${run.status} visible without run.finished`);
      }
      await new Promise((r) => setTimeout(r, 2));
    }
  })();

  try {
    const state = await pipe.start('do a thing');
    assert.equal(state.status, 'failed');
  } finally {
    slow = false;
    watching = false;
    await watcher;
    (fs as { appendFile: typeof fs.appendFile }).appendFile = realAppend as typeof fs.appendFile;
  }
  assert.deepEqual(violations, []);
});
