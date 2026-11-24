import type { Access, Config } from './types.ts';

/** Limits shared by validation, the editor and the executor. */
export const FLOW_SCHEMA = 1;
export const MAX_FLOW_STEPS = 20;
export const STEP_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export type FlowKind = 'builtin:four-stage' | 'custom';
export type StepType = 'agent' | 'command' | 'approval' | 'commit';

/** One vocabulary for step state, shared by the store and the executor. Finished successfully is `succeeded`. */
export const STEP_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'unknown', 'skipped'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** A parsed `{{ }}` reference. Only these four forms exist; anything else is a validation error. */
export type InputRef =
  | { kind: 'task' }
  | { kind: 'step-output'; step: string }
  | { kind: 'step-exit-code'; step: string }
  | { kind: 'file'; path: string };

/** The first version only executes `text`; `json` is reserved and rejected on save. */
export type OutputSpec =
  | { kind: 'text' }
  | { kind: 'json'; schema: object; as?: string };

export interface StepBase {
  id: string;
  title: string;
  type: StepType;
}

export interface AgentStep extends StepBase {
  type: 'agent';
  agent: string;
  model?: string;
  fallbackAgent?: string;
  access: Access;
  prompt: string;
  inputs?: InputRef[];
  timeoutSec?: number;
  output: OutputSpec;
}

export interface CommandStep extends StepBase {
  type: 'command';
  run: string;
  inputs?: InputRef[];
  timeoutSec?: number;
  okExitCodes?: number[];
  output: OutputSpec;
}

export interface ApprovalStep extends StepBase {
  type: 'approval';
  show: InputRef[];
  message?: string;
}

export interface CommitStep extends StepBase {
  type: 'commit';
  message: string;
  paths?: string[];
}

export type Step = AgentStep | CommandStep | ApprovalStep | CommitStep;

export interface GitPolicy {
  mode: 'none' | 'explicit-step' | 'agent-managed';
  /** Reuses the existing publish options; only valid with `explicit-step`. */
  publish?: Partial<Config['publish']>;
}

export interface Workflow {
  schema: typeof FLOW_SCHEMA;
  kind: FlowKind;
  name: string;
  steps: Step[];
  git: GitPolicy;
}

export interface FlowIssue {
  level: 'error' | 'warning';
  /** Step id the issue belongs to, or undefined for flow-level problems. */
  step?: string;
  field?: string;
  message: string;
}
