import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { AgentRegistry } from '../src/agents/registry.ts';
import { defaultConfig } from '../src/config.ts';
import { git, removeWorktree, realRemoteOps } from '../src/git.ts';
import { Pipeline, PipelineError } from '../src/pipeline.ts';
import { cleanupPreview, cleanupRun, recoverInterrupted } from '../src/recovery.ts';
import { RunStore } from '../src/store.ts';
import { readStepOutput, readStepPrompt } from '../src/flow-store.ts';
import { eventsFile, readEvents } from '../src/events.ts';
import { checkAndRecord } from '../src/publishcheck.ts';
import type { Workflow } from '../src/flow-types.ts';
import type { Agent, AgentRunRequest, AgentResult } from '../src/types.ts';
import { AgentError } from '../src/types.ts';

const previousHome = process.env.REPOBATON_HOME;
const testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-flow-exec-home-'));
process.env.REPOBATON_HOME = testHome;
after(async () => {
  if (previousHome === undefined) delete process.env.REPOBATON_HOME;
  else process.env.REPOBATON_HOME = previousHome;
  const resolved = await fs.realpath(testHome);
  assert.equal(path.dirname(resolved).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
  assert.ok(path.basename(resolved).startsWith('rb-flow-exec-home-'));
  await fs.rm(resolved, { recursive: true, force: true });
});

class Fake implements Agent {
  type = 'command' as const;
  id: string;
  calls: AgentRunRequest[] = [];
  private handler: (req: AgentRunRequest, n: number) => Promise<string> | string;
  constructor(id: string, handler: (req: AgentRunRequest, n: number) => Promise<string> | string) {
    this.id = id;
    this.handler = handler;
  }
  describe(): string {
    return `fake ${this.id}`;
  }
  async check(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'fake' };
  }
  async run(req: AgentRunRequest): Promise<AgentResult> {
    this.calls.push(req);
    const text = await this.handler(req, this.calls.length);
    return { text, durationMs: 1, sessionId: `s-${this.calls.length}` };
  }
}

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-exec-'));
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 't@example.com']);
  await git(dir, ['config', 'user.name', 't']);
  await fs.writeFile(path.join(dir, 'value.txt'), 'old\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function setup(repo: string, agents: Record<string, Fake>): Pipeline {
  const config = defaultConfig();
  config.agents = { first: { type: 'command', command: 'x' }, second: { type: 'command', command: 'x' } };
  config.test.setup = '';
  const registry = { get: (id: string) => agents[id] } as unknown as AgentRegistry;
  return new Pipeline({ repo, config, registry });
}

const agentStep = (id: string, agent: string, prompt: string, access = 'read-only') =>
  ({ id, title: id, type: 'agent', agent, access, prompt, output: { kind: 'text' } }) as Workflow['steps'][number];

function flow(steps: Workflow['steps']): Workflow {
  return { schema: 1, kind: 'custom', name: 't', steps, git: { mode: 'none' } };
}

test('two agent steps run in order and the second prompt carries the first output', async () => {
  const repo = await makeRepo();
  const first = new Fake('first', () => 'PLAN-XYZ');
  const second = new Fake('second', async (req) => {
    req.onProgress?.('writing file');
    await fs.writeFile(path.join(req.cwd, 'value.txt'), 'new\n');
    return 'built';
  });
  const p = setup(repo, { first, second });
  const state = await p.startFlow('do it', flow([
    agentStep('design', 'first', 'plan: {{task}}'),
    agentStep('build', 'second', 'implement\n{{steps.design.output}}', 'workspace-write'),
  ]));
  assert.equal(state.status, 'succeeded', state.error);
  assert.equal(state.steps?.design.status, 'succeeded');
  assert.equal(state.steps?.build.status, 'succeeded');
  assert.equal(second.calls.length, 1);
  assert.match(second.calls[0].prompt, /PLAN-XYZ/);
  const promptRef = state.steps?.build.promptRef;
  assert.ok(promptRef);
  assert.equal(await readStepPrompt(new RunStore(repo).dir(state.id), 'build', promptRef), second.calls[0].prompt);
  assert.match(first.calls[0].prompt, /do it/);
  const events = await readEvents(eventsFile(new RunStore(repo).dir(state.id)));
  assert.deepEqual(events.filter((event) => event.type === 'step.started').map((event) => event.data?.stepId), ['design', 'build']);
  assert.deepEqual(events.filter((event) => event.type === 'step.finished').map((event) => event.data?.stepId), ['design', 'build']);
  assert.ok(events.some((event) => event.type === 'agent.progress' && event.message.includes('writing file')));
  assert.equal(events.at(-1)?.type, 'run.finished');
  const report = await fs.readFile(path.join(new RunStore(repo).dir(state.id), 'report.md'), 'utf8');
  assert.match(report, /Workflow: t/);
  assert.match(report, /design.*\n- Type: agent\n- Status: succeeded/);
  assert.match(report, /steps\/build\/prompt-1\.txt/);
  assert.equal(second.calls[0].cwd, first.calls[0].cwd, 'one worktree for the whole task');
  // No commit step: the change stays uncommitted in the worktree.
  assert.equal((await fs.readFile(path.join(state.worktree!, 'value.txt'), 'utf8')).trim(), 'new');
  assert.ok((await git(state.worktree!, ['status', '--porcelain'])).includes('value.txt'));
  let removed = false;
  await assert.rejects(cleanupRun(new RunStore(repo), repo, state.id, () => false, async () => { removed = true; }), /uncommitted changes/);
  assert.equal(removed, false);
  assert.equal((await fs.readFile(path.join(state.worktree!, 'value.txt'), 'utf8')).trim(), 'new');
  const preview = await cleanupPreview(new RunStore(repo), repo, state.id, () => false);
  assert.ok(preview.files.some((line) => line.includes('value.txt')));
  await fs.writeFile(path.join(state.worktree!, 'later.txt'), 'later');
  await assert.rejects(cleanupRun(new RunStore(repo), repo, state.id, () => false, removeWorktree, preview.confirmationHash), /changed/);
  const updated = await cleanupPreview(new RunStore(repo), repo, state.id, () => false);
  await cleanupRun(new RunStore(repo), repo, state.id, () => false, removeWorktree, updated.confirmationHash);
  await assert.rejects(fs.stat(state.worktree!));
});

