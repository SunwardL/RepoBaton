import { ConfigError } from './config.ts';
import { STAGE_NAMES, type Config, type TaskWorkflow } from './types.ts';

export function readTaskWorkflow(config: Config, value: unknown): TaskWorkflow | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !STAGE_NAMES.includes(key as typeof STAGE_NAMES[number]))) {
    throw new ConfigError(['workflow: expected a mapping of stages to agents and models']);
  }
  const inputs = value as Record<string, unknown>;
  const workflow: TaskWorkflow = {};
  for (const name of STAGE_NAMES) {
    const stage = config.stages[name];
    if (stage.enabled === false) continue;
    const input = inputs[name];
    if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => key !== 'agent' && key !== 'model'))) {
      throw new ConfigError([`${name}: invalid agent or model selection`]);
    }
    const selection = input as { agent?: unknown; model?: unknown } | undefined;
    const agent = selection?.agent ?? stage.agent;
    const model = selection?.model ?? (agent === stage.agent ? stage.model : undefined);
    if (typeof agent !== 'string' || !Object.hasOwn(config.agents, agent)) throw new ConfigError([`${name}: choose an available agent`]);
    if (model !== undefined && (typeof model !== 'string' || model.length > 200 || /[\r\n\0]/.test(model))) {
      throw new ConfigError([`${name}: invalid model`]);
    }
    workflow[name] = { agent, model: model?.trim() || config.agents[agent].model };
  }
  return workflow;
}

export function withWorkflow(config: Config, workflow?: TaskWorkflow): Config {
  if (!workflow) return config;
  const stages = { ...config.stages };
  for (const name of STAGE_NAMES) {
    const selected = workflow[name];
    if (!selected) continue;
    if (!Object.hasOwn(config.agents, selected.agent)) {
      throw new ConfigError([`${name}: restore the configured agent "${selected.agent}" to continue this task`]);
    }
    const original = stages[name];
    // The backup belongs to the primary agent it was configured for. Keep it while that agent is
    // unchanged; once the user swaps the agent, the old backup is dropped (and an agent never backs
    // itself up).
    const sameAgent = original.agent === selected.agent;
    const fallbackAgent = sameAgent && original.fallbackAgent !== selected.agent ? original.fallbackAgent : undefined;
    stages[name] = {
      ...original,
      ...selected,
      model: selected.model,
      effort: sameAgent ? original.effort : undefined,
      fallbackAgent,
    };
  }
  return { ...config, stages };
}
