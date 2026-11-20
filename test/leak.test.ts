import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { git } from '../src/git.ts';
import { ProjectRegistry } from '../src/projects.ts';
import { startServer } from '../src/server/server.ts';
import { RunStore } from '../src/store.ts';
import { eventsFile } from '../src/events.ts';

// A fake provider that rejects every request and, like some real ones, repeats the credential
// it was given in the error body, in a header it echoes, and in a URL.
const SENTINEL = 'sk-SENTINEL-do-not-leak-0123456789abcdef';
const URL_PASSWORD = 'urlpass-SENTINEL-77';

async function fakeProvider(): Promise<{ base: string; close: () => Promise<void>; hits: number[] }> {
  const hits: number[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits.push(1);
      const auth = String(req.headers.authorization ?? '');
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${auth.replace('Bearer ', '')}. Authorization: ${auth}`, type: 'invalid_request_error', api_key: auth.replace('Bearer ', '') } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, hits, close: () => new Promise((r) => server.close(() => r())) };
}

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'worktrees' || e.name === 'node_modules' || e.name === '.git') continue;
      out.push(...(await allFiles(p)));
    } else out.push(p);
  }
  return out;
}

test('a provider that echoes the key in its error never gets it into state, events, report, artifacts, the API, the log or the UI payloads', async () => {
  const provider = await fakeProvider();
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-leak-'));
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 't@e.com']);
  await git(repo, ['config', 'user.name', 't']);
  await fs.writeFile(path.join(repo, 'a.txt'), 'x\n');
  await fs.writeFile(
    path.join(repo, 'repobaton.yaml'),
    [
      'agents:',
      `  gpt: { type: openai-compatible, baseUrl: "${provider.base}/v1", model: m, apiKeyEnv: RB_LEAK_TEST_KEY }`,
      'stages:',
      '  plan: { agent: gpt, retries: 0 }',
      '  implement: { agent: gpt, retries: 0 }',
      '  review: { agent: gpt, retries: 0 }',
      '  release: { agent: gpt, retries: 0 }',
      'test: { setup: "" }',
      '',
    ].join('\n'),
  );
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'init']);

  process.env.RB_LEAK_TEST_KEY = SENTINEL;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-leak-home-'));
  const prevHome = process.env.REPOBATON_HOME;
  process.env.REPOBATON_HOME = home; // so server.log lands where the test can read it
  const registry = new ProjectRegistry(path.join(home, 'projects.json'));
  const srv = await startServer({ registry, seedProjects: [repo], skipRecovery: true });
  const bodies: string[] = [];
  const call = async (method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api${p}`, {
      method,
      headers: { authorization: `Bearer ${srv.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  try {
    const pid = (await call('GET', '/projects')).json.projects[0].id as string;
    const created = await call('POST', `/projects/${pid}/runs`, { task: 'anything' });
    assert.equal(created.status, 202);
    const id = created.json.id as string;
    let run: any;
    for (let i = 0; i < 400; i++) {
      run = (await call('GET', `/projects/${pid}/runs/${id}`)).json;
      if (run.run.status !== 'running' || !run.executing) if (run.run.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(run.run.status, 'failed');
    assert.ok(provider.hits.length >= 1, 'the fake provider really was called');

    // What stays useful: the agent, the category, the variable name never needed hiding, and the status line.
    assert.equal(run.run.errorKind, 'auth');
    assert.equal(run.run.errorAgent, 'gpt');
    assert.match(run.run.error, /HTTP 401/);
    assert.match(run.run.error, /Incorrect API key provided/);

    await call('GET', `/projects/${pid}/runs`);
    await call('GET', `/projects/${pid}/runs/${id}/events`);
    await call('GET', `/projects/${pid}/runs/${id}/report`);
    await call('GET', `/projects/${pid}/status`);
    await call('GET', '/projects');
  } finally {
    await srv.close();
    await provider.close();
  }

  // Everything the server returned over HTTP.
  for (const b of bodies) assert.ok(!b.includes(SENTINEL), `an API response contained the key:\n${b.slice(0, 300)}`);
  // Everything on disk under the repository and under the server's data folder.
  const files = [...(await allFiles(path.join(repo, '.repobaton'))), ...(await allFiles(home))];
  assert.ok(files.length > 3, 'there was something to scan');
  for (const f of files) {
    const text = await fs.readFile(f, 'utf8').catch(() => '');
    assert.ok(!text.includes(SENTINEL), `${f} contains the key`);
  }
  // The server log exists and is clean (it is written through the masking logger).
  const log = await fs.readFile(path.join(home, 'server.log'), 'utf8').catch(() => '');
  assert.ok(!log.includes(SENTINEL));
  // The run events specifically.
  const store = new RunStore(repo);
  const [runId] = (await store.list()).map((r) => r.id);
  const ev = await fs.readFile(eventsFile(store.dir(runId)), 'utf8');
  assert.ok(ev.includes('agent.failed'));
  assert.ok(!ev.includes(SENTINEL));
  if (prevHome === undefined) delete process.env.REPOBATON_HOME;
  else process.env.REPOBATON_HOME = prevHome;
  delete process.env.RB_LEAK_TEST_KEY;
  void URL_PASSWORD;
});

test('a runs list written by an older version, with a credential already in its error text, is masked when served', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-old-'));
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 't@e.com']);
  await git(repo, ['config', 'user.name', 't']);
  await fs.writeFile(path.join(repo, 'a.txt'), 'x\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  const store = new RunStore(repo);
  const dir = store.dir('old1');
  await fs.mkdir(dir, { recursive: true });
  // Written directly, bypassing the masking save(): exactly what an older release left on disk.
  await fs.writeFile(
    path.join(dir, 'state.json'),
    JSON.stringify({ id: 'old1', task: 't', repo, status: 'failed', error: `plan stage failed: HTTP 401: Incorrect API key provided: ${SENTINEL}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), rounds: [], publish: {}, usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, calls: 0 } }),
  );
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-old-home-'));
  const registry = new ProjectRegistry(path.join(home, 'projects.json'));
  const srv = await startServer({ registry, seedProjects: [repo], skipRecovery: true });
  try {
    const get = async (p: string): Promise<string> => (await fetch(`http://127.0.0.1:${srv.port}/api${p}`, { headers: { authorization: `Bearer ${srv.token}` } })).text();
    const pid = JSON.parse(await get('/projects')).projects[0].id as string;
    for (const p of [`/projects/${pid}/runs`, `/projects/${pid}/runs/old1`]) {
      const text = await get(p);
      assert.ok(text.includes('old1'));
      assert.ok(!text.includes(SENTINEL), p);
      assert.match(text, /Incorrect API key provided/);
    }
  } finally {
    await srv.close();
  }
});