test('a custom step uses its configured fallback and retains the failed session', async () => {
  const repo = await makeRepo();
  const first = new Fake('first', (req) => {
    req.onSession?.('primary-session');
    throw new AgentError('primary failed', false, 'auth', 'primary-session');
  });
  const second = new Fake('second', (req) => {
    assert.equal(req.sessionId, undefined);
    assert.equal(req.model, undefined);
    return 'fallback result';
  });
  const step = { ...agentStep('design', 'first', 'plan'), fallbackAgent: 'second', model: 'primary-model' } as Workflow['steps'][number];
  const state = await setup(repo, { first, second }).startFlow('task', flow([step]));
  assert.equal(state.status, 'succeeded', state.error);
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 1);
  assert.equal(state.steps?.design.agent, 'second');
  assert.deepEqual(state.sessions?.map((session) => [session.agent, session.status, session.sessionId]),
    [['first', 'failed', 'primary-session'], ['second', 'completed', 's-1']]);
  assert.equal((await readStepOutput(new RunStore(repo).dir(state.id), 'design')).status, 'succeeded');
});

test('a timed-out custom agent does not automatically run its fallback', async () => {
  const repo = await makeRepo();
  const first = new Fake('first', () => { throw new AgentError('timed out', true, 'timeout'); });
  const second = new Fake('second', () => 'never');
  const step = { ...agentStep('design', 'first', 'plan'), fallbackAgent: 'second' } as Workflow['steps'][number];
  const state = await setup(repo, { first, second }).startFlow('task', flow([step]));
  assert.equal(state.steps?.design.status, 'unknown');
  assert.equal(second.calls.length, 0);
});

test('a failed step stops the flow and the dependent agent step is never started', async () => {
  const repo = await makeRepo();
  const first = new Fake('first', () => {
    throw new Error('boom');
  });
  const second = new Fake('second', () => 'never');
  const state = await setup(repo, { first, second }).startFlow('t', flow([
    agentStep('design', 'first', 'plan'),
    agentStep('build', 'second', '{{steps.design.output}}'),
  ]));
  assert.equal(state.status, 'failed');
  assert.equal(state.steps?.design.status, 'failed');
  assert.ok(state.steps?.design.reason);
  assert.notEqual(state.steps?.build.status, 'succeeded');
  assert.equal(second.calls.length, 0);
});

test('a successful agent whose output cannot be saved has an unknown step result', async () => {
  const repo = await makeRepo();
  let runId = '';
  const writer = new Fake('first', async () => {
    await fs.mkdir(path.join(new RunStore(repo).dir(runId), 'steps', 'write', 'output.txt'));
    return 'the agent already ran';
  });
  const pipeline = setup(repo, { first: writer });
  const state = await pipeline.startFlow('task', flow([agentStep('write', 'first', 'modify', 'workspace-write')]), (id) => { runId = id; });
  assert.equal(state.status, 'failed');
  assert.equal(state.steps?.write.status, 'unknown');
  assert.equal(writer.calls.length, 1);
  assert.equal(state.sessions?.[0].status, 'completed', 'the Agent completed even though saving its output failed');
  assert.equal(state.sessions?.[0].sessionId, 's-1');
  assert.equal(state.usage.calls, 1);
});

test('a command step reads the task through a file and special characters stay data', async () => {
  const repo = await makeRepo();
  const nasty = 'a & echo INJECTED > injected.txt | whoami "q" %PATH% $(id) `id` end';
  const reader = `node -e "process.stdout.write(require('fs').readFileSync(process.env.RB_TASK_FILE,'utf8'))"`;
  const second = new Fake('second', () => 'unused');
  const state = await setup(repo, { first: new Fake('first', () => 'x'), second }).startFlow(nasty, flow([
    { id: 'cmd', title: 'cmd', type: 'command', run: reader, inputs: [{ kind: 'task' }], output: { kind: 'text' } },
  ]));
  assert.equal(state.status, 'succeeded', state.error);
  assert.equal(state.steps?.cmd.status, 'succeeded');
  const out = await fs.readFile(path.join(repo, '.repobaton', 'runs', state.id, 'steps', 'cmd', 'output.txt'), 'utf8');
  assert.ok(out.includes(nasty));
  await assert.rejects(fs.stat(path.join(state.worktree!, 'injected.txt')));
});

test('an explicit commit records the tree produced by the prior step', async () => {
  const repo = await makeRepo();
  const writer = new Fake('first', async (req) => {
    await fs.writeFile(path.join(req.cwd, 'value.txt'), 'committed\n');
    return 'done';
  });
  const definition = flow([
    agentStep('write', 'first', 'edit', 'workspace-write'),
    { id: 'commit', title: 'commit', type: 'commit', message: 'save work' },
  ]);
  definition.git.mode = 'explicit-step';
  const state = await setup(repo, { first: writer }).startFlow('save it', definition);
  assert.equal(state.status, 'succeeded', state.error);
  assert.equal(state.steps?.commit.status, 'succeeded');
  assert.equal((await git(state.worktree!, ['rev-parse', 'HEAD^{tree}'])).trim(), state.steps?.commit.expectedTree);
  assert.equal((await git(state.worktree!, ['show', 'HEAD:value.txt'])).trim(), 'committed');
});

test('an explicit commit does not stage or commit while another Git operation is in progress', async () => {
  const repo = await makeRepo();
  const writer = new Fake('first', async (req) => {
    await fs.writeFile(path.join(req.cwd, 'value.txt'), 'uncommitted\n');
    const marker = path.resolve(req.cwd, (await git(req.cwd, ['rev-parse', '--git-path', 'MERGE_HEAD'])).trim());
    await fs.writeFile(marker, (await git(req.cwd, ['rev-parse', 'HEAD'])).trim());
    return 'done';
  });
  const definition = flow([agentStep('write', 'first', 'edit', 'workspace-write'),
    { id: 'commit', title: 'commit', type: 'commit', message: 'save' }]);
  definition.git.mode = 'explicit-step';
  const state = await setup(repo, { first: writer }).startFlow('save', definition);
  assert.equal(state.steps?.commit.status, 'failed');
  assert.match(state.steps!.commit.reason!, /unfinished operation/);
  assert.equal((await git(state.worktree!, ['diff', '--cached', '--name-only'])).trim(), '');
  assert.equal((await git(state.worktree!, ['rev-parse', 'HEAD'])).trim(), state.base!.sha);
  assert.equal(await fs.readFile(path.join(state.worktree!, 'value.txt'), 'utf8'), 'uncommitted\n');
});

