import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MAX_INJECT_HARD, readStepOutput, stepDir, writeStepOutput } from '../src/flow-store.ts';
import { renderPrompt } from '../src/flow-render.ts';

async function runDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'rb-steps-'));
}
const meta = { status: 'succeeded', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:05Z', agent: 'claude' };

test('stepDir only accepts valid step ids, so a step id can never leave the run directory', async () => {
  const run = await runDir();
  assert.equal(stepDir(run, 'design'), path.join(run, 'steps', 'design'));
  for (const bad of ['../x', 'a/b', 'a\\b', '', '.', 'A', '..']) assert.throws(() => stepDir(run, bad), /步骤 id/);
});

test('output and meta are written and read back with a checksum', async () => {
  const run = await runDir();
  const w = await writeStepOutput(run, 'design', 'the plan', { ...meta });
  assert.equal(w.meta.originalBytes, 8);
  assert.equal(w.meta.storedTruncated, false);
  assert.match(w.meta.sha256, /^[0-9a-f]{64}$/);
  const r = await readStepOutput(run, 'design', { maxInjectBytes: 1000 });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.text, 'the plan');
  assert.equal(r.truncated, false);
  const onDisk = JSON.parse(await fs.readFile(path.join(run, 'steps', 'design', 'meta.json'), 'utf8'));
  assert.equal(onDisk.agent, 'claude');
  assert.equal(onDisk.status, 'succeeded');
});

test('secrets are removed before anything reaches disk', async () => {
  const run = await runDir();
  process.env.RB_STEP_TEST_API_KEY = 'sk-zzzzzzzzzzzzzzzz9999';
  try {
    await writeStepOutput(run, 's', 'key sk-zzzzzzzzzzzzzzzz9999 and Bearer abcdef123456789 end', { ...meta });
    for (const f of ['output.txt', 'meta.json']) {
      const text = await fs.readFile(path.join(run, 'steps', 's', f), 'utf8');
      assert.ok(!text.includes('zzzzzzzzzzzzzzzz9999'), f);
      assert.ok(!text.includes('abcdef123456789'), f);
    }
  } finally {
    delete process.env.RB_STEP_TEST_API_KEY;
  }
});

test('a secret that straddles the storage cut is masked, not half-exposed', async () => {
  const run = await runDir();
  process.env.RB_STEP_TEST_API_KEY = 'sk-0123456789abcdefghij';
  try {
    const text = 'x'.repeat(95) + 'sk-0123456789abcdefghij' + 'y'.repeat(50);
    const w = await writeStepOutput(run, 's', text, { ...meta }, { maxStoredBytes: 100 });
    const stored = await fs.readFile(path.join(run, 'steps', 's', 'output.txt'), 'utf8');
    assert.equal(w.meta.storedTruncated, true);
    assert.ok(!stored.includes('sk-01'), 'not even a prefix of the secret survives');
    assert.ok(!stored.includes('0123456789'));
  } finally {
    delete process.env.RB_STEP_TEST_API_KEY;
  }
});

test('storage limit: oversized output is cut on a character boundary and flagged in meta', async () => {
  const run = await runDir();
  const text = '汉'.repeat(1000); // 3000 bytes
  const w = await writeStepOutput(run, 's', text, { ...meta }, { maxStoredBytes: 100 });
  assert.equal(w.meta.storedTruncated, true);
  assert.equal(w.meta.originalBytes, 3000);
  const stored = await fs.readFile(path.join(run, 'steps', 's', 'output.txt'), 'utf8');
  assert.ok(Buffer.byteLength(stored) <= 100 + 200, 'stored text stays near the cap including its note');
  assert.ok(!stored.includes('\uFFFD'));
  assert.match(stored, /已截断/);
});

test('injection limit: a large stored output is shown as head and tail with the marker, and says so', async () => {
  const run = await runDir();
  await writeStepOutput(run, 's', 'H'.repeat(500) + 'M'.repeat(5000) + 'T'.repeat(500), { ...meta });
  const r = await readStepOutput(run, 's', { maxInjectBytes: 800 });
  assert.equal(r.truncated, true);
  assert.equal(r.originalBytes, 6000);
  assert.match(r.text, /省略 \d+ 字节/);
  assert.match(r.text, /steps\/s\/output\.txt/);
  assert.match(r.path, /steps\/s\/output\.txt/);
});

test('the injection limit has a hard ceiling', async () => {
  const run = await runDir();
  await writeStepOutput(run, 's', 'a'.repeat(MAX_INJECT_HARD + 5000), { ...meta });
  const r = await readStepOutput(run, 's', { maxInjectBytes: MAX_INJECT_HARD * 10 });
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.text) <= MAX_INJECT_HARD + 200);
});

test('a missing step, or one that did not succeed, yields no usable output', async () => {
  const run = await runDir();
  const none = await readStepOutput(run, 'ghost', { maxInjectBytes: 100 });
  assert.equal(none.status, 'missing');
  await writeStepOutput(run, 'bad', '', { ...meta, status: 'failed' });
  const failed = await readStepOutput(run, 'bad', { maxInjectBytes: 100 });
  assert.equal(failed.status, 'failed');
});

test('an output file edited after it was recorded is not trusted', async () => {
  const run = await runDir();
  await writeStepOutput(run, 's', 'original', { ...meta });
  await fs.writeFile(path.join(run, 'steps', 's', 'output.txt'), 'tampered');
  const r = await readStepOutput(run, 's', { maxInjectBytes: 100 });
  assert.equal(r.status, 'corrupt');
  const rendered = renderPrompt('{{steps.s.output}}', { task: '', outputs: new Map([['s', r]]), exitCodes: new Map(), files: new Map() });
  assert.equal(rendered.ok, false);
  if (!rendered.ok) assert.match(rendered.reason, /corrupt/);
});

test('a stored output feeds the renderer end to end, truncation note included', async () => {
  const run = await runDir();
  await writeStepOutput(run, 'design', 'A'.repeat(4000), { ...meta });
  const out = await readStepOutput(run, 'design', { maxInjectBytes: 500 });
  const r = renderPrompt('Plan:{{steps.design.output}}', { task: '', outputs: new Map([['design', out]]), exitCodes: new Map(), files: new Map() });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.text, /已截断：原始 4000 字节/);
    assert.deepEqual(r.truncated, ['steps.design.output']);
  }
});

test('exit codes and optional fields are recorded in meta', async () => {
  const run = await runDir();
  const w = await writeStepOutput(run, 'tests', 'ok', { ...meta, exitCode: 3, sessionId: 'abc' });
  assert.equal(w.meta.exitCode, 3);
  assert.equal(w.meta.sessionId, 'abc');
});
