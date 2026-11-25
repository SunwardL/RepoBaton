import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ClaudeCliAgent, CodexCliAgent } from '../src/agents/cli.ts';
import { defaultConfig } from '../src/config.ts';
import { git } from '../src/git.ts';
import { AgentRegistry } from '../src/agents/registry.ts';
import { Pipeline } from '../src/pipeline.ts';
import { recoverInterrupted } from '../src/recovery.ts';
import { RunStore } from '../src/store.ts';
import { AgentError, type Agent, type AgentResult, type AgentRunRequest, type Config, type RunState } from '../src/types.ts';
import { readTaskWorkflow, withWorkflow } from '../src/workflow.ts';
import { resumeCommand } from '../src/resume.ts';

/**
 * Phase 1, item 1: choosing agents for one task must not silently drop the project's backup
 * (fallback) agent when the primary agent is unchanged.
 */

function configWithBackup(): Config {
  const config = defaultConfig();
  config.agents = {
    claude: { type: 'claude-cli' },
    codex: { type: 'codex-cli' },
    backup: { type: 'command', command: 'x' },
    other: { type: 'command', command: 'y' },
  };
  config.stages.implement.agent = 'codex';
  config.stages.implement.fallbackAgent = 'backup';
  config.stages.implement.effort = 'high';
  return config;
}

test('a task that keeps the default primary agent keeps the configured fallback agent', () => {
  const config = configWithBackup();
  // The page always submits every stage, even the ones the user did not touch.
  const workflow = readTaskWorkflow(config, {
    plan: { agent: config.stages.plan.agent },
    implement: { agent: 'codex' },
    review: { agent: config.stages.review.agent },
    release: { agent: config.stages.release.agent },
  });
  const effective = withWorkflow(config, workflow);
  assert.equal(effective.stages.implement.agent, 'codex');
  assert.equal(effective.stages.implement.fallbackAgent, 'backup');
  assert.equal(effective.stages.implement.effort, 'high');
});

test('the stage model chosen for the task still applies while the fallback is kept', () => {
  const config = configWithBackup();
  const effective = withWorkflow(config, readTaskWorkflow(config, { implement: { agent: 'codex', model: 'gpt-x' } }));
  assert.equal(effective.stages.implement.model, 'gpt-x');
  assert.equal(effective.stages.implement.fallbackAgent, 'backup');
});

test('changing the primary agent drops the old fallback: it belongs to the agent that was replaced', () => {
  const config = configWithBackup();
  const effective = withWorkflow(config, readTaskWorkflow(config, { implement: { agent: 'other' } }));
  assert.equal(effective.stages.implement.agent, 'other');
  assert.equal(effective.stages.implement.fallbackAgent, undefined);
  assert.equal(effective.stages.implement.effort, undefined);
});

test('the fallback survives the stored workflow when a task is resumed (same config, same result)', () => {
  const config = configWithBackup();
  const stored = readTaskWorkflow(config, { implement: { agent: 'codex' } });
  // What is stored on the run is the plain selection; resuming rebuilds the stage from it.
  const again = withWorkflow(config, JSON.parse(JSON.stringify(stored)));
  assert.equal(again.stages.implement.fallbackAgent, 'backup');
});

test('choosing the fallback agent itself as the primary leaves no self-referencing fallback', () => {
  const config = configWithBackup();
  const effective = withWorkflow(config, readTaskWorkflow(config, { implement: { agent: 'backup' } }));
  assert.equal(effective.stages.implement.agent, 'backup');
  assert.notEqual(effective.stages.implement.fallbackAgent, 'backup');
});

// ------------------------------------------------------------------ item 2: session ids survive failures

/**
 * A fake native CLI that RepoBaton launches exactly like an installed one: a script on disk plus an
 * npm-style .cmd shim next to it (the shape resolveLaunch understands on Windows).
 */
async function fakeCli(dir: string, name: string, body: string): Promise<string> {
  const script = path.join(dir, name + '.js');
  // RepoBaton probes every CLI with --version before using it; answer like a real one.
  await fs.writeFile(script, 'if (process.argv.includes("--version")) { console.log("9.9.9"); process.exit(0); }\n' + body, 'utf8');
  if (process.platform !== 'win32') {
    const launcher = path.join(dir, name);
    await fs.writeFile(launcher, '#!/bin/sh\nexec node "' + script + '" "$@"\n', { mode: 0o755 });
    return launcher;
  }
  const shim = path.join(dir, name + '.cmd');
  await fs.writeFile(shim, '@ECHO off\r\nSET dp0=%~dp0\r\n"%dp0%\\' + name + '.js" %*\r\n', 'utf8');
  return shim;
}