test('custom publishing pushes only after the exact commit and destination are approved', async () => {
  const repo = await makeRepo();
  const remotes = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-custom-publish-'));
  const remote = path.join(remotes, 'origin.git');
  await git(remotes, ['init', '-q', '--bare', remote]);
  await git(repo, ['remote', 'add', 'origin', remote]);
  const writer = new Fake('first', async (req) => {
    await fs.writeFile(path.join(req.cwd, 'value.txt'), 'ready to publish\n');
    return 'changed';
  });
  const definition = flow([agentStep('write', 'first', '{{task}}', 'workspace-write'),
    { id: 'save', title: 'save', type: 'commit', message: 'save work' },
    { id: 'confirm', title: 'confirm', type: 'approval', show: [{ kind: 'task' }] }]);
  definition.git = { mode: 'explicit-step', publish: { push: true } };
  const pipeline = setup(repo, { first: writer });
  const waiting = await pipeline.startFlow('publish this', definition);
  assert.equal(waiting.status, 'needs-human', waiting.error);
  const preview = waiting.steps?.confirm.approvalPreview;
  assert.ok(preview);
  assert.match(preview.content, /发布确认/);
  assert.ok(preview.content.includes(waiting.steps!.save.headAfter!));
  assert.equal((await git(remotes, ['--git-dir', remote, 'for-each-ref'])).trim(), '');
  const replacement = path.join(remotes, 'replacement.git');
  await git(remotes, ['init', '-q', '--bare', replacement]);
  await git(repo, ['remote', 'set-url', '--push', 'origin', replacement]);
  await assert.rejects(pipeline.approveFlow(waiting.id, 'confirm', preview.contentHash), /approval content changed/);
  assert.equal((await git(remotes, ['--git-dir', replacement, 'for-each-ref'])).trim(), '');
  const updated = (await pipeline.store.load(waiting.id)).steps?.confirm.approvalPreview;
  assert.ok(updated);
  assert.notEqual(updated.contentHash, preview.contentHash);
  const done = await pipeline.approveFlow(waiting.id, 'confirm', updated.contentHash);
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.publish.pushed, true);
  assert.equal((await git(remotes, ['--git-dir', replacement, 'rev-parse', `refs/heads/${done.branch}`])).trim(), done.steps!.save.headAfter);
  assert.equal((await git(remotes, ['--git-dir', remote, 'for-each-ref'])).trim(), '');
});

test('custom publication remains running while a remote operation is in flight', async () => {
  const repo = await makeRepo();
  const writer = new Fake('first', async (req) => { await fs.writeFile(path.join(req.cwd, 'value.txt'), 'new\n'); return 'done'; });
  const config = defaultConfig();
  config.agents = { first: { type: 'command', command: 'x' } };
  config.test.setup = '';
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const remoteOps: typeof realRemoteOps = { ...realRemoteOps,
    pushUrls: async () => ['https://example.invalid/test.git'],
    push: async () => { enter(); await gate; },
  };
  const pipeline = new Pipeline({ repo, config, registry: { get: () => writer } as unknown as AgentRegistry, remote: remoteOps,
    owner: { serverId: 'old', pid: 42, startedAt: new Date(0).toISOString() } });
  const definition = flow([agentStep('write', 'first', '{{task}}', 'workspace-write'),
    { id: 'save', title: 'save', type: 'commit', message: 'save' },
    { id: 'confirm', title: 'confirm', type: 'approval', show: [{ kind: 'task' }] }]);
  definition.git = { mode: 'explicit-step', publish: { push: true } };
  const waiting = await pipeline.startFlow('publish', definition);
  const preview = waiting.steps!.confirm.approvalPreview!;
  const completing = pipeline.approveFlow(waiting.id, 'confirm', preview.contentHash);
  try {
    await entered;
    const inFlight = await pipeline.store.load(waiting.id);
    assert.equal(inFlight.status, 'running');
    assert.equal(inFlight.publish.inFlight, 'push');
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-inflight-copy-'));
    const otherStore = new RunStore(otherRoot);
    await otherStore.save(inFlight);
    await recoverInterrupted(otherStore, { currentServerId: 'new', isExecuting: () => false, probe: async () => ({ alive: false }) });
    const recovered = await otherStore.load(waiting.id);
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.publish.inFlight, 'push');
  } finally { release(); }
  const done = await completing;
  assert.equal(done.status, 'succeeded', done.error);
});

test('custom publishing checks an interrupted real local push before continuing', async () => {
  const repo = await makeRepo();
  const remotes = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-custom-interrupted-'));
  const remote = path.join(remotes, 'origin.git');
  await git(remotes, ['init', '-q', '--bare', remote]);
  await git(repo, ['remote', 'add', 'origin', remote]);
  const writer = new Fake('first', async (req) => { await fs.writeFile(path.join(req.cwd, 'value.txt'), 'publish\n'); return 'done'; });
  const config = defaultConfig();
  config.agents = { first: { type: 'command', command: 'x' } };
  config.test.setup = '';
  let pushes = 0;
  const remoteOps = { ...realRemoteOps, push: async (cwd: string, name: string, branch: string) => {
    pushes++;
    await realRemoteOps.push(cwd, name, branch);
    throw new Error('simulated interruption after push');
  } };
  const pipeline = new Pipeline({ repo, config, registry: { get: () => writer } as unknown as AgentRegistry, remote: remoteOps });
  const definition = flow([agentStep('write', 'first', '{{task}}', 'workspace-write'),
    { id: 'save', title: 'save', type: 'commit', message: 'save' },
    { id: 'confirm', title: 'confirm', type: 'approval', show: [{ kind: 'task' }] }]);
  definition.git = { mode: 'explicit-step', publish: { push: true } };
  const waiting = await pipeline.startFlow('publish', definition);
  const preview = waiting.steps?.confirm.approvalPreview;
  assert.ok(preview);
  const interrupted = await pipeline.approveFlow(waiting.id, 'confirm', preview.contentHash);
  assert.equal(interrupted.publish.inFlight, 'push');
  assert.equal(pushes, 1);
  const replacement = path.join(remotes, 'other.git');
  await git(remotes, ['init', '-q', '--bare', replacement]);
  await git(repo, ['remote', 'set-url', '--push', 'origin', replacement]);
  const conflict = await checkAndRecord(pipeline.store, repo, config, waiting.id, {}, remoteOps);
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.code, 'contradicts-remote');
  assert.equal((await git(remotes, ['--git-dir', replacement, 'for-each-ref'])).trim(), '');
  await git(repo, ['remote', 'set-url', '--push', 'origin', remote]);
  const checked = await checkAndRecord(pipeline.store, repo, config, waiting.id, {}, remoteOps);
  assert.equal(checked.ok, true);
  if (checked.ok) assert.equal(checked.recorded, 'done');
  await assert.rejects(pipeline.reviewPublicationAgain(waiting.id, preview.contentHash), /remote operation already started/);
  const changed = await pipeline.store.load(waiting.id);
  const approvedDraft = structuredClone(changed.release!);
  changed.release!.pr_title = 'different after approval';
  await pipeline.store.save(changed);
  const refused = await pipeline.resume(waiting.id);
  assert.equal(refused.status, 'needs-human');
  assert.match(refused.error ?? '', /draft changed/);
  assert.equal(pushes, 1);
  const restored = await pipeline.store.load(waiting.id);
  restored.release = approvedDraft;
  await pipeline.store.save(restored);
  const done = await pipeline.resume(waiting.id);
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.publish.pushed, true);
  assert.equal(pushes, 1);
});

