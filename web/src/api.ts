// Types mirror what src/server/server.ts returns. Only the fields the UI uses are listed.

export type RunStatus =
  | 'running'
  | 'awaiting-plan-approval'
  | 'succeeded'
  | 'needs-human'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface Project {
  id: string;
  name: string;
  root: string;
  available: boolean;
  isGit: boolean;
  hasCommits: boolean;
  runs: number;
  needsAttention: number;
  busy: boolean;
  busyRunId: string | null;
}

export interface RunRow {
  id: string;
  task: string;
  status: RunStatus;
  stage?: string;
  error?: string;
  errorKind?: string;
  errorAgent?: string;
  createdAt: string;
  updatedAt: string;
  interruptedAt?: string;
  branch?: string;
  rounds: number;
  usage: { costUsd: number; inputTokens: number; outputTokens: number; calls: number };
  executing: boolean;
  hasWorktree: boolean;
  publishInFlight: string | null;
}

export interface Issue {
  severity: 'blocker' | 'major' | 'minor' | 'nit';
  file: string;
  description: string;
  suggestion: string;
}

export interface Round {
  n: number;
  implement?: { agent: string; sha: string; summary: string; changedFiles: string[]; durationMs: number };
  test?: { skipped: boolean; exitCode: number | null; durationMs: number; sha: string; outputTail: string };
  review?: { agent: string; sha: string; verdict: string; rawVerdict: string; summary: string; issues: Issue[]; overriddenBy?: string };
  decision?: 'approved' | 'changes-requested';
}

export interface StageSession {
  label: string;
  stage: StageName;
  round?: number;
  agent: string;
  agentType: string;
  sessionId?: string;
  persisted: boolean;
  cwd: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  noSessionReason?: string;
  sessionConfirmed?: boolean;
  /** Built by the server from how the CLI was actually launched; null when nothing safe can be offered. */
  resumeCommand?: string | null;
  startedAt: string;
  finishedAt?: string;
}

export interface Plan {
  summary: string;
  steps: { title: string; detail: string; files: string[] }[];
  acceptance: string[];
  risks: string[];
  test_hints: string[];
}

export interface RunDetail extends Omit<RunRow, 'rounds' | 'executing' | 'hasWorktree' | 'publishInFlight'> {
  rounds: Round[];
  workflow?: Partial<Record<StageName, { agent: string; model?: string }>>;
  plan?: Plan;
  planVersion?: number;
  planApproved?: boolean;
  worktree?: string;
  workspaceMode?: 'directory' | 'worktree';
  humanControl?: { startedAt: string; headBefore?: string; branchBefore?: string; dirtyBefore?: boolean };
  handoff?: { returnedAt: string; headBefore?: string; headAfter?: string; branchBefore?: string; branchAfter?: string; status?: string; reviewRequired?: boolean };
  base?: { branch: string; sha: string };
  release?: { version_bump: string; suggested_version: string; pr_title: string; pr_body: string; release_notes: string; risks: string[] };
  publish: { inFlight?: string; pushed?: boolean; prUrl?: string; merged?: boolean; tag?: string; tagPushed?: boolean; pendingTag?: string };
  sessions?: StageSession[];
  flow?: { workflow: CustomFlow };
  steps?: Record<string, { status: string; attempt: number; reason?: string; agent?: string; agentType?: string; sessionId?: string; headBefore?: string; headAfter?: string; branchBefore?: string; branchAfter?: string; dirtyBefore?: boolean; dirtyAfter?: boolean; readOnlyChanged?: boolean; manualCompletion?: { by: 'user'; at: string }; promptRef?: { attempt: number; truncated: boolean }; truncatedRefs?: string[]; approval?: { contentHash: string }; approvalPreview?: { content: string; contentHash: string } }>;
  flowConfigChanges?: string[];
}