test('claude: a call that times out still reports the session id RepoBaton assigned up front', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-fakecli-'));
  // Never answers: the call can only end by timeout.
  const script = await fakeCli(dir, 'claude', 'setTimeout(() => {}, 60000);\n');
  const agent = new ClaudeCliAgent('c', { type: 'claude-cli', path: script });
  const seen: string[] = [];
  const err = await agent
    .run({ stage: 'implement', prompt: 'x', cwd: dir, access: 'workspace-write', timeoutMs: 800, persist: true, onSession: (id) => seen.push(id) })
    .then(() => null, (e) => e as AgentError);
  assert.ok(err instanceof AgentError);
  assert.equal(err.kind, 'timeout');
  assert.match(err.sessionId ?? '', /^[0-9a-f-]{36}$/, 'the id travels with the error');
  assert.deepEqual(seen, [err.sessionId], 'and it was announced as soon as the call started');
  assert.equal(err.sessionConfirmed, false, 'an id chosen before the call and never acknowledged is not presented as certain');
});

test('codex: the thread id from thread.started survives a call that then times out', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-fakecli-'));
  const script = await fakeCli(
    dir,
    'codex',
    'console.log(JSON.stringify({ type: "thread.started", thread_id: "11111111-2222-3333-4444-555555555555" }));\nsetTimeout(() => {}, 60000);\n',
  );
  const agent = new CodexCliAgent('x', { type: 'codex-cli', path: script });
  const seen: string[] = [];
  const err = await agent
    .run({ stage: 'implement', prompt: 'x', cwd: dir, access: 'workspace-write', timeoutMs: 1500, persist: true, onSession: (id) => seen.push(id) })
    .then(() => null, (e) => e as AgentError);
  assert.ok(err instanceof AgentError);
  assert.equal(err.sessionId, '11111111-2222-3333-4444-555555555555');
  assert.deepEqual(seen, ['11111111-2222-3333-4444-555555555555']);
  assert.notEqual(err.sessionConfirmed, false, 'codex announces its own id, so it is confirmed');
});

test('codex: a call that fails before any thread started has no session id, and says so', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-fakecli-'));
  const script = await fakeCli(dir, 'codex', 'console.error("boom"); process.exit(2);\n');
  const agent = new CodexCliAgent('x', { type: 'codex-cli', path: script });
  const err = await agent
    .run({ stage: 'implement', prompt: 'x', cwd: dir, access: 'workspace-write', timeoutMs: 5000, persist: true })
    .then(() => null, (e) => e as AgentError);
  assert.ok(err instanceof AgentError);
  assert.equal(err.sessionId, undefined);
});

/** Fails like a CLI that died. In 'announce-then-fail' mode it announces its session id first, then checks the id is already on disk. */
class Boom implements Agent {
  type = 'codex-cli' as const;
  id = 'boom';
  onDisk: () => Promise<string | undefined> = async () => undefined;
  seenOnDisk: string | undefined;
  mode: 'announce-then-fail' | 'fail';
  constructor(mode: 'announce-then-fail' | 'fail') {
    this.mode = mode;
  }
  describe(): string {
    return 'boom';
  }
  async check(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: '' };
  }
  async run(req: AgentRunRequest): Promise<AgentResult> {
    if (this.mode === 'announce-then-fail') {
      req.onSession?.('sess-early');
      await new Promise((r) => setTimeout(r, 50));
      this.seenOnDisk = await this.onDisk();
    }
    throw new AgentError('it broke', false, 'unknown', this.mode === 'announce-then-fail' ? 'sess-early' : undefined);
  }
}

async function repoWith(agents: Record<string, Agent>): Promise<{ pipe: Pipeline; repo: string }> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-rel-'));
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 't@e.com']);
  await git(repo, ['config', 'user.name', 't']);
  await fs.writeFile(path.join(repo, 'value.txt'), 'old\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  const config = defaultConfig();
  config.agents = { p: { type: 'command', command: 'x' }, boom: { type: 'command', command: 'x' } };
  config.stages.plan.enabled = false;
  config.stages.implement.agent = 'boom';
  config.stages.implement.retries = 0;
  config.stages.review.agent = 'p';
  config.stages.release.agent = 'p';
  config.test.setup = '';
  const registry = { get: (id: string) => agents[id] } as unknown as AgentRegistry;
  return { pipe: new Pipeline({ repo, config, registry }), repo };
}

