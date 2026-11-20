export type StageName = 'plan' | 'implement' | 'review' | 'release';
export type Access = 'read-only' | 'workspace-write';
export type AgentType =
  | 'claude-cli'
  | 'codex-cli'
  | 'openai-compatible'
  | 'anthropic-compatible'
  | 'command';

export const STAGE_NAMES: StageName[] = ['plan', 'implement', 'review', 'release'];
export const AGENT_TYPES: AgentType[] = [
  'claude-cli',
  'codex-cli',
  'openai-compatible',
  'anthropic-compatible',
  'command',
];

export interface AgentConfig {
  type: AgentType;
  /** CLI agents: explicit executable path. Omit for auto-discovery. */
  path?: string;
  model?: string;
  effort?: string;
  /** Extra raw CLI arguments appended to the agent invocation. */
  extraArgs?: string[];
  env?: Record<string, string>;
  // --- API agents ---
  baseUrl?: string;
  apiKeyEnv?: string;
  /** Discouraged: prefer apiKeyEnv so secrets stay out of the config file. */
  apiKey?: string;
  headers?: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
  /** Max tool-call round trips for API agents. */
  maxSteps?: number;
  /** API agents: allow a run_command tool when the stage has write access. */
  allowShell?: boolean;
  // --- claude-cli ---
  readOnlyTools?: string[];
  writeTools?: string[];
  maxBudgetUsd?: number;
  // --- command (generic third-party CLI) ---
  command?: string;
  args?: string[];
  promptVia?: 'stdin' | 'arg';
  output?: 'text' | 'json';
}

export interface StageConfig {
  agent: string;
  model?: string;
  effort?: string;
  enabled?: boolean;
  timeoutSec?: number;
  retries?: number;
  fallbackAgent?: string;
  /** Custom prompt template file, relative to the repository root. */
  promptFile?: string;
  /** plan stage: pause for human approval before implementing. */
  requireApproval?: boolean;
}

export interface Config {
  version: 1;
  agents: Record<string, AgentConfig>;
  stages: Record<StageName, StageConfig>;
  loop: {
    maxReviewRounds: number;
    blockOn: string[];
    testsMustPass: boolean;
    resumeImplementerSession: boolean;
  };
  test: { command?: string; setup?: string; timeoutSec: number };
  git: {
    baseBranch: string;
    branchPrefix: string;
    worktreeDir: string;
    noVerify: boolean;
    authorName?: string;
    authorEmail?: string;
  };
  publish: {
    push: boolean;
    createPr: boolean;
    draftPr: boolean;
    merge: boolean;
    tag: boolean;
    tagPrefix: string;
    remote: string;
  };
  limits: { maxDiffChars: number };
}

export interface AgentRunRequest {
  stage: StageName;
  prompt: string;
  cwd: string;
  access: Access;
  /** JSON schema the final answer must satisfy. */
  schema?: Record<string, unknown>;
  model?: string;
  effort?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Continue an earlier session (CLI agents only). */
  sessionId?: string;
  /** Keep the session on disk so it can be resumed later. */
  persist?: boolean;
  onProgress?: (line: string) => void;
}

export interface AgentResult {
  text: string;
  structured?: unknown;
  sessionId?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  /** Raw transcript, stored as an artifact for debugging. */
  raw?: string;
}

export interface Agent {
  id: string;
  type: AgentType;
  describe(): string;
  check(): Promise<{ ok: boolean; detail: string }>;
  run(req: AgentRunRequest): Promise<AgentResult>;
}

/** Why an agent call failed. The UI maps these to actionable messages. */
export type AgentErrorKind =
  | 'auth' // credentials missing or rejected
  | 'rate-limit'
  | 'network' // unreachable, DNS, TLS, connection reset
  | 'timeout'
  | 'not-found' // CLI missing, model or endpoint unknown
  | 'bad-output' // answered, but not in the required shape
  | 'cancelled'
  | 'unknown';

export class AgentError extends Error {
  retryable: boolean;
  kind: AgentErrorKind;
  constructor(message: string, retryable = true, kind: AgentErrorKind = 'unknown') {
    super(message);
    this.name = 'AgentError';
    this.retryable = retryable;
    this.kind = kind;
  }
}

// ---- Run state ----

export interface PlanStep {
  title: string;
  detail: string;
  files: string[];
}
export interface Plan {
  summary: string;
  steps: PlanStep[];
  acceptance: string[];
  risks: string[];
  test_hints: string[];
}

export interface ReviewIssue {
  severity: 'blocker' | 'major' | 'minor' | 'nit';
  file: string;
  description: string;
  suggestion: string;
}
export interface ReviewResult {
  verdict: 'approve' | 'request_changes';
  summary: string;
  issues: ReviewIssue[];
}

export interface ReleaseDraft {
  version_bump: 'major' | 'minor' | 'patch' | 'none';
  suggested_version: string;
  pr_title: string;
  pr_body: string;
  release_notes: string;
  risks: string[];
}

export interface Round {
  n: number;
  implement?: {
    agent: string;
    sha: string;
    summary: string;
    changedFiles: string[];
    durationMs: number;
    sessionId?: string;
  };
  test?: {
    skipped: boolean;
    exitCode: number | null;
    durationMs: number;
    sha: string;
    outputTail: string;
  };
  review?: {
    agent: string;
    sha: string;
    verdict: 'approve' | 'request_changes';
    rawVerdict: 'approve' | 'request_changes';
    summary: string;
    issues: ReviewIssue[];
    overriddenBy?: string;
  };
  decision?: 'approved' | 'changes-requested';
}

export type RunStatus =
  | 'running'
  | 'awaiting-plan-approval'
  | 'succeeded'
  | 'needs-human'
  | 'failed'
  | 'cancelled';

export interface PublishState {
  pushed?: boolean;
  prUrl?: string;
  merged?: boolean;
  mergeSha?: string;
  tag?: string;
  tagPushed?: boolean;
}

export interface RunState {
  id: string;
  task: string;
  repo: string;
  status: RunStatus;
  stage?: string;
  error?: string;
  /** When an agent failure ended the run: what kind, and which agent. */
  errorKind?: AgentErrorKind;
  errorAgent?: string;
  createdAt: string;
  updatedAt: string;
  base?: { branch: string; sha: string };
  branch?: string;
  worktree?: string;
  setupDone?: boolean;
  plan?: Plan;
  planAgent?: string;
  planApproved?: boolean;
  extraRounds?: number;
  /** Human guidance injected into the next implement round. */
  pendingFeedback?: string;
  /** Human feedback on the plan; consumed by the next planning attempt only. */
  planFeedback?: string;
  rounds: Round[];
  release?: ReleaseDraft;
  publish: PublishState;
  usage: { costUsd: number; inputTokens: number; outputTokens: number; calls: number };
}
