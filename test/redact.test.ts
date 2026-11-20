import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentError } from '../src/types.ts';
import { clearRegisteredSecrets, redactDeep, redactDiagnostic, redactSecrets, registerSecret, REDACTED } from '../src/redact.ts';
import { GitError } from '../src/git.ts';
import { PipelineError } from '../src/pipeline.ts';

const SENTINEL = 'sk-SENTINEL-live-abcdef0123456789';

test('redact: env secret values are masked by value, whatever the surrounding text', () => {
  process.env.RB_TEST_PROVIDER_KEY = 'plainvalue-NOT-a-known-format-98765';
  try {
    const out = redactDiagnostic('upstream said: bad key plainvalue-NOT-a-known-format-98765 (rejected)');
    assert.ok(!out.includes('plainvalue-NOT'), out);
    assert.ok(out.includes('upstream said'));
  } finally {
    delete process.env.RB_TEST_PROVIDER_KEY;
  }
});

test('redact: known token shapes, bearer headers, URL credentials, query keys and JSON fields', () => {
  const samples = [
    `Incorrect API key provided: ${SENTINEL}. You can find your key at https://example`,
    'Authorization: Bearer abcDEF1234567890xyz',
    'fatal: unable to access https://user:ghp_abcdefghijklmnop1234@github.com/o/r.git/',
    'GET https://api.example.com/v1/x?api_key=SUPERSECRETVALUE&other=1 failed',
    '{"error":{"message":"nope","api_key":"SUPERSECRETVALUE"}}',
    'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked',
    'x-api-key: SUPERSECRETVALUE',
  ];
  for (const s of samples) {
    const out = redactDiagnostic(s);
    for (const bad of [SENTINEL, 'SUPERSECRETVALUE', 'abcDEF1234567890xyz', 'ghp_abcdefghijklmnop', 'user:ghp']) {
      assert.ok(!out.includes(bad), `"${bad}" survived in: ${out}`);
    }
    assert.ok(out.includes(REDACTED), out);
  }
});

test('redact: NAME=value assignments are masked in diagnostics but names stay readable', () => {
  const out = redactDiagnostic('spawn failed: OPENAI_API_KEY=abc123456789 node run.js');
  assert.equal(out, `spawn failed: OPENAI_API_KEY=${REDACTED} node run.js`);
});

test('redact: names, agent ids, categories and ordinary prose are left alone', () => {
  const msg = 'agent "gpt" needs the environment variable OPENAI_API_KEY (error kind: auth). Set it before starting.';
  assert.equal(redactDiagnostic(msg), msg);
  const plain = 'git push failed (1): remote: Permission to o/r denied; token scope missing';
  assert.equal(redactDiagnostic(plain), plain);
});

test('redact: registered values (inline config keys) are masked', () => {
  registerSecret('inline-config-key-777');
  try {
    assert.ok(!redactDiagnostic('bad key inline-config-key-777').includes('inline-config'));
  } finally {
    clearRegisteredSecrets();
  }
});

test('redact: path-like and short env values are never treated as secrets', () => {
  process.env.RB_TEST_SOME_TOKEN_DIR = 'C:\\Users\\me\\tokens';
  process.env.RB_TEST_SHORT_KEY = 'abc';
  try {
    const s = 'working in C:\\Users\\me\\tokens with abc';
    assert.equal(redactSecrets(s), s);
  } finally {
    delete process.env.RB_TEST_SOME_TOKEN_DIR;
    delete process.env.RB_TEST_SHORT_KEY;
  }
});

test('redactDeep: masks nested strings and keeps structure', () => {
  const v = redactDeep({ a: [`key ${SENTINEL}`, { b: `Bearer abcdefgh12345678` }], n: 3, ok: true });
  const j = JSON.stringify(v);
  assert.ok(!j.includes('SENTINEL') && !j.includes('abcdefgh12345678'), j);
  assert.equal((v as any).n, 3);
});

test('error classes mask the message at construction, so no catch site can leak it', () => {
  assert.ok(!new AgentError(`HTTP 401: invalid key ${SENTINEL}`, false, 'auth').message.includes('SENTINEL'));
  assert.ok(!new GitError(`git push failed: https://u:${SENTINEL}@h/r`, 1).message.includes('SENTINEL'));
  assert.ok(!new PipelineError(`plan stage failed: ${SENTINEL}`).message.includes('SENTINEL'));
  // The category and the human-readable part survive.
  const e = new AgentError(`HTTP 401: invalid key ${SENTINEL}`, false, 'auth');
  assert.equal(e.kind, 'auth');
  assert.match(e.message, /HTTP 401: invalid key/);
});
