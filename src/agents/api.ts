import { resolveApiKey } from '../config.ts';
import { registerSecret } from '../redact.ts';
import {
  AgentError,
  type AgentErrorKind,
  type Agent,
  type AgentConfig,
  type AgentResult,
  type AgentRunRequest,
} from '../types.ts';
import { extractJson, validateSchema } from '../util.ts';
import { execTool, toolSpecs } from './tools.ts';

const SCHEMA_TOOL = 'submit_result';

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  outer?: AbortSignal,
): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const onAbort = (): void => ctrl.abort(new Error('cancelled'));
  outer?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      const kind: AgentErrorKind =
        res.status === 401 || res.status === 403
          ? 'auth'
          : res.status === 429
            ? 'rate-limit'
            : res.status === 404
              ? 'not-found'
              : res.status === 408
                ? 'timeout'
                : 'unknown';
      throw new AgentError(`HTTP ${res.status} from ${url}: ${text.slice(0, 500)}`, retryable, kind);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new AgentError(`non-JSON response from ${url}: ${text.slice(0, 300)}`, true, 'bad-output');
    }
  } catch (e) {
    if (e instanceof AgentError) throw e;
    if (outer?.aborted) throw new AgentError('cancelled', false, 'cancelled');
    // Node's fetch hides the real reason in `cause` ("fetch failed" alone tells the user nothing).
    const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause;
    const reason = cause?.code ?? cause?.message ?? (e as Error).message;
    // Our own timer aborts with the message "timeout"; everything else is a transport failure.
    const timedOut = ctrl.signal.aborted && String((ctrl.signal.reason as Error | undefined)?.message) === 'timeout';
    throw new AgentError(
      `request to ${url} failed: ${reason}`,
      true,
      timedOut ? 'timeout' : 'network',
    );
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

function joinUrl(base: string, suffix: string): string {
  return base.replace(/\/+$/, '') + suffix;
}

function schemaInstruction(schema: Record<string, unknown>): string {
  return `\n\nWhen you are finished, reply with ONLY one JSON object (no prose, no code fence) matching this JSON schema:\n${JSON.stringify(schema)}`;
}

abstract class ApiAgent implements Agent {
  abstract type: Agent['type'];
  id: string;
  protected cfg: AgentConfig;
  constructor(id: string, cfg: AgentConfig) {
    this.id = id;
    this.cfg = cfg;
  }
  protected abstract defaultBase: string;
  protected abstract keyEnv: string;

  describe(): string {
    return `${this.type} (${this.cfg.model ?? '?'} @ ${this.cfg.baseUrl ?? this.defaultBase})`;
  }

  protected key(): string {
    const k = resolveApiKey(this.cfg, this.keyEnv);
    if (!k) {
      throw new AgentError(
        `no API key for agent "${this.id}": set ${this.cfg.apiKeyEnv ?? this.keyEnv} in the environment`,
        false,
        'auth',
      );
    }
    // The user may choose an env name that does not look like a credential name.
    registerSecret(k);
    return k;
  }

  async check(): Promise<{ ok: boolean; detail: string }> {
    const hasKey = !!resolveApiKey(this.cfg, this.keyEnv);
    const model = this.cfg.model ?? '(model not set)';
    return hasKey
      ? { ok: true, detail: `${model} @ ${this.cfg.baseUrl ?? this.defaultBase}` }
      : { ok: false, detail: `missing env ${this.cfg.apiKeyEnv ?? this.keyEnv}` };
  }

  abstract run(req: AgentRunRequest): Promise<AgentResult>;

  protected finish(
    req: AgentRunRequest,
    text: string,
    usage: { in?: number; out?: number },
    started: number,
    raw: unknown,
    structuredFromTool?: unknown,
  ): AgentResult {
    let structured = structuredFromTool;
    if (req.schema && structured === undefined) {
      try {
        structured = extractJson(text);
      } catch {
        throw new AgentError(`model did not return JSON matching the schema: ${text.slice(0, 200)}`, true, 'bad-output');
      }
    }
    if (req.schema) {
      const errs = validateSchema(req.schema, structured);
      if (errs.length) throw new AgentError(`model JSON failed schema validation: ${errs.slice(0, 4).join('; ')}`, true, 'bad-output');
    }
    return {
      text,
      structured,
      inputTokens: usage.in,
      outputTokens: usage.out,
      durationMs: Date.now() - started,
      raw: JSON.stringify(raw),
    };
  }
}

export class OpenAiCompatibleAgent extends ApiAgent {
  type = 'openai-compatible' as const;
  protected defaultBase = 'https://api.openai.com/v1';
  protected keyEnv = 'OPENAI_API_KEY';

  async run(req: AgentRunRequest): Promise<AgentResult> {
    const started = Date.now();
    const model = req.model ?? this.cfg.model;
    if (!model) throw new AgentError(`agent "${this.id}" has no model configured`, false, 'not-found');
    const key = this.key();
    const url = joinUrl(this.cfg.baseUrl ?? this.defaultBase, '/chat/completions');
    const headers = { authorization: `Bearer ${key}`, ...(this.cfg.headers ?? {}) };
    const tools = toolSpecs(req.access, !!this.cfg.allowShell).map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    const messages: any[] = [
      { role: 'user', content: req.prompt + (req.schema ? schemaInstruction(req.schema) : '') },
    ];
    const maxSteps = this.cfg.maxSteps ?? 30;
    let inTok = 0;
    let outTok = 0;
    for (let step = 0; step < maxSteps; step++) {
      const remaining = req.timeoutMs - (Date.now() - started);
      if (remaining <= 0) throw new AgentError('API agent timed out', true, 'timeout');
      const body: Record<string, unknown> = { model, messages, tools, max_tokens: this.cfg.maxTokens ?? 8192 };
      if (this.cfg.temperature !== undefined) body.temperature = this.cfg.temperature;
      const effort = req.effort ?? this.cfg.effort;
      if (effort) body.reasoning_effort = effort;
      const res = await postJson(url, headers, body, remaining, req.signal);
      inTok += res.usage?.prompt_tokens ?? 0;
      outTok += res.usage?.completion_tokens ?? 0;
      const msg = res.choices?.[0]?.message;
      if (!msg) throw new AgentError(`unexpected response shape: ${JSON.stringify(res).slice(0, 300)}`, true, 'bad-output');
      messages.push(msg);
      const calls: any[] = msg.tool_calls ?? [];
      if (calls.length === 0) {
        return this.finish(req, String(msg.content ?? ''), { in: inTok, out: outTok }, started, messages);
      }
      for (const c of calls) {
        let args: Record<string, any> = {};
        try {
          args = JSON.parse(c.function?.arguments || '{}');
        } catch {
          /* report below */
        }
        req.onProgress?.(`tool ${c.function?.name}`);
        const out = await execTool(c.function?.name, args, req.cwd, {
          access: req.access,
          allowShell: !!this.cfg.allowShell,
          timeoutMs: Math.max(1000, req.timeoutMs - (Date.now() - started)),
          signal: req.signal,
        });
        messages.push({ role: 'tool', tool_call_id: c.id, content: out });
      }
    }
    throw new AgentError(`API agent exceeded ${maxSteps} tool steps without finishing`, false);
  }
}

export class AnthropicCompatibleAgent extends ApiAgent {
  type = 'anthropic-compatible' as const;
  protected defaultBase = 'https://api.anthropic.com';
  protected keyEnv = 'ANTHROPIC_API_KEY';

  async run(req: AgentRunRequest): Promise<AgentResult> {
    const started = Date.now();
    const model = req.model ?? this.cfg.model;
    if (!model) throw new AgentError(`agent "${this.id}" has no model configured`, false, 'not-found');
    const key = this.key();
    const base = (this.cfg.baseUrl ?? this.defaultBase).replace(/\/+$/, '');
    const url = joinUrl(base, base.endsWith('/v1') ? '/messages' : '/v1/messages');
    const headers = {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      ...(this.cfg.headers ?? {}),
    };
    const tools: any[] = toolSpecs(req.access, !!this.cfg.allowShell).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
    if (req.schema) {
      tools.push({
        name: SCHEMA_TOOL,
        description: 'Submit the final structured result. Call this exactly once when you are done.',
        input_schema: req.schema,
      });
    }
    const messages: any[] = [{ role: 'user', content: req.prompt }];
    const maxSteps = this.cfg.maxSteps ?? 30;
    let inTok = 0;
    let outTok = 0;
    for (let step = 0; step < maxSteps; step++) {
      const remaining = req.timeoutMs - (Date.now() - started);
      if (remaining <= 0) throw new AgentError('API agent timed out', true, 'timeout');
      const body: Record<string, unknown> = {
        model,
        messages,
        tools,
        max_tokens: this.cfg.maxTokens ?? 8192,
      };
      if (this.cfg.temperature !== undefined) body.temperature = this.cfg.temperature;
      const res = await postJson(url, headers, body, remaining, req.signal);
      inTok += res.usage?.input_tokens ?? 0;
      outTok += res.usage?.output_tokens ?? 0;
      const content: any[] = res.content ?? [];
      messages.push({ role: 'assistant', content });
      const uses = content.filter((b) => b.type === 'tool_use');
      const text = content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const submit = uses.find((u) => u.name === SCHEMA_TOOL);
      if (submit) {
        return this.finish(req, text, { in: inTok, out: outTok }, started, messages, submit.input);
      }
      if (uses.length === 0) {
        return this.finish(req, text, { in: inTok, out: outTok }, started, messages);
      }
      const results: any[] = [];
      for (const u of uses) {
        req.onProgress?.(`tool ${u.name}`);
        const out = await execTool(u.name, u.input ?? {}, req.cwd, {
          access: req.access,
          allowShell: !!this.cfg.allowShell,
          timeoutMs: Math.max(1000, req.timeoutMs - (Date.now() - started)),
          signal: req.signal,
        });
        results.push({ type: 'tool_result', tool_use_id: u.id, content: out });
      }
      messages.push({ role: 'user', content: results });
    }
    throw new AgentError(`API agent exceeded ${maxSteps} tool steps without finishing`, false);
  }
}
