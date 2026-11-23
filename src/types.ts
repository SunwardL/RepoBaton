import { redactDiagnostic } from './redact.ts';
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

export type TaskWorkflow = Partial<Record<StageName, { agent: string; model?: string }>>;

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
  /**
   * Called as soon as the agent's native session id is known (before the call ends), so the id
   * survives a failure, cancellation, timeout or a server stop in the middle of the call.
   */
  onSession?: (sessionId: string, confirmed?: boolean) => void;
  /**
   * Called once the executable that will run is known, before the call starts, so a continue command
   * can use the same one even if the call then fails, times out or the server stops.
   */
  onLaunch?: (cli: { path: string; command?: string; prefixArgs?: string[] }) => void;
}

export interface AgentResult {
  text: string;
  structured?: unknown;
  sessionId?: string;
  /** The executable that ran, so a continue command can use the same one. CLI agents only. */
  cli?: { path: string; command?: string; prefixArgs?: string[] };
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
  /** The native session id the call had already obtained when it failed, if any. */
  sessionId?: string;
  /** The executable that was running, if the call got that far. */
  cli?: { path: string; command?: string; prefixArgs?: string[] };
  /**
   * False when the id was chosen by RepoBaton before the call and the CLI never confirmed it, so the
   * CLI may not have saved that session (a call stopped very early). Undefined when there is no id.
   */
  sessionConfirmed?: boolean;
  constructor(message: string, retryable = true, kind: AgentErrorKind = 'unknown', sessionId?: string, sessionConfirmed?: boolean) {
    super(redactDiagnostic(message));
    this.name = 'AgentError';
    this.retryable = retryable;
    this.kind = kind;
    this.sessionId = sessionId;
    this.sessionConfirmed = sessionConfirmed;
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

/**
 * One call of an agent for one stage. Lets the task page show where a native Codex or Claude Code
 * session lives and how to continue it. Older runs have none: the page then says the native
 * session cannot be located instead of guessing.
 */
export interface StageSession {
  /** Matches the artifact label, e.g. "plan", "implement-r2", "review-r1", "release". */
  label: string;
  stage: StageName;
  /** Round number for implement and review; implement retries in the same round share one session. */
  round?: number;
  agent: string;
  agentType: AgentType;
  /** Only agents that really report a session id have one (third-party APIs do not). */
  sessionId?: string;
  /** Whether the agent was asked to keep the session on disk. */
  persisted: boolean;
  cwd: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  /**
   * False when the id was assigned before the call and the CLI never confirmed it: a call stopped very
   * early may have left no session behind, so a continue command could fail. Undefined means confirmed
   * (or an older record).
   */
  sessionConfirmed?: boolean;
  /** Why there is no session id (the call failed before the agent reported one, or the agent has none). */
  noSessionReason?: string;
  /** How the CLI that created this session was launched; older records have none. */
  cli?: { path: string; command?: string; prefixArgs?: string[] };
  startedAt: string;
  finishedAt?: string;
}

export type RunStatus =
  | 'running'
  | 'awaiting-plan-approval'
  | 'succeeded'
  | 'needs-human'
  | 'failed'
  | 'cancelled'
  /** The server that was executing this run is gone and nothing is executing it now. */
  | 'interrupted';

export interface PublishState {
  pushed?: boolean;
  prUrl?: string;
  merged?: boolean;
  mergeSha?: string;
  tag?: string;
  tagPushed?: boolean;
  /**
   * Set just before an external side effect (push, PR, merge, tag) and cleared once its
   * result is recorded. If a run is interrupted while this is set, nobody can tell whether
   * the operation happened, so recovery stops and asks a human to check.
   */
  inFlight?: 'push' | 'pr' | 'merge' | 'tag';
  /** The tag name, recorded before the tag operation starts, so recovery knows which tag to look for. */
  pendingTag?: string;
  /**
   * Where the in-flight operation actually writes, so recovery checks that same place even if
   * the configuration changes later: the remote name, its push address without credentials
   * (the fetch address can differ), and for PR steps the GitHub repository. Runs without it
   * (older records) are never matched against the current configuration.
   */
  inFlightTarget?: { remote: string; url: string; githubRepo?: string };
}

export interface RunState {
  id: string;
  task: string;
  workflow?: TaskWorkflow;
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
  /**
   * Set only when a local server launches the run. It names the server instance, so a later
   * server can tell "mine, still executing", "an earlier server's, now gone" and "no server
   * involved at all" (a standalone CLI run) apart.
   */
  owner?: { serverId: string; pid: number; startedAt: string };
  /** When the run was marked interrupted. */
  interruptedAt?: string;
  setupDone?: boolean;
  plan?: Plan;
  planAgent?: string;
  planApproved?: boolean;
  /** Increments each time a new plan is stored; approve and reject must name the version the user saw. */
  planVersion?: number;
  extraRounds?: number;
  /** Human guidance injected into the next implement round. */
  pendingFeedback?: string;
  /** Human feedback on the plan; consumed by the next planning attempt only. */
  planFeedback?: string;
  rounds: Round[];
  /** Native agent sessions per stage call, in call order. */
  sessions?: StageSession[];
  release?: ReleaseDraft;
  publish: PublishState;
  usage: { costUsd: number; inputTokens: number; outputTokens: number; calls: number };
}
