import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import YAML from 'yaml';
import { loadConfig, ConfigError } from '../config.ts';
import { eventsFile, readEvents, SETTLED_STATUSES } from '../events.ts';
import * as G from '../git.ts';
import { agentEntries, importAgentYaml, readGlobalAgents, saveGlobalAgents } from '../global-agents.ts';
import { createLogger, type Logger } from '../log.ts';
import { redactDeep } from '../redact.ts';
import { Pipeline, PipelineError } from '../pipeline.ts';
import { AckRefused, checkAndRecord } from '../publishcheck.ts';
import { ProjectRegistry, userDataDir, type ProjectEntry } from '../projects.ts';
import { cleanupPreview, cleanupRun, CleanupRefused, recoverInterrupted, type Prober } from '../recovery.ts';
import { identifyProject, type ProjectIdentity } from '../repoid.ts';
import { RunStore } from '../store.ts';
import type { Config, RunState } from '../types.ts';
import { exists, writeFileAtomic } from '../util.ts';
import { resumeCommand } from '../resume.ts';
import { readStepOutput, readStepPrompt } from '../flow-store.ts';
import { changedFlowAgentFields, snapshotFlowAgents, type FlowAgentSnapshot } from '../flow-config.ts';
import { requestsPublish, validateWorkflow, workflowHash } from '../flow.ts';
import type { Workflow } from '../flow-types.ts';
import { readTaskWorkflow, withWorkflow } from '../workflow.ts';
import { missingSecrets, type MissingSecret } from './secrets.ts';
import { guard, newToken } from './security.ts';
import { checkAgents, projectSettings, saveProjectSettings } from './settings.ts';
import { BusyError, ExecutionSlots } from './slot.ts';

function startConfirmationHash(flow: Workflow, identity: ProjectIdentity, hasCommits: boolean, agents: Record<string, FlowAgentSnapshot>): string {
  return createHash('sha256').update(JSON.stringify({ workflow: workflowHash(flow), root: identity.slotKey,
    workspaceMode: hasCommits ? 'worktree' : 'directory', agents,
    shell: flow.steps.some((step) => step.type === 'command') ? commandShell() : undefined })).digest('hex');
}