test('pipeline: a failed call keeps the session id it got, and a call that got none says so', async () => {
  for (const mode of ['announce-then-fail', 'fail'] as const) {
    const boom = new Boom(mode);
    const { pipe } = await repoWith({ boom });
    boom.onDisk = async () => {
      const id = await pipe.store.resolve('last');
      return (await pipe.store.load(id)).sessions?.find((x) => x.stage === 'implement')?.sessionId;
    };
    const state = await pipe.start('t').catch(() => null);
    const stored = await pipe.store.load(state?.id ?? (await pipe.store.resolve('last')));
    const s = stored.sessions?.find((x) => x.stage === 'implement');
    assert.equal(s?.status, 'failed');
    if (mode === 'announce-then-fail') {
      assert.equal(s?.sessionId, 'sess-early');
      assert.equal(boom.seenOnDisk, 'sess-early', 'saved while the call was still running');
    }
    else {
      assert.equal(s?.sessionId, undefined);
      assert.match(s?.noSessionReason ?? '', /session id/i, 'the page can say why');
    }
  }
});

test('recovery: session records left running by a dead server are closed, not shown as running forever', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-rel-'));
  const store = new RunStore(repo);
  const now = new Date().toISOString();
  await store.save({
    id: 'dead',
    task: 't',
    repo,
    status: 'running',
    stage: 'implement-r1',
    createdAt: now,
    updatedAt: now,
    owner: { serverId: 'old', pid: 424242, startedAt: now },
    rounds: [],
    publish: {},
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, calls: 0 },
    sessions: [
      { label: 'plan', stage: 'plan', agent: 'a', agentType: 'claude-cli', sessionId: 's1', persisted: true, cwd: repo, status: 'completed', startedAt: now, finishedAt: now },
      { label: 'implement-r1', stage: 'implement', agent: 'a', agentType: 'codex-cli', sessionId: 's2', persisted: true, cwd: repo, status: 'running', startedAt: now },
    ],
  } as RunState);
  await recoverInterrupted(store, { currentServerId: 'new', isExecuting: () => false, probe: async () => ({ alive: false }) });
  const after = await store.load('dead');
  assert.equal(after.status, 'interrupted');
  const impl = after.sessions!.find((s) => s.label === 'implement-r1')!;
  assert.equal(impl.status, 'interrupted');
  assert.ok(impl.finishedAt);
  assert.equal(impl.sessionId, 's2', 'the id is kept so the user can continue it');
  assert.equal(after.sessions!.find((s) => s.label === 'plan')!.status, 'completed');
});

// ------------------------------------------------------------------ item 3: resume commands use the real CLI

const SID = '01a2079f-2f6f-7041-b8b9-c1620698f68b';

test('resume command: uses the path of the CLI RepoBaton actually launched, quoted for CMD when it has spaces', () => {
  const cmd = resumeCommand({
    agentType: 'codex-cli',
    sessionId: SID,
    cwd: 'C:\\Users\\Some One\\repo\\.repobaton\\worktrees\\r1',
    cli: { path: 'C:\\Program Files\\Codex Tools\\codex.exe' },
  });
  assert.equal(cmd, 'cd /d "C:\\Users\\Some One\\repo\\.repobaton\\worktrees\\r1" && "C:\\Program Files\\Codex Tools\\codex.exe" resume ' + SID);
});

test('resume command: a path without spaces is not over-quoted, and claude uses --resume', () => {
  const cmd = resumeCommand({ agentType: 'claude-cli', sessionId: SID, cwd: 'D:\\w\\wt', cli: { path: 'C:\\tools\\claude.exe' } });
  assert.equal(cmd, 'cd /d D:\\w\\wt && C:\\tools\\claude.exe --resume ' + SID);
});

test('resume command: arguments carried by a node launcher are included', () => {
  const cmd = resumeCommand({
    agentType: 'claude-cli',
    sessionId: SID,
    cwd: 'D:\\w',
    cli: { path: 'C:\\npm\\claude.cmd', command: 'C:\\Program Files\\nodejs\\node.exe', prefixArgs: ['C:\\npm\\node_modules\\cli.js'] },
  });
  assert.equal(cmd, 'cd /d D:\\w && "C:\\Program Files\\nodejs\\node.exe" C:\\npm\\node_modules\\cli.js --resume ' + SID);
});

