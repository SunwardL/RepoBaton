import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentRegistry } from '../src/agents/registry.ts';
import { defaultConfig } from '../src/config.ts';
import { git } from '../src/git.ts';
import { Pipeline } from '../src/pipeline.ts';
import type { Agent, AgentRunRequest, AgentResult } from '../src/types.ts';

class Fake implements Agent {
  type = 'command' as const;
  id: string;
  calls: AgentRunRequest[] = [];
  private handler: (req: AgentRunRequest, n: number) => Promise<unknown> | unknown;
  constructor(id: string, handler: (req: AgentRunRequest, n: number) => Promise<unknown> | unknown) {
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
    const out = await this.handler(req, this.calls.length);
    if (req.schema) return { text: JSON.stringify(out), structured: out, durationMs: 1 };
    return { text: String(out), durationMs: 1, sessionId: `s-${this.calls.length}` };
  }
}

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-pipe-'));
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 't@example.com']);
  await git(dir, ['config', 'user.name', 't']);
  await fs.writeFile(path.join(dir, 'value.txt'), 'old\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

const plan = { summary: 's', steps: [{ title: 't', detail: 'd', files: ['value.txt'] }], acceptance: ['value.txt says good'], risks: [], test_hints: [] };
const release = { version_bump: 'patch', suggested_version: '1.0.1', pr_title: 'x', pr_body: 'b', release_notes: 'n', risks: [] };

function setup(repo: string, agents: Record<string, Fake>, maxRounds = 3, fallbackAgent?: string): Pipeline {
  const config = defaultConfig();
  config.agents = { planner: { type: 'command', command: 'x' }, coder: { type: 'command', command: 'x' }, judge: { type: 'command', command: 'x' } };
  config.stages.plan.agent = 'planner';
  config.stages.implement.agent = 'coder';
  config.stages.implement.fallbackAgent = fallbackAgent;
  config.stages.review.agent = 'judge';
  config.stages.release.agent = 'judge';
  config.stages.implement.retries = 0;
  config.loop.maxReviewRounds = maxRounds;
  config.test.setup = '';
  config.test.command = 'node -e "process.exit(require(\'fs\').readFileSync(\'value.txt\',\'utf8\').trim()===\'good\'?0:1)"';
  const registry = { get: (id: string) => agents[id] } as unknown as AgentRegistry;
  return new Pipeline({ repo, config, registry });
}

test('failing tests send the work back, the fix is re-tested and approved', async () => {
  const repo = await makeRepo();
  const planner = new Fake('planner', () => plan);
  const coder = new Fake('coder', async (req, n) => {
    await fs.writeFile(path.join(req.cwd, 'value.txt'), n === 1 ? 'bad\n' : 'good\n');
    return `round ${n}`;
  });
  const judgeAgent = new Fake('judge', (req, n) => {
    if (req.prompt.includes('RELEASE MANAGER')) return release;
    // A lenient reviewer approves even round 1; the failing test must override it.
    return { verdict: 'approve', summary: 'looks fine', issues: [] };
  });
  const state = await setup(repo, { planner, coder, judge: judgeAgent }).start('make value good');
  assert.equal(state.status, 'succeeded', state.error);
  assert.equal(state.rounds.length, 2);
  assert.equal(state.rounds[0].review?.overriddenBy, 'tests failed');
  assert.equal(state.rounds[0].decision, 'changes-requested');
  assert.equal(state.rounds[1].decision, 'approved');
  // The second implement call resumed the first session and saw the test failure.
  assert.equal(coder.calls[1].sessionId, 's-1');
  assert.match(coder.calls[1].prompt, /exit code 1/);
  // The implementer is never given a review/release schema or read-only access.
  assert.equal(coder.calls[0].access, 'workspace-write');
  assert.equal(judgeAgent.calls[0].access, 'read-only');
  assert.equal(state.release?.suggested_version, '1.0.1');
  // The approved commit is on the task branch, the main branch is untouched.
  assert.equal((await git(repo, ['show', `${state.branch}:value.txt`])).trim(), 'good');
  assert.equal((await git(repo, ['show', 'main:value.txt'])).trim(), 'old');
});

test('a run that never passes stops as needs-human after maxReviewRounds', async () => {
  const repo = await makeRepo();
  const planner = new Fake('planner', () => plan);
  const coder = new Fake('coder', async (req, n) => {
    await fs.writeFile(path.join(req.cwd, 'value.txt'), `bad ${n}\n`);
    return 'tried';
  });
  const judgeAgent = new Fake('judge', () => ({
    verdict: 'request_changes',
    summary: 'still wrong',
    issues: [{ severity: 'blocker', file: 'value.txt', description: 'wrong', suggestion: 'fix' }],
  }));
  const state = await setup(repo, { planner, coder, judge: judgeAgent }, 2).start('make value good');
  assert.equal(state.status, 'needs-human');
  assert.equal(state.rounds.length, 2);
  assert.equal(state.release, undefined, 'no release draft for unapproved work');
  assert.equal(judgeAgent.calls.length, 2);
});

test('a retry only passes a native session ID to the agent that created it', async () => {
  const repo = await makeRepo();
  const planner = new Fake('planner', () => plan);
  const coder = new Fake('coder', () => { throw new Error('primary unavailable'); });
  const backup = new Fake('backup', async (req, n) => {
    await fs.writeFile(path.join(req.cwd, 'value.txt'), n === 1 ? 'bad\n' : 'good\n');
    return 'done';
  });
  const judge = new Fake('judge', (req) => req.stage === 'release' ? release : { verdict: 'approve', summary: 'ok', issues: [] });
  const state = await setup(repo, { planner, coder, backup, judge }, 3, 'backup').start('retry only the owning session');
  assert.equal(state.status, 'succeeded', state.error);
  assert.equal(coder.calls[1].sessionId, undefined);
  assert.equal(backup.calls[1].sessionId, 's-1');
});

test('plan approval pauses the run until approved', async () => {
  const repo = await makeRepo();
  const planner = new Fake('planner', () => plan);
  const coder = new Fake('coder', async (req) => {
    await fs.writeFile(path.join(req.cwd, 'value.txt'), 'good\n');
    return 'done';
  });
  const judgeAgent = new Fake('judge', (req) =>
    req.prompt.includes('RELEASE MANAGER') ? release : { verdict: 'approve', summary: 'ok', issues: [] },
  );
  const pipe = setup(repo, { planner, coder, judge: judgeAgent });
  (pipe as unknown as { cfg: ReturnType<typeof defaultConfig> }).cfg.stages.plan.requireApproval = true;
  const paused = await pipe.start('make value good');
  assert.equal(paused.status, 'awaiting-plan-approval');
  assert.equal(coder.calls.length, 0);
  const done = await pipe.resume(paused.id, { approvePlan: true });
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(coder.calls.length, 1);
});

function approvalPipe(repo: string, agents: Record<string, Fake>, opts: { interactive?: Array<{ approved: true } | { approved: false; feedback: string }> } = {}): Pipeline {
  const config = defaultConfig();
  config.agents = { planner: { type: 'command', command: 'x' }, coder: { type: 'command', command: 'x' }, judge: { type: 'command', command: 'x' } };
  config.stages.plan.agent = 'planner';
  config.stages.plan.requireApproval = true;
  config.stages.implement.agent = 'coder';
  config.stages.review.agent = 'judge';
  config.stages.release.agent = 'judge';
  config.stages.implement.retries = 0;
  config.test.setup = '';
  config.test.command = 'node -e "process.exit(0)"';
  const registry = { get: (id: string) => agents[id] } as unknown as AgentRegistry;
  const queue = opts.interactive ? [...opts.interactive] : undefined;
  return new Pipeline({
    repo,
    config,
    registry,
    approvePlan: queue ? async () => queue.shift() ?? { approved: true } : undefined,
  });
}

function happyAgents(planPrompts: string[]): Record<string, Fake> {
  const planner = new Fake('planner', (req) => {
    planPrompts.push(req.prompt);
    return plan;
  });
  const coder = new Fake('coder', async (req) => {
    await fs.writeFile(path.join(req.cwd, 'value.txt'), 'good\n');
    return 'done';
  });
  const judgeAgent = new Fake('judge', (req) =>
    req.prompt.includes('RELEASE MANAGER') ? release : { verdict: 'approve', summary: 'ok', issues: [] },
  );
  return { planner, coder, judge: judgeAgent };
}

test('rejecting a paused plan sends the feedback to the planner, not the implementer', async () => {
  const repo = await makeRepo();
  const planPrompts: string[] = [];
  const agents = happyAgents(planPrompts);
  const pipe = approvalPipe(repo, agents);
  const paused = await pipe.start('make value good');
  assert.equal(paused.status, 'awaiting-plan-approval');
  assert.equal(planPrompts.length, 1);

  const again = await pipe.rejectPlan(paused.id, 'split step 1 into two steps');
  assert.equal(again.status, 'awaiting-plan-approval', 'a revised plan must wait for approval again');
  assert.equal(planPrompts.length, 2);
  assert.match(planPrompts[1], /split step 1 into two steps/);
  assert.equal((agents.coder as Fake).calls.length, 0, 'implementation must not start before approval');

  const done = await pipe.resume(again.id, { approvePlan: true });
  assert.equal(done.status, 'succeeded', done.error);
  const implPrompt = (agents.coder as Fake).calls[0].prompt;
  assert.doesNotMatch(implPrompt, /split step 1 into two steps/, 'plan feedback must not leak into implementation');
  assert.equal(done.pendingFeedback, undefined);
});

test('interactive rejection also reaches the planner', async () => {
  const repo = await makeRepo();
  const planPrompts: string[] = [];
  const agents = happyAgents(planPrompts);
  const pipe = approvalPipe(repo, agents, { interactive: [{ approved: false, feedback: 'add a rollback step' }, { approved: true }] });
  const done = await pipe.start('make value good');
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(planPrompts.length, 2);
  assert.match(planPrompts[1], /add a rollback step/);
  assert.doesNotMatch((agents.coder as Fake).calls[0].prompt, /add a rollback step/);
});

test('resume --feedback on a paused plan is plan feedback, not implementer guidance', async () => {
  const repo = await makeRepo();
  const planPrompts: string[] = [];
  const agents = happyAgents(planPrompts);
  const pipe = approvalPipe(repo, agents);
  const paused = await pipe.start('make value good');
  const again = await pipe.resume(paused.id, { feedback: 'mention the migration' });
  assert.equal(again.status, 'awaiting-plan-approval');
  assert.match(planPrompts[1], /mention the migration/);
  assert.equal((agents.coder as Fake).calls.length, 0);
});

test('a run without an interactive approver always stops at the plan', async () => {
  const repo = await makeRepo();
  const agents = happyAgents([]);
  const pipe = approvalPipe(repo, agents);
  const paused = await pipe.start('make value good');
  assert.equal(paused.status, 'awaiting-plan-approval');
  assert.equal((agents.coder as Fake).calls.length, 0);
});

// ------------------------------------------------------------------ native sessions are recorded per stage

/** Same as Fake, but reports a native agent type and always returns a session id, like the real CLIs. */
class Native extends Fake {
  override type = 'codex-cli' as unknown as 'command';
  constructor(id: string, kind: 'codex-cli' | 'claude-cli', handler: ConstructorParameters<typeof Fake>[1]) {
    super(id, handler);
    this.type = kind as unknown as 'command';
  }
  override async run(req: AgentRunRequest): Promise<AgentResult> {
    const res = await super.run(req);
    return { ...res, sessionId: this.id + '-' + this.calls.length };
  }
}

test('every stage call is recorded as a session; native agents are asked to keep theirs, others are not', async () => {
  const repo = await makeRepo();
  const planner = new Native('planner', 'claude-cli', () => plan);
  const coder = new Native('coder', 'codex-cli', async (req, n) => {
    await fs.writeFile(path.join(req.cwd, 'value.txt'), n === 1 ? 'bad\n' : 'good\n');
    return 'round ' + n;
  });
  const judgeAgent = new Fake('judge', (req) => {
    if (req.prompt.includes('RELEASE MANAGER')) return release;
    return { verdict: 'approve', summary: 'ok', issues: [] };
  });
  const state = await setup(repo, { planner, coder, judge: judgeAgent }).start('make value good');
  assert.equal(state.status, 'succeeded', state.error);
  const labels = (state.sessions ?? []).map((s) => s.label);
  assert.deepEqual(labels, ['plan', 'implement-r1', 'review-r1', 'implement-r2', 'review-r2', 'release']);
  assert.ok(planner.calls.every((c) => c.persist === true), 'a native planner keeps its session');
  assert.ok(coder.calls.every((c) => c.persist === true), 'a native implementer keeps its session');
  assert.ok(judgeAgent.calls.every((c) => !c.persist), 'a non-native agent is not asked to persist');
  const byLabel = Object.fromEntries((state.sessions ?? []).map((s) => [s.label, s]));
  assert.equal(byLabel['plan'].agentType, 'claude-cli');
  assert.equal(byLabel['plan'].sessionId, 'planner-1');
  assert.equal(byLabel['implement-r1'].sessionId, 'coder-1');
  assert.equal(byLabel['implement-r1'].round, 1);
  assert.equal(byLabel['review-r2'].round, 2);
  assert.equal(byLabel['review-r1'].agentType, 'command');
  assert.equal(byLabel['review-r1'].sessionId, undefined, 'only agents that report a session id have one');
  assert.equal(byLabel['review-r1'].persisted, false);
  for (const s of state.sessions ?? []) {
    assert.equal(s.status, 'completed');
    assert.ok(s.finishedAt);
    assert.equal(s.cwd, state.worktree);
  }
});

test('a failed agent call leaves a failed session record, and the records survive a reload', async () => {
  const repo = await makeRepo();
  const planner = new Native('planner', 'claude-cli', () => {
    throw new Error('boom');
  });
  const coder = new Fake('coder', () => 'x');
  const judgeAgent = new Fake('judge', () => release);
  const pipe = setup(repo, { planner, coder, judge: judgeAgent });
  const state = await pipe.start('anything').catch(() => null);
  const stored = await pipe.store.load((state?.id ?? (await pipe.store.resolve('last'))));
  const first = stored.sessions?.[0];
  assert.equal(first?.label, 'plan');
  assert.equal(first?.status, 'failed');
  assert.ok(first?.finishedAt);
  assert.equal(first?.sessionId, undefined);
});
