import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discover, toLaunchWithShell, type CliKind, type Discovered } from '../discover.ts';
import { runLaunch } from '../proc.ts';
import {
  AgentError,
  type Agent,
  type AgentConfig,
  type AgentResult,
  type AgentRunRequest,
} from '../types.ts';
import { extractJson, stripAnsi, tail } from '../util.ts';

const DEFAULT_READ_TOOLS = ['Read', 'Grep', 'Glob'];
const DEFAULT_WRITE_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'];

abstract class CliAgent implements Agent {
  abstract type: Agent['type'];
  id: string;
  protected found?: Discovered;
  protected cfg: AgentConfig;
  protected kind: CliKind;
  constructor(id: string, cfg: AgentConfig, kind: CliKind) {
    this.id = id;
    this.cfg = cfg;
    this.kind = kind;
  }

  protected async locate(): Promise<Discovered> {
    if (!this.found) {
      const d = await discover({ kind: this.kind, configured: this.cfg.path });
      if (!d) {
        const hint = this.cfg.path
          ? `configured path "${this.cfg.path}" did not run`
          : `could not find the "${this.kind}" CLI on this machine`;
        throw new AgentError(
          `${hint}. Set agents.${this.id}.path, REPOBATON_${this.kind.toUpperCase()}_PATH, or run "repobaton doctor".`,
          false,
          'not-found',
        );
      }
      this.found = d;
    }
    return this.found;
  }

  /** What a continue command needs to run the same CLI again. */
  protected cliInfo(d: Discovered): { path: string; command?: string; prefixArgs?: string[] } {
    const unwrapped = d.launch.command !== d.path || d.launch.prefixArgs.length > 0;
    return unwrapped ? { path: d.path, command: d.launch.command, prefixArgs: d.launch.prefixArgs } : { path: d.path };
  }

  describe(): string {
    return `${this.type}${this.cfg.model ? ` (${this.cfg.model})` : ''}`;
  }

