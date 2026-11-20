import type { Config, ReviewIssue, ReviewResult, Round } from './types.ts';

export interface Judgement {
  verdict: 'approve' | 'request_changes';
  overriddenBy?: string;
  blocking: ReviewIssue[];
}

/**
 * Decide the effective verdict. The reviewer's word is not final: the
 * orchestrator enforces the configured severity gate and the test result, so a
 * lenient model cannot approve a failing or blocker-laden change.
 */
export function judge(review: ReviewResult, tests: Round['test'] | undefined, cfg: Config['loop']): Judgement {
  const blocking = review.issues.filter((i) => cfg.blockOn.includes(i.severity));
  const testsFailed = !!tests && !tests.skipped && tests.exitCode !== 0;
  if (testsFailed && cfg.testsMustPass) {
    return { verdict: 'request_changes', blocking, overriddenBy: 'tests failed' };
  }
  if (blocking.length > 0) {
    return {
      verdict: 'request_changes',
      blocking,
      overriddenBy: review.verdict === 'approve' ? 'blocking issues despite approve' : undefined,
    };
  }
  if (review.verdict === 'request_changes') {
    // Reviewer asked for changes but listed nothing at a blocking severity.
    return { verdict: 'request_changes', blocking, overriddenBy: undefined };
  }
  return { verdict: 'approve', blocking };
}

const ORDER: Record<ReviewIssue['severity'], number> = { blocker: 0, major: 1, minor: 2, nit: 3 };

export function formatFeedback(review: ReviewResult, blockOn: string[]): string {
  const issues = [...review.issues].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const lines = [review.summary.trim(), ''];
  issues.forEach((i, n) => {
    const must = blockOn.includes(i.severity) ? ' (MUST FIX)' : '';
    lines.push(`${n + 1}. [${i.severity}]${must} ${i.file || '(general)'}`);
    lines.push(`   ${i.description.trim()}`);
    if (i.suggestion.trim()) lines.push(`   Suggestion: ${i.suggestion.trim()}`);
  });
  return lines.join('\n').trim();
}
