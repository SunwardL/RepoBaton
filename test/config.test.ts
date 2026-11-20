import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigError, defaultConfig, loadConfig, validateConfig } from '../src/config.ts';
import { extractJson, renderTemplate, validateSchema } from '../src/util.ts';
import { REVIEW_SCHEMA } from '../src/prompts.ts';

async function tmpRepo(yaml?: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-cfg-'));
  if (yaml !== undefined) await fs.writeFile(path.join(dir, 'repobaton.yaml'), yaml);
  return dir;
}

test('defaults load with no config file', async () => {
  const { config, file } = await loadConfig(await tmpRepo());
  assert.equal(file, null);
  assert.equal(config.stages.implement.agent, 'codex');
  assert.equal(config.loop.maxReviewRounds, 3);
});

test('user config overrides stages and keeps other defaults', async () => {
  const repo = await tmpRepo(`stages:\n  review:\n    agent: codex\n    model: o3\nloop:\n  maxReviewRounds: 5\n`);
  const { config } = await loadConfig(repo);
  assert.equal(config.stages.review.agent, 'codex');
  assert.equal(config.stages.review.model, 'o3');
  assert.equal(config.stages.plan.agent, 'claude');
  assert.equal(config.loop.maxReviewRounds, 5);
  assert.deepEqual(config.loop.blockOn, ['blocker', 'major']);
});

test('custom agents replace the default pair', async () => {
  const repo = await tmpRepo(
    `agents:\n  gpt:\n    type: openai-compatible\n    model: gpt-5\nstages:\n  plan: { agent: gpt }\n  implement: { agent: gpt }\n  review: { agent: gpt }\n  release: { agent: gpt }\n`,
  );
  const { config } = await loadConfig(repo);
  assert.deepEqual(Object.keys(config.agents), ['gpt']);
});

test('unknown agent reference is rejected', async () => {
  const repo = await tmpRepo(`stages:\n  review:\n    agent: nobody\n`);
  await assert.rejects(loadConfig(repo), (e: unknown) => e instanceof ConfigError && /unknown agent "nobody"/.test(e.message));
});

test('publish dependencies are validated', () => {
  const cfg = defaultConfig();
  cfg.publish.merge = true;
  assert.ok(validateConfig(cfg).some((p) => /createPr/.test(p)));
});

test('invalid yaml gives a ConfigError', async () => {
  await assert.rejects(loadConfig(await tmpRepo('a: [unclosed')), ConfigError);
});

test('extractJson handles plain, fenced and embedded JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('Sure! Here it is: {"a":{"b":"}"}} thanks'), { a: { b: '}' } });
  assert.throws(() => extractJson('no json here'));
});

test('schema validation catches bad review output', () => {
  assert.deepEqual(validateSchema(REVIEW_SCHEMA, { verdict: 'approve', summary: 's', issues: [] }), []);
  assert.ok(validateSchema(REVIEW_SCHEMA, { verdict: 'maybe', summary: 's', issues: [] }).length > 0);
  assert.ok(validateSchema(REVIEW_SCHEMA, { verdict: 'approve' }).length > 0);
});

test('renderTemplate fills known vars and blanks unknown ones', () => {
  assert.equal(renderTemplate('a {{x}} b {{y}}', { x: 1 }), 'a 1 b ');
});
