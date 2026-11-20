import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentRegistry } from '../src/agents/registry.ts';
import { defaultConfig } from '../src/config.ts';
import { git } from '../src/git.ts';
import { Pipeline } from '../src/pipeline.ts';
import { RunStore } from '../src/store.ts';
import type { RunState } from '../src/types.ts';

async function prepared(setupCmd: string, setupDone: boolean) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-resume-'));
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 't@e.com']);
  await git(repo, ['config', 'user.name', 't']);
  await fs.writeFile(path.join(repo, 'v.txt'), 'old\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  const wt = path.join(repo, '.repobaton', 'wt');
  await git(repo, ['worktree', 'add', '-q', '-b', 'repobaton/x', wt, base]);
  await fs.writeFile(path.join(wt, 'v.txt'), 'good\n');
  await git(wt, ['add', '-A']);
  await git(wt, ['commit', '-q', '-m', 'work']);
  const sha = (await git(wt, ['rev-parse', 'HEAD'])).trim();
  await fs.writeFile(path.join(wt, 'setup.cjs'), 'require(\'fs\').writeFileSync(\'setup.marker\', \'1\');\n');
  const config = defaultConfig();
  config.agents = { a: { type: 'command', command: 'x' } };
  for (const s of ['plan', 'implement', 'review', 'release'] as const) config.stages[s].agent = 'a';
  config.loop.maxReviewRounds = 1;
  config.test.setup = setupCmd;
  const calls: string[] = [];
  const registry = { get: () => { calls.push('agent'); throw new Error('no agent may be used'); } } as unknown as AgentRegistry;
  const store = new RunStore(repo);
  const state: RunState = {
    id: 'run1', task: 't', repo, status: 'interrupted', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    rounds: [{ n: 1, decision: 'approved', implement: { agent: 'a', sha, summary: '', changedFiles: ['v.txt'], durationMs: 1 } }],
    publish: {}, usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, calls: 0 },
    worktree: wt, branch: 'repobaton/x', base: { branch: 'main', sha: base }, setupDone, planApproved: true, planVersion: 1,
    plan: { summary: 's', steps: [], acceptance: [], risks: [], test_hints: [] },
    release: { version_bump: 'patch', suggested_version: '1.0.1', pr_title: 't', pr_body: 'b', release_notes: 'n', risks: [] },
  };
  await store.save(state);
  return { pipe: new Pipeline({ repo, config, registry }), store, sha, wt, calls };
}

test('an approved commit resumes at release/publish with the same SHA, even when the round budget is used up', async () => {
  const { pipe, store, sha, calls } = await prepared('', true);
  const out = await pipe.resume('run1');
  assert.equal(out.status, 'succeeded', out.error);
  assert.equal(out.rounds.length, 1, 'no new implement round');
  assert.equal(out.rounds[0].implement?.sha, sha);
  assert.deepEqual(calls, [], 'no agent was called');
  assert.equal((await store.load('run1')).rounds[0].implement?.sha, sha);
});

test('a saved worktree whose setup never finished gets its setup completed on resume', async () => {
  const { pipe, store, wt } = await prepared('node setup.cjs', false);
  const out = await pipe.resume('run1');
  assert.equal(out.status, 'succeeded', out.error);
  assert.equal(await fs.readFile(path.join(wt, 'setup.marker'), 'utf8'), '1');
  assert.equal((await store.load('run1')).setupDone, true);
});
