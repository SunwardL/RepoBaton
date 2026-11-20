import type { Agent, Config } from '../types.ts';
import { AnthropicCompatibleAgent, OpenAiCompatibleAgent } from './api.ts';
import { ClaudeCliAgent, CodexCliAgent } from './cli.ts';
import { CommandAgent } from './command.ts';

export function createAgent(id: string, cfg: Config): Agent {
  const a = cfg.agents[id];
  if (!a) throw new Error(`unknown agent "${id}"`);
  switch (a.type) {
    case 'claude-cli':
      return new ClaudeCliAgent(id, a);
    case 'codex-cli':
      return new CodexCliAgent(id, a);
    case 'openai-compatible':
      return new OpenAiCompatibleAgent(id, a);
    case 'anthropic-compatible':
      return new AnthropicCompatibleAgent(id, a);
    case 'command':
      return new CommandAgent(id, a);
    default:
      throw new Error(`agent "${id}" has unsupported type "${String((a as { type: string }).type)}"`);
  }
}

export class AgentRegistry {
  private cache = new Map<string, Agent>();
  private cfg: Config;
  constructor(cfg: Config) {
    this.cfg = cfg;
  }
  get(id: string): Agent {
    let a = this.cache.get(id);
    if (!a) {
      a = createAgent(id, this.cfg);
      this.cache.set(id, a);
    }
    return a;
  }
}