export interface RunEvent {
  seq: number;
  ts: string;
  type: string;
  stage?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface MissingSecret {
  agent: string;
  variable: string;
  stages: string[];
}

export type StageName = 'plan' | 'implement' | 'review' | 'release';
export type TaskWorkflow = Partial<Record<StageName, { agent: string; model: string }>>;
export interface FlowStep {
  id: string;
  title: string;
  type: 'agent' | 'command' | 'commit' | 'approval';
  agent?: string;
  fallbackAgent?: string;
  model?: string;
  access?: 'read-only' | 'workspace-write';
  prompt?: string;
  run?: string;
  message?: string;
  show?: Array<{ kind: 'task' } | { kind: 'step-output'; step: string } | { kind: 'step-exit-code'; step: string } | { kind: 'file'; path: string }>;
  output?: { kind: 'text' };
  inputs?: Array<{ kind: 'task' } | { kind: 'step-output'; step: string } | { kind: 'step-exit-code'; step: string } | { kind: 'file'; path: string }>;
}
export interface CustomFlow {
  schema: 1;
  kind: 'custom';
  name: string;
  git: { mode: 'none' | 'explicit-step' | 'agent-managed'; publish?: { push?: boolean; createPr?: boolean; draftPr?: boolean; merge?: boolean; tag?: boolean; tagPrefix?: string; remote?: string }; release?: { title?: string; body?: string; version?: string; notes?: string } };
  steps: FlowStep[];
}
export type GlobalAgentType = 'codex-cli' | 'claude-cli' | 'openai-compatible' | 'anthropic-compatible' | 'command';

export interface CommandOptions {
  command: string;
  args: string[];
  promptVia: 'stdin' | 'arg';
  output: 'text' | 'json';
}

export interface GlobalAgent extends Partial<CommandOptions> {
  id: string;
  type: GlobalAgentType;
  path?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
}

export interface GlobalAgents {
  file: string;
  revision: string;
  agents: GlobalAgent[];
}

export interface ProjectSettings {
  file: string | null;
  revision: string;
  agents: Array<{ id: string; type: string }>;
  commandAgents: Array<CommandOptions & { id: string }>;
  stages: Array<{ name: StageName; agent: string; model: string; enabled: boolean }>;
  requireApproval: boolean;
  testCommand: string | null;
}

export interface SettingsUpdate {
  revision: string;
  stages?: Partial<Record<StageName, { agent?: string; model?: string }>>;
  requireApproval?: boolean;
  testCommand?: string | null;
  commands?: Record<string, CommandOptions>;
}

export interface AgentConnection {
  id: string;
  status: 'logged-in' | 'signed-out' | 'installed' | 'missing' | 'key-present' | 'key-missing' | 'found';
  version?: string;
  path?: string;
  variable?: string;
}

export class ApiError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const TOKEN_KEY = 'repobaton.token';

/** The token arrives once in the URL fragment (never sent to a server), then lives in sessionStorage. */
export function loadToken(): string {
  const m = /[#&]token=([^&]+)/.exec(window.location.hash);
  if (m) {
    sessionStorage.setItem(TOKEN_KEY, decodeURIComponent(m[1]));
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  return sessionStorage.getItem(TOKEN_KEY) ?? '';
}

let token = '';
export function initApi(): void {
  token = loadToken();
}
export function hasToken(): boolean {
  return token !== '';
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = json?.error ?? {};
    const { code, message, ...extra } = e;
    throw new ApiError(res.status, code ?? 'error', message ?? res.statusText, extra);
  }
  return json as T;
}

const p = (id: string) => `/projects/${encodeURIComponent(id)}`;

export const api = {
  health: () => call<{ ok: boolean; serverId: string }>('GET', '/health'),
  globalAgents: () => call<GlobalAgents>('GET', '/agents'),
  saveGlobalAgents: (revision: string, agents: GlobalAgent[]) => call<GlobalAgents>('PUT', '/agents', { revision, agents }),
  checkGlobalAgents: () => call<{ agents: AgentConnection[] }>('POST', '/agents/check', {}),
  previewAgentsYaml: (yaml: string) => call<{ agents: GlobalAgent[] }>('POST', '/agents/import', { yaml }),
  projects: () => call<{ projects: Project[] }>('GET', '/projects'),
  addProject: (path: string, name?: string) => call<{ project: Project }>('POST', '/projects', { path, name }),
  removeProject: (id: string) => call<{ ok: boolean }>('DELETE', p(id)),
  status: (id: string) => call<{ project: Project; missingSecrets: MissingSecret[]; configFile: string | null }>('GET', `${p(id)}/status`),
  settings: (id: string) => call<ProjectSettings>('GET', `${p(id)}/settings`),
  saveSettings: (id: string, update: SettingsUpdate) => call<ProjectSettings>('PUT', `${p(id)}/settings`, update),
  checkAgents: (id: string) => call<{ agents: AgentConnection[] }>('POST', `${p(id)}/settings/check`, {}),
  runs: (id: string) => call<{ runs: RunRow[] }>('GET', `${p(id)}/runs`),
  createRun: (id: string, task: string, workflow?: TaskWorkflow) => call<{ id: string }>('POST', `${p(id)}/runs`, { task, workflow }),
  createFlowRun: (id: string, task: string, flow: CustomFlow, confirmedWorkflowHash: string) => call<{ id: string }>('POST', `${p(id)}/runs`, { task, flow, confirmedWorkflowHash }),
  previewFlowStart: (id: string, flow: CustomFlow) => call<{ flow: CustomFlow; agents: Record<string, { type: string; command?: string; hasArguments: boolean }>; hash: string; shell: string; workspace: string; workspaceMode: 'worktree' | 'directory' }>('POST', `${p(id)}/flow/start-preview`, { flow }),
  flow: (id: string) => call<{ flow: CustomFlow | null; revision: string }>('GET', `${p(id)}/flow`),
  saveFlow: (id: string, revision: string, flow: CustomFlow) => call<{ flow: CustomFlow; revision: string }>('PUT', `${p(id)}/flow`, { revision, flow }),
  previewFlow: (id: string, yaml: string) => call<{ flow: CustomFlow; issues: Array<{ level: string; message: string }> }>('POST', `${p(id)}/flow/preview`, { yaml }),
  exportFlow: (id: string, flow: CustomFlow) => call<{ yaml: string }>('POST', `${p(id)}/flow/export`, { flow }),
  run: (id: string, run: string) => call<{ run: RunDetail; executing: boolean }>('GET', `${p(id)}/runs/${encodeURIComponent(run)}`),
  stepOutput: (id: string, run: string, step: string) => call<{ output: { status: string; text: string; truncated: boolean } }>('GET', `${p(id)}/runs/${encodeURIComponent(run)}/steps/${encodeURIComponent(step)}`),
  stepPrompt: (id: string, run: string, step: string) => call<{ prompt: string; attempt: number; truncated: boolean }>('GET', `${p(id)}/runs/${encodeURIComponent(run)}/steps/${encodeURIComponent(step)}/prompt`),
  approveFlow: (id: string, run: string, stepId: string, contentHash: string) => call<{ id: string }>('POST', `${p(id)}/runs/${encodeURIComponent(run)}/flow-approve`, { stepId, contentHash }),
  retryFlow: (id: string, run: string, stepId: string, stepStatus: string) => call<{ id: string }>('POST', `${p(id)}/runs/${encodeURIComponent(run)}/flow-retry`, { stepId, stepStatus }),
  completeUnknownFlow: (id: string, run: string, stepId: string, attempt: number, output: string, exitCode?: number) => call<{ id: string }>('POST', `${p(id)}/runs/${encodeURIComponent(run)}/flow-complete-unknown`, { stepId, attempt, output, exitCode }),
  recheckUnknownCommit: (id: string, run: string, stepId: string, attempt: number) => call<{ id: string }>('POST', `${p(id)}/runs/${encodeURIComponent(run)}/flow-recheck-commit`, { stepId, attempt }),
  previewChangedCommit: (id: string, run: string, stepId: string, attempt: number) => call<{ head: string; expectedTree: string; actualTree: string; diff: string; truncated: boolean; hash: string }>('POST', `${p(id)}/runs/${encodeURIComponent(run)}/flow-preview-changed-commit`, { stepId, attempt }),
  acceptChangedCommit: (id: string, run: string, stepId: string, attempt: number, hash: string) => call<{ id: string }>('POST', `${p(id)}/runs/${encodeURIComponent(run)}/flow-accept-changed-commit`, { stepId, attempt, hash }),
  reviewPublicationAgain: (id: string, run: string, expectedHash: string) => call<{ ok: boolean }>('POST', `${p(id)}/runs/${encodeURIComponent(run)}/flow-review-publication`, { expectedHash }),
  takeover: (id: string, run: string) => call<{ ok: boolean }>('POST', `${p(id)}/runs/${encodeURIComponent(run)}/takeover`, {}),
  returnControl: (id: string, run: string) => call<{ ok: boolean }>('POST', `${p(id)}/runs/${encodeURIComponent(run)}/return-control`, {}),
  openWorkspace: (id: string, run: string) => call<{ ok: boolean }>('POST', `${p(id)}/runs/${encodeURIComponent(run)}/open-workspace`, {}),
  events: (id: string, run: string, after: number) =>
    call<{ events: RunEvent[]; settled: boolean; status: RunStatus }>('GET', `${p(id)}/runs/${encodeURIComponent(run)}/events?after=${after}`),
  diff: (id: string, run: string) => call<{ diff: string; stat: string; truncated?: boolean; sha?: string }>('GET', `${p(id)}/runs/${encodeURIComponent(run)}/diff`),
  report: (id: string, run: string) => call<{ report: string | null }>('GET', `${p(id)}/runs/${encodeURIComponent(run)}/report`),
  approve: (id: string, run: string, planVersion: number) =>
    call<{ id: string }>('POST', `${p(id)}/runs/${encodeURIComponent(run)}/approve`, { expectStatus: 'awaiting-plan-approval', expectPlanVersion: planVersion }),
  reject: (id: string, run: string, feedback: string, planVersion: number) =>
    call<{ id: string }>('POST', `${p(id)}/runs/${encodeURIComponent(run)}/reject`, { feedback, expectStatus: 'awaiting-plan-approval', expectPlanVersion: planVersion }),
  resume: (id: string, run: string, expectStatus: RunStatus, extra: { moreRounds?: number; feedback?: string } = {}) =>
    call<{ id: string }>('POST', `${p(id)}/runs/${encodeURIComponent(run)}/resume`, { expectStatus, ...extra }),
  cancel: (id: string, run: string) => call<{ id: string }>('POST', `${p(id)}/runs/${encodeURIComponent(run)}/cancel`, {}),
  cleanupPreview: (id: string, run: string) => call<{ files: string[]; unreferencedHead?: string; confirmationHash: string }>('GET', `${p(id)}/runs/${encodeURIComponent(run)}/cleanup-preview`),
  cleanup: (id: string, run: string, discardHash?: string) => call<{ removedWorktree: boolean; keptBranch?: string }>('POST', `${p(id)}/runs/${encodeURIComponent(run)}/cleanup`, discardHash ? { discardHash } : {}),
  /** Ask the remote about an interrupted push/PR/merge/tag step. Evidence is only needed when the remote cannot settle it. */
  check: (id: string, run: string, body: { completed?: boolean; evidence?: { remoteSha?: string; prUrl?: string; mergeSha?: string } } = {}) =>
    call<{ ok: boolean; recorded: 'done' | 'not-done'; summary: string }>('POST', `${p(id)}/runs/${encodeURIComponent(run)}/check`, body),
};