test('a changed target after approval pauses and can be reviewed again before any push', async () => {
  const repo = await makeRepo();
  const remotes = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-custom-rereview-'));
  const original = path.join(remotes, 'first.git');
  const replacement = path.join(remotes, 'second.git');
  await git(remotes, ['init', '-q', '--bare', original]);
  await git(remotes, ['init', '-q', '--bare', replacement]);
  await git(repo, ['remote', 'add', 'origin', original]);
  const writer = new Fake('first', async (req) => { await fs.writeFile(path.join(req.cwd, 'value.txt'), 'new\n'); return 'done'; });
  const config = defaultConfig();
  config.agents = { first: { type: 'command', command: 'x' } };
  config.test.setup = '';
  let checks = 0;
  const remoteOps = { ...realRemoteOps, pushUrls: async (cwd: string, name: string) => {
    checks++;
    if (checks === 3) await git(repo, ['remote', 'set-url', '--push', 'origin', replacement]);
    return realRemoteOps.pushUrls(cwd, name);
  } };
  const pipeline = new Pipeline({ repo, config, registry: { get: () => writer } as unknown as AgentRegistry, remote: remoteOps });
  const definition = flow([agentStep('write', 'first', '{{task}}', 'workspace-write'),
    { id: 'save', title: 'save', type: 'commit', message: 'save' },
    { id: 'confirm', title: 'confirm', type: 'approval', show: [{ kind: 'task' }] }]);
  definition.git = { mode: 'explicit-step', publish: { push: true } };
  const waiting = await pipeline.startFlow('publish', definition);
  const first = waiting.steps?.confirm.approvalPreview;
  assert.ok(first);
  const paused = await pipeline.approveFlow(waiting.id, 'confirm', first.contentHash);
  assert.equal(paused.status, 'needs-human');
  assert.equal(paused.publish.inFlight, undefined);
  assert.equal((await git(remotes, ['--git-dir', original, 'for-each-ref'])).trim(), '');
  assert.equal((await git(remotes, ['--git-dir', replacement, 'for-each-ref'])).trim(), '');
  await pipeline.reviewPublicationAgain(waiting.id, first.contentHash);
  const reviewed = (await pipeline.store.load(waiting.id)).steps?.confirm.approvalPreview;
  assert.ok(reviewed);
  assert.notEqual(reviewed.contentHash, first.contentHash);
  const done = await pipeline.approveFlow(waiting.id, 'confirm', reviewed.contentHash);
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal((await git(remotes, ['--git-dir', replacement, 'rev-parse', `refs/heads/${done.branch}`])).trim(), done.steps!.save.headAfter);
});

test('custom publication checks the destination again between push and PR', async () => {
  const repo = await makeRepo();
  const writer = new Fake('first', async (req) => { await fs.writeFile(path.join(req.cwd, 'value.txt'), 'new\n'); return 'done'; });
  const config = defaultConfig();
  config.agents = { first: { type: 'command', command: 'x' } };
  config.test.setup = '';
  const original = 'https://github.com/example/test.git';
  let address = original;
  let prCalls = 0;
  const remoteOps: typeof realRemoteOps = { ...realRemoteOps,
    pushUrls: async () => [address],
    push: async () => { address = 'https://github.com/example/other.git'; },
    ghAvailable: async () => true,
    ghCreatePr: async () => { prCalls++; return 'https://github.com/example/test/pull/7'; },
  };
  const pipeline = new Pipeline({ repo, config, registry: { get: () => writer } as unknown as AgentRegistry, remote: remoteOps });
  const definition = flow([agentStep('write', 'first', '{{task}}', 'workspace-write'),
    { id: 'save', title: 'save', type: 'commit', message: 'save' },
    { id: 'confirm', title: 'confirm', type: 'approval', show: [{ kind: 'task' }] }]);
  definition.git = { mode: 'explicit-step', publish: { push: true, createPr: true } };
  const waiting = await pipeline.startFlow('publish', definition);
  const preview = waiting.steps!.confirm.approvalPreview!;
  const paused = await pipeline.approveFlow(waiting.id, 'confirm', preview.contentHash);
  assert.equal(paused.status, 'needs-human');
  assert.equal(paused.publish.pushed, true);
  assert.equal(paused.publish.inFlight, undefined);
  assert.equal(prCalls, 0);
  address = original;
  const resumed = await pipeline.resume(waiting.id);
  assert.equal(resumed.status, 'succeeded', resumed.error);
  assert.equal(prCalls, 1);
});

test('custom publication uses the approved PR and tag draft with the existing remote operations', async () => {
  const repo = await makeRepo();
  const writer = new Fake('first', async (req) => { await fs.writeFile(path.join(req.cwd, 'value.txt'), 'new\n'); return 'done'; });
  const config = defaultConfig();
  config.agents = { first: { type: 'command', command: 'x' } };
  config.test.setup = '';
  let approved = '';
  const calls: string[] = [];
  const remoteOps: typeof realRemoteOps = { ...realRemoteOps,
    pushUrls: async () => ['https://github.com/example/test.git'],
    push: async () => { calls.push('push'); },
    ghAvailable: async () => true,
    ghCreatePr: async (_cwd, options) => { calls.push(`pr:${options.repo}:${options.title}:${options.body}`); return 'https://github.com/example/test/pull/7'; },
    ghMarkReady: async () => { calls.push('ready'); },
    ghMergePr: async (_cwd, _pr, sha) => { assert.equal(sha, approved); calls.push('merge'); },
    ghMergeCommit: async () => approved,
    fetchMergeCommit: async (_cwd, _address, _branch, sha) => sha === approved,
    pushTag: async (_cwd, _remote, tag) => { calls.push(`tag:${tag}`); },
  };
  const pipeline = new Pipeline({ repo, config, registry: { get: () => writer } as unknown as AgentRegistry, remote: remoteOps });
  const definition = flow([agentStep('write', 'first', '{{task}}', 'workspace-write'),
    { id: 'save', title: 'save', type: 'commit', message: 'save' },
    { id: 'confirm', title: 'confirm', type: 'approval', show: [{ kind: 'task' }] }]);
  definition.git = { mode: 'explicit-step', publish: { push: true, createPr: true, merge: true, tag: true },
    release: { title: 'My PR', body: 'PR body', version: '1.2.3', notes: 'release notes' } };
  const waiting = await pipeline.startFlow('publish', definition);
  approved = waiting.steps!.save.headAfter!;
  const preview = waiting.steps?.confirm.approvalPreview;
  assert.ok(preview);
  assert.match(preview.content, /My PR/);
  assert.match(preview.content, /1\.2\.3/);
  const done = await pipeline.approveFlow(waiting.id, 'confirm', preview.contentHash);
  assert.equal(done.status, 'succeeded', done.error);
  assert.deepEqual(calls, ['push', 'pr:github.com/example/test:My PR:PR body', 'ready', 'merge', 'tag:v1.2.3']);
  assert.equal(done.publish.mergeSha, approved);
  assert.equal(done.publish.tagPushed, true);
});

