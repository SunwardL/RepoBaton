import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTemplate, validateWorkflow, workflowHash } from '../src/flow.ts';
import { defaultConfig } from '../src/config.ts';
import type { Workflow } from '../src/flow-types.ts';

const config = defaultConfig();
const AGENTS = Object.keys(config.agents);
const known = (id: string) => AGENTS.includes(id);

function flow(steps: Workflow['steps'], git: Workflow['git'] = { mode: 'none' }): Workflow {
  return { schema: 1, kind: 'custom', name: 't', steps, git };
}
const agent = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: id, type: 'agent', agent: 'claude', access: 'read-only', prompt: 'hi', output: { kind: 'text' }, ...extra }) as Workflow['steps'][number];
const command = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: id, type: 'command', run: 'echo ok', output: { kind: 'text' }, ...extra }) as Workflow['steps'][number];

function errors(w: Workflow) {
  return validateWorkflow(w, { hasAgent: known }).filter((i) => i.level === 'error');
}
function warnings(w: Workflow) {
  return validateWorkflow(w, { hasAgent: known }).filter((i) => i.level === 'warning');
}
function has(list: { message: string }[], text: string) {
  return list.some((i) => i.message.includes(text));
}

test('parseTemplate recognises the four reference forms and nothing else', () => {
  const r = parseTemplate('a {{task}} b {{steps.design.output}} c {{steps.t.exit_code}} d {{file:docs/a.md}}');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.refs, [
    { kind: 'task' },
    { kind: 'step-output', step: 'design' },
    { kind: 'step-exit-code', step: 't' },
    { kind: 'file', path: 'docs/a.md' },
  ]);
});

test('parseTemplate rejects unknown forms instead of passing them through', () => {
  for (const bad of ['{{ steps.a.output | upper }}', '{{steps.a.stdout}}', '{{env.HOME}}', '{{task.x}}', '{{ }}', '{{steps..output}}', '{{#if task}}']) {
    const r = parseTemplate(`x ${bad} y`);
    assert.equal(r.errors.length, 1, bad);
    assert.match(r.errors[0], /不支持的引用/);
  }
});

test('parseTemplate tolerates spaces inside braces and unclosed braces are an error', () => {
  assert.deepEqual(parseTemplate('{{ task }}').refs, [{ kind: 'task' }]);
  assert.equal(parseTemplate('oops {{task').errors.length, 1);
});

test('a valid three step flow has no errors', () => {
  const w = flow([
    agent('design', { prompt: '写方案：{{task}}' }),
    agent('build', { agent: 'codex', access: 'workspace-write', prompt: '实现\n{{steps.design.output}}' }),
    agent('ux', { prompt: '检查：{{steps.build.output}}' }),
  ]);
  assert.deepEqual(errors(w), []);
});

test('step ids: invalid and duplicate', () => {
  assert.ok(has(errors(flow([agent('Bad')])), '步骤 id'));
  assert.ok(has(errors(flow([agent('1a')])), '步骤 id'));
  assert.ok(has(errors(flow([agent('a'.repeat(33))])), '步骤 id'));
  assert.ok(has(errors(flow([agent('x'), agent('x')])), '重复'));
});

test('step count: at least one, at most twenty', () => {
  assert.ok(has(errors(flow([])), '至少'));
  const many = Array.from({ length: 21 }, (_, i) => agent(`s${i}`));
  assert.ok(has(errors(flow(many)), '至多'));
  assert.deepEqual(errors(flow(many.slice(0, 20))), []);
});

test('references can only point backwards', () => {
  const forward = flow([agent('a', { prompt: '{{steps.b.output}}' }), agent('b')]);
  assert.ok(has(errors(forward), '之后'));
  const self = flow([agent('a', { prompt: '{{steps.a.output}}' })]);
  assert.ok(has(errors(self), '之后'));
  const missing = flow([agent('a', { prompt: '{{steps.zz.output}}' })]);
  assert.ok(has(errors(missing), '不存在'));
});

