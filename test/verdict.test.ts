import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judge, formatFeedback } from '../src/verdict.ts';
import type { Config, ReviewResult } from '../src/types.ts';

const loop: Config['loop'] = {
  maxReviewRounds: 3,
  blockOn: ['blocker', 'major'],
  testsMustPass: true,
  resumeImplementerSession: true,
};
const issue = (severity: 'blocker' | 'major' | 'minor' | 'nit') => ({
  severity,
  file: 'a.ts',
  description: 'd',
  suggestion: 's',
});
const review = (verdict: ReviewResult['verdict'], ...sev: Array<'blocker' | 'major' | 'minor' | 'nit'>): ReviewResult => ({
  verdict,
  summary: 'sum',
  issues: sev.map(issue),
});
const passed = { skipped: false, exitCode: 0, durationMs: 1, sha: 'x', outputTail: '' };
const failed = { ...passed, exitCode: 1 };

test('approve with no blocking issues and passing tests is approved', () => {
  assert.equal(judge(review('approve', 'nit'), passed, loop).verdict, 'approve');
});

test('approve with a blocker is overridden', () => {
  const j = judge(review('approve', 'blocker'), passed, loop);
  assert.equal(j.verdict, 'request_changes');
  assert.match(j.overriddenBy ?? '', /blocking/);
});

test('failing tests override an approve', () => {
  const j = judge(review('approve'), failed, loop);
  assert.equal(j.verdict, 'request_changes');
  assert.equal(j.overriddenBy, 'tests failed');
});

test('failing tests are ignored when testsMustPass is off', () => {
  assert.equal(judge(review('approve'), failed, { ...loop, testsMustPass: false }).verdict, 'approve');
});

test('skipped tests never block', () => {
  assert.equal(judge(review('approve'), { ...passed, skipped: true, exitCode: null }, loop).verdict, 'approve');
});

test('request_changes with only minor issues stays request_changes', () => {
  assert.equal(judge(review('request_changes', 'minor'), passed, loop).verdict, 'request_changes');
});

test('blockOn is configurable', () => {
  assert.equal(judge(review('approve', 'major'), passed, { ...loop, blockOn: ['blocker'] }).verdict, 'approve');
});

test('feedback lists must-fix issues first', () => {
  const text = formatFeedback(review('request_changes', 'nit', 'blocker'), loop.blockOn);
  assert.ok(text.indexOf('[blocker]') < text.indexOf('[nit]'));
  assert.match(text, /MUST FIX/);
});
