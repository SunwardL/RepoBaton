import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ConfigError, CONFIG_FILENAMES, loadConfig, resolveApiKey, resolveConfig, type LoadedConfig } from '../config.ts';
import { discover, toLaunchWithShell, which } from '../discover.ts';
import { commandFields, redactCommandArgs } from '../global-agents.ts';
import { runLaunch } from '../proc.ts';
import { STAGE_NAMES, type AgentConfig, type Config } from '../types.ts';
import { writeFileAtomic } from '../util.ts';

export function projectSettings(loaded: Pick<LoadedConfig, 'config' | 'file' | 'source'>) {
  const { config, file, source } = loaded;
  const localAgents = (YAML.parse(source) as { agents?: Record<string, unknown> } | null)?.agents ?? {};
  const commandAgents = Object.keys(localAgents).flatMap((id) => {
    const a = config.agents[id];
    return a?.type === 'command'
      ? [{ id, command: a.command ?? '', args: redactCommandArgs(a.args ?? []), promptVia: a.promptVia ?? 'stdin', output: a.output ?? 'text' }]
      : [];
  });
  return {
    file,
    revision: createHash('sha256').update(file ?? '').update('\0').update(source).digest('hex'),
    agents: Object.entries(config.agents).map(([id, a]) => ({ id, type: a.type })),
    commandAgents,
    stages: STAGE_NAMES.map((name) => ({
      name,
      agent: config.stages[name].agent,
      model: config.stages[name].model ?? '',
      enabled: config.stages[name].enabled !== false,
    })),
    requireApproval: !!config.stages.plan.requireApproval,
    testCommand: config.test.command ?? null,
  };
}

function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ConfigError(['settings contain an unsupported field or value']);
  }
  return value as Record<string, unknown>;
}

/** Write only the edited fields, keeping the rest of the YAML (including comments) in place. */
export async function saveProjectSettings(repo: string, body: Record<string, unknown>, shared?: Config['agents']) {
  const loaded = await loadConfig(repo, undefined, shared);
  const current = projectSettings(loaded);
  if (typeof body.revision !== 'string') throw new ConfigError(['settings revision is required']);
  if (current.revision !== body.revision) return null;

  const file = loaded.file ?? path.join(repo, CONFIG_FILENAMES[0]);
  const existing = loaded.file ? await fs.lstat(file) : null;
  if (existing?.isSymbolicLink()) {
    throw new ConfigError(['edit the linked configuration file directly']);
  }
  const patch = fields(body, ['revision', 'stages', 'requireApproval', 'testCommand', 'commands']);
  const doc = YAML.parseDocument(loaded.source);
  let changed = false;
  const put = (where: string[], value: string | string[] | boolean | null): void => {
    if (typeof value === 'string' && value.includes('[redacted]')) {
      throw new ConfigError([`${where.join('.')}: replace the redacted value or edit the file directly`]);
    }
    try {
      if (value === null || (typeof value === 'string' && !value.trim())) doc.deleteIn(where);
      else doc.setIn(where, value);
      changed = true;
    } catch {
      throw new ConfigError([`${where.join('.')}: edit this value in the YAML file directly`]);
    }
  };
  if (patch.commands !== undefined) {
    const commands = fields(patch.commands, current.commandAgents.map((agent) => agent.id));
    for (const [id, value] of Object.entries(commands)) {
      const command = commandFields(fields(value, ['command', 'args', 'promptVia', 'output']), id);
      for (const [key, field] of Object.entries(command)) put(['agents', id, key], field);
    }
  }
  if (patch.stages !== undefined) {
    for (const [name, value] of Object.entries(fields(patch.stages, STAGE_NAMES))) {
      const stage = fields(value, ['agent', 'model']);
      if ('agent' in stage) {
        if (typeof stage.agent !== 'string' || !Object.hasOwn(loaded.config.agents, stage.agent)) {
          throw new ConfigError([`stages.${name}.agent: choose a configured agent`]);
        }
        put(['stages', name, 'agent'], stage.agent);
      }
      if ('model' in stage) {
        if (typeof stage.model !== 'string' && stage.model !== null) throw new ConfigError([`stages.${name}.model: expected text`]);
        put(['stages', name, 'model'], stage.model);
      }
    }
  }
  if ('requireApproval' in patch) {
    if (typeof patch.requireApproval !== 'boolean') throw new ConfigError(['requireApproval: expected true or false']);
    put(['stages', 'plan', 'requireApproval'], patch.requireApproval);
  }
  if ('testCommand' in patch) {
    if (typeof patch.testCommand !== 'string' && patch.testCommand !== null) throw new ConfigError(['testCommand: expected text']);
    put(['test', 'command'], patch.testCommand);
  }

  if (!changed) return current;
  const source = doc.toString();
  const effective = resolveConfig(YAML.parse(source) ?? {}, file, shared);
  await writeFileAtomic(file, source, existing ? existing.mode & 0o777 : 0o600);
  return projectSettings({ ...effective, file, source });
}

type Connection = {
  status: 'logged-in' | 'signed-out' | 'installed' | 'missing' | 'key-present' | 'key-missing' | 'found';
  version?: string;
  path?: string;
  variable?: string;
};

async function checkAgent(repo: string, config: AgentConfig): Promise<Connection> {
  if (config.type === 'command') {
    const found = await which(config.command ?? '');
    return found ? { status: 'found', path: found } : { status: 'missing' };
  }
  if (config.type === 'openai-compatible' || config.type === 'anthropic-compatible') {
    const defaultEnv = config.type === 'openai-compatible' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    return { status: resolveApiKey(config, defaultEnv) ? 'key-present' : 'key-missing', variable: config.apiKeyEnv ?? defaultEnv };
  }

  const kind = config.type === 'codex-cli' ? 'codex' : 'claude';
  const found = await discover({ kind, configured: config.path });
  if (!found) return { status: 'missing' };
  const { launch, shell } = toLaunchWithShell(found.launch);
  const args = kind === 'codex' ? ['login', 'status'] : ['auth', 'status'];
  let status: Connection['status'] = 'installed';
  try {
    const result = await runLaunch(launch, args, { cwd: repo, env: config.env, shell, timeoutMs: 8000 });
    if (kind === 'claude') {
      const { loggedIn } = JSON.parse(result.stdout) as { loggedIn?: unknown };
      if (loggedIn === false) status = 'signed-out';
      if (loggedIn === true && result.code === 0) status = 'logged-in';
    } else {
      const output = result.stdout + '\n' + result.stderr;
      if (/not logged in/i.test(output)) status = 'signed-out';
      else if (result.code === 0 && /logged in/i.test(output)) status = 'logged-in';
    }
  } catch {
    // Older versions may not expose a status command.
  }
  return { status, version: found.version, path: found.path };
}

export function checkAgents(repo: string, agents: Config['agents']) {
  return Promise.all(Object.entries(agents).map(async ([id, agent]) => ({
    id,
    ...await checkAgent(repo, agent).catch((): Connection => ({ status: 'missing' })),
  })));
}