test('custom PR, merge and tag interruptions are checked rather than replayed', async () => {
  for (const interruptedOp of ['pr', 'merge', 'tag'] as const) {
    const repo = await makeRepo();
    const writer = new Fake('first', async (req) => { await fs.writeFile(path.join(req.cwd, 'value.txt'), 'new\n'); return 'done'; });
    const config = defaultConfig();
    config.agents = { first: { type: 'command', command: 'x' } };
    config.test.setup = '';
    let approved = '';
    let taskBranch = '';
    let pr: { url: string; state: 'OPEN' | 'MERGED'; headSha: string; mergeCommit: string } | null = null;
    let remoteTag = '';
    const calls = { push: 0, pr: 0, merge: 0, tag: 0 };
    const remoteOps: typeof realRemoteOps = { ...realRemoteOps,
      pushUrls: async () => ['https://github.com/example/test.git'],
      push: async () => { calls.push++; },
      ghAvailable: async () => true,
      ghCreatePr: async () => {
        calls.pr++;
        pr = { url: 'https://github.com/example/test/pull/7', state: 'OPEN', headSha: approved, mergeCommit: '' };
        if (interruptedOp === 'pr') throw new Error('interrupted after PR creation');
        return pr.url;
      },
      ghMarkReady: async () => undefined,
      ghMergePr: async (cwd) => {
        calls.merge++;
        pr = { url: 'https://github.com/example/test/pull/7', state: 'MERGED', headSha: approved, mergeCommit: approved };
        if (interruptedOp === 'tag') {
          await git(cwd, ['checkout', '-q', '--detach', approved]);
          await git(repo, ['branch', '-D', taskBranch]);
        }
        if (interruptedOp === 'merge') throw new Error('interrupted after merge');
      },
      ghMergeCommit: async () => approved,
      ghPrView: async () => pr,
      fetchMergeCommit: async () => true,
      pushTag: async () => { calls.tag++; remoteTag = approved; if (interruptedOp === 'tag') throw new Error('interrupted after tag'); },
      remoteTagTarget: async () => remoteTag,
    };
    const pipeline = new Pipeline({ repo, config, registry: { get: () => writer } as unknown as AgentRegistry, remote: remoteOps });
    const definition = flow([agentStep('write', 'first', '{{task}}', 'workspace-write'),
      { id: 'save', title: 'save', type: 'commit', message: 'save' },
      { id: 'confirm', title: 'confirm', type: 'approval', show: [{ kind: 'task' }] }]);
    definition.git = { mode: 'explicit-step', publish: { push: true, createPr: true, merge: interruptedOp !== 'pr', tag: interruptedOp === 'tag' },
      release: { version: '1.2.3' } };
    const waiting = await pipeline.startFlow('publish', definition);
    approved = waiting.steps!.save.headAfter!;
    taskBranch = waiting.branch!;
    const preview = waiting.steps!.confirm.approvalPreview!;
    const interrupted = await pipeline.approveFlow(waiting.id, 'confirm', preview.contentHash);
    assert.equal(interrupted.publish.inFlight, interruptedOp);
    assert.equal(calls[interruptedOp], 1);
    const checked = await checkAndRecord(pipeline.store, repo, config, waiting.id, {}, remoteOps);
    assert.equal(checked.ok, true);
    if (checked.ok) assert.equal(checked.recorded, 'done');
    const resumed = await pipeline.resume(waiting.id);
    assert.equal(resumed.status, 'succeeded', resumed.error);
    assert.equal(calls[interruptedOp], 1, `${interruptedOp} was not repeated`);
  }
});

test('a changed hidden part of a push address cannot be mistaken for the approved destination', async () => {
  const repo = await makeRepo();
  const writer = new Fake('first', async (req) => { await fs.writeFile(path.join(req.cwd, 'value.txt'), 'new\n'); return 'done'; });
  const config = defaultConfig();
  config.agents = { first: { type: 'command', command: 'x' } };
  config.test.setup = '';
  let address = 'https://user:password@example.invalid/repo.git?route=one';
  let remoteQueries = 0;
  const remoteOps: typeof realRemoteOps = { ...realRemoteOps,
    pushUrls: async () => [address],
    push: async () => { throw new Error('interrupted during push'); },
    remoteBranchSha: async () => { remoteQueries++; return ''; },
  };
  const pipeline = new Pipeline({ repo, config, registry: { get: () => writer } as unknown as AgentRegistry, remote: remoteOps });
  const definition = flow([agentStep('write', 'first', '{{task}}', 'workspace-write'),
    { id: 'save', title: 'save', type: 'commit', message: 'save' },
    { id: 'confirm', title: 'confirm', type: 'approval', show: [{ kind: 'task' }] }]);
  definition.git = { mode: 'explicit-step', publish: { push: true } };
  const waiting = await pipeline.startFlow('publish', definition);
  const preview = waiting.steps!.confirm.approvalPreview!;
  assert.doesNotMatch(JSON.stringify(preview), /password|route=one/);
  const interrupted = await pipeline.approveFlow(waiting.id, 'confirm', preview.contentHash);
  assert.equal(interrupted.publish.inFlight, 'push');
  address = 'https://user:password@example.invalid/repo.git?route=two';
  const checked = await checkAndRecord(pipeline.store, repo, config, waiting.id, {}, remoteOps);
  assert.equal(checked.ok, false);
  if (!checked.ok) assert.equal(checked.code, 'contradicts-remote');
  assert.equal(remoteQueries, 0);
  assert.doesNotMatch(JSON.stringify(await pipeline.store.load(waiting.id)), /password|route=one|route=two/);
});

test('agent-managed Git records the commit and remaining changes made by the agent', async () => {
  const repo = await makeRepo();
  const writer = new Fake('first', async (req) => {
    await fs.writeFile(path.join(req.cwd, 'value.txt'), 'agent commit\n');
    await git(req.cwd, ['add', 'value.txt']);
    await git(req.cwd, ['commit', '-q', '-m', 'agent commit']);
    await fs.writeFile(path.join(req.cwd, 'pending.txt'), 'not committed\n');
    return 'done';
  });
  const definition = flow([agentStep('write', 'first', 'edit and commit', 'workspace-write')]);
  definition.git.mode = 'agent-managed';
  const state = await setup(repo, { first: writer }).startFlow('task', definition);
  assert.equal(state.status, 'succeeded', state.error);
  assert.notEqual(state.steps?.write.headBefore, state.steps?.write.headAfter);
  assert.equal(state.steps?.write.headAfter, (await git(state.worktree!, ['rev-parse', 'HEAD'])).trim());
  assert.equal(state.steps?.write.dirtyBefore, false);
  assert.equal(state.steps?.write.dirtyAfter, true);
});