test('resume command actually runs the recorded launcher and enters its working directory on Windows', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rb resume command-'));
  const cwd = path.join(root, 'work tree');
  const script = path.join(root, 'fake cli.cjs');
  await fs.mkdir(cwd);
  await fs.writeFile(script, "process.stdout.write(JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2)}));\n");
  try {
    for (const [agentType, verb] of [['codex-cli', 'resume'], ['claude-cli', '--resume']] as const) {
      const command = resumeCommand({ agentType, sessionId: SID, cwd,
        cli: { path: 'unused-launcher.cmd', command: process.execPath, prefixArgs: [script] } });
      assert.ok(command);
      // Feed the line to CMD as a user would paste it; passing it through /c adds another quoting layer.
      const result = spawnSync('C:\\Windows\\System32\\cmd.exe', ['/d', '/q'], { input: `${command}\r\nexit\r\n`, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      const json = result.stdout.match(/\{[^\r\n]+\}/)?.[0];
      assert.ok(json, result.stdout);
      const actual = JSON.parse(json) as { cwd: string; args: string[] };
      assert.equal((await fs.realpath(actual.cwd)).toLowerCase(), (await fs.realpath(cwd)).toLowerCase());
      assert.deepEqual(actual.args, [verb, SID]);
    }
  } finally {
    const target = await fs.realpath(root);
    assert.equal(path.dirname(target).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
    assert.ok(path.basename(target).startsWith('rb resume command-'));
    await fs.rm(target, { recursive: true });
  }
});

test('resume command: old records without a recorded CLI fall back to the bare name, and records without an id give nothing', () => {
  assert.equal(resumeCommand({ agentType: 'codex-cli', sessionId: SID, cwd: 'D:\\w' }), 'cd /d D:\\w && codex resume ' + SID);
  assert.equal(resumeCommand({ agentType: 'claude-cli', sessionId: SID, cwd: 'D:\\w' }), 'cd /d D:\\w && claude --resume ' + SID);
  assert.equal(resumeCommand({ agentType: 'codex-cli', cwd: 'D:\\w' }), null);
  assert.equal(resumeCommand({ agentType: 'command', sessionId: 'x', cwd: 'D:\\w' }), null);
});

test('resume command: characters that would break out of a CMD line are refused, not escaped', () => {
  for (const bad of ['C:\\a & calc\\codex.exe', 'C:\\a"b\\codex.exe', 'C:\\%PATH%\\codex.exe', 'C:\\a^b\\codex.exe']) {
    assert.equal(resumeCommand({ agentType: 'codex-cli', sessionId: SID, cwd: 'D:\\w', cli: { path: bad } }), null, bad);
  }
  assert.equal(resumeCommand({ agentType: 'codex-cli', sessionId: SID + ' & calc', cwd: 'D:\\w' }), null);
  assert.equal(resumeCommand({ agentType: 'codex-cli', sessionId: SID, cwd: 'D:\\w & calc' }), null);
});

test('the pipeline records how the CLI that created each session was launched', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-fakecli-'));
  const script = await fakeCli(dir, 'codex', 'console.log(JSON.stringify({ type: "thread.started", thread_id: "' + SID + '" }));\nconsole.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }));\nconsole.log(JSON.stringify({ type: "turn.completed", usage: {} }));\n');
  const agent = new CodexCliAgent('x', { type: 'codex-cli', path: script });
  const res = await agent.run({ stage: 'implement', prompt: 'x', cwd: dir, access: 'workspace-write', timeoutMs: 20000, persist: true });
  assert.equal(res.sessionId, SID);
  assert.ok(res.cli?.path, 'the adapter reports which executable it ran');
  assert.equal(path.resolve(res.cli!.path).toLowerCase(), path.resolve(script).toLowerCase());
  const cmd = resumeCommand({ agentType: 'codex-cli', sessionId: SID, cwd: dir, cli: res.cli });
  assert.ok(cmd?.includes(' resume ' + SID));
});

// ------------------------------------------------------------------ follow-up A: state writes are ordered

/**
 * Slow down the write of exactly the snapshots that satisfy `when`, by delaying the rename that
 * publishes them. Returns a function that puts the real rename back.
 */
function delaySnapshots(when: (s: RunState) => boolean, ms: number): () => void {
  const target = fs as unknown as { rename: (a: string, b: string) => Promise<void> };
  const real = target.rename.bind(fs);
  target.rename = async (from: string, to: string): Promise<void> => {
    if (to.endsWith('state.json')) {
      try {
        if (when(JSON.parse(await fs.readFile(from, 'utf8')) as RunState)) await new Promise((r) => setTimeout(r, ms));
      } catch {
        /* not a snapshot we recognise: do not delay */
      }
    }
    return real(from, to);
  };
  return () => {
    target.rename = real;
  };
}

function minimalState(repo: string, over: Partial<RunState> = {}): RunState {
  const now = new Date().toISOString();
  return { id: 'ord', task: 't', repo, status: 'running', createdAt: now, updatedAt: now, rounds: [], publish: {}, usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, calls: 0 }, ...over };
}

