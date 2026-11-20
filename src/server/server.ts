import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { loadConfig } from '../config.ts';
import { eventsFile, readEvents, SETTLED_STATUSES } from '../events.ts';
import * as G from '../git.ts';
import { createLogger, type Logger } from '../log.ts';
import { Pipeline, PipelineError } from '../pipeline.ts';
import { RunStore } from '../store.ts';
import type { Config, RunState } from '../types.ts';
import { exists } from '../util.ts';
import { guard, newToken } from './security.ts';
import { BusyError, ExecutionSlot } from './slot.ts';

export interface ServerOptions {
  repo: string;
  config: Config;
  port?: number;
  token?: string;
  /** Directory with the built UI (index.html + assets). Optional: the API works without it. */
  staticDir?: string;
  log?: Logger;
  /** Test hook: build the pipeline for a run. */
  makePipeline?: (signal: AbortSignal) => Pipeline;
}

export interface RunningServer {
  port: number;
  token: string;
  url: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
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
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
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

/** What the list/detail views need. Never includes secrets: state holds none. */
function summarize(s: RunState): Record<string, unknown> {
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
    branch: s.branch,
    rounds: s.rounds.length,
    usage: s.usage,
  };
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const store = new RunStore(opts.repo);
  const slot = new ExecutionSlot();
  const token = opts.token ?? newToken();
  const log = opts.log ?? createLogger({ file: path.join(opts.repo, '.repobaton', 'server.log'), quiet: true });
  let port = 0;

  const makePipeline =
    opts.makePipeline ??
    ((signal: AbortSignal): Pipeline =>
      // No interactive approver: every run that needs approval stops at the plan and waits for the UI.
      new Pipeline({ repo: opts.repo, config: opts.config, log, signal }));

  /** Detach execution from the request: the HTTP call returns while the run continues. */
  function launch(label: string, work: (p: Pipeline, signal: AbortSignal, setId: (id: string) => void) => Promise<RunState>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      slot
        .run(label, async (holder) => {
          const setId = (id: string): void => {
            holder.runId = id;
            resolve(id);
          };
          try {
            await work(makePipeline(holder.abort.signal), holder.abort.signal, setId);
          } catch (e) {
            log.error(`${label}: ${(e as Error).message}`);
            // A failure before the run was created never reached setId.
            reject(e);
          }
        })
        .catch(reject);
    });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const isApi = parts[0] === 'api';

    const g = guard(req, port, token, { needToken: isApi });
    if (!g.ok) return send(res, g.status, { error: { code: 'forbidden', message: g.message } });

    if (!isApi) return serveStatic(url.pathname, res);

    const method = req.method ?? 'GET';
    const [, a, b, c] = parts;

    if (method === 'GET' && a === 'health') return send(res, 200, { ok: true });

    if (method === 'GET' && a === 'state') {
      const cur = slot.current;
      return send(res, 200, { busy: !!cur, runId: cur?.runId ?? null });
    }

    if (method === 'GET' && a === 'runs' && !b) {
      const runs = await store.list();
      return send(res, 200, { runs: runs.map(summarize) });
    }

    if (method === 'POST' && a === 'runs' && !b) {
      const body = await readBody(req);
      const task = typeof body.task === 'string' ? body.task.trim() : '';
      if (!task) throw new HttpError(400, 'bad-request', 'task is required');
      if (!(await exists(opts.repo))) throw new HttpError(500, 'internal', 'repository is missing');
      const id = await launch('start', (p, _s, setId) => p.start(task, setId));
      return send(res, 202, { id });
    }

    if (a === 'runs' && b) {
      const id = await store.resolve(b).catch(() => {
        throw new HttpError(404, 'not-found', `run not found: ${b}`);
      });

      if (method === 'GET' && !c) return send(res, 200, { run: await store.load(id) });

      if (method === 'GET' && c === 'events') {
        const after = Number(url.searchParams.get('after') ?? 0) || 0;
        const events = await readEvents(eventsFile(store.dir(id)), after);
        const state = await store.load(id);
        return send(res, 200, { events, settled: SETTLED_STATUSES.includes(state.status), status: state.status });
      }

      if (method === 'GET' && c === 'plan') {
        const state = await store.load(id);
        return send(res, 200, { plan: state.plan ?? null, planApproved: !!state.planApproved });
      }

      if (method === 'GET' && c === 'diff') {
        const state = await store.load(id);
        const last = [...state.rounds].reverse().find((r) => r.implement);
        if (!state.worktree || !state.base || !last?.implement) return send(res, 200, { diff: '', stat: '' });
        const base = state.base.sha;
        const head = last.implement.sha;
        const [diff, stat] = await Promise.all([
          G.diffRange(state.worktree, base, head).catch(() => ''),
          G.diffStat(state.worktree, base, head).catch(() => ''),
        ]);
        return send(res, 200, { diff: diff.slice(0, 400_000), truncated: diff.length > 400_000, stat, sha: head });
      }

      if (method === 'POST' && c === 'cancel') {
        const ok = slot.cancel(id);
        if (!ok) throw new HttpError(409, 'not-running', 'this run is not executing right now');
        return send(res, 202, { id });
      }

      if (method === 'POST' && (c === 'approve' || c === 'reject' || c === 'resume')) {
        const state = await store.load(id);
        const body = await readBody(req);
        const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : '';
        if (c === 'approve' && state.status !== 'awaiting-plan-approval') {
          throw new HttpError(409, 'wrong-state', `run is ${state.status}, not waiting for plan approval`);
        }
        if (c === 'reject') {
          if (state.status !== 'awaiting-plan-approval') {
            throw new HttpError(409, 'wrong-state', `run is ${state.status}, not waiting for plan approval`);
          }
          if (!feedback) throw new HttpError(400, 'bad-request', 'feedback is required to reject a plan');
        }
        if (c === 'resume' && state.status === 'awaiting-plan-approval') {
          throw new HttpError(409, 'wrong-state', 'approve or reject the plan instead');
        }
        const more = Number(body.moreRounds ?? 0) || 0;
        await launch(c, async (p, _s, setId) => {
          setId(id);
          if (c === 'approve') return p.resume(id, { approvePlan: true });
          if (c === 'reject') return p.rejectPlan(id, feedback);
          return p.resume(id, { moreRounds: more || undefined, feedback: feedback || undefined });
        });
        return send(res, 202, { id });
      }
    }

    throw new HttpError(404, 'not-found', `no such endpoint: ${method} ${url.pathname}`);
  }

  async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
    if (!opts.staticDir) return send(res, 404, { error: { code: 'no-ui', message: 'UI is not built; the API is at /api' } });
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    let file = path.resolve(opts.staticDir, '.' + rel);
    const root = path.resolve(opts.staticDir);
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
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return send(res, e.status, { error: { code: e.code, message: e.message } });
      if (e instanceof BusyError) return send(res, 409, { error: { code: 'busy', message: e.message, runId: e.runId ?? null } });
      if (e instanceof PipelineError) return send(res, 409, { error: { code: 'pipeline', message: e.message } });
      log.error(`unhandled: ${(e as Error).stack ?? e}`);
      send(res, 500, { error: { code: 'internal', message: 'internal error' } });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 only: never the LAN.
    server.listen(opts.port ?? 0, '127.0.0.1', resolve);
  });
  port = (server.address() as AddressInfo).port;

  return {
    port,
    token,
    url: `http://127.0.0.1:${port}/#token=${token}`,
    close: () =>
      new Promise<void>((resolve) => {
        slot.current?.abort.abort();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

export { loadConfig };