test('a referenced step must be able to produce what is referenced', () => {
  const approval = { id: 'ok', title: 'ok', type: 'approval', show: [{ kind: 'task' }] } as Workflow['steps'][number];
  const commit = { id: 'cm', title: 'cm', type: 'commit', message: 'm' } as Workflow['steps'][number];
  assert.ok(has(errors(flow([approval, agent('a', { prompt: '{{steps.ok.output}}' })])), '没有输出'));
  assert.ok(has(errors(flow([commit, agent('a', { prompt: '{{steps.cm.output}}' })], { mode: 'explicit-step' })), '没有输出'));
  assert.ok(has(errors(flow([agent('x'), agent('a', { prompt: '{{steps.x.exit_code}}' })])), '退出码'));
  assert.deepEqual(errors(flow([command('t'), agent('a', { prompt: '{{steps.t.exit_code}}' })])), []);
});

test('file references: must be relative and stay inside the worktree', () => {
  for (const p of ['/etc/passwd', 'C:/x/y.txt', 'C:\\x\\y.txt', '../secret', 'a/../../b', '.git/config', '.repobaton/runs/x', 'a/.git/config', '\\\\server\\share\\f', 'a\0b']) {
    const w = flow([agent('a', { prompt: `{{file:${p}}}` })]);
    assert.ok(errors(w).length > 0, `should reject ${JSON.stringify(p)}`);
  }
  assert.deepEqual(errors(flow([agent('a', { prompt: '{{file:docs/readme.md}}' })])), []);
  assert.deepEqual(errors(flow([agent('a', { prompt: '{{file:./docs/../docs/readme.md}}' })])), []);
});

test('unknown reference syntax inside any templated field is an error', () => {
  assert.ok(has(errors(flow([agent('a', { prompt: '{{nope}}' })])), '不支持的引用'));
  assert.ok(has(errors(flow([command('c', { run: 'echo {{nope}}' })])), '环境变量'));
  const commit = { id: 'cm', title: 'cm', type: 'commit', message: '{{nope}}' } as Workflow['steps'][number];
  assert.ok(has(errors(flow([commit], { mode: 'explicit-step' })), '不支持的引用'));
});

test('declared inputs and body references: mismatch is a warning, the body wins', () => {
  const undeclared = flow([agent('a'), agent('b', { prompt: '{{steps.a.output}}', inputs: [] })]);
  assert.deepEqual(errors(undeclared), []);
  assert.ok(has(warnings(undeclared), '未在 inputs 中声明'));
  const unused = flow([agent('a'), agent('b', { prompt: 'plain', inputs: [{ kind: 'step-output', step: 'a' }] })]);
  assert.deepEqual(errors(unused), []);
  assert.ok(has(warnings(unused), '正文没有用到'));
  const consistent = flow([agent('a'), agent('b', { prompt: '{{steps.a.output}}', inputs: [{ kind: 'step-output', step: 'a' }] })]);
  assert.deepEqual(warnings(consistent), []);
});

test('declared inputs are validated like body references', () => {
  const w = flow([agent('a', { inputs: [{ kind: 'step-output', step: 'later' }] }), agent('later')]);
  assert.ok(has(errors(w), '之后'));
  const bad = flow([agent('a', { inputs: [{ kind: 'file', path: '../x' }] })]);
  assert.ok(errors(bad).length > 0);
});

test('agents must exist; a fallback agent cannot be the primary', () => {
  assert.ok(has(errors(flow([agent('a', { agent: 'ghost' })])), '未配置'));
  assert.ok(has(errors(flow([agent('a', { fallbackAgent: 'ghost' })])), '未配置'));
  assert.ok(has(errors(flow([agent('a', { agent: 'claude', fallbackAgent: 'claude' })])), '备用'));
  assert.deepEqual(errors(flow([agent('a', { agent: 'claude', fallbackAgent: 'codex' })])), []);
});

test('json output is reserved and rejected on save', () => {
  const w = flow([agent('a', { output: { kind: 'json', schema: {} } })]);
  assert.ok(has(errors(w), '暂不执行结构化输出'));
  assert.ok(has(errors(flow([command('c', { output: { kind: 'json', schema: {} } })])), '暂不执行结构化输出'));
});

test('structural field checks: access, timeouts, exit codes, empty text', () => {
  assert.ok(has(errors(flow([agent('a', { access: 'root' })])), 'access'));
  assert.ok(has(errors(flow([agent('a', { prompt: '  ' })])), '提示词'));
  assert.ok(has(errors(flow([command('c', { run: '' })])), '命令'));
  assert.ok(has(errors(flow([command('c', { run: 'a\nb' })])), '一行'));
  assert.ok(has(errors(flow([agent('a', { timeoutSec: 0 })])), 'timeoutSec'));
  assert.ok(has(errors(flow([agent('a', { timeoutSec: 1.5 })])), 'timeoutSec'));
  assert.ok(has(errors(flow([command('c', { okExitCodes: [] })])), 'okExitCodes'));
  assert.ok(has(errors(flow([command('c', { okExitCodes: [1.5] })])), 'okExitCodes'));
  assert.ok(has(errors(flow([agent('a', { type: 'wat' })])), '步骤类型'));
});

