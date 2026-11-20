import type { Config } from '../types.ts';
import { resolveApiKey } from '../config.ts';

export interface MissingSecret {
  agent: string;
  /** The environment variable the agent reads its key from. Never the key itself. */
  variable: string;
  /** The stages that use this agent. */
  stages: string[];
}

const DEFAULT_ENV: Record<string, string> = {
  'openai-compatible': 'OPENAI_API_KEY',
  'anthropic-compatible': 'ANTHROPIC_API_KEY',
};

/**
 * Which API agents have no key in this process's environment? Reports only the variable
 * name. CLI agents (claude, codex) use their own logins and are not checked here.
 */
export function missingSecrets(
  config: Config,
  _configFile: string | null,
  opts: { onlyUsed?: boolean } = {},
): MissingSecret[] {
  const usedBy = new Map<string, string[]>();
  for (const [stage, sc] of Object.entries(config.stages)) {
    if (sc.enabled === false) continue;
    for (const id of [sc.agent, sc.fallbackAgent]) {
      if (!id) continue;
      usedBy.set(id, [...(usedBy.get(id) ?? []), stage]);
    }
  }
  const out: MissingSecret[] = [];
  for (const [id, agent] of Object.entries(config.agents)) {
    const def = DEFAULT_ENV[agent.type];
    if (!def) continue;
    const stages = usedBy.get(id) ?? [];
    if (opts.onlyUsed && stages.length === 0) continue;
    if (resolveApiKey(agent, def)) continue;
    // An inline apiKey in the config file counts as present; we still never read it out.
    out.push({ agent: id, variable: agent.apiKeyEnv ?? def, stages });
  }
  return out;
}
