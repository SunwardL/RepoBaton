import { which } from '../discover.ts';
import { runProcess } from '../proc.ts';
import {
  AgentError,
  type Agent,
  type AgentConfig,
  type AgentResult,
  type AgentRunRequest,
} from '../types.ts';
import { extractJson, stripAnsi, tail } from '../util.ts';

/**
 * Generic adapter for any third-party coding agent that has a non-interactive
 * entry point (aider, gemini-cli, opencode, ...). The prompt goes in via stdin
 * or as the last argument; stdout is the answer. Placeholders in `args`:
 * {{model}} {{cwd}} {{access}}.
 */
export class CommandAgent implements Agent {
  type = 'command' as const;
  id: string;
  private cfg: AgentConfig;
  constructor(id: string, cfg: AgentConfig) {
    this.id = id;
    this.cfg = cfg;
  }

  describe(): string {
    return `command (${this.cfg.command})`;
  }

  async check(): Promise<{ ok: boolean; detail: string }> {
    const cmd = this.cfg.command ?? '';
    const found = await which(cmd);
    return found ? { ok: true, detail: found } : { ok: false, detail: `command not found: ${cmd}` };
  }

  async run(req: AgentRunRequest): Promise<AgentResult> {
    const cmd = this.cfg.command;
    if (!cmd) throw new AgentError(`agent "${this.id}" has no command`, false);
    const model = req.model ?? this.cfg.model ?? '';
    const sub = (s: string): string =>
      s.replace(/\{\{model\}\}/g, model).replace(/\{\{cwd\}\}/g, req.cwd).replace(/\{\{access\}\}/g, req.access);
    const args = (this.cfg.args ?? []).map(sub);
    let prompt = req.prompt;
    if (req.schema) {
      prompt += `\n\nReply with ONLY one JSON object matching this JSON schema:\n${JSON.stringify(req.schema)}`;
    }
    const viaArg = this.cfg.promptVia === 'arg';
    if (viaArg) args.push(prompt);
    const found = (await which(cmd)) ?? cmd;
    const r = await runProcess({
      command: found,
      args,
      cwd: req.cwd,
      input: viaArg ? undefined : prompt,
      env: this.cfg.env,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(found),
      onStderrLine: (l) => req.onProgress?.(stripAnsi(l)),
    });
    if (r.aborted) throw new AgentError('cancelled', false);
    if (r.timedOut) throw new AgentError(`${cmd} timed out`);
    if (r.error) throw new AgentError(`failed to start ${cmd}: ${r.error}`, false);
    if (r.code !== 0) throw new AgentError(`${cmd} exited ${r.code}: ${tail(stripAnsi(r.stderr || r.stdout), 600)}`);
    const text = stripAnsi(r.stdout).trim();
    let structured: unknown;
    if (req.schema) {
      try {
        structured = extractJson(text);
      } catch {
        throw new AgentError(`${cmd} output was not JSON for a schema request: ${text.slice(0, 200)}`);
      }
    }
    return { text, structured, durationMs: r.durationMs, raw: r.stdout };
  }
}
