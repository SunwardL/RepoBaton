import type { Discovered } from './discover.ts';

export interface TemplateOptions {
  claude?: Discovered | null;
  codex?: Discovered | null;
  testCommand?: string;
  setupCommand?: string;
  baseBranch?: string;
  /** Put explicit absolute paths in the file even when the CLI is on PATH. */
  pinPaths?: boolean;
}

const q = (s: string): string => JSON.stringify(s);
const onPath = (d: Discovered): boolean => d.source === 'PATH';

/** A commented starter config. Detected CLI locations are written as explicit paths when not on PATH. */
export function configTemplate(o: TemplateOptions = {}): string {
  const pathLine = (d: Discovered | null | undefined, label: string): string => {
    if (d && (!onPath(d) || o.pinPaths)) return `    path: ${q(d.path)}   # detected (${d.version})`;
    if (d) return `    # path: ${q(d.path)}   # found on PATH (${d.version}); uncomment to pin`;
    return `    # path: "C:/path/to/${label}"   # ${label} was not found automatically; set this`;
  };
  return `# RepoBaton configuration. Every stage can use a different agent and model.
version: 1

# ---------------------------------------------------------------- agents
# Agent types:
#   claude-cli           local Claude Code CLI (uses your own login)
#   codex-cli            local Codex CLI (uses your own login)
#   openai-compatible    any OpenAI Chat Completions endpoint (OpenAI, Azure, DeepSeek, Ollama, vLLM, OpenRouter...)
#   anthropic-compatible any Anthropic Messages endpoint
#   command              any other CLI that takes a prompt and prints an answer
agents:
  claude:
    type: claude-cli
${pathLine(o.claude, 'claude')}
    # model: sonnet
    # effort: high
  codex:
    type: codex-cli
${pathLine(o.codex, 'codex')}
    # model: gpt-5-codex
    # effort: high

  # --- API agents: keys are read from environment variables, never stored here ---
  # gpt:
  #   type: openai-compatible
  #   baseUrl: https://api.openai.com/v1
  #   apiKeyEnv: OPENAI_API_KEY
  #   model: gpt-5
  #   allowShell: false        # let the model run commands when it has write access
  # claude-api:
  #   type: anthropic-compatible
  #   baseUrl: https://api.anthropic.com
  #   apiKeyEnv: ANTHROPIC_API_KEY
  #   model: claude-sonnet-4-5
  # local:
  #   type: openai-compatible
  #   baseUrl: http://localhost:11434/v1
  #   apiKeyEnv: OLLAMA_API_KEY
  #   model: qwen2.5-coder
  # aider:
  #   type: command
  #   command: aider
  #   args: ["--yes-always", "--no-auto-commits", "--model", "{{model}}", "--message-file", "-"]
  #   model: gpt-5

# ---------------------------------------------------------------- stages
stages:
  plan:
    agent: claude          # reads the repo and writes the plan + acceptance criteria
    # model: opus
    requireApproval: false # true = pause after planning until you approve
    timeoutSec: 900
  implement:
    agent: codex           # edits code inside an isolated git worktree
    # fallbackAgent: claude
    timeoutSec: 2400
  review:
    agent: claude          # fresh, read-only session; sees the diff and the test result
    timeoutSec: 900
  release:
    agent: claude          # drafts PR text, version bump and release notes (read-only)
    timeoutSec: 600
    # enabled: false

# ---------------------------------------------------------------- review/fix loop
loop:
  maxReviewRounds: 3         # implement -> test -> review rounds before asking a human
  blockOn: [blocker, major]  # issue severities that force another round
  testsMustPass: true
  resumeImplementerSession: true

test:
${o.testCommand ? `  command: ${q(o.testCommand)}` : '  # command: "npm test"   # auto-detected when omitted'}
${o.setupCommand ? `  setup: ${q(o.setupCommand)}` : '  # setup: "npm ci"       # runs once in the new worktree'}
  timeoutSec: 900

# ---------------------------------------------------------------- git & publishing
git:
  baseBranch: ${q(o.baseBranch ?? '')}   # empty = origin/HEAD, main or master
  branchPrefix: "repobaton/"
  worktreeDir: ".repobaton/worktrees"
  noVerify: false

publish:               # nothing leaves your machine unless you turn it on (or pass --push/--pr/...)
  push: false
  createPr: false
  draftPr: true
  merge: false         # squash-merge only the exact commit that was approved
  tag: false           # tag the merge commit (requires merge: true)
  tagPrefix: "v"
  remote: origin
`;
}
