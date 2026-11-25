import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { defaultConfig } from '../src/config.ts';
import { changedFlowAgentFields, restoreFlowAgents, snapshotFlowAgents } from '../src/flow-config.ts';
import type { Workflow } from '../src/flow-types.ts';

test('agent snapshots preserve invocation settings without storing secret argument or environment values', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-flow-key-'));
  const previous = process.env.REPOBATON_HOME;
  process.env.REPOBATON_HOME = home;
  try {
    const config = defaultConfig();
    config.agents.test = { type: 'command', command: 'node', model: 'initial', args: ['--token', 'secret-argument'], env: { TOKEN: 'secret-env' } };
    const workflow: Workflow = { schema: 1, kind: 'custom', name: 'test', git: { mode: 'none' }, steps: [
      { id: 'run', title: 'run', type: 'agent', agent: 'test', access: 'workspace-write', prompt: '{{task}}', output: { kind: 'text' } },
    ] };
    const snapshots = await Promise.all(Array.from({ length: 5 }, () => snapshotFlowAgents(workflow, config)));
    const snapshot = snapshots[0];
    assert.ok(snapshots.every((item) => item.test.argsFingerprint === snapshot.test.argsFingerprint));
    assert.doesNotMatch(JSON.stringify(snapshot), /secret-argument|secret-env/);
    config.agents.test.model = 'changed';
    config.agents.test.path = 'new-path';
    assert.deepEqual(changedFlowAgentFields(JSON.parse(JSON.stringify(snapshot)), config).sort(), ['test.model', 'test.path']);
    assert.doesNotMatch(JSON.stringify(changedFlowAgentFields(snapshot, config)), /secret|new-path/);
    const restored = await restoreFlowAgents(snapshot, config);
    assert.equal(restored.test.model, 'initial');
    assert.deepEqual(restored.test.args, ['--token', 'secret-argument']);
    config.agents.test.args = ['--token', 'different'];
    await assert.rejects(restoreFlowAgents(snapshot, config), /arguments have changed/);
    config.agents.test.args = ['--token', 'secret-argument'];
    delete config.agents.test.env;
    await assert.rejects(restoreFlowAgents(snapshot, config), /environment variable TOKEN/);
  } finally {
    if (previous === undefined) delete process.env.REPOBATON_HOME;
    else process.env.REPOBATON_HOME = previous;
    const resolved = await fs.realpath(home);
    assert.equal(path.dirname(resolved), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('rb-flow-key-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