test('state writes for one run land in the order they were requested, even when an earlier one is slow', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-ord-'));
  const store = new RunStore(repo);
  const state = minimalState(repo);
  const restore = delaySnapshots((s) => s.status === 'running', 250);
  try {
    const first = store.save(state); // snapshot: running (slow)
    state.status = 'failed';
    const second = store.save(state); // snapshot: failed (fast)
    await Promise.all([first, second]);
  } finally {
    restore();
  }
  assert.equal((await store.load('ord')).status, 'failed', 'the newest requested state is the one on disk');
});

test('two stores over the same repository share one write order', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-ord-'));
  const a = new RunStore(repo);
  const b = new RunStore(repo);
  const state = minimalState(repo);
  const restore = delaySnapshots((s) => s.status === 'running', 250);
  try {
    const first = a.save(state);
    state.status = 'interrupted';
    const second = b.save(state);
    await Promise.all([first, second]);
  } finally {
    restore();
  }
  assert.equal((await a.load('ord')).status, 'interrupted');
});

test('a failed write does not block the writes queued behind it', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-ord-'));
  const store = new RunStore(repo);
  const state = minimalState(repo);
  const target = fs as unknown as { rename: (a: string, b: string) => Promise<void> };
  const real = target.rename.bind(fs);
  let failedOnce = false;
  target.rename = async (from: string, to: string): Promise<void> => {
    if (!failedOnce && to.endsWith('state.json')) {
      failedOnce = true;
      throw Object.assign(new Error('disk said no'), { code: 'ENOSPC' });
    }
    return real(from, to);
  };
  try {
    const first = store.save(state).then(() => 'ok', () => 'failed');
    state.status = 'failed';
    const second = store.save(state);
    assert.equal(await first, 'failed');
    await second;
  } finally {
    target.rename = real;
  }
  assert.equal((await store.load('ord')).status, 'failed');
});

/** Reports a session id and returns at once, so the save started by onSession is still in flight when the stage ends. */
class QuickNative implements Agent {
  type = 'codex-cli' as const;
  id = 'quick';
  describe(): string {
    return 'quick';
  }
  async check(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: '' };
  }
  async run(req: AgentRunRequest): Promise<AgentResult> {
    req.onSession?.('sess-early');
    return { text: 'done', durationMs: 1, sessionId: 'sess-early' };
  }
}

test('pipeline: a slow save started when the session id arrived cannot overwrite the finished stage', async () => {
  const quick = new QuickNative();
  const { pipe, repo } = await repoWith({ boom: quick });
  const restore = delaySnapshots((s) => !!s.sessions?.some((x) => x.sessionId === 'sess-early' && x.status === 'running'), 300);
  try {
    await pipe.start('t').catch(() => null);
    await new Promise((r) => setTimeout(r, 600)); // long enough for a stray late write to land
  } finally {
    restore();
  }
  const stored = await new RunStore(repo).load(await new RunStore(repo).resolve('last'));
  const s = stored.sessions?.find((x) => x.stage === 'implement');
  assert.equal(s?.sessionId, 'sess-early');
  assert.equal(s?.status, 'completed', 'the stage finished; an older "running" snapshot must not be the last write');
  assert.ok(s?.finishedAt);
});

// ------------------------------------------------------------------ follow-up B: the launch is recorded before the call

const SID2 = '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';

