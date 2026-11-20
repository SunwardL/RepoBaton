# RepoBaton

Let Codex, Claude Code and OpenAI/Anthropic-compatible models work on one task as planner, implementer, reviewer and release manager. Stages hand work over through files and git commits; the orchestrator, not an AI, decides the next step.

## Quick start

```
npm install
node bin/repobaton.mjs doctor      # check CLIs, API keys, git, gh
node bin/repobaton.mjs init        # detect CLIs and write repobaton.yaml
node bin/repobaton.mjs run "your task" -v
```

Flow: plan -> implement (isolated git worktree) -> test -> independent review -> fix loop -> release draft. Nothing is pushed unless you enable publish steps (--push, --pr, --merge, --tag).

## Finding the CLIs

For claude and codex the path is resolved in this order:

1. `agents.<id>.path` in repobaton.yaml
2. environment variable `REPOBATON_CLAUDE_PATH` / `REPOBATON_CODEX_PATH`
3. PATH
4. known install locations (for Codex this includes `~/.codex/plugins/.plugin-appserver`, preferring installs that ship the code-mode host)

An explicit path that does not run is an error; it never silently falls back.

## Per-stage agents and models

Each stage picks an agent and optionally a model and effort. Command-line overrides: `--plan`, `--implement`, `--review`, `--release` and the matching `--*-model` flags. Loop control: `loop.maxReviewRounds`, `loop.blockOn`, `loop.testsMustPass`, and `--max-rounds`.

## Agent types

- `claude-cli`, `codex-cli`: use the local login of each CLI.
- `openai-compatible`: Chat Completions endpoint, set `baseUrl`, `model`, `apiKeyEnv`.
- `anthropic-compatible`: Messages endpoint, same fields.
- `command`: any other CLI that reads a prompt and prints an answer.

API agents get sandboxed file tools limited to the worktree. Read-only stages get no write tool and no shell.

## Safety

- Review is read-only and runs in a fresh session; the orchestrator overrides an approve if tests fail or blocking issues exist.
- Merge uses the exact approved commit.

## Development

```
npm run typecheck
npm test
npm run build
```