test('a read-only agent that changes a clean Git worktree is flagged', async () => {
  const repo = await makeRepo();
  const writer = new Fake('first', async (req) => {
    await fs.writeFile(path.join(req.cwd, 'value.txt'), 'changed despite request\n');
    return 'done';
  });
  const state = await setup(repo, { first: writer }).startFlow('inspect', flow([agentStep('check', 'first', 'inspect')]));
  assert.equal(state.status, 'succeeded', state.error);
  assert.equal(state.steps?.check.agentType, 'command');
  assert.equal(state.steps?.check.dirtyBefore, false);
  assert.equal(state.steps?.check.dirtyAfter, true);
  assert.equal(state.steps?.check.readOnlyChanged, true);
});

test('a read-only agent switching branches at the same commit is flagged', async () => {
  const repo = await makeRepo();
  const writer = new Fake('first', async (req) => {
    await git(req.cwd, ['checkout', '-q', '-b', 'agent-other-branch']);
    return 'done';
  });
  const state = await setup(repo, { first: writer }).startFlow('inspect', flow([agentStep('check', 'first', 'inspect')]));
  assert.equal(state.status, 'succeeded', state.error);
  assert.equal(state.steps?.check.headBefore, state.steps?.check.headAfter);
  assert.notEqual(state.steps?.check.branchBefore, state.steps?.check.branchAfter);
  assert.equal(state.steps?.check.branchAfter, 'agent-other-branch');
  assert.equal(state.steps?.check.readOnlyChanged, true);
});

test('resuming a running custom step stops with an unknown result', async () => {
  const repo = await makeRepo();
  const writer = new Fake('first', () => 'done');
  const pipeline = setup(repo, { first: writer });
  const state = await pipeline.startFlow('do it', flow([agentStep('write', 'first', 'edit')]));
  state.status = 'interrupted';
  state.steps!.write.status = 'running';
  await pipeline.store.save(state);
  const resumed = await pipeline.resume(state.id);
  assert.equal(resumed.status, 'needs-human');
  assert.equal(resumed.steps?.write.status, 'unknown');
  assert.equal(writer.calls.length, 1);
});

test('a missing custom worktree pauses instead of recreating it during resume', async () => {
  const repo = await makeRepo();
  const first = new Fake('first', () => 'done');
  const second = new Fake('second', () => 'must not run');
  const pipeline = setup(repo, { first, second });
  const state = await pipeline.startFlow('task', flow([
    agentStep('first', 'first', '{{task}}'),
    { id: 'confirm', title: 'confirm', type: 'approval', show: [{ kind: 'task' }] },
    agentStep('second', 'second', '{{steps.first.output}}'),
  ]));
  assert.equal(state.status, 'needs-human');
  await git(repo, ['worktree', 'remove', state.worktree!]);
  const resumed = await pipeline.resume(state.id);
  assert.equal(resumed.status, 'needs-human');
  assert.match(resumed.error ?? '', /worktree is missing/);
  assert.equal(second.calls.length, 0);
  await assert.rejects(fs.stat(state.worktree!));
});

test('approval refuses a changed step output and never starts the next agent', async () => {
  const repo = await makeRepo();
  const first = new Fake('first', () => 'original output');
  const second = new Fake('second', () => 'must not run');
  const pipeline = setup(repo, { first, second });
  const state = await pipeline.startFlow('task', flow([
    agentStep('first', 'first', '{{task}}'),
    { id: 'confirm', title: 'confirm', type: 'approval', show: [{ kind: 'step-output', step: 'first' }] },
    agentStep('second', 'second', '{{steps.first.output}}'),
  ]));
  const preview = state.steps!.confirm.approvalPreview!;
  await fs.writeFile(path.join(pipeline.store.dir(state.id), 'steps', 'first', 'output.txt'), 'changed output');
  await assert.rejects(pipeline.approveFlow(state.id, 'confirm', preview.contentHash), /corrupt/);
  const saved = await pipeline.store.load(state.id);
  assert.equal(saved.status, 'needs-human');
  assert.equal(saved.steps!.confirm.status, 'pending');
  assert.equal(second.calls.length, 0);
});

test('retry needs the current failed step and does not replay earlier successful work', async () => {
  const repo = await makeRepo();
  const first = new Fake('first', () => 'plan');
  const second = new Fake('second', (_req, count) => {
    if (count === 1) throw new Error('temporary failure');
    return 'done';
  });
  const pipeline = setup(repo, { first, second });
  const state = await pipeline.startFlow('task', flow([
    agentStep('first', 'first', '{{task}}'), agentStep('second', 'second', '{{steps.first.output}}'),
  ]));
  assert.equal(state.status, 'failed');
  await assert.rejects(pipeline.retryFlow(state.id, 'second', 'unknown'), /status changed/);
  const resumed = await pipeline.retryFlow(state.id, 'second', 'failed');
  assert.equal(resumed.status, 'succeeded', resumed.error);
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 2);
});

test('a user can confirm an unknown agent result without repeating it', async () => {
  const repo = await makeRepo();
  const agent = new Fake('first', () => 'original result');
  const pipeline = setup(repo, { first: agent });
  const state = await pipeline.startFlow('task', flow([
    agentStep('first', 'first', '{{task}}'),
    { id: 'confirm', title: 'confirm', type: 'approval', show: [{ kind: 'step-output', step: 'first' }] },
  ]));
  assert.equal(state.status, 'needs-human');
  state.status = 'interrupted';
  state.steps!.first.status = 'unknown';
  state.steps!.confirm.approvalPreview = undefined;
  await pipeline.store.save(state);
  await assert.rejects(pipeline.completeUnknownFlow(state.id, 'first', state.steps!.first.attempt + 1, 'wrong', undefined), /status changed/);
  const resumed = await pipeline.completeUnknownFlow(state.id, 'first', state.steps!.first.attempt, 'verified result', undefined);
  assert.equal(resumed.status, 'needs-human', resumed.error);
  assert.equal(agent.calls.length, 1);
  assert.equal(resumed.steps!.first.manualCompletion?.by, 'user');
  assert.match(resumed.steps!.confirm.approvalPreview!.content, /verified result/);
  assert.equal((await readStepOutput(pipeline.store.dir(state.id), 'first')).text, 'verified result');
  await assert.rejects(pipeline.completeUnknownFlow(state.id, 'first', state.steps!.first.attempt, 'again', undefined), /status changed/);
});

