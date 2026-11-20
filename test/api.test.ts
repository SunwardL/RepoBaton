import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AnthropicCompatibleAgent, OpenAiCompatibleAgent } from '../src/agents/api.ts';
import { execTool } from '../src/agents/tools.ts';
import { REVIEW_SCHEMA } from '../src/prompts.ts';

interface Hit {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

async function serve(replies: unknown[]): Promise<{ base: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      hits.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(data || '{}') });
      const reply = replies[Math.min(hits.length - 1, replies.length - 1)];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, hits, close: () => new Promise((r) => server.close(() => r())) };
}

async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-api-'));
  await fs.writeFile(path.join(d, 'a.txt'), 'hello\nworld\n');
  return d;
}

const baseReq = { stage: 'review' as const, prompt: 'review it', access: 'read-only' as const, timeoutMs: 10_000 };

test('openai-compatible: tool loop then JSON answer, key sent as bearer', async () => {
  const cwd = await tmp();
  const final = { verdict: 'approve', summary: 'ok', issues: [] };
  const srv = await serve([
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
    { choices: [{ message: { role: 'assistant', content: JSON.stringify(final) } }], usage: { prompt_tokens: 20, completion_tokens: 5 } },
  ]);
  process.env.TEST_OPENAI_KEY = 'sk-test';
  const agent = new OpenAiCompatibleAgent('gpt', { type: 'openai-compatible', baseUrl: `${srv.base}/v1`, model: 'm1', apiKeyEnv: 'TEST_OPENAI_KEY' });
  const res = await agent.run({ ...baseReq, cwd, schema: REVIEW_SCHEMA });
  await srv.close();
  assert.deepEqual(res.structured, final);
  assert.equal(res.inputTokens, 30);
  assert.equal(srv.hits[0].url, '/v1/chat/completions');
  assert.equal(srv.hits[0].headers.authorization, 'Bearer sk-test');
  assert.equal(srv.hits[0].body.model, 'm1');
  const names = srv.hits[0].body.tools.map((t: any) => t.function.name);
  assert.deepEqual(names.sort(), ['list_dir', 'read_file', 'search']);
  const toolMsg = srv.hits[1].body.messages.find((m: any) => m.role === 'tool');
  assert.match(toolMsg.content, /1\thello/);
});

test('anthropic-compatible: submit_result tool yields structured output', async () => {
  const cwd = await tmp();
  const final = { verdict: 'request_changes', summary: 'no', issues: [{ severity: 'major', file: 'a.txt', description: 'd', suggestion: 's' }] };
  const srv = await serve([{ content: [{ type: 'tool_use', id: 't1', name: 'submit_result', input: final }], usage: { input_tokens: 7, output_tokens: 3 } }]);
  process.env.TEST_ANTHROPIC_KEY = 'ak-test';
  const agent = new AnthropicCompatibleAgent('cl', { type: 'anthropic-compatible', baseUrl: srv.base, model: 'claude-x', apiKeyEnv: 'TEST_ANTHROPIC_KEY' });
  const res = await agent.run({ ...baseReq, cwd, schema: REVIEW_SCHEMA });
  await srv.close();
  assert.deepEqual(res.structured, final);
  assert.equal(srv.hits[0].url, '/v1/messages');
  assert.equal(srv.hits[0].headers['x-api-key'], 'ak-test');
  assert.equal(srv.hits[0].headers['anthropic-version'], '2023-06-01');
  assert.ok(srv.hits[0].body.tools.some((t: any) => t.name === 'submit_result'));
});

test('invalid structured output from an API agent is rejected', async () => {
  const cwd = await tmp();
  const srv = await serve([{ choices: [{ message: { role: 'assistant', content: '{"verdict":"maybe","summary":"x","issues":[]}' } }] }]);
  process.env.TEST_OPENAI_KEY = 'sk-test';
  const agent = new OpenAiCompatibleAgent('gpt', { type: 'openai-compatible', baseUrl: srv.base, model: 'm1', apiKeyEnv: 'TEST_OPENAI_KEY' });
  await assert.rejects(agent.run({ ...baseReq, cwd, schema: REVIEW_SCHEMA }), /schema validation/);
  await srv.close();
});

test('missing API key fails without a network call', async () => {
  delete process.env.NO_SUCH_KEY;
  const agent = new OpenAiCompatibleAgent('gpt', { type: 'openai-compatible', model: 'm', apiKeyEnv: 'NO_SUCH_KEY' });
  await assert.rejects(agent.run({ ...baseReq, cwd: os.tmpdir() }), /no API key/);
});

test('tools: read-only stages cannot write, paths cannot escape, .git is blocked', async () => {
  const cwd = await tmp();
  const ro = { access: 'read-only' as const, allowShell: true, timeoutMs: 5000 };
  assert.match(await execTool('write_file', { path: 'x.txt', content: 'x' }, cwd, ro), /read-only/);
  await assert.rejects(fs.access(path.join(cwd, 'x.txt')));
  assert.match(await execTool('run_command', { command: 'echo hi' }, cwd, ro), /not enabled/);
  assert.match(await execTool('read_file', { path: '../outside.txt' }, cwd, ro), /escapes/);
  assert.match(await execTool('read_file', { path: '.git/config' }, cwd, ro), /not allowed/);
  const rw = { access: 'workspace-write' as const, allowShell: false, timeoutMs: 5000 };
  assert.match(await execTool('write_file', { path: 'sub/y.txt', content: 'y' }, cwd, rw), /wrote/);
  assert.equal(await fs.readFile(path.join(cwd, 'sub', 'y.txt'), 'utf8'), 'y');
  assert.match(await execTool('run_command', { command: 'echo hi' }, cwd, rw), /not enabled/);
});
