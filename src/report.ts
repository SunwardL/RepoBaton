import type { Plan, RunState } from './types.ts';
import { formatDuration } from './util.ts';

export function formatPlan(plan: Plan): string {
  const lines = [plan.summary.trim(), '', '## Steps'];
  plan.steps.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.title}${s.files.length ? ` (${s.files.join(', ')})` : ''}`);
    if (s.detail.trim()) lines.push(`   ${s.detail.trim().replace(/\n/g, '\n   ')}`);
  });
  if (plan.risks.length) lines.push('', '## Risks', ...plan.risks.map((r) => `- ${r}`));
  if (plan.test_hints.length) lines.push('', '## Test hints', ...plan.test_hints.map((r) => `- ${r}`));
  return lines.join('\n');
}

export function formatAcceptance(plan: Plan): string {
  return plan.acceptance.length ? plan.acceptance.map((a) => `- [ ] ${a}`).join('\n') : '- The task is completed as described.';
}

export function renderReport(s: RunState): string {
  const L: string[] = [];
  L.push(`# RepoBaton run ${s.id}`, '');
  L.push(`- **Status:** ${s.status}${s.error ? ` — ${s.error}` : ''}`);
  L.push(`- **Task:** ${s.task.split('\n')[0]}`);
  if (s.branch) L.push(`- **Branch:** \`${s.branch}\`${s.base ? ` (base \`${s.base.branch}\` @ ${s.base.sha.slice(0, 8)})` : ''}`);
  if (s.worktree) L.push(`- **Worktree:** ${s.worktree}`);
  L.push(
    `- **Usage:** ${s.usage.calls} agent calls, ${s.usage.inputTokens} in / ${s.usage.outputTokens} out tokens` +
      (s.usage.costUsd ? `, $${s.usage.costUsd.toFixed(4)}` : ''),
  );
  if (s.plan) {
    L.push('', `## Plan${s.planAgent ? ` (by ${s.planAgent})` : ''}`, '', formatPlan(s.plan), '', '### Acceptance', formatAcceptance(s.plan));
  }
  for (const r of s.rounds) {
    L.push('', `## Round ${r.n}${r.decision ? ` — ${r.decision}` : ' — incomplete'}`);
    if (r.implement) {
      L.push(
        `- Implement (${r.implement.agent}, ${formatDuration(r.implement.durationMs)}): ${r.implement.changedFiles.length} files, commit \`${r.implement.sha.slice(0, 8)}\``,
      );
      if (r.implement.summary) L.push(`  > ${r.implement.summary.trim().split('\n').slice(0, 6).join('\n  > ')}`);
    }
    if (r.test) {
      L.push(
        r.test.skipped
          ? '- Tests: skipped (no test command)'
          : `- Tests: exit ${r.test.exitCode} (${formatDuration(r.test.durationMs)})`,
      );
    }
    if (r.review) {
      L.push(
        `- Review (${r.review.agent}): **${r.review.verdict}**${r.review.overriddenBy ? ` (overridden: ${r.review.overriddenBy})` : ''} — ${r.review.summary.trim()}`,
      );
      for (const i of r.review.issues) L.push(`  - [${i.severity}] ${i.file}: ${i.description.trim()}`);
    }
  }
  if (s.release) {
    L.push('', '## Release draft', `- Version bump: ${s.release.version_bump} → ${s.release.suggested_version || '?'}`, `- PR title: ${s.release.pr_title}`);
    if (s.release.risks.length) L.push('- Risks:', ...s.release.risks.map((r) => `  - ${r}`));
  }
  const p = s.publish;
  if (p.pushed || p.prUrl || p.merged || p.tag) {
    L.push('', '## Publish');
    if (p.pushed) L.push('- Pushed branch');
    if (p.prUrl) L.push(`- PR: ${p.prUrl}`);
    if (p.merged) L.push(`- Merged${p.mergeSha ? ` @ ${p.mergeSha.slice(0, 8)}` : ''}`);
    if (p.tag) L.push(`- Tag: ${p.tag}${p.tagPushed ? ' (pushed)' : ''}`);
  }
  return L.join('\n') + '\n';
}
