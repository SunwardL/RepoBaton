import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ConfigError, defaultConfig, loadConfig } from './config.ts';
import { userDataDir } from './projects.ts';
import { REDACTED, redactDiagnostic } from './redact.ts';
import type { AgentConfig, Config } from './types.ts';
import { writeFileAtomic } from './util.ts';

const CUSTOM_TYPES = ['openai-compatible', 'anthropic-compatible', 'command'];
const BUILT_IN = { codex: 'codex-cli', claude: 'claude-cli' } as const;

function textField(value: unknown, label: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 2048 || /[\r\n\0]/.test(value) || value.includes('[redacted]')) {
    throw new ConfigError([`${label}: invalid value`]);
  }
  return value.trim() || undefined;
}

const SECRET_FLAG = /^--(?:api[-_]?key|(?:access[-_]?)?token|password|secret|authorization)(=|$)/i;

export function redactCommandArgs(args: string[]): string[] {
  return args.map((arg, i) => {
    if (i > 0 && SECRET_FLAG.exec(args[i - 1])?.[1] === '') return REDACTED;
    const assignment = SECRET_FLAG.exec(arg);
    if (assignment?.[1]) return assignment[0] + REDACTED;
    return redactDiagnostic(arg);
  });
}

export function commandFields(data: Record<string, unknown>, label: string) {
  const command = textField(data.command, `${label}.command`);
  const args = data.args ?? [];
  if (!command || !Array.isArray(args) || args.length > 64 ||
      args.some((arg) => typeof arg !== 'string' || arg.length > 2048 || /[\r\n\0]/.test(arg))) {
    throw new ConfigError([`${label}: enter an executable and up to 64 arguments`]);
  }
  if (redactDiagnostic(command) !== command ||
      redactCommandArgs(args).some((value, index) => value !== args[index] || value.includes(REDACTED))) {
    throw new ConfigError([`${label}: remove secrets from the command and arguments; use environment variables instead`]);
  }
  const promptVia = data.promptVia ?? 'stdin';
  const output = data.output ?? 'text';
  if ((promptVia !== 'stdin' && promptVia !== 'arg') || (output !== 'text' && output !== 'json')) {
    throw new ConfigError([`${label}: invalid prompt or output mode`]);
  }
  return { command, args: args as string[], promptVia, output } as const;
}

function parseAgents(value: unknown): Config['agents'] {
  if (!Array.isArray(value)) throw new ConfigError(['agents: expected a list']);
  const agents: Config['agents'] = defaultConfig().agents;
  const seen = new Set<string>();
  for (const input of value) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConfigError(['agents: invalid entry']);
    const data = input as Record<string, unknown>;
    const id = textField(data.id, 'agent ID');
    if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(id) || Object.hasOwn(Object.prototype, id) || seen.has(id)) {
      throw new ConfigError(['agents: use unique IDs consisting of letters, digits, hyphens or underscores']);
    }
    seen.add(id);
    const builtIn = Object.hasOwn(BUILT_IN, id) ? BUILT_IN[id as keyof typeof BUILT_IN] : undefined;
    const type = builtIn ?? data.type;
    if ((builtIn && data.type !== builtIn) || typeof type !== 'string' || (!builtIn && !CUSTOM_TYPES.includes(type))) {
      throw new ConfigError([`${id}: unsupported agent type`]);
    }
    const model = textField(data.model, `${id}.model`);
    if (builtIn) {
      agents[id] = { type: builtIn, model, path: textField(data.path, `${id}.path`) };
      continue;
    }
    if (type === 'command') {
      agents[id] = { type, model, ...commandFields(data, id) };
      continue;
    }

    const baseUrl = textField(data.baseUrl, `${id}.baseUrl`);
    const url = baseUrl ? URL.parse(baseUrl) : null;
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new ConfigError([`${id}: enter an HTTP(S) base URL without credentials, a query, or a fragment`]);
    }
    const apiKeyEnv = textField(data.apiKeyEnv, `${id}.apiKeyEnv`);
    if (!model || !apiKeyEnv || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
      throw new ConfigError([`${id}: a model and a valid environment variable name are required`]);
    }
    agents[id] = { type: type as AgentConfig['type'], model, baseUrl, apiKeyEnv };
  }
  return agents;
}

export async function readGlobalAgents(file = path.join(userDataDir(), 'agents.json')) {
  const source = await fs.readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return '';
    throw err;
  });
  let entries: unknown = [];
  if (source) {
    try {
      entries = JSON.parse(source).agents;
    } catch {
      throw new ConfigError(['the global agent settings file could not be read']);
    }
  }
  return { file, revision: createHash('sha256').update(source).digest('hex'), agents: parseAgents(entries) };
}

export function agentEntries(agents: Config['agents']) {
  return Object.entries(agents).map(([id, a]) => ({
    id, type: a.type, model: a.model, path: a.path, baseUrl: a.baseUrl, apiKeyEnv: a.apiKeyEnv,
    command: a.command, args: a.args, promptVia: a.promptVia, output: a.output,
  }));
}

/** Import only connection fields that the global form can edit. The result is a preview. */
export function importAgentYaml(source: unknown) {
  if (typeof source !== 'string' || !source.trim()) throw new ConfigError(['choose a nonempty YAML file']);
  let yaml: unknown;
  try {
    yaml = YAML.parse(source);
  } catch {
    throw new ConfigError(['the YAML file could not be parsed']);
  }
  const agents = (yaml as { agents?: unknown } | null)?.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents) || !Object.keys(agents).length) {
    throw new ConfigError(['the YAML file must have an agents mapping']);
  }
  const entries = Object.entries(agents).map(([id, data]) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ConfigError([`${id}: expected agent settings`]);
    const entry = { ...data, id } as Record<string, unknown>;
    if (entry.type === 'openai-compatible' || entry.type === 'anthropic-compatible') {
      const openAI = entry.type === 'openai-compatible';
      entry.apiKeyEnv ??= openAI ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
      entry.baseUrl ??= openAI ? 'https://api.openai.com/v1' : 'https://api.anthropic.com';
    }
    return entry;
  });
  const parsed = parseAgents(entries);
  return agentEntries(parsed).filter((agent) => Object.hasOwn(agents, agent.id));
}

export async function saveGlobalAgents(file: string | undefined, revision: unknown, entries: unknown) {
  const current = await readGlobalAgents(file);
  if (revision !== current.revision) return null;
  const agents = parseAgents(entries);
  const source = JSON.stringify({ agents: agentEntries(agents) }, null, 2) + '\n';
  await writeFileAtomic(current.file, source, 0o600);
  return readGlobalAgents(current.file);
}

export async function loadLocalConfig(repo: string, explicit?: string) {
  return loadConfig(repo, explicit, (await readGlobalAgents()).agents);
}
