import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { loadConfig, ConfigError } from '../config.ts';
import { eventsFile, readEvents, SETTLED_STATUSES } from '../events.ts';
import * as G from '../git.ts';
import { agentEntries, importAgentYaml, readGlobalAgents, saveGlobalAgents } from '../global-agents.ts';
import { createLogger, type Logger } from '../log.ts';
import { redactDeep } from '../redact.ts';
import { Pipeline, PipelineError } from '../pipeline.ts';
import { AckRefused, checkAndRecord } from '../publishcheck.ts';
import { ProjectRegistry, userDataDir, type ProjectEntry } from '../projects.ts';
import { cleanupRun, CleanupRefused, recoverInterrupted, type Prober } from '../recovery.ts';
import { identifyRepo, NotAGitRepoError, type RepoIdentity } from '../repoid.ts';
import { RunStore } from '../store.ts';
import type { Config, RunState } from '../types.ts';
import { exists } from '../util.ts';
import { readTaskWorkflow, withWorkflow } from '../workflow.ts';
import { missingSecrets, type MissingSecret } from './secrets.ts';
import { guard, newToken } from './security.ts';
import { checkAgents, projectSettings, saveProjectSettings } from './settings.ts';
import { BusyError, ExecutionSlots } from './slot.ts';

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
  identity: RepoIdentity;
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

  const owner = { serverId, pid: process.pid, startedAt };

  /** Load a project's identity, config and run store. The config is read fresh each time. */
  async function load(projectId: string): Promise<Loaded> {
    const project = await registry.get(projectId);
    if (!project) throw new HttpError(404, 'no-project', `unknown project: ${projectId}`);
    let identity: RepoIdentity;
    try {
      identity = await identifyRepo(project.root);
    } catch (e) {
      if (e instanceof NotAGitRepoError) throw new HttpError(409, 'project-missing', `the folder is no longer a Git repository: ${project.root}`);
      throw e;
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
        .run(l.identity.key, label, async (holder) => {
          const setId = (id: string): void => {
            holder.runId = id;
            resolve(id);
          };
          try {
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
        const id = await identifyRepo(p.root);
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
    try {
      const id = await identifyRepo(p.root);
      const list = await new RunStore(id.root).list();
      runs = list.length;
      needsAttention = list.filter((r) => ['awaiting-plan-approval', 'needs-human', 'interrupted'].includes(r.status)).length;
      busyRun = slots.current(id.key)?.runId ?? (slots.current(id.key) ? '' : null);
    } catch {
      available = false;
    }
    return { id: p.id, name: p.name, root: p.root, available, runs, needsAttention, busy: busyRun !== null, busyRunId: busyRun || null };
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const isApi = parts[0] === 'api';

    const g = guard(req, port, token, { needToken: isApi });
    if (!g.ok) return send(res, g.status, { error: { code: 'forbidden', message: g.message } });
    if (!isApi) return serveStatic(url.pathname, res);

    const method = req.method ?? 'GET';
    const [, a, b, c, d, e] = parts;

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
          if (err instanceof NotAGitRepoError) throw new HttpError(400, 'not-a-repo', `not a Git repository: ${dir}`);
          throw err;
        }
      }
    }

    if (a === 'projects' && b) {
      if (method === 'DELETE' && !c) {
        const p = await registry.get(b);
        if (!p) throw new HttpError(404, 'no-project', `unknown project: ${b}`);
        const id = await identifyRepo(p.root).catch(() => null);
        if (id && slots.current(id.key)) throw new HttpError(409, 'busy', 'a run is executing in this project');
        await registry.remove(b);
        return send(res, 200, { ok: true });
      }

      const l = await load(b);

      if (method === 'GET' && c === 'status') {
        return send(res, 200, { project: await projectView(l.project), missingSecrets: missingSecrets(l.config, l.configFile) satisfies MissingSecret[], configFile: l.configFile });
      }

      if (c === 'settings') {
        if (method === 'GET' && !d) {
          return send(res, 200, projectSettings({ config: l.config, file: l.configFile, source: l.configSource }));
        }
        if (method === 'PUT' && !d) {
          const body = await readBody(req);
          const saved = await slots.run(l.identity.key, 'settings', async () =>
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
          const workflow = readTaskWorkflow(l.config, body.workflow);
          // Refuse up front when a stage's agent has no key: the run would fail at its first call.
          const missing = missingSecrets(withWorkflow(l.config, workflow), l.configFile, { onlyUsed: true });
          if (missing.length) throw new HttpError(422, 'missing-secret', describeMissing(missing), { missing });
          if (!(await G.hasCommits(l.identity.root))) throw new HttpError(409, 'no-commits', 'the repository has no commits yet');
          const id = await launch(l, 'start', (p, setId) => p.start(task, setId, workflow));
          return send(res, 202, { id });
        }
      }

      if (c === 'runs' && d) {
        const id = await l.store.resolve(d).catch(() => {
          throw new HttpError(404, 'not-found', `run not found: ${d}`);
        });

        if (method === 'GET' && !e) {
          const run = await l.store.load(id);
          return send(res, 200, { run, executing: slots.isExecuting(id) });
        }
        if (method === 'GET' && e === 'events') {
          const after = Number(url.searchParams.get('after') ?? 0) || 0;
          const events = await readEvents(eventsFile(l.store.dir(id)), after);
          const state = await l.store.load(id);
          return send(res, 200, { events, settled: SETTLED_STATUSES.includes(state.status) && !slots.isExecuting(id), status: state.status });
        }
        if (method === 'GET' && e === 'report') {
          const file = path.join(l.store.dir(id), 'report.md');
          return send(res, 200, { report: (await exists(file)) ? await fs.readFile(file, 'utf8') : null });
        }
        if (method === 'GET' && e === 'diff') {
          const state = await l.store.load(id);
          const last = [...state.rounds].reverse().find((r) => r.implement);
          if (!state.worktree || !state.base || !last?.implement) return send(res, 200, { diff: '', stat: '' });
          const [diff, stat] = await Promise.all([
            G.diffRange(state.worktree, state.base.sha, last.implement.sha).catch(() => ''),
            G.diffStat(state.worktree, state.base.sha, last.implement.sha).catch(() => ''),
          ]);
          return send(res, 200, { diff: diff.slice(0, 400_000), truncated: diff.length > 400_000, stat, sha: last.implement.sha });
        }

        if (method === 'POST' && e === 'cancel') {
          if (!slots.cancel(l.identity.key, id)) throw new HttpError(409, 'not-running', 'this run is not executing right now');
          return send(res, 202, { id });
        }

        if (method === 'POST' && e === 'cleanup') {
          try {
            // Cleanup takes the repository's slot like every other mutation: while it holds it, no
            // resume/approve can start using this worktree, and while one of those runs, cleanup is busy.
            const r = await slots.run(l.identity.key, 'cleanup', () =>
              cleanupRun(l.store, l.identity.root, id, (rid) => slots.isExecuting(rid), G.removeWorktree),
            );
            return send(res, 200, r);
          } catch (err) {
            if (err instanceof CleanupRefused) throw new HttpError(409, 'cleanup-refused', err.message);
            throw err;
          }
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
            const r = await slots.run(l.identity.key, 'check', async (holder) => {
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
            if (e === 'approve' && state.status !== 'awaiting-plan-approval') wrong(`run is ${state.status}, not waiting for plan approval`);
            if (e === 'reject') {
              if (state.status !== 'awaiting-plan-approval') wrong(`run is ${state.status}, not waiting for plan approval`);
              if (!feedback) throw new HttpError(400, 'bad-request', 'feedback is required to reject a plan');
            }
            if (e === 'resume') {
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
            const missing = missingSecrets(withWorkflow(l.config, state.workflow), l.configFile, { onlyUsed: true });
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
