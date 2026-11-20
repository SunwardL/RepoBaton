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

function setup(repo: string, agents: Record<string, Fake>, maxRounds = 3): Pipeline {
  const config = defaultConfig();
  config.agents = { planner: { type: 'command', command: 'x' }, coder: { type: 'command', command: 'x' }, judge: { type: 'command', command: 'x' } };
  config.stages.plan.agent = 'planner';
  config.stages.implement.agent = 'coder';
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
