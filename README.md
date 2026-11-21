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

## Local web UI (`repobaton ui`)

```
npm install
npm run install:web     # once: installs the UI's dependencies
npm run build           # server + web UI
node bin/repobaton.mjs ui [--port <n>] [--no-open] [--project <dir>]...
```

It prints a URL such as `http://127.0.0.1:8787/#token=...` and opens it. The server listens on `127.0.0.1` only. The token is random per launch and lives in the URL fragment, so it is never sent over the network; a page without it, a foreign `Host` or a foreign `Origin` is refused. If the page says it needs reopening, use the full URL from the terminal again.

From the UI you can add projects, create a task, watch live progress, approve a plan or reject it with comments, continue, cancel, and read the diff, release draft and report.

### Environment variables and secrets

The server reads API keys from the environment of the process that started `repobaton ui` (for example `OPENAI_API_KEY`, or whatever `apiKeyEnv` names). Set them before you start it:

```
set OPENAI_API_KEY=...
node bin\repobaton.mjs ui
```

Nothing stores or writes keys. If an enabled stage uses an API agent whose variable is not set, the project page names the agent and the variable (not a value), and new runs, approvals and resumes are refused until you restart with it set. Key values never appear in API responses, the UI or `server.log`. CLI agents (`claude`, `codex`) use their own logins.

Other variables: `REPOBATON_HOME` overrides the per-user data folder (default `%APPDATA%\repobaton`, holding `projects.json` and `server.log`); `REPOBATON_CLAUDE_PATH` and `REPOBATON_CODEX_PATH` as below.

### Several projects

- The project list is a small file, `projects.json`, in the per-user folder. It survives restarts.
- Each project reads its own `repobaton.yaml` on every request. The config is never written back.
- A repository's identity is `git rev-parse --git-common-dir`, resolved to a real path (relative paths, drive-letter and folder casing, 8.3 short names and links all collapse to one). The main folder, any subfolder and every linked worktree are the **same project**.
- **One execution at a time per repository.** Two different repositories can each run a task at the same time. Anything that starts executing (new task, approve, reject, resume) takes the repository's slot before doing any work and gives it back when the run finishes or stops for approval. If it is taken you get a "busy" message at once; nothing is queued. A duplicate or stale approval (the run already moved on) is refused and cannot start a second execution.

### Interrupted runs and recovery

When the server stops while a run is executing (closed terminal, crash, reboot), the run stays `running` on disk. The next time the project is loaded the server marks it **Interrupted** (distinct from **Failed** and **Awaiting approval**) and offers **Continue**. The worktree, branch, commits, plan, approvals and report are kept, and Continue resumes from the last checkpoint rather than from scratch.

- Only runs this server can prove it owned are touched: each server run records the server's pid and start time. A run started by the plain CLI has no owner and is never marked interrupted. If the old pid is still alive, or its liveness cannot be checked, the run is left alone.
- Push, PR, merge and tag are recorded as "in flight" before they happen. If a run was interrupted in the middle of one, nobody can tell whether it happened, so Continue is blocked and nothing is repeated. Use "Check the remote" on the run page (or `repobaton check <run>` from a standalone CLI): the remote is asked read-only (branch commit, PR state and merge commit, tag target) and only what it confirms is recorded, such as the PR URL, the merge commit or the tag. "Completed" is accepted without remote proof only with matching evidence (the pushed commit, a PR URL, a full merge SHA); "did not happen" is accepted only when the remote shows it did not. The check always targets the place the operation wrote to, recorded when it started: the remote name and its **push** address without credentials (the address `git push` uses, which can differ from the fetch address), and for pull requests the GitHub repository (`github.com/owner/name`). `gh` is always told that repository explicitly instead of guessing it from the directory. If the push address or repository now differs, or the remote was removed, nothing is queried and nothing can be recorded, even with evidence. A branch or tag missing from the fetch address proves nothing; only the push address is asked.
  Supported: one push address per remote (`pushurl`/`insteadOf` are honoured), and for PR steps a github.com address (https, ssh or scp-style). A remote with several push addresses, or a PR step on another host, stops before anything is written, with a message saying so.
  Tagging: the merge commit is fetched from the push address (the repository the PR was merged in, which can differ from the fetch address) and must be on its base branch before it is tagged. If that repository has no such branch or does not contain the commit, nothing is tagged and the run pauses with a message saying so. The same holds when the remote answers but shows something different (a branch, PR or tag at another commit): that conflict is never overridden by hand, fix it on the remote and check again. If the remote merely cannot be reached or does not answer clearly, the run stays paused, and evidence you supply can still settle it. Runs interrupted before this recording existed have no recorded remote and can only be settled with evidence.
- Approving or rejecting a plan names the plan version you were looking at. If the plan changed since (for example it was rejected in another window and a new one is pending), the request is refused with a "refresh" message and nothing starts.
- Resuming a run that already has an approved commit continues from release/publish with that exact commit; it never starts a new implement round, even when the round budget is used up. A saved worktree whose setup did not finish gets its setup completed.
- **Clean up** removes only the worktree folder of the run you select (the branch and commits stay). It takes the repository's execution slot like resume and approve do, so it is refused while anything else is executing in that repository, and nothing can start using the worktree while it is being removed.
- Credentials are masked before upstream or git/gh error text reaches run state, events, reports, logs, the API or the UI. Agent names, environment variable names and error categories stay readable.

**Do not drive the same run from a standalone CLI while the UI server manages it.** The server owns the run's state; use either the UI or the CLI for a given run.

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
npm run install:web
npm run typecheck      # server + web
npm test
npm run build          # tsc -> dist, vite -> web/dist, copied to dist/web
```

The UI is in `web/` (Vite, React, TypeScript). For UI work run `npm --prefix web run dev` with `REPOBATON_URL` pointing at a running `repobaton ui`.

Limits: single user, local only. There is no queueing of Git operations, global scheduler, concurrency setting, cross-process lock or key storage.