test('confirming an unknown command requires an exit code and exposes the supplied result', async () => {
  const repo = await makeRepo();
  const pipeline = setup(repo, {});
  const state = await pipeline.startFlow('task', flow([
    { id: 'command', title: 'command', type: 'command', run: 'echo original', output: { kind: 'text' } },
    { id: 'confirm', title: 'confirm', type: 'approval', show: [{ kind: 'step-output', step: 'command' }, { kind: 'step-exit-code', step: 'command' }] },
  ]));
  assert.equal(state.status, 'needs-human');
  state.status = 'interrupted';
  state.steps!.command.status = 'unknown';
  state.steps!.confirm.approvalPreview = undefined;
  await pipeline.store.save(state);
  await assert.rejects(pipeline.completeUnknownFlow(state.id, 'command', state.steps!.command.attempt, 'verified', undefined), /exit code/);
  const resumed = await pipeline.completeUnknownFlow(state.id, 'command', state.steps!.command.attempt, 'verified', 9009);
  assert.equal(resumed.status, 'needs-human', resumed.error);
  assert.equal(resumed.steps!.command.exitCode, 9009);
  assert.match(resumed.steps!.confirm.approvalPreview!.content, /verified/);
  assert.match(resumed.steps!.confirm.approvalPreview!.content, /9009/);
});

test('restoring a flow explains when its snapshotted agent was removed', async () => {
  const repo = await makeRepo();
  const config = defaultConfig();
  config.agents = { first: { type: 'command', command: 'x' } };
  const fake = new Fake('first', () => 'done');
  const pipeline = new Pipeline({ repo, config, registry: { get: () => fake } as unknown as AgentRegistry });
  const state = await pipeline.startFlow('task', flow([agentStep('first', 'first', '{{task}}')]));
  state.status = 'interrupted';
  state.steps!.first.status = 'pending';
  await pipeline.store.save(state);
  delete config.agents.first;
  await assert.rejects(pipeline.resume(state.id), (error: unknown) => error instanceof PipelineError && /first/.test(error.message));
  assert.equal((await pipeline.store.load(state.id)).status, 'interrupted');
});

test('a paused flow resumes using its saved prompt, command and model after configuration changes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-flow-snapshot-run-'));
  try {
    const script = path.join(dir, 'agent.cjs');
    await fs.writeFile(script, "let p='';process.stdin.on('data',c=>p+=c);process.stdin.on('end',()=>process.stdout.write(process.argv[2]+'|'+p));\n");
    const config = defaultConfig();
    config.agents = { first: { type: 'command', command: process.execPath, args: [script, '{{model}}'], model: 'original-model' } };
    const pipeline = new Pipeline({ repo: dir, config });
    const definition = flow([
      { id: 'confirm', title: 'confirm', type: 'approval', show: [{ kind: 'task' }] },
      agentStep('agent', 'first', 'original prompt: {{task}}'),
    ]);
    const waiting = await pipeline.startFlow('task', definition);
    assert.equal(waiting.status, 'needs-human');
    const preview = waiting.steps!.confirm.approvalPreview!;
    config.agents.first.command = 'changed-command-that-must-not-run';
    config.agents.first.model = 'changed-model';
    const configured = definition.steps[1];
    assert.equal(configured.type, 'agent');
    if (configured.type === 'agent') configured.prompt = 'changed prompt';
    const done = await pipeline.approveFlow(waiting.id, 'confirm', preview.contentHash);
    assert.equal(done.status, 'succeeded', done.error);
    const output = await readStepOutput(pipeline.store.dir(done.id), 'agent');
    assert.match(output.text, /original-model\|original prompt/);
    assert.doesNotMatch(output.text, /changed-model|changed prompt/);
  } finally {
    const target = await fs.realpath(dir);
    assert.equal(path.dirname(target).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
    assert.ok(path.basename(target).startsWith('rb-flow-snapshot-run-'));
    await fs.rm(target, { recursive: true });
  }
});

test('interrupted commit is accepted only when the recorded tree and workspace match', async () => {
  for (const change of ['none', 'staged', 'unstaged', 'untracked', 'branch'] as const) {
    const repo = await makeRepo();
    const writer = new Fake('first', async (req) => {
      await fs.writeFile(path.join(req.cwd, 'value.txt'), 'committed\n');
      return 'done';
    });
    const definition = flow([agentStep('write', 'first', 'edit', 'workspace-write'),
      { id: 'commit', title: 'commit', type: 'commit', message: 'save' }]);
    definition.git.mode = 'explicit-step';
    const pipeline = setup(repo, { first: writer });
    const state = await pipeline.startFlow('save', definition);
    assert.equal(state.status, 'succeeded', state.error);
    state.status = 'running';
    state.owner = { serverId: 'old', pid: 42, startedAt: new Date(0).toISOString() };
    state.steps!.commit.status = 'running';
    if (change === 'staged' || change === 'unstaged') {
      await fs.writeFile(path.join(state.worktree!, 'value.txt'), 'changed after commit\n');
      if (change === 'staged') await git(state.worktree!, ['add', 'value.txt']);
    }
    if (change === 'untracked') await fs.writeFile(path.join(state.worktree!, 'new-file.txt'), 'new file\n');
    if (change === 'branch') await git(state.worktree!, ['checkout', '-qb', 'other-branch']);
    await pipeline.store.save(state);
    await recoverInterrupted(pipeline.store, { currentServerId: 'new', isExecuting: () => false, probe: async () => ({ alive: false }) });
    const recovered = await pipeline.store.load(state.id);
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.steps?.commit.status, change === 'none' ? 'succeeded' : 'unknown', change);
    if (change !== 'none') assert.match(recovered.steps!.commit.reason!, change === 'branch' ? /task branch/ : /uncommitted changes or untracked files/);
  }
});

test('retrying an unknown commit requires the original HEAD and staged contents', async () => {
  const repo = await makeRepo();
  const writer = new Fake('first', async (req) => {
    await fs.writeFile(path.join(req.cwd, 'value.txt'), 'committed\n');
    return 'done';
  });
  const definition = flow([agentStep('write', 'first', 'edit', 'workspace-write'),
    { id: 'commit', title: 'commit', type: 'commit', message: 'save' }]);
  definition.git.mode = 'explicit-step';
  const pipeline = setup(repo, { first: writer });
  const state = await pipeline.startFlow('save', definition);
  assert.equal(state.status, 'succeeded', state.error);
  state.status = 'interrupted';
  state.steps!.commit.status = 'unknown';
  await pipeline.store.save(state);
  await assert.rejects(pipeline.retryFlow(state.id, 'commit', 'unknown'), /cannot be safely retried/);
  await git(state.worktree!, ['reset', '--soft', state.steps!.commit.headBefore!]);
  await fs.writeFile(path.join(state.worktree!, 'value.txt'), 'changed after staging\n');
  await assert.rejects(pipeline.retryFlow(state.id, 'commit', 'unknown'), /cannot be safely retried/);
  await git(state.worktree!, ['add', 'value.txt']);
  await assert.rejects(pipeline.retryFlow(state.id, 'commit', 'unknown'), /cannot be safely retried/);
  await fs.writeFile(path.join(state.worktree!, 'value.txt'), 'committed\n');
  await git(state.worktree!, ['add', 'value.txt']);
  await fs.writeFile(path.join(state.worktree!, 'new-file.txt'), 'untracked\n');
  await assert.rejects(pipeline.retryFlow(state.id, 'commit', 'unknown'), /cannot be safely retried/);
  await fs.unlink(path.join(state.worktree!, 'new-file.txt'));
  await git(state.worktree!, ['checkout', '-qb', 'different-branch']);
  await assert.rejects(pipeline.retryFlow(state.id, 'commit', 'unknown'), /cannot be safely retried/);
  await git(state.worktree!, ['checkout', '-q', state.branch!]);
  const lock = path.resolve(state.worktree!, (await git(state.worktree!, ['rev-parse', '--git-path', 'index.lock'])).trim());
  await fs.writeFile(lock, 'test lock');
  await assert.rejects(pipeline.retryFlow(state.id, 'commit', 'unknown'), /index lock/);
  await fs.unlink(lock);
  const resumed = await pipeline.retryFlow(state.id, 'commit', 'unknown');
  assert.equal(resumed.status, 'succeeded', resumed.error);
  assert.notEqual(resumed.steps!.commit.headAfter, resumed.steps!.commit.headBefore);
});

