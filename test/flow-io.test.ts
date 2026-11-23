import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { commandEnv, envName, readWorktreeFile } from '../src/flow-io.ts';
import { validateWorkflow } from '../src/flow.ts';
import { runShell } from '../src/proc.ts';

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'rb-flow-io-'));
}

test('readWorktreeFile reads a normal file and reports its size', async () => {
  const root = await tmp();
  await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(root, 'docs', 'a.md'), 'hello');
  const r = await readWorktreeFile(root, 'docs/a.md', { maxBytes: 1000 });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.text, 'hello');
    assert.equal(r.bytes, 5);
    assert.equal(r.truncated, false);
  }
});

test('readWorktreeFile refuses lexical escapes, missing files and directories with a reason', async () => {
  const root = await tmp();
  await fs.mkdir(path.join(root, 'dir'));
  for (const p of ['../x', '/etc/passwd', '.git/config', 'nope.txt', 'dir']) {
    const r = await readWorktreeFile(root, p, { maxBytes: 100 });
    assert.equal(r.ok, false, p);
    if (!r.ok) assert.ok(r.reason.length > 0);
  }
});

test('readWorktreeFile refuses a directory link that points outside the worktree', async () => {
  const root = await tmp();
  const outside = await tmp();
  await fs.writeFile(path.join(outside, 'secret.txt'), 'TOP-SECRET');
  // A junction needs no elevated rights on Windows; on other systems it is an ordinary symlink.
  await fs.symlink(outside, path.join(root, 'link'), 'junction');
  const r = await readWorktreeFile(root, 'link/secret.txt', { maxBytes: 100 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /工作区之外/);
});

test('readWorktreeFile refuses a file link that points outside, and allows one that stays inside', async (t) => {
  const root = await tmp();
  const outside = await tmp();
  await fs.writeFile(path.join(outside, 'secret.txt'), 'TOP-SECRET');
  await fs.writeFile(path.join(root, 'real.txt'), 'inside');
  try {
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'out.txt'));
    await fs.symlink(path.join(root, 'real.txt'), path.join(root, 'in.txt'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return t.skip('creating file symlinks needs privileges here');
    throw e;
  }
  const bad = await readWorktreeFile(root, 'out.txt', { maxBytes: 100 });
  assert.equal(bad.ok, false);
  const good = await readWorktreeFile(root, 'in.txt', { maxBytes: 100 });
  assert.equal(good.ok, true);
});

test('readWorktreeFile refuses a link into .git or .repobaton even though the name looks harmless', async () => {
  const root = await tmp();
  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, '.git', 'config'), '[core]');
  await fs.symlink(path.join(root, '.git'), path.join(root, 'innocent'), 'junction');
  const r = await readWorktreeFile(root, 'innocent/config', { maxBytes: 100 });
  assert.equal(r.ok, false);
});

test('readWorktreeFile truncates at the byte limit and says so; binary files are refused', async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(500));
  const r = await readWorktreeFile(root, 'big.txt', { maxBytes: 100 });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.truncated, true);
    assert.equal(r.bytes, 500);
    assert.equal(r.text.length, 100);
  }
  await fs.writeFile(path.join(root, 'bin.dat'), Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02]));
  const b = await readWorktreeFile(root, 'bin.dat', { maxBytes: 100 });
  assert.equal(b.ok, false);
  if (!b.ok) assert.match(b.reason, /二进制/);
});

test('envName maps step ids to variable names and distinct ids never collide', () => {
  assert.equal(envName('design'), 'DESIGN');
  assert.equal(envName('run-tests_2'), 'RUN_TESTS_2');
});

test('step ids that would share an environment variable name are rejected', () => {
  const step = (id: string) => ({ id, title: id, type: 'agent', agent: 'claude', access: 'read-only', prompt: 'x', output: { kind: 'text' } });
  const w = { schema: 1, kind: 'custom', name: 't', git: { mode: 'none' }, steps: [step('a-b'), step('a_b')] };
  const issues = validateWorkflow(w, { hasAgent: () => true });
  assert.ok(issues.some((i) => i.level === 'error' && i.message.includes('环境变量')));
});

test('commandEnv exposes files and exit codes, never raw values', () => {
  const env = commandEnv({
    taskFile: '/run/task.txt',
    refs: [
      { kind: 'task' },
      { kind: 'step-output', step: 'design' },
      { kind: 'step-exit-code', step: 'tests' },
      { kind: 'file', path: 'docs/a.md' },
    ],
    outputFile: (step) => `/run/steps/${step}/output.txt`,
    exitCode: (step) => (step === 'tests' ? 3 : undefined),
    resolvedFile: (p) => `/wt/${p}`,
  });
  assert.deepEqual(env, {
    RB_TASK_FILE: '/run/task.txt',
    RB_STEP_DESIGN_OUTPUT_FILE: '/run/steps/design/output.txt',
    RB_STEP_TESTS_EXIT_CODE: '3',
    RB_FILE_4: '/wt/docs/a.md',
  });
});

test('injection: text full of shell metacharacters reaches the command as data and runs nothing', async () => {
  const dir = await tmp();
  const nasty = 'a & echo INJECTED > injected.txt\n| whoami "quoted" %PATH% $(id) `id` ; rm -rf / \' end';
  const taskFile = path.join(dir, 'task.txt');
  await fs.writeFile(taskFile, nasty);
  const env = commandEnv({
    taskFile,
    refs: [{ kind: 'task' }],
    outputFile: () => '',
    exitCode: () => undefined,
    resolvedFile: (p) => p,
  });
  const r = await runShell('node -e "process.stdout.write(require(\'fs\').readFileSync(process.env.RB_TASK_FILE,\'utf8\'))"', { cwd: dir, env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, nasty);
  await assert.rejects(fs.stat(path.join(dir, 'injected.txt')), 'the injected command must not have run');
});