test('git policy: commit steps need explicit-step, publish only with explicit-step', () => {
  const commit = { id: 'cm', title: 'cm', type: 'commit', message: 'm' } as Workflow['steps'][number];
  assert.ok(has(errors(flow([agent('a'), commit], { mode: 'none' })), '提交步骤'));
  assert.ok(has(errors(flow([agent('a'), commit], { mode: 'agent-managed' })), '提交步骤'));
  assert.deepEqual(errors(flow([agent('a'), commit], { mode: 'explicit-step' })), []);
  assert.ok(has(errors(flow([agent('a')], { mode: 'none', publish: { push: true } })), 'publish'));
  assert.ok(has(errors(flow([agent('a'), commit], { mode: 'explicit-step', publish: { createPr: true } })), 'push'));
  assert.ok(has(errors(flow([agent('a')], { mode: 'wat' as never })), 'Git'));
});

test('agent-managed allows agents to control Git without a commit step', () => {
  assert.equal(errors(flow([agent('a')], { mode: 'agent-managed' })).length, 0);
});

test('custom publishing requires an explicit commit and a final human confirmation', () => {
  const commit = { id: 'save', title: 'save', type: 'commit', message: 'save' } as Workflow['steps'][number];
  const approval = { id: 'confirm', title: 'confirm', type: 'approval', show: [{ kind: 'task' }] } as Workflow['steps'][number];
  assert.deepEqual(errors(flow([agent('a'), commit, approval], { mode: 'explicit-step', publish: { push: true } })), []);
  assert.ok(has(errors(flow([agent('a'), commit], { mode: 'explicit-step', publish: { push: true } })), '人工确认'));
  assert.ok(has(errors(flow([agent('a'), approval], { mode: 'explicit-step', publish: { push: true } })), '提交步骤'));
  assert.ok(has(errors(flow([agent('a'), commit, approval], { mode: 'explicit-step', publish: { push: true, createPr: true, merge: true, tag: true } })), '版本号'));
});

test('approval steps must show something and are validated like references', () => {
  const none = { id: 'ok', title: 'ok', type: 'approval', show: [] } as Workflow['steps'][number];
  assert.ok(has(errors(flow([none])), '至少'));
  const fwd = { id: 'ok', title: 'ok', type: 'approval', show: [{ kind: 'step-output', step: 'later' }] } as Workflow['steps'][number];
  assert.ok(has(errors(flow([fwd, agent('later')])), '之后'));
});

test('workflow-level structure: schema, kind, name, and non-object input', () => {
  assert.ok(has(errors({ ...flow([agent('a')]), schema: 2 as never }), 'schema'));
  assert.ok(has(errors({ ...flow([agent('a')]), kind: 'x' as never }), 'kind'));
  assert.ok(has(errors({ ...flow([agent('a')]), name: ' ' }), '名称'));
  assert.ok(validateWorkflow(null, { hasAgent: known }).some((i) => i.level === 'error'));
  assert.ok(validateWorkflow({ steps: 'nope' }, { hasAgent: known }).some((i) => i.level === 'error'));
});

test('issues carry the step id and field so the editor can point at them', () => {
  const issue = validateWorkflow(flow([agent('a', { agent: 'ghost' })]), { hasAgent: known }).find((i) => i.level === 'error');
  assert.equal(issue?.step, 'a');
  assert.equal(issue?.field, 'agent');
});

test('workflowHash is stable under key order and changes with content', () => {
  const a = flow([agent('a')]);
  const b = JSON.parse(JSON.stringify(a));
  b.steps[0] = Object.fromEntries(Object.entries(b.steps[0]).reverse());
  assert.equal(workflowHash(a), workflowHash(b));
  assert.match(workflowHash(a), /^[0-9a-f]{64}$/);
  assert.notEqual(workflowHash(a), workflowHash(flow([agent('a', { prompt: 'changed' })])));
});
