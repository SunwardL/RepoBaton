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
  base?: { branch: string; sha: string };
  release?: { version_bump: string; suggested_version: string; pr_title: string; pr_body: string; release_notes: string; risks: string[] };
  publish: { inFlight?: string; pushed?: boolean; prUrl?: string };
  sessions?: StageSession[];
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
  run: (id: string, run: string) => call<{ run: RunDetail; executing: boolean }>('GET', `${p(id)}/runs/${encodeURIComponent(run)}`),
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
  cleanup: (id: string, run: string) => call<{ removedWorktree: boolean; keptBranch?: string }>('POST', `${p(id)}/runs/${encodeURIComponent(run)}/cleanup`, {}),
  /** Ask the remote about an interrupted push/PR/merge/tag step. Evidence is only needed when the remote cannot settle it. */
  check: (id: string, run: string, body: { completed?: boolean; evidence?: { remoteSha?: string; prUrl?: string; mergeSha?: string } } = {}) =>
    call<{ ok: boolean; recorded: 'done' | 'not-done'; summary: string }>('POST', `${p(id)}/runs/${encodeURIComponent(run)}/check`, body),
};