test('an unknown commit can be rechecked without creating another commit', async () => {
  const repo = await makeRepo();
  const writer = new Fake('first', async (req) => {
    await fs.writeFile(path.join(req.cwd, 'value.txt'), 'committed\n');
    return 'done';
  });
  const definition = flow([agentStep('write', 'first', 'edit', 'workspace-write'),
    { id: 'commit', title: 'commit', type: 'commit', message: 'save' }]);
  definition.git.mode = 'explicit-step';
  const pipeline = setup(repo, { first: writer });
  const state = await pipeline.startFlow('save', definition);
  assert.equal(state.status, 'succeeded', state.error);
  const originalHead = await git(state.worktree!, ['rev-parse', 'HEAD']);
  state.status = 'interrupted';
  state.steps!.commit.status = 'unknown';
  await pipeline.store.save(state);
  await assert.rejects(pipeline.recheckUnknownCommit(state.id, 'commit', state.steps!.commit.attempt + 1), /status changed/);
  await fs.writeFile(path.join(state.worktree!, 'new-file.txt'), 'untracked\n');
  await assert.rejects(pipeline.recheckUnknownCommit(state.id, 'commit', state.steps!.commit.attempt), /does not match/);
  await fs.unlink(path.join(state.worktree!, 'new-file.txt'));
  const resumed = await pipeline.recheckUnknownCommit(state.id, 'commit', state.steps!.commit.attempt);
  assert.equal(resumed.status, 'succeeded', resumed.error);
  assert.equal(await git(state.worktree!, ['rev-parse', 'HEAD']), originalHead);
  assert.equal(writer.calls.length, 1);
  await assert.rejects(pipeline.recheckUnknownCommit(state.id, 'commit', state.steps!.commit.attempt), /cannot be checked/);
});

test('a user can inspect and accept an altered commit only while the preview stays current', async () => {
  const repo = await makeRepo();
  const writer = new Fake('first', async (req) => {
    await fs.writeFile(path.join(req.cwd, 'value.txt'), 'original\n');
    return 'done';
  });
  const definition = flow([agentStep('write', 'first', 'edit', 'workspace-write'),
    { id: 'commit', title: 'commit', type: 'commit', message: 'save' }]);
  definition.git.mode = 'explicit-step';
  const pipeline = setup(repo, { first: writer });
  const state = await pipeline.startFlow('save', definition);
  assert.equal(state.status, 'succeeded', state.error);
  state.status = 'interrupted';
  state.steps!.commit.status = 'unknown';
  await pipeline.store.save(state);
  await fs.writeFile(path.join(state.worktree!, 'value.txt'), 'hook output\n');
  await git(state.worktree!, ['add', 'value.txt']);
  await git(state.worktree!, ['commit', '--amend', '-q', '--no-edit']);
  const first = await pipeline.previewChangedCommit(state.id, 'commit', state.steps!.commit.attempt);
  assert.match(first.diff, /hook output/);
  await fs.writeFile(path.join(state.worktree!, 'value.txt'), 'changed again\n');
  await assert.rejects(pipeline.acceptChangedCommit(state.id, 'commit', state.steps!.commit.attempt, first.hash), /worktree/);
  await git(state.worktree!, ['add', 'value.txt']);
  await git(state.worktree!, ['commit', '--amend', '-q', '--no-edit']);
  await assert.rejects(pipeline.acceptChangedCommit(state.id, 'commit', state.steps!.commit.attempt, first.hash), /changed/);
  const current = await pipeline.previewChangedCommit(state.id, 'commit', state.steps!.commit.attempt);
  const resumed = await pipeline.acceptChangedCommit(state.id, 'commit', state.steps!.commit.attempt, current.hash);
  assert.equal(resumed.status, 'succeeded', resumed.error);
  assert.equal((await git(state.worktree!, ['rev-parse', 'HEAD'])).trim(), current.head);
  assert.equal(resumed.steps!.commit.manualCompletion?.by, 'user');
  assert.equal(writer.calls.length, 1);
});

test('interrupted commit remains unknown while Git has an unfinished operation or index lock', async () => {
  const repo = await makeRepo();
  const writer = new Fake('first', async (req) => {
    await fs.writeFile(path.join(req.cwd, 'value.txt'), 'committed\n');
    return 'done';
  });
  const definition = flow([agentStep('write', 'first', 'edit', 'workspace-write'),
    { id: 'commit', title: 'commit', type: 'commit', message: 'save' }]);
  definition.git.mode = 'explicit-step';
  const pipeline = setup(repo, { first: writer });
  const state = await pipeline.startFlow('save', definition);
  assert.equal(state.status, 'succeeded', state.error);
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'index.lock']) {
    const markerPath = path.resolve(state.worktree!, (await git(state.worktree!, ['rev-parse', '--git-path', marker])).trim());
    if (marker.startsWith('rebase-')) await fs.mkdir(markerPath);
    else await fs.writeFile(markerPath, state.steps!.commit.headAfter!);
    state.status = 'running';
    state.owner = { serverId: 'old', pid: 42, startedAt: new Date(0).toISOString() };
    state.steps!.commit.status = 'running';
    await pipeline.store.save(state);
    await recoverInterrupted(pipeline.store, { currentServerId: 'new', isExecuting: () => false, probe: async () => ({ alive: false }) });
    const recovered = await pipeline.store.load(state.id);
    assert.equal(recovered.steps?.commit.status, 'unknown', marker);
    assert.match(recovered.steps!.commit.reason!, /unfinished operation or index lock/);
    if (marker.startsWith('rebase-')) await fs.rmdir(markerPath);
    else await fs.unlink(markerPath);
  }
});
