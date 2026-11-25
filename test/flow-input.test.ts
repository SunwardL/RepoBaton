import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateWorkflow } from '../src/flow.ts';

const known = (id: string) => ['claude', 'codex'].includes(id);
function check(w: unknown) {
  return validateWorkflow(w, { hasAgent: known }).filter((i) => i.level === 'error');
}
function has(list: { message: string }[], text: string) {
  return list.some((i) => i.message.includes(text));
}
const base = (steps: unknown[], git: unknown = { mode: 'none' }) => ({ schema: 1, kind: 'custom', name: 't', steps, git });
const agent = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: id, type: 'agent', agent: 'claude', access: 'read-only', prompt: 'hi', output: { kind: 'text' }, ...extra });
const command = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: id, type: 'command', run: 'echo ok', output: { kind: 'text' }, ...extra });

test('command lines never contain references: values reach the command through environment variables', () => {
  for (const ref of ['{{task}}', '{{steps.a.output}}', '{{steps.a.exit_code}}', '{{file:docs/a.md}}']) {
    const w = base([agent('a'), command('c', { run: 'echo ' + ref })]);
    assert.ok(has(check(w), '环境变量'), ref);
  }
});

test('a command that uses shell metacharacters of its own is the author\'s business, not an error', () => {
  const w = base([agent('a'), command('c', { run: 'echo a & echo b | findstr b', inputs: [{ kind: 'step-output', step: 'a' }, { kind: 'task' }] })]);
  assert.deepEqual(check(w), []);
});

test('declared command inputs are still checked: they become environment variables', () => {
  const later = base([command('c', { inputs: [{ kind: 'step-output', step: 'z' }] }), agent('z')]);
  assert.ok(has(check(later), '之后'));
  const badFile = base([command('c', { inputs: [{ kind: 'file', path: '../x' }] })]);
  assert.ok(check(badFile).length > 0);
});

test('approval message and commit message are checked for reference syntax', () => {
  const ok = { id: 'ok', title: 'ok', type: 'approval', show: [{ kind: 'task' }] };
  assert.ok(has(check(base([{ ...ok, message: '{{nope}}' }])), '不支持的引用'));
  assert.ok(has(check(base([{ ...ok, message: 5 }])), 'message'));
  assert.ok(has(check(base([{ ...ok, message: '{{steps.later.output}}' }, agent('later')])), '之后'));
  assert.deepEqual(check(base([{ ...ok, message: '请确认：{{task}}' }])), []);
});

test('git.publish of the wrong type or with unknown or non-boolean flags is an error', () => {
  for (const publish of ['yes', ['push'], 5, { push: 'true' }, { bogus: true }, { tagPrefix: 5 }, { remote: '' }]) {
    const w = base([agent('a')], { mode: 'explicit-step', publish });
    assert.ok(has(check(w), 'publish'), JSON.stringify(publish));
  }
  assert.deepEqual(check(base([agent('a'), { id: 'save', title: 'save', type: 'commit', message: 'save' },
    { id: 'approve', title: 'approve', type: 'approval', show: [{ kind: 'task' }] }],
  { mode: 'explicit-step', publish: { push: true, tagPrefix: 'v', remote: 'origin' } })), []);
});

test('step entries and optional fields of the wrong type are errors, never ignored', () => {
  assert.ok(check(base([null])).length > 0);
  assert.ok(check(base([5, 'x'])).length > 0);
  assert.ok(has(check(base([agent('a', { model: 5 })])), 'model'));
  assert.ok(has(check(base([agent('a', { title: 5 })])), '标题'));
  assert.ok(has(check(base([agent('a', { inputs: 'task' })])), 'inputs'));
  assert.ok(has(check(base([agent('a', { fallbackAgent: 5 })])), '备用'));
  assert.ok(has(check(base([command('c', { inputs: {} })])), 'inputs'));
  assert.ok(has(check(base([agent('a')], 'none')), 'Git'));
});

test('a non-string name, step list or git block never throws', () => {
  for (const w of [{ schema: 1, kind: 'custom', name: 5, steps: [], git: null }, { schema: 1, kind: 'custom', name: 't', steps: null, git: 5 }, [], 'x', 5, undefined]) {
    assert.doesNotThrow(() => validateWorkflow(w, { hasAgent: known }));
    assert.ok(validateWorkflow(w, { hasAgent: known }).some((i) => i.level === 'error'));
  }
});