/** A native Codex pipeline whose CLI is a fake script in a directory with a space in its name. */
async function nativePipe(script: string, timeoutSec: number, signal?: AbortSignal): Promise<{ pipe: Pipeline; repo: string }> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-launch-'));
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 't@e.com']);
  await git(repo, ['config', 'user.name', 't']);
  await fs.writeFile(path.join(repo, 'value.txt'), 'old\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  const config = defaultConfig();
  config.agents = { n: { type: 'codex-cli', path: script } };
  config.stages.plan.enabled = false;
  config.stages.implement.agent = 'n';
  config.stages.implement.retries = 0;
  config.stages.implement.timeoutSec = timeoutSec;
  config.stages.review.agent = 'n';
  config.stages.release.agent = 'n';
  config.test.setup = '';
  return { pipe: new Pipeline({ repo, config, registry: new AgentRegistry(config), signal }), repo };
}

async function spacedDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'rb fake cli-'));
}

const threadStarted = 'console.log(JSON.stringify({ type: "thread.started", thread_id: "' + SID2 + '" }));\n';

async function implementSession(repo: string): Promise<NonNullable<RunState['sessions']>[number]> {
  const store = new RunStore(repo);
  const s = (await store.load(await store.resolve('last'))).sessions?.find((x) => x.stage === 'implement');
  assert.ok(s, 'the implement call left a session record');
  return s;
}

test('a call that fails after the CLI announced its session keeps the CLI launch, so the command is runnable', async () => {
  const script = await fakeCli(await spacedDir(), 'codex', threadStarted + 'process.exit(1);\n');
  const { pipe, repo } = await nativePipe(script, 30);
  await pipe.start('t').catch(() => null);
  const s = await implementSession(repo);
  assert.equal(s.status, 'failed');
  assert.equal(s.sessionId, SID2);
  assert.ok(s.cli?.path, 'the executable that was launched is recorded even though the call failed');
  const cmd = resumeCommand(s);
  assert.ok(cmd, 'a command is offered');
  assert.ok(cmd.includes('rb fake cli-'), 'it uses the real location, not the bare name: ' + cmd);
  assert.ok(!/ && codex resume /.test(cmd), 'and does not fall back to a bare "codex"');
});

test('a call that times out keeps the CLI launch', async () => {
  const script = await fakeCli(await spacedDir(), 'codex', threadStarted + 'setTimeout(() => {}, 60000);\n');
  const { pipe, repo } = await nativePipe(script, 1);
  await pipe.start('t').catch(() => null);
  const s = await implementSession(repo);
  assert.equal(s.status, 'failed');
  assert.equal(s.sessionId, SID2);
  assert.ok(s.cli?.path);
  assert.ok(resumeCommand(s)?.includes('rb fake cli-'));
});

test('while the call is still running, the saved record already carries the id and the CLI launch', async () => {
  const script = await fakeCli(await spacedDir(), 'codex', threadStarted + 'setTimeout(() => {}, 60000);\n');
  const ctl = new AbortController();
  const { pipe, repo } = await nativePipe(script, 120, ctl.signal);
  const done = pipe.start('t').catch(() => null);
  const store = new RunStore(repo);
  let onDisk: NonNullable<RunState['sessions']>[number] | undefined;
  const end = Date.now() + 60000;
  while (Date.now() < end && !onDisk) {
    await new Promise((r) => setTimeout(r, 100));
    const ids = await store.list();
    onDisk = ids[0]?.sessions?.find((x) => x.stage === 'implement' && x.sessionId && x.cli);
  }
  ctl.abort();
  await done;
  assert.ok(onDisk, 'the id and the launch reached disk during the call (what a server stop would leave behind)');
  assert.equal(onDisk.status, 'running');
  assert.ok(resumeCommand(onDisk)?.includes('rb fake cli-'));
});

test('recovery keeps the recorded launch when it closes a running session', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-rel-'));
  const store = new RunStore(repo);
  const now = new Date().toISOString();
  const wt = path.join(repo, 'wt');
  await store.save(
    minimalState(repo, {
      id: 'rec',
      stage: 'implement-r1',
      owner: { serverId: 'old', pid: 424242, startedAt: now },
      sessions: [
        { label: 'implement-r1', stage: 'implement', agent: 'n', agentType: 'codex-cli', sessionId: SID2, persisted: true, cwd: wt, status: 'running', startedAt: now, cli: { path: 'D:\\tools\\codex.exe' } },
      ],
    }),
  );
  await recoverInterrupted(store, { currentServerId: 'new', isExecuting: () => false, probe: async () => ({ alive: false }) });
  const s = (await store.load('rec')).sessions![0];
  assert.equal(s.status, 'interrupted');
  assert.equal(s.cli?.path, 'D:\\tools\\codex.exe');
  assert.ok(resumeCommand(s)?.includes('D:\\tools\\codex.exe'));
});