function commandShell(): string { return process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'; }

async function previewAgents(flow: Workflow, config: Config): Promise<Record<string, FlowAgentSnapshot>> {
  try { return await snapshotFlowAgents(flow, config); }
  catch (error) { throw new ConfigError([(error as Error).message]); }
}

async function checkPublishTag(repo: string, flow: Workflow, hasCommits: boolean): Promise<void> {
  if (!requestsPublish(flow.git)) return;
  if (!hasCommits) throw new ConfigError(['远端发布需要已有提交的 Git 仓库']);
  if (flow.git.publish?.tag) {
    const tag = `${flow.git.publish.tagPrefix ?? 'v'}${flow.git.release?.version ?? ''}`;
    try { await G.git(repo, ['check-ref-format', `refs/tags/${tag}`]); }
    catch { throw new ConfigError(['标签前缀和版本号不能组成合法的 Git 标签']); }
  }
}

export interface ServerOptions {
  /** Project list file. Defaults to the per-user location. */
  registry?: ProjectRegistry;
  /** Override the per-user Agent settings file for isolated instances. */
  agentsFile?: string;
  /** Open these repositories as projects at startup (e.g. the current directory). */
  seedProjects?: string[];
  port?: number;
  token?: string;
  /** Directory with the built UI (index.html + assets). Optional: the API works without it. */
  staticDir?: string;
  log?: Logger;
  /** Test hooks. */
  makePipeline?: (ctx: PipelineContext) => Pipeline;
  probe?: Prober;
  /** Remote operations; tests pass fakes so no real remote or GitHub is contacted. */
  remote?: G.RemoteOps;
  /** Stable id of this server instance; random per start unless a test pins it. */
  serverId?: string;
  /** Test hook: skip the startup recovery scan. */
  skipRecovery?: boolean;
  /** Test hook for the local file manager. */
  openDirectory?: (dir: string) => Promise<void>;
}

async function openLocalDirectory(dir: string): Promise<void> {
  if (process.platform !== 'win32') throw new HttpError(501, 'unsupported', 'opening a folder is currently supported on Windows');
  const explorer = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(explorer, [dir], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export interface PipelineContext {
  repoRoot: string;
  config: Config;
  signal: AbortSignal;
  log: Logger;
  owner: NonNullable<RunState['owner']>;
}

export interface RunningServer {
  port: number;
  token: string;
  serverId: string;
  url: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  status: number;
  code: string;
  extra?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const MAX_BODY = 1_000_000;

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'too-large', 'request body too large');
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'bad-json', 'request body must be a JSON object');
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(redactDeep(body, { assignments: true })));
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Run list row. Never includes anything secret: run state holds none. */
function summarize(s: RunState, executing: boolean): Record<string, unknown> {
  return {
    id: s.id,
    task: s.task,
    status: s.status,
    stage: s.stage,
    error: s.error,
    errorKind: s.errorKind,
    errorAgent: s.errorAgent,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    interruptedAt: s.interruptedAt,
    branch: s.branch,
    rounds: s.rounds.length,
    usage: s.usage,
    executing,
    hasWorktree: !!s.worktree,
    publishInFlight: s.publish.inFlight ?? null,
  };
}

interface Loaded {
  project: ProjectEntry;
  identity: ProjectIdentity;
  config: Config;
  configFile: string | null;
  configSource: string;
  store: RunStore;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const registry = opts.registry ?? new ProjectRegistry();
  const slots = new ExecutionSlots();
  const token = opts.token ?? newToken();
  const serverId = opts.serverId ?? randomBytes(6).toString('hex');
  const startedAt = new Date().toISOString();
  const logFile = path.join(userDataDir(), 'server.log');
  const log = opts.log ?? createLogger({ file: logFile, quiet: true });
  let port = 0;
  let savingAgents = false;
  const savingFlows = new Set<string>();

  const owner = { serverId, pid: process.pid, startedAt };

  /** Load a project's identity, config and run store. The config is read fresh each time. */
  async function load(projectId: string): Promise<Loaded> {
    const project = await registry.get(projectId);
    if (!project) throw new HttpError(404, 'no-project', `unknown project: ${projectId}`);
    let identity: ProjectIdentity;
    try {
      identity = await identifyProject(project.root);
    } catch (e) {
      throw new HttpError(409, 'project-missing', `project directory is unavailable: ${project.root}`);
    }
    const shared = (await readGlobalAgents(opts.agentsFile)).agents;
    const loaded = await loadConfig(identity.root, undefined, shared);
    return {
      project, identity, config: loaded.config, configFile: loaded.file, configSource: loaded.source,
      store: new RunStore(identity.root),
    };
  }

  const makePipeline =
    opts.makePipeline ??
    ((ctx: PipelineContext): Pipeline =>
      // No interactive approver: a run that needs approval stops at the plan and waits for the UI.
      new Pipeline({ repo: ctx.repoRoot, config: ctx.config, log: ctx.log, signal: ctx.signal, owner: ctx.owner, remote: opts.remote }));

  /**
   * Start execution for a project. The slot is taken before anything is awaited, so the
   * busy answer is immediate and two clicks cannot start two runs. The HTTP call returns as
   * soon as the run id is known while the run continues in the background.
   */
  function launch(
    l: Loaded,
    label: string,
    work: (p: Pipeline, setId: (id: string) => void) => Promise<RunState>,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      slots
        .run(l.identity.slotKey, label, async (holder) => {
          const setId = (id: string): void => {
            holder.runId = id;
            resolve(id);
          };
          try {
            if ((await l.store.list()).some((run) => run.workspaceMode === 'directory' && run.humanControl)) {
              throw new HttpError(409, 'busy', 'the shared project directory is under human control');
            }
            await work(
              makePipeline({ repoRoot: l.identity.root, config: l.config, signal: holder.abort.signal, log, owner }),
              setId,
            );
          } catch (e) {
            log.error(`${label}: ${(e as Error).message}`);
            reject(e); // no-op if the run id was already handed out
          }
        })
        .catch(reject);
    });
  }

  async function startupRecovery(): Promise<void> {
    if (opts.skipRecovery) return;
    for (const p of await registry.list()) {
      try {
        const id = await identifyProject(p.root);
        const r = await recoverInterrupted(new RunStore(id.root), {
          currentServerId: serverId,
          isExecuting: (runId) => slots.isExecuting(runId),
          probe: opts.probe,
        });
        if (r.interrupted.length) log.warn(`${p.name}: marked ${r.interrupted.length} run(s) as interrupted`);
      } catch (e) {
        log.warn(`recovery skipped for ${p.root}: ${(e as Error).message}`);
      }
    }
  }

  async function projectView(p: ProjectEntry): Promise<Record<string, unknown>> {
    let available = true;
    let runs = 0;
    let needsAttention = 0;
    let busyRun: string | null = null;
    let isGit = false;
    let hasCommits = false;
    try {
      const id = await identifyProject(p.root);
      isGit = id.isGit;
      hasCommits = isGit && await G.hasCommits(id.root);
      const list = await new RunStore(id.root).list();
      runs = list.length;
      needsAttention = list.filter((r) => ['awaiting-plan-approval', 'needs-human', 'interrupted'].includes(r.status)).length;
      busyRun = slots.current(id.slotKey)?.runId ?? (slots.current(id.slotKey) ? '' : null);
      if (busyRun === null) busyRun = list.find((run) => run.workspaceMode === 'directory' && run.humanControl)?.id ?? null;
    } catch {
      available = false;
    }
    return { id: p.id, name: p.name, root: p.root, available, isGit, hasCommits, runs, needsAttention, busy: busyRun !== null, busyRunId: busyRun || null };
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const isApi = parts[0] === 'api';

    const g = guard(req, port, token, { needToken: isApi });
    if (!g.ok) return send(res, g.status, { error: { code: 'forbidden', message: g.message } });
    if (!isApi) return serveStatic(url.pathname, res);

    const method = req.method ?? 'GET';
    const [, a, b, c, d, e, f, subresource] = parts;

    if (method === 'GET' && a === 'health') return send(res, 200, { ok: true, serverId });

    if (a === 'agents') {
      if (method === 'GET' && !b) {
        const current = await readGlobalAgents(opts.agentsFile);
        return send(res, 200, { ...current, agents: agentEntries(current.agents) });
      }
      if (method === 'PUT' && !b) {
        const body = await readBody(req);
        if (savingAgents) throw new HttpError(409, 'busy', 'agent settings are already being saved');
        savingAgents = true;
        try {
          const saved = await saveGlobalAgents(opts.agentsFile, body.revision, body.agents);
          if (!saved) throw new HttpError(409, 'stale-config', 'the global agent settings changed; reload before saving');
          return send(res, 200, { ...saved, agents: agentEntries(saved.agents) });
        } finally {
          savingAgents = false;
        }
      }
      if (method === 'POST' && b === 'check' && !c) {
        const { agents } = await readGlobalAgents(opts.agentsFile);
        return send(res, 200, { agents: await checkAgents(process.cwd(), agents) });
      }
      if (method === 'POST' && b === 'import' && !c) {
        const body = await readBody(req);
        return send(res, 200, { agents: importAgentYaml(body.yaml) });
      }
    }

    // ---------------------------------------------------------------- projects
    if (a === 'projects' && !b) {
      if (method === 'GET') return send(res, 200, { projects: await Promise.all((await registry.list()).map(projectView)) });
      if (method === 'POST') {
        const body = await readBody(req);
        const dir = typeof body.path === 'string' ? body.path.trim() : '';
        if (!dir) throw new HttpError(400, 'bad-request', 'path is required');
        try {
          const p = await registry.add(dir, typeof body.name === 'string' ? body.name : undefined);
          return send(res, 201, { project: await projectView(p) });
        } catch (err) {
          throw new HttpError(400, 'invalid-project', `project directory is unavailable: ${dir}`);
        }
      }
    }

    if (a === 'projects' && b) {
      if (method === 'DELETE' && !c) {
        const p = await registry.get(b);
        if (!p) throw new HttpError(404, 'no-project', `unknown project: ${b}`);
        const id = await identifyProject(p.root).catch(() => null);
        if (id && slots.current(id.slotKey)) throw new HttpError(409, 'busy', 'a run is executing in this project');
        await registry.remove(b);
        return send(res, 200, { ok: true });
      }

      const l = await load(b);

      if (c === 'flow') {
        const file = path.join(opts.agentsFile ? path.dirname(opts.agentsFile) : userDataDir(), 'workflows', `${l.project.id}.json`);
        const read = async () => {
          const source = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return '';
            throw error;
          });
          let flow: unknown = null;
          if (source) {
            try { flow = JSON.parse(source); } catch { throw new ConfigError(['saved workflow could not be read']); }
          }
          return { flow, revision: createHash('sha256').update(source).digest('hex') };
        };
        const checked = (flow: unknown) => {
          const issues = validateWorkflow(flow, { hasAgent: (id) => Object.hasOwn(l.config.agents, id) });
          if (issues.some((issue) => issue.level === 'error')) throw new ConfigError(issues.filter((issue) => issue.level === 'error').map((issue) => issue.message));
          if ((flow as Workflow).kind !== 'custom') throw new ConfigError(['choose a custom workflow']);
          if (JSON.stringify(redactDeep(flow, { assignments: true })) !== JSON.stringify(flow)) throw new ConfigError(['workflow contains sensitive values; use environment variables']);
          return issues;
        };
        if (method === 'GET' && !d) return send(res, 200, await read());
        if (method === 'PUT' && !d) {
          const body = await readBody(req);
          if (savingFlows.has(file)) throw new HttpError(409, 'busy', 'workflow is being saved');
          savingFlows.add(file);
          try {
            const current = await read();
            if (body.revision !== current.revision) throw new HttpError(409, 'stale-config', 'workflow changed; reload before saving');
            checked(body.flow);
            await writeFileAtomic(file, JSON.stringify(body.flow, null, 2) + '\n', 0o600);
            return send(res, 200, await read());
          } finally { savingFlows.delete(file); }
        }
        if (method === 'POST' && d === 'preview' && !e) {
          const body = await readBody(req);
          if (typeof body.yaml !== 'string' || !body.yaml.trim()) throw new ConfigError(['choose a nonempty YAML file']);
          let flow: unknown;
          try { flow = YAML.parse(body.yaml); } catch { throw new ConfigError(['the YAML file could not be parsed']); }
          return send(res, 200, { flow, issues: checked(flow) });
        }
        if (method === 'POST' && d === 'export' && !e) {
          const body = await readBody(req);
          checked(body.flow);
          return send(res, 200, { yaml: YAML.stringify(body.flow) });
        }
        if (method === 'POST' && d === 'start-preview' && !e) {
          const body = await readBody(req);
          checked(body.flow);
          const flow = body.flow as Workflow;
          const hasCommits = l.identity.isGit && await G.hasCommits(l.identity.root);
          await checkPublishTag(l.identity.root, flow, hasCommits);
          const agents = await previewAgents(flow, l.config);
          return send(res, 200, { flow, agents: Object.fromEntries(Object.entries(agents).map(([id, agent]) => [id,
            { type: agent.settings.type, command: agent.settings.command, hasArguments: !!(l.config.agents[id]?.args?.length || l.config.agents[id]?.extraArgs?.length) }])),
            hash: startConfirmationHash(flow, l.identity, hasCommits, agents), shell: commandShell(), workspace: l.identity.root,
            workspaceMode: hasCommits ? 'worktree' : 'directory' });
        }
      }

      if (method === 'GET' && c === 'status') {
        return send(res, 200, { project: await projectView(l.project), missingSecrets: missingSecrets(l.config, l.configFile) satisfies MissingSecret[], configFile: l.configFile });
      }

      if (c === 'settings') {
        if (method === 'GET' && !d) {
          return send(res, 200, projectSettings({ config: l.config, file: l.configFile, source: l.configSource }));
        }
        if (method === 'PUT' && !d) {
          const body = await readBody(req);
          const saved = await slots.run(l.identity.slotKey, 'settings', async () =>
            saveProjectSettings(l.identity.root, body, (await readGlobalAgents(opts.agentsFile)).agents));
          if (!saved) throw new HttpError(409, 'stale-config', 'the project configuration changed; reload before saving');
          return send(res, 200, saved);
        }
        if (method === 'POST' && d === 'check' && !e) {
          return send(res, 200, { agents: await checkAgents(l.identity.root, l.config.agents) });
        }
      }

      if (c === 'runs' && !d) {
        if (method === 'GET') {
          const runs = await l.store.list();
          return send(res, 200, { runs: runs.map((r) => summarize(r, slots.isExecuting(r.id))) });
        }
        if (method === 'POST') {
          const body = await readBody(req);
          const task = typeof body.task === 'string' ? body.task.trim() : '';
          if (!task) throw new HttpError(400, 'bad-request', 'task is required');
          if (body.flow !== undefined) {
            const issues = validateWorkflow(body.flow, { hasAgent: (id) => Object.hasOwn(l.config.agents, id) }).filter((issue) => issue.level === 'error');
            if (issues.length) throw new ConfigError(issues.map((issue) => issue.message));
            const flow = body.flow as Workflow;
            if (flow.kind !== 'custom') throw new ConfigError(['expected a custom workflow']);
            const ids = new Set(flow.steps.flatMap((step) => step.type === 'agent' ? [step.agent, step.fallbackAgent].filter(Boolean) : []));
            const missing = missingSecrets(l.config, l.configFile).filter((item) => ids.has(item.agent));
            if (missing.length) throw new HttpError(422, 'missing-secret', describeMissing(missing), { missing });
            const hasCommits = l.identity.isGit && await G.hasCommits(l.identity.root);
            await checkPublishTag(l.identity.root, flow, hasCommits);
            const requiresConfirmation = requestsPublish(flow.git) || flow.steps.some((step) => step.type === 'command' ||
              (step.type === 'agent' && (l.config.agents[step.agent]?.type === 'command' || (step.fallbackAgent && l.config.agents[step.fallbackAgent]?.type === 'command'))));
            if ((requiresConfirmation || body.confirmedWorkflowHash !== undefined) &&
                body.confirmedWorkflowHash !== startConfirmationHash(flow, l.identity, hasCommits, await previewAgents(flow, l.config))) {
              throw new HttpError(409, 'confirmation-required', '流程、Agent 配置或工作区已变化，请重新检查并确认。');
            }
            if (!hasCommits && flow.steps.some((step) => step.type === 'commit')) throw new ConfigError(['Git commit steps require a repository with an initial commit']);
            if (!hasCommits && flow.git.mode === 'agent-managed') throw new ConfigError(['agent-managed Git needs a repository with an initial commit']);
            const id = await launch(l, 'start', async (p, setId) => {
              return p.startFlow(task, flow, setId, hasCommits ? 'worktree' : 'directory', typeof body.confirmedWorkflowHash === 'string' ? body.confirmedWorkflowHash : undefined);
            });
            return send(res, 202, { id });
          }
          const workflow = readTaskWorkflow(l.config, body.workflow);
          // Refuse up front when a stage's agent has no key: the run would fail at its first call.
          const missing = missingSecrets(withWorkflow(l.config, workflow), l.configFile, { onlyUsed: true });
          if (missing.length) throw new HttpError(422, 'missing-secret', describeMissing(missing), { missing });
          if (!l.identity.isGit) throw new HttpError(422, 'git-required', 'the built-in workflow needs Git; use a custom workflow for this directory');
          if (!(await G.hasCommits(l.identity.root))) throw new HttpError(409, 'no-commits', 'the repository has no commits yet');
          const id = await launch(l, 'start', (p, setId) => p.start(task, setId, workflow));
          return send(res, 202, { id });
        }
      }

      if (c === 'runs' && d) {
        const id = await l.store.resolve(d).catch(() => {
          throw new HttpError(404, 'not-found', `run not found: ${d}`);
        });

        if (method === 'POST' && e === 'open-workspace') {
          const state = await l.store.load(id);
          if (!state.worktree || !(await fs.stat(state.worktree).then((s) => s.isDirectory(), () => false))) {
            throw new HttpError(409, 'missing-workspace', 'the workspace directory is unavailable');
          }
          await (opts.openDirectory ?? openLocalDirectory)(state.worktree);
          return send(res, 200, { ok: true });
        }

        if (method === 'GET' && !e) {
          const run = await l.store.load(id);
          // The continue command is built here, once, so the page never re-implements CMD quoting.
          // An unconfirmed id (chosen by RepoBaton, never acknowledged by the CLI) may not exist: the
          // page gets the command separately so it can say so instead of presenting it as certain.
          const sessions = run.sessions?.map((s) => ({ ...s, resumeCommand: resumeCommand(s) }));
          const flowConfigChanges = run.flow?.agents ? changedFlowAgentFields(run.flow.agents, l.config) : [];
          return send(res, 200, { run: { ...run, ...(sessions ? { sessions } : {}), flowConfigChanges }, executing: slots.isExecuting(id) });
        }
        if (method === 'GET' && e === 'events') {
          const after = Number(url.searchParams.get('after') ?? 0) || 0;
          const events = await readEvents(eventsFile(l.store.dir(id)), after);
          const state = await l.store.load(id);
          return send(res, 200, { events, settled: SETTLED_STATUSES.includes(state.status) && !slots.isExecuting(id), status: state.status });
        }
        if (method === 'GET' && e === 'steps' && f) {
          const state = await l.store.load(id);
          if (!state.flow?.workflow.steps.some((step) => step.id === f)) throw new HttpError(404, 'not-found', 'step not found');
          if (subresource === 'prompt') {
            const ref = state.steps?.[f]?.promptRef;
            if (!ref) throw new HttpError(404, 'not-found', 'this step has no saved prompt');
            const prompt = await readStepPrompt(l.store.dir(id), f, ref).catch(() => { throw new HttpError(409, 'corrupt-prompt', 'the saved prompt is missing or has changed'); });
            return send(res, 200, { prompt, ...ref });
          }
          if (subresource) throw new HttpError(404, 'not-found', 'step resource not found');
          return send(res, 200, { output: await readStepOutput(l.store.dir(id), f) });
        }
        if (method === 'GET' && e === 'report') {
          const file = path.join(l.store.dir(id), 'report.md');
          return send(res, 200, { report: (await exists(file)) ? await fs.readFile(file, 'utf8') : null });
        }
        if (method === 'GET' && e === 'diff') {
          const state = await l.store.load(id);
          if (state.flow && state.worktree && state.base) {
            const [diff, stat, untracked] = await Promise.all([
              G.git(state.worktree, ['diff', '--no-color', state.base.sha]),
              G.git(state.worktree, ['diff', '--no-color', '--stat', state.base.sha]),
              G.git(state.worktree, ['ls-files', '--others', '--exclude-standard']),
            ]);
            const summary = stat + (untracked.trim() ? `\n未跟踪文件:\n${untracked}` : '');
            return send(res, 200, { diff: diff.slice(0, 400_000), truncated: diff.length > 400_000, stat: summary });
          }
          const last = [...state.rounds].reverse().find((r) => r.implement);
          if (!state.worktree || !state.base || !last?.implement) return send(res, 200, { diff: '', stat: '' });
          const [diff, stat] = await Promise.all([
            G.diffRange(state.worktree, state.base.sha, last.implement.sha).catch(() => ''),
            G.diffStat(state.worktree, state.base.sha, last.implement.sha).catch(() => ''),
          ]);
          return send(res, 200, { diff: diff.slice(0, 400_000), truncated: diff.length > 400_000, stat, sha: last.implement.sha });
        }

        if (method === 'POST' && e === 'cancel') {
          if (!slots.cancel(l.identity.slotKey, id)) throw new HttpError(409, 'not-running', 'this run is not executing right now');
          return send(res, 202, { id });
        }

        if (method === 'GET' && e === 'cleanup-preview') {
          try {
            return send(res, 200, await cleanupPreview(l.store, l.identity.root, id, (rid) => slots.isExecuting(rid)));
          } catch (err) {
            if (err instanceof CleanupRefused) throw new HttpError(409, 'cleanup-refused', err.message);
            throw err;
          }
        }
        if (method === 'POST' && e === 'cleanup') {
          try {
            const body = await readBody(req);
            if (body.discardHash !== undefined && (typeof body.discardHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.discardHash))) {
              throw new HttpError(400, 'bad-request', 'discardHash is invalid');
            }
            // Cleanup takes the repository's slot like every other mutation: while it holds it, no
            // resume/approve can start using this worktree, and while one of those runs, cleanup is busy.
            const r = await slots.run(l.identity.slotKey, 'cleanup', () =>
              cleanupRun(l.store, l.identity.root, id, (rid) => slots.isExecuting(rid), G.removeWorktree, body.discardHash as string | undefined),
            );
            return send(res, 200, r);
          } catch (err) {
            if (err instanceof CleanupRefused) throw new HttpError(409, 'cleanup-refused', err.message);
            throw err;
          }
        }

        if (method === 'POST' && (e === 'takeover' || e === 'return-control')) {
          const result = await slots.run(l.identity.slotKey, e, async () => {
            const state = await l.store.load(id);
            if (state.status === 'running' || slots.isExecuting(id)) throw new HttpError(409, 'busy', 'the task is still executing');
            if (!state.worktree || !(await exists(state.worktree))) throw new HttpError(409, 'missing-workspace', 'the workspace is unavailable');
            if (e === 'takeover') {
              if (state.humanControl) throw new HttpError(409, 'wrong-state', 'the task is already under human control');
              if ((await l.store.list()).some((other) => other.id !== id && other.humanControl &&
                  (state.workspaceMode === 'directory' || other.workspaceMode === 'directory'))) {
                throw new HttpError(409, 'busy', 'the shared project directory is under human control');
              }
              const gitWorkspace = state.workspaceMode !== 'directory';
              state.humanControl = { startedAt: new Date().toISOString(),
                ...(gitWorkspace ? { headBefore: state.handoff?.reviewRequired ? state.handoff.headBefore : await G.headSha(state.worktree),
                  branchBefore: state.handoff?.reviewRequired ? state.handoff.branchBefore ?? state.branch : await G.currentBranch(state.worktree), dirtyBefore: await G.isDirty(state.worktree) } : {}) };
            } else {
              if (!state.humanControl) throw new HttpError(409, 'wrong-state', 'the task is not under human control');
              const gitWorkspace = state.workspaceMode !== 'directory';
              const headAfter = gitWorkspace ? await G.headSha(state.worktree) : undefined;
              const branchAfter = gitWorkspace ? await G.currentBranch(state.worktree) : undefined;
              const status = gitWorkspace ? await G.git(state.worktree, ['status', '--short']) : undefined;
              const wrongBranch = !state.flow && !!state.branch && branchAfter !== state.branch;
              const changed = gitWorkspace && (headAfter !== state.humanControl.headBefore || branchAfter !== state.humanControl.branchBefore || wrongBranch || !!status?.trim());
              state.handoff = { returnedAt: new Date().toISOString(), headBefore: state.humanControl.headBefore, headAfter,
                branchBefore: state.humanControl.branchBefore, branchAfter, status };
              if (!state.flow && changed) {
                const published = !!(state.publish.inFlight || state.publish.pushed || state.publish.prUrl || state.publish.merged || state.publish.tag);
                if (wrongBranch || status?.trim() || published || !headAfter || !state.base) {
                  state.handoff.reviewRequired = true;
                } else {
                  try {
                    await G.git(state.worktree, ['merge-base', '--is-ancestor', state.base.sha, headAfter]);
                    for (const round of state.rounds) if (round.decision === 'approved') round.superseded = true;
                    if (state.rounds.length) {
                      state.rounds.push({ n: state.rounds.length + 1, implement: { agent: 'human', sha: headAfter,
                        summary: 'Changes made during human takeover', changedFiles: await G.changedFiles(state.worktree, state.base.sha, headAfter), durationMs: 0 } });
                    } else {
                      state.plan = undefined;
                      state.planApproved = false;
                      state.planVersion = (state.planVersion ?? 0) + 1;
                    }
                    state.release = undefined;
                    state.status = 'needs-human';
                    state.error = 'human changes require a fresh test and review';
                  } catch {
                    state.handoff.reviewRequired = true;
                  }
                }
              }
              delete state.humanControl;
            }
            await l.store.save(state);
            return { ok: true };
          });
          return send(res, 200, result);
        }

        if (method === 'POST' && e === 'flow-approve') {
          const body = await readBody(req);
          if (typeof body.stepId !== 'string' || typeof body.contentHash !== 'string') throw new HttpError(400, 'bad-request', 'stepId and contentHash are required');
          const stepId = body.stepId;
          const contentHash = body.contentHash;
          await launch(l, 'flow-approve', (pipeline, setId) => pipeline.approveFlow(id, stepId, contentHash, setId));
          return send(res, 202, { id });
        }

        if (method === 'POST' && e === 'flow-retry') {
          const body = await readBody(req);
          if (typeof body.stepId !== 'string' || typeof body.stepStatus !== 'string') throw new HttpError(400, 'bad-request', 'stepId and stepStatus are required');
          const stepId = body.stepId;
          const stepStatus = body.stepStatus;
          await launch(l, 'flow-retry', (pipeline, setId) => pipeline.retryFlow(id, stepId, stepStatus, setId));
          return send(res, 202, { id });
        }

        if (method === 'POST' && e === 'flow-complete-unknown') {
          const body = await readBody(req);
          if (typeof body.stepId !== 'string' || !Number.isSafeInteger(body.attempt) || typeof body.output !== 'string' ||
              (body.exitCode !== undefined && !Number.isSafeInteger(body.exitCode))) throw new HttpError(400, 'bad-request', 'stepId, attempt, output and optional exitCode are required');
          await launch(l, 'flow-complete-unknown', (pipeline, setId) => pipeline.completeUnknownFlow(id, body.stepId as string, body.attempt as number, body.output as string, body.exitCode as number | undefined, setId));
          return send(res, 202, { id });
        }

        if (method === 'POST' && e === 'flow-recheck-commit') {
          const body = await readBody(req);
          if (typeof body.stepId !== 'string' || !Number.isSafeInteger(body.attempt)) throw new HttpError(400, 'bad-request', 'stepId and attempt are required');
          await launch(l, 'flow-recheck-commit', (pipeline, setId) => pipeline.recheckUnknownCommit(id, body.stepId as string, body.attempt as number, setId));
          return send(res, 202, { id });
        }

        if (method === 'POST' && e === 'flow-preview-changed-commit') {
          const body = await readBody(req);
          if (typeof body.stepId !== 'string' || !Number.isSafeInteger(body.attempt)) throw new HttpError(400, 'bad-request', 'stepId and attempt are required');
          const result = await slots.run(l.identity.slotKey, 'preview-changed-commit', async (holder) => {
            holder.runId = id;
            const pipeline = makePipeline({ repoRoot: l.identity.root, config: l.config, signal: holder.abort.signal, log, owner });
            return pipeline.previewChangedCommit(id, body.stepId as string, body.attempt as number);
          });
          return send(res, 200, result);
        }

        if (method === 'POST' && e === 'flow-accept-changed-commit') {
          const body = await readBody(req);
          if (typeof body.stepId !== 'string' || !Number.isSafeInteger(body.attempt) || typeof body.hash !== 'string') throw new HttpError(400, 'bad-request', 'stepId, attempt and hash are required');
          await launch(l, 'flow-accept-changed-commit', (pipeline, setId) => pipeline.acceptChangedCommit(id, body.stepId as string, body.attempt as number, body.hash as string, setId));
          return send(res, 202, { id });
        }

        if (method === 'POST' && e === 'flow-review-publication') {
          const body = await readBody(req);
          if (typeof body.expectedHash !== 'string') throw new HttpError(400, 'bad-request', 'expectedHash is required');
          await slots.run(l.identity.slotKey, 'review-publication', async (holder) => {
            holder.runId = id;
            const pipeline = makePipeline({ repoRoot: l.identity.root, config: l.config, signal: holder.abort.signal, log, owner });
            await pipeline.reviewPublicationAgain(id, body.expectedHash as string);
          });
          return send(res, 200, { ok: true });
        }

        if (method === 'POST' && (e === 'acknowledge' || e === 'check')) {
          // Ask the remote what happened to an interrupted publish step and record only what it confirms
          // (or what the user's evidence settles). Holds the repository slot like any other mutation.
          const body = await readBody(req);
          const ev = body.evidence && typeof body.evidence === 'object' ? (body.evidence as Record<string, unknown>) : {};
          const evidence = {
            remoteSha: typeof ev.remoteSha === 'string' ? ev.remoteSha : undefined,
            prUrl: typeof ev.prUrl === 'string' ? ev.prUrl : undefined,
            mergeSha: typeof ev.mergeSha === 'string' ? ev.mergeSha : undefined,
          };
          const hasEvidence = Object.values(evidence).some(Boolean);
          const completed = typeof body.completed === 'boolean' ? body.completed : undefined;
          try {
            const r = await slots.run(l.identity.slotKey, 'check', async (holder) => {
              holder.runId = id;
              return checkAndRecord(l.store, l.identity.root, l.config, id, { completed, evidence: hasEvidence ? evidence : undefined }, opts.remote);
            });
            if (!r.ok) {
              const status = r.code === 'nothing-to-ack' ? 409 : 422;
              throw new HttpError(status, r.code, r.message);
            }
            return send(res, 200, { ok: true, recorded: r.recorded, summary: r.summary });
          } catch (err) {
            if (err instanceof AckRefused) throw new HttpError(409, err.code, err.message);
            throw err;
          }
        }

        if (method === 'POST' && (e === 'approve' || e === 'reject' || e === 'resume')) {
          const body = await readBody(req);
          const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : '';
          const expect = typeof body.expectStatus === 'string' ? body.expectStatus : undefined;
          const more = Number(body.moreRounds ?? 0) || 0;

          // The slot comes first. Everything after it - re-reading the state, checking it is
          // still the state the user saw - happens while holding it, so a duplicate or stale
          // request cannot start a second execution.
          await launch(l, e, async (p, setId) => {
            const state = await l.store.load(id);
            const wrong = (msg: string): never => {
              throw new HttpError(409, 'wrong-state', msg, { status: state.status });
            };
            if (expect && state.status !== expect) wrong(`this run is now ${state.status}, not ${expect}; reload and try again`);
            if (state.humanControl) wrong('this task is under human control; return it before continuing');
            if (state.handoff?.reviewRequired) wrong('the human changes or current branch need review before continuing');
            if (e === 'approve' && state.status !== 'awaiting-plan-approval') wrong(`run is ${state.status}, not waiting for plan approval`);
            if (e === 'reject') {
              if (state.status !== 'awaiting-plan-approval') wrong(`run is ${state.status}, not waiting for plan approval`);
              if (!feedback) throw new HttpError(400, 'bad-request', 'feedback is required to reject a plan');
            }
            if (e === 'resume') {
              if (state.flow) {
                const first = state.flow.workflow.steps.find((step) => state.steps?.[step.id]?.status !== 'succeeded');
                if (first && (state.steps?.[first.id]?.status !== 'pending' || first.type === 'approval')) {
                  wrong('this custom step needs explicit review before it can continue');
                }
              }
              if (state.status === 'awaiting-plan-approval') wrong('approve or reject the plan instead');
              if (state.status === 'running') wrong('this run is already running');
              if (state.status === 'succeeded') wrong('this run already succeeded');
              if (state.publish.inFlight) wrong('an external step was interrupted; check it and mark it as checked first');
            }
            if (e === 'approve' || e === 'reject') {
              // The user must name the plan version they were looking at; checked while holding the slot.
              if (typeof body.expectPlanVersion !== 'number') throw new HttpError(400, 'bad-request', 'expectPlanVersion is required to approve or reject a plan');
              const current = state.planVersion ?? 0;
              if (current !== body.expectPlanVersion) {
                throw new HttpError(409, 'stale-plan', 'the plan changed since you opened it (now version ' + current + '); refresh the page and review it again', { planVersion: current, status: state.status });
              }
            }
            const used = state.flow ? new Set(state.flow.workflow.steps.flatMap((step) => step.type === 'agent' ? [step.agent, step.fallbackAgent].filter(Boolean) : [])) : null;
            const missing = used ? missingSecrets(l.config, l.configFile).filter((item) => used.has(item.agent)) : missingSecrets(withWorkflow(l.config, state.workflow), l.configFile, { onlyUsed: true });
            if (missing.length) throw new HttpError(422, 'missing-secret', describeMissing(missing), { missing });
            setId(id);
            if (e === 'approve') return p.resume(id, { approvePlan: true });
            if (e === 'reject') return p.rejectPlan(id, feedback);
            return p.resume(id, { moreRounds: more || undefined, feedback: feedback || undefined });
          });
          return send(res, 202, { id });
        }
      }
    }

    throw new HttpError(404, 'not-found', `no such endpoint: ${method} ${url.pathname}`);
  }

  async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
    if (!opts.staticDir) return send(res, 404, { error: { code: 'no-ui', message: 'UI is not built; the API is at /api' } });
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const root = path.resolve(opts.staticDir);
    let file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) && file !== root) return send(res, 403, { error: { code: 'forbidden', message: 'bad path' } });
    if (!(await exists(file))) file = path.join(root, 'index.html'); // client-side routes
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    } catch {
      send(res, 404, { error: { code: 'not-found', message: 'not found' } });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return send(res, err.status, { error: { code: err.code, message: err.message, ...(err.extra ?? {}) } });
      if (err instanceof ConfigError) return send(res, 422, { error: { code: 'bad-config', message: err.message, problems: err.problems } });
      if (err instanceof BusyError) return send(res, 409, { error: { code: 'busy', message: err.message, runId: err.runId ?? null } });
      if (err instanceof PipelineError) return send(res, 409, { error: { code: 'pipeline', message: err.message } });
      log.error(`unhandled: ${(err as Error).stack ?? err}`); // the logger masks it
      send(res, 500, { error: { code: 'internal', message: 'internal error' } });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 only: never the LAN.
    server.listen(opts.port ?? 0, '127.0.0.1', resolve);
  });
  port = (server.address() as AddressInfo).port;

  await registry.stabilize();
  for (const dir of opts.seedProjects ?? []) await registry.add(dir).catch(() => undefined);
  await startupRecovery();

  return {
    port,
    token,
    serverId,
    url: `http://127.0.0.1:${port}/#token=${token}`,
    close: () =>
      new Promise<void>((resolve) => {
        slots.abortAll();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

function describeMissing(missing: MissingSecret[]): string {
  return missing.map((m) => `agent "${m.agent}" needs the environment variable ${m.variable}`).join('; ') + '. Set it before starting repobaton ui.';
}
