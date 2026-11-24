import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { STEP_STATUSES, type StepStatus } from '../src/flow-types.ts';
import { readStepOutput, stepOutputFile, writeStepOutput } from '../src/flow-store.ts';
import { renderPrompt } from '../src/flow-render.ts';

async function runDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'rb-consistency-'));
}
const meta = { status: 'succeeded' as StepStatus, startedAt: '2026-01-01T00:00:00Z', agent: 'claude' };
const empty = (outputs: Map<string, Awaited<ReturnType<typeof readStepOutput>>>) => ({ task: '', outputs, exitCodes: new Map<string, number>(), files: new Map() });

test('the step status vocabulary has one completed state, named succeeded', () => {
  assert.deepEqual([...STEP_STATUSES].sort(), ['failed', 'pending', 'running', 'skipped', 'succeeded', 'unknown']);
  assert.ok(!(STEP_STATUSES as readonly string[]).includes('completed'));
});

test('a step finished with the shared status is readable by the next step and renders', async () => {
  const run = await runDir();
  const done: StepStatus = 'succeeded';
  await writeStepOutput(run, 'design', 'the plan', { ...meta, status: done });
  const out = await readStepOutput(run, 'design');
  assert.equal(out.status, 'succeeded');
  const r = renderPrompt('{{steps.design.output}}', empty(new Map([['design', out]])));
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.text, /the plan/);
});

test('a stale status name is not accepted as usable output', async () => {
  const run = await runDir();
  await writeStepOutput(run, 'design', 'plan', { ...meta, status: 'completed' as StepStatus });
  const out = await readStepOutput(run, 'design');
  assert.notEqual(out.status, 'succeeded');
  const r = renderPrompt('{{steps.design.output}}', empty(new Map([['design', out]])));
  assert.equal(r.ok, false);
});

test('storage truncation says the full output was not kept; injection truncation points to the file', async () => {
  const run = await runDir();
  await writeStepOutput(run, 'stored', 'x'.repeat(3000), { ...meta }, { maxStoredBytes: 100 });
  const s = await readStepOutput(run, 'stored', { maxInjectBytes: 10_000 });
  assert.equal(s.storedTruncated, true);
  const rs = renderPrompt('{{steps.stored.output}}', empty(new Map([['stored', s]])));
  assert.equal(rs.ok, true);
  if (rs.ok) {
    assert.match(rs.text, /完整内容未保存/);
    assert.doesNotMatch(rs.text, /完整内容见/);
    assert.match(rs.text, /3000/);
  }

  await writeStepOutput(run, 'big', 'y'.repeat(5000), { ...meta });
  const b = await readStepOutput(run, 'big', { maxInjectBytes: 500 });
  assert.equal(b.storedTruncated, false);
  const rb = renderPrompt('{{steps.big.output}}', empty(new Map([['big', b]])));
  assert.equal(rb.ok, true);
  if (rb.ok) {
    assert.match(rb.text, /完整内容见 steps\/big\/output\.txt/);
    assert.doesNotMatch(rb.text, /完整内容未保存/);
  }
});

test('both truncations at once: the note says the stored copy is partial too', async () => {
  const run = await runDir();
  await writeStepOutput(run, 'both', 'z'.repeat(5000), { ...meta }, { maxStoredBytes: 2000 });
  const o = await readStepOutput(run, 'both', { maxInjectBytes: 300 });
  const r = renderPrompt('{{steps.both.output}}', empty(new Map([['both', o]])));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.text, /完整内容未保存/);
    assert.doesNotMatch(r.text, /完整内容见 steps/);
  }
});

test('stepOutputFile hands a command step a path only for a verified, succeeded output', async () => {
  const run = await runDir();
  await writeStepOutput(run, 'ok', 'data', { ...meta });
  const good = await stepOutputFile(run, 'ok');
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(await fs.readFile(good.file, 'utf8'), 'data');

  const missing = await stepOutputFile(run, 'ghost');
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.reason, /ghost/);

  await writeStepOutput(run, 'bad', '', { ...meta, status: 'failed' });
  const failed = await stepOutputFile(run, 'bad');
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.match(failed.reason, /failed/);

  await fs.writeFile(path.join(run, 'steps', 'ok', 'output.txt'), 'tampered');
  const tampered = await stepOutputFile(run, 'ok');
  assert.equal(tampered.ok, false);
  if (!tampered.ok) assert.match(tampered.reason, /corrupt/);
});
