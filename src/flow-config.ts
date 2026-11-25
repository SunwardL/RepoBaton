import { createHmac, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { userDataDir } from './projects.ts';
import { redactDeep } from './redact.ts';
import type { AgentConfig, Config } from './types.ts';
import type { Workflow } from './flow-types.ts';

type PublicAgent = Omit<AgentConfig, 'apiKey' | 'env' | 'headers' | 'args' | 'extraArgs'>;
export interface FlowAgentSnapshot {
  settings: PublicAgent;
  envNames: string[];
  headerNames: string[];
  inlineApiKey: boolean;
  argsFingerprint?: string;
}

const PUBLIC_KEYS: Array<keyof PublicAgent> = ['type', 'path', 'model', 'effort', 'baseUrl', 'apiKeyEnv', 'maxTokens', 'temperature', 'maxSteps', 'allowShell', 'readOnlyTools', 'writeTools', 'maxBudgetUsd', 'command', 'promptVia', 'output'];

/** Only expose field names; a saved task continues to use its original structural settings. */
export function changedFlowAgentFields(snapshots: Record<string, FlowAgentSnapshot>, current: Config): string[] {
  const changed: string[] = [];
  for (const [id, snapshot] of Object.entries(snapshots)) {
    const agent = current.agents[id];
    if (!agent) { changed.push(`${id}（已移除）`); continue; }
    for (const key of PUBLIC_KEYS) {
      if (JSON.stringify(snapshot.settings[key]) !== JSON.stringify(agent[key])) changed.push(`${id}.${key}`);
    }
  }
  return changed;
}

const keyRequests = new Map<string, Promise<Buffer>>();

async function fingerprint(args: unknown, create: boolean): Promise<string> {
  const directory = userDataDir();
  const file = path.join(directory, 'flow-fingerprint.key');
  let pending = keyRequests.get(file);
  if (!pending) {
    pending = (async () => {
      if (create) {
        await fs.mkdir(directory, { recursive: true });
        try {
          await fs.writeFile(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      const key = await fs.readFile(file).catch(() => { throw new Error('workflow fingerprint key is missing'); });
      if (key.length !== 32) throw new Error('workflow fingerprint key is invalid');
      return key;
    })();
    keyRequests.set(file, pending);
    void pending.finally(() => { if (keyRequests.get(file) === pending) keyRequests.delete(file); }).catch(() => undefined);
  }
  const key = await pending;
  return createHmac('sha256', key).update(JSON.stringify(args)).digest('hex');
}

/** Compare a complete remote address without storing credentials or query parameters. */
export function fingerprintRemoteAddress(address: string, create: boolean): Promise<string> {
  return fingerprint(['remote-address', address], create);
}

export async function snapshotFlowAgents(workflow: Workflow, config: Config): Promise<Record<string, FlowAgentSnapshot>> {
  const ids = new Set(workflow.steps.flatMap((step) => step.type === 'agent' ? [step.agent, step.fallbackAgent].filter((id): id is string => !!id) : []));
  const snapshots: Record<string, FlowAgentSnapshot> = {};
  for (const id of ids) {
    const agent = config.agents[id];
    if (!agent) throw new Error(`agent ${id} is not configured`);
    const { apiKey, env, headers, args, extraArgs } = agent;
    const settings: PublicAgent = {
      type: agent.type, path: agent.path, model: agent.model, effort: agent.effort, baseUrl: agent.baseUrl,
      apiKeyEnv: agent.apiKeyEnv, maxTokens: agent.maxTokens, temperature: agent.temperature, maxSteps: agent.maxSteps,
      allowShell: agent.allowShell, readOnlyTools: agent.readOnlyTools, writeTools: agent.writeTools,
      maxBudgetUsd: agent.maxBudgetUsd, command: agent.command, promptVia: agent.promptVia, output: agent.output,
    };
    if (settings.baseUrl) {
      const url = new URL(settings.baseUrl);
      if (url.username || url.password || url.search || url.hash) throw new Error(`agent ${id} base URL contains credentials or a query; use environment variables`);
    }
    if (JSON.stringify(redactDeep(settings, { assignments: true })) !== JSON.stringify(settings)) {
      throw new Error(`agent ${id} has sensitive values in structural settings; move them to the environment`);
    }
    snapshots[id] = {
      settings: structuredClone(settings), envNames: Object.keys(env ?? {}).sort(), headerNames: Object.keys(headers ?? {}).sort(),
      inlineApiKey: !!apiKey,
      ...((args || extraArgs) ? { argsFingerprint: await fingerprint([args ?? null, extraArgs ?? null], true) } : {}),
    };
  }
  return snapshots;
}

export async function restoreFlowAgents(snapshots: Record<string, FlowAgentSnapshot>, current: Config): Promise<Config['agents']> {
  const agents: Config['agents'] = {};
  for (const [id, snapshot] of Object.entries(snapshots)) {
    const configured = current.agents[id];
    if (!configured || configured.type !== snapshot.settings.type) throw new Error(`agent ${id} is missing or has changed type`);
    if (snapshot.inlineApiKey && !configured.apiKey) throw new Error(`agent ${id} needs its configured API key`);
    if (snapshot.settings.apiKeyEnv && !process.env[snapshot.settings.apiKeyEnv]) throw new Error(`agent ${id} needs environment variable ${snapshot.settings.apiKeyEnv}`);
    for (const name of snapshot.envNames) if (!(configured.env?.[name] ?? process.env[name])) throw new Error(`agent ${id} needs environment variable ${name}`);
    for (const name of snapshot.headerNames) if (!configured.headers?.[name]) throw new Error(`agent ${id} needs header ${name}`);
    if (snapshot.argsFingerprint !== undefined && await fingerprint([configured.args ?? null, configured.extraArgs ?? null], false) !== snapshot.argsFingerprint) {
      throw new Error(`agent ${id} arguments have changed; restore the original configuration`);
    }
    const env = Object.fromEntries(snapshot.envNames.map((name) => [name, configured.env?.[name] ?? process.env[name]!]));
    const headers = Object.fromEntries(snapshot.headerNames.map((name) => [name, configured.headers![name]]));
    agents[id] = { ...snapshot.settings, ...(snapshot.inlineApiKey ? { apiKey: configured.apiKey } : {}),
      ...(snapshot.envNames.length ? { env } : {}), ...(snapshot.headerNames.length ? { headers } : {}),
      ...(snapshot.argsFingerprint !== undefined ? { args: configured.args, extraArgs: configured.extraArgs } : {}) };
  }
  return agents;
}
