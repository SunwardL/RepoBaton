import { promises as fs } from 'node:fs';
import path from 'node:path';
import { renderTemplate } from './util.ts';

export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'detail', 'files'],
      },
    },
    acceptance: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    test_hints: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'steps', 'acceptance', 'risks', 'test_hints'],
};

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['approve', 'request_changes'] },
    summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          file: { type: 'string' },
          description: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['severity', 'file', 'description', 'suggestion'],
      },
    },
  },
  required: ['verdict', 'summary', 'issues'],
};

export const RELEASE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version_bump: { type: 'string', enum: ['major', 'minor', 'patch', 'none'] },
    suggested_version: { type: 'string' },
    pr_title: { type: 'string' },
    pr_body: { type: 'string' },
    release_notes: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['version_bump', 'suggested_version', 'pr_title', 'pr_body', 'release_notes', 'risks'],
};

export const DEFAULT_PROMPTS = {
  plan: `You are the PLANNER in a multi-agent software pipeline. You only read code; you never edit it.

# Task
{{task}}

# Instructions
Explore the repository, then produce an implementation plan another engineer can follow without asking questions.
- "summary": what will change and why, in 2-4 sentences.
- "steps": ordered, small, concrete steps. Name the files each step touches.
- "acceptance": a checklist of observable conditions that prove the task is done. A reviewer will use it verbatim.
- "risks": things likely to go wrong, or ambiguities you resolved by assumption.
- "test_hints": which tests to add or run.
Do not pad the plan. If the task is small, the plan is small.`,

  implement: `You are the IMPLEMENTER in a multi-agent software pipeline. You work in a git worktree on branch {{branch}}.

# Task
{{task}}

# Plan
{{plan}}

# Acceptance criteria
{{acceptance}}

# Rules
- Implement the plan completely. Follow the repository's existing conventions.
- Add or update tests that cover the acceptance criteria.
- Do not run \`git commit\`, \`git push\`, \`git checkout\` or change branches: the orchestrator commits for you.
- Do not edit files outside this repository.
- When finished, reply with a short summary of what you changed and anything left undone.
{{test_hint}}`,

  fix: `You are the IMPLEMENTER. A reviewer (and/or the test run) rejected your previous work. Fix every blocking problem below.

# Task
{{task}}

# Acceptance criteria
{{acceptance}}

# Test result
{{tests}}

# Review feedback (round {{round}})
{{feedback}}

# Rules
- Address each issue; if you disagree with one, explain why in your final summary instead of ignoring it.
- Keep the diff focused: do not refactor unrelated code.
- Do not run \`git commit\`, \`git push\`, \`git checkout\` or change branches: the orchestrator commits for you.
- When finished, reply with a short summary of what you changed.`,

  review: `You are the REVIEWER in a multi-agent software pipeline. You are independent: you did not write this code. You only read; you never edit.

# Task
{{task}}

# Acceptance criteria
{{acceptance}}

# Automated test result
{{tests}}

# Commits under review ({{base_short}}..{{head_short}})
{{log}}

# Diff stat
{{stat}}

# Diff
{{diff}}

# Instructions
Judge whether the diff fully satisfies the task and every acceptance criterion, and whether it is correct and safe.
- Look for real bugs, missing requirements, broken tests, security problems and missing tests. You may read files in the repository for context.
- Use severity "blocker" for wrong or unsafe behavior, "major" for a missing requirement or missing test coverage that matters, "minor"/"nit" for style.
- Only choose "approve" if there is no blocker or major issue and the tests did not fail.
- Be specific: each issue needs a file, a description, and a concrete suggestion.
- Do not invent problems to look thorough. An empty issues list is fine for good work.
{{previous}}`,

  release: `You are the RELEASE MANAGER in a multi-agent software pipeline. You only read; you never edit.

# Task
{{task}}

# Commits
{{log}}

# Diff stat
{{stat}}

# Review summary
{{review}}

# Current version info
Latest git tag: {{latest_tag}}
{{version_info}}

# Instructions
Draft the release hand-off:
- "version_bump": semantic-versioning impact (major/minor/patch, or none if this should not be released).
- "suggested_version": the next version number (no prefix), based on the latest tag/version above. Use "" if unknown.
- "pr_title": under 70 characters, imperative mood.
- "pr_body": Markdown with Summary, Changes, Testing, Risks.
- "release_notes": user-facing Markdown notes.
- "risks": remaining concerns a human should know before merging.
Base everything on the actual diff, not on guesses.`,
};

export type PromptName = keyof typeof DEFAULT_PROMPTS;

export async function loadPrompt(
  name: PromptName,
  repo: string,
  override: string | undefined,
  vars: Record<string, string | number>,
): Promise<string> {
  let tpl: string = DEFAULT_PROMPTS[name];
  if (override) {
    tpl = await fs.readFile(path.resolve(repo, override), 'utf8');
  }
  return renderTemplate(tpl, vars);
}