  async check(): Promise<{ ok: boolean; detail: string }> {
    try {
      const d = await this.locate();
      return { ok: true, detail: `${d.path} — ${d.version} [${d.source}]` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  abstract run(req: AgentRunRequest): Promise<AgentResult>;
}

export class ClaudeCliAgent extends CliAgent {
  type = 'claude-cli' as const;
  constructor(id: string, cfg: AgentConfig) {
    super(id, cfg, 'claude');
  }

  async run(req: AgentRunRequest): Promise<AgentResult> {
    const d = await this.locate();
    const args = ['-p', '--output-format', 'json'];
    const model = req.model ?? this.cfg.model;
    if (model) args.push('--model', model);
    const effort = req.effort ?? this.cfg.effort;
    if (effort) args.push('--effort', effort);
    if (req.schema) args.push('--json-schema', JSON.stringify(req.schema));
    if (req.access === 'read-only') {
      // --tools removes the capability; --allowedTools alone would only pre-approve.
      args.push('--tools', (this.cfg.readOnlyTools ?? DEFAULT_READ_TOOLS).join(','));
    } else {
      const tools = (this.cfg.writeTools ?? DEFAULT_WRITE_TOOLS).join(',');
      args.push('--tools', tools, '--allowedTools', tools, '--permission-mode', 'acceptEdits');
    }
    // Resuming keeps the id it has. A new persisted session gets an id chosen here, before the call
    // starts, so a timeout, cancellation or crash still leaves the user an id to continue from.
    let sessionId: string | undefined = req.sessionId;
    if (req.sessionId) args.push('--resume', req.sessionId);
    else if (req.persist) {
      sessionId = randomUUID();
      args.push('--session-id', sessionId);
    }
    if (!req.persist) args.push('--no-session-persistence');
    // Only a resumed session is known to exist; a freshly assigned id is confirmed by the CLI's answer.
    const confirmed = !!req.sessionId;
    if (sessionId) req.onSession?.(sessionId, confirmed);
    if (this.cfg.maxBudgetUsd) args.push('--max-budget-usd', String(this.cfg.maxBudgetUsd));
    args.push(...(this.cfg.extraArgs ?? []));

    req.onLaunch?.(this.cliInfo(d));
    const { launch, shell } = toLaunchWithShell(d.launch);
    const r = await runLaunch(launch, args, {
      cwd: req.cwd,
      input: req.prompt,
      env: this.cfg.env,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      shell,
      onStderrLine: (l) => req.onProgress?.(stripAnsi(l)),
    });
    if (r.aborted) throw new AgentError('cancelled', false, 'cancelled', sessionId, confirmed);
    if (r.timedOut) throw new AgentError(`claude timed out after ${Math.round(req.timeoutMs / 1000)}s`, true, 'timeout', sessionId, confirmed);
    // A process that never started has no session worth pointing at.
    if (r.error) throw new AgentError(`failed to start claude: ${r.error}`, false, 'not-found');

    let payload: any;
    try {
      const parsed = JSON.parse(r.stdout.trim());
      payload = Array.isArray(parsed) ? [...parsed].reverse().find((x) => x?.type === 'result') : parsed;
    } catch {
      /* handled below */
    }
    if (!payload) {
      throw new AgentError(
        `claude exited ${r.code} without a JSON result: ${tail(stripAnsi(r.stderr || r.stdout), 600)}`,
        true,
        'unknown',
        sessionId,
        confirmed,
      );
    }
    if (payload.is_error || (r.code !== 0 && payload.subtype !== 'success')) {
      const msg = typeof payload.result === 'string' ? payload.result : payload.subtype;
      const isAuth = /auth|login|credit|permission|api key|unauthorized|401|403/i.test(String(msg));
      throw new AgentError(`claude reported an error: ${msg}`, !isAuth, isAuth ? 'auth' : /rate.?limit|429|overloaded/i.test(String(msg)) ? 'rate-limit' : 'unknown', payload.session_id ?? sessionId, !!payload.session_id || confirmed);
    }
    const text = typeof payload.result === 'string' ? payload.result : '';
    let structured = payload.structured_output;
    if (req.schema && structured === undefined) {
      // Some versions answer in text only; accept a JSON body but never invent one.
      try {
        structured = extractJson(text);
      } catch {
        throw new AgentError('claude returned no structured_output for a schema request', true, 'bad-output', payload.session_id ?? sessionId, !!payload.session_id || confirmed);
      }
    }
    return {
      text,
      structured,
      sessionId: payload.session_id ?? sessionId,
      cli: this.cliInfo(d),
      costUsd: payload.total_cost_usd,
      inputTokens:
        (payload.usage?.input_tokens ?? 0) +
        (payload.usage?.cache_creation_input_tokens ?? 0) +
        (payload.usage?.cache_read_input_tokens ?? 0),
      outputTokens: payload.usage?.output_tokens,
      durationMs: r.durationMs,
      raw: r.stdout,
    };
  }
}

export class CodexCliAgent extends CliAgent {
  type = 'codex-cli' as const;
  constructor(id: string, cfg: AgentConfig) {
    super(id, cfg, 'codex');
  }

  async run(req: AgentRunRequest): Promise<AgentResult> {
    const d = await this.locate();
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'repobaton-codex-'));
    try {
      const args = ['exec'];
      if (req.sessionId) args.push('resume');
      args.push('--json', '--skip-git-repo-check');
      const model = req.model ?? this.cfg.model;
      if (model) args.push('-m', model);
      const effort = req.effort ?? this.cfg.effort;
      if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
      // `exec resume` has no --sandbox flag, so the sandbox goes through -c in both cases.
      args.push('-c', `sandbox_mode="${req.access}"`);
      if (req.schema) {
        const schemaFile = path.join(tmp, 'schema.json');
        await fs.writeFile(schemaFile, JSON.stringify(req.schema), 'utf8');
        args.push('--output-schema', schemaFile);
      }
      if (!req.persist) args.push('--ephemeral');
      args.push(...(this.cfg.extraArgs ?? []));
      if (req.sessionId) args.push(req.sessionId);
      args.push('-'); // prompt from stdin: avoids argv length limits on Windows

      req.onLaunch?.(this.cliInfo(d));
      const { launch, shell } = toLaunchWithShell(d.launch);
      const events: any[] = [];
      let threadId: string | undefined = req.sessionId;
      if (threadId) req.onSession?.(threadId);
      const r = await runLaunch(launch, args, {
        cwd: req.cwd,
        input: req.prompt,
        env: this.cfg.env,
        timeoutMs: req.timeoutMs,
        signal: req.signal,
        shell,
        onStdoutLine: (l) => {
          if (!l.startsWith('{')) return;
          try {
            const ev = JSON.parse(l);
            events.push(ev);
            if (ev.type === 'thread.started' && typeof ev.thread_id === 'string' && ev.thread_id !== threadId) {
              threadId = ev.thread_id;
              req.onSession?.(ev.thread_id);
            }
            if (ev.type === 'item.completed' && ev.item?.type === 'command_execution') {
              req.onProgress?.(`$ ${String(ev.item.command ?? '').slice(0, 160)}`);
            }
          } catch {
            /* ignore partial line */
          }
        },
      });
      if (r.aborted) throw new AgentError('cancelled', false, 'cancelled', threadId);
      if (r.timedOut) throw new AgentError(`codex timed out after ${Math.round(req.timeoutMs / 1000)}s`, true, 'timeout', threadId);
      if (r.error) throw new AgentError(`failed to start codex: ${r.error}`, false, 'not-found');

      const failed = events.find((e) => e.type === 'turn.failed' || e.type === 'error');
      const messages = events
        .filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')
        .map((e) => String(e.item.text ?? ''));
      const completed = events.filter((e) => e.type === 'turn.completed').pop();
      if (!completed || (r.code !== 0 && r.code !== null)) {
        const reason =
          failed?.error?.message ??
          failed?.message ??
          tail(stripAnsi(r.stderr), 600) ??
          `exit ${r.code}`;
        const isAuth = /auth|login|sign in|credit|quota|api key|unauthorized|401|403/i.test(String(reason));
        throw new AgentError(`codex failed: ${reason}`, !isAuth, isAuth ? 'auth' : /rate.?limit|429/i.test(String(reason)) ? 'rate-limit' : 'unknown', threadId);
      }
      const text = messages[messages.length - 1] ?? '';
      let structured: unknown;
      if (req.schema) {
        try {
          structured = extractJson(text);
        } catch {
          throw new AgentError('codex final message was not valid JSON for a schema request', true, 'bad-output', threadId);
        }
      }
      const thread = events.find((e) => e.type === 'thread.started');
      return {
        text,
        structured,
        sessionId: thread?.thread_id ?? req.sessionId,
        cli: this.cliInfo(d),
        inputTokens: completed.usage?.input_tokens,
        outputTokens: completed.usage?.output_tokens,
        durationMs: r.durationMs,
        raw: r.stdout,
      };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
