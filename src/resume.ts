import type { StageSession } from './types.ts';

/**
 * How a CLI was launched when it created a session. `path` is the executable the user configured or
 * RepoBaton found; `command` and `prefixArgs` are set when that path is a launcher that RepoBaton
 * unwraps (an npm .cmd shim becomes `node <script>`), so the continue command runs the same thing.
 */
export interface CliLaunchInfo {
  path: string;
  command?: string;
  prefixArgs?: string[];
}

/** Characters CMD treats specially. A value containing one is refused rather than escaped. */
const UNSAFE_FOR_CMD = /[&|<>^%"!\r\n\0]/;
const SESSION_ID = /^[A-Za-z0-9._-]{8,128}$/;

function quote(value: string): string | null {
  if (!value || UNSAFE_FOR_CMD.test(value)) return null;
  return /[\s()]/.test(value) ? `"${value}"` : value;
}

type Resumable = Pick<StageSession, 'agentType' | 'sessionId' | 'cwd'> & { cli?: CliLaunchInfo; sessionConfirmed?: boolean };

/**
 * The Windows CMD line that continues a session from its own working directory. Returns null when
 * there is nothing safe and correct to offer: no session id, an agent without native sessions, or a
 * value that cannot be placed on a command line without escaping.
 *
 * Records written before the launch was recorded have no `cli`; they fall back to the bare
 * `codex` / `claude` name, which is what the page offered before.
 */
export function resumeCommand(s: Resumable): string | null {
  if (!s.sessionId || !SESSION_ID.test(s.sessionId)) return null;
  const verb = s.agentType === 'codex-cli' ? ['resume', s.sessionId] : s.agentType === 'claude-cli' ? ['--resume', s.sessionId] : null;
  if (!verb) return null;
  const bare = s.agentType === 'codex-cli' ? 'codex' : 'claude';
  const parts = s.cli ? [s.cli.command ?? s.cli.path, ...(s.cli.prefixArgs ?? [])].map(quote) : [bare];
  const cwd = quote(s.cwd);
  if (!cwd || parts.some((p) => p === null)) return null;
  return `cd /d ${cwd} && ${(parts as string[]).join(' ')} ${verb.join(' ')}`;
}
