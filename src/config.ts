import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { AGENT_TYPES, STAGE_NAMES, type AgentConfig, type Config, type StageName } from './types.ts';
import { registerSecret } from './redact.ts';
import { exists } from './util.ts';

export const CONFIG_FILENAMES = ['repobaton.yaml', 'repobaton.yml', '.repobaton.yaml'];

export function defaultConfig(): Config {
  return {
    version: 1,
    agents: {
      claude: { type: 'claude-cli' },
      codex: { type: 'codex-cli' },
    },
    stages: {
      plan: { agent: 'claude', timeoutSec: 900, retries: 1, requireApproval: false },
      implement: { agent: 'codex', timeoutSec: 2400, retries: 1 },
      review: { agent: 'claude', timeoutSec: 900, retries: 1 },
      release: { agent: 'claude', timeoutSec: 600, retries: 1 },
    },
    loop: {
      maxReviewRounds: 3,
      blockOn: ['blocker', 'major'],
      testsMustPass: true,
      resumeImplementerSession: true,
    },
    test: { timeoutSec: 900 },
    git: {
      baseBranch: '',
      branchPrefix: 'repobaton/',
      worktreeDir: '.repobaton/worktrees',
      noVerify: false,
    },
    publish: {
      push: false,
      createPr: false,
      draftPr: true,
      merge: false,
      tag: false,
      tagPrefix: 'v',
      remote: 'origin',
    },
    limits: { maxDiffChars: 120_000 },
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : (over as T));
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined || v === null) continue;
    out[k] = isObj(out[k]) && isObj(v) ? merge(out[k], v) : v;
  }
  return out as T;
}

export class ConfigError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`Invalid config:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

export function validateConfig(cfg: Config): string[] {
  const p: string[] = [];
  const agentIds = Object.keys(cfg.agents);
  if (agentIds.length === 0) p.push('agents: define at least one agent');
  for (const [id, a] of Object.entries(cfg.agents)) {
    if (!AGENT_TYPES.includes(a.type)) {
      p.push(`agents.${id}.type: "${String(a.type)}" is not one of ${AGENT_TYPES.join(', ')}`);
      continue;
    }
    if ((a.type === 'openai-compatible' || a.type === 'anthropic-compatible') && !a.baseUrl && !a.model) {
      // baseUrl has a sane default; model is required because there is no CLI default.
      p.push(`agents.${id}.model: required for ${a.type}`);
    }
    if (a.type === 'command' && !a.command) p.push(`agents.${id}.command: required for type "command"`);
    if (a.apiKey) p.push(`agents.${id}.apiKey: (warning) prefer apiKeyEnv so the key stays out of the file`);
  }
  for (const s of STAGE_NAMES) {
    const st = cfg.stages[s];
    if (!st) {
      p.push(`stages.${s}: missing`);
      continue;
    }
    if (st.enabled === false) continue;
    if (!cfg.agents[st.agent]) p.push(`stages.${s}.agent: unknown agent "${st.agent}"`);
    if (st.fallbackAgent && !cfg.agents[st.fallbackAgent]) {
      p.push(`stages.${s}.fallbackAgent: unknown agent "${st.fallbackAgent}"`);
    }
  }
  if (!(cfg.loop.maxReviewRounds >= 1)) p.push('loop.maxReviewRounds: must be >= 1');
  for (const sev of cfg.loop.blockOn) {
    if (!['blocker', 'major', 'minor', 'nit'].includes(sev)) p.push(`loop.blockOn: unknown severity "${sev}"`);
  }
  if (cfg.publish.merge && !cfg.publish.createPr) p.push('publish.merge requires publish.createPr');
  if (cfg.publish.createPr && !cfg.publish.push) p.push('publish.createPr requires publish.push');
  return p;
}

/** Warnings are reported but do not block a run. */
export function splitProblems(problems: string[]): { errors: string[]; warnings: string[] } {
  const warnings = problems.filter((x) => x.includes('(warning)'));
  return { errors: problems.filter((x) => !x.includes('(warning)')), warnings };
}

export async function findConfig(repo: string): Promise<string | null> {
  for (const n of CONFIG_FILENAMES) {
    const p = path.join(repo, n);
    if (await exists(p)) return p;
  }
  return null;
}

export interface LoadedConfig {
  config: Config;
  file: string | null;
  warnings: string[];
}

export async function loadConfig(repo: string, explicit?: string): Promise<LoadedConfig> {
  const file = explicit ? path.resolve(explicit) : await findConfig(repo);
  let raw: unknown = {};
  if (file) {
    if (!(await exists(file))) throw new ConfigError([`config file not found: ${file}`]);
    try {
      raw = YAML.parse(await fs.readFile(file, 'utf8')) ?? {};
    } catch (e) {
      throw new ConfigError([`${file}: ${(e as Error).message}`]);
    }
    if (!isObj(raw)) throw new ConfigError([`${file}: top level must be a mapping`]);
  }
  const base = defaultConfig();
  const user = raw as Record<string, unknown>;
  // User-defined agents replace the default pair rather than merging into it, so
  // a config that only defines "writer" does not drag in a dangling "claude".
  if (isObj(user.agents)) base.agents = {};
  const config = merge(base, user);
  const { errors, warnings } = splitProblems(validateConfig(config));
  if (errors.length) throw new ConfigError(errors);
  // An inline apiKey is a secret value too: make sure no error text can echo it back.
  for (const a of Object.values(config.agents)) registerSecret(a.apiKey);
  return { config, file, warnings };
}

export function stageAgentId(cfg: Config, stage: StageName): string {
  return cfg.stages[stage].agent;
}

export function resolveApiKey(a: AgentConfig, defaultEnv: string): string | undefined {
  if (a.apiKeyEnv) return process.env[a.apiKeyEnv];
  return a.apiKey ?? process.env[defaultEnv];
}

export function configToYaml(cfg: Config, header = ''): string {
  return header + YAML.stringify(cfg, { lineWidth: 100 });
}
