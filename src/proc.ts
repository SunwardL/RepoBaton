import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface Launch {
  command: string;
  prefixArgs: string[];
  /** Windows .cmd fallback: args must be passed verbatim through cmd.exe. */
  verbatim?: boolean;
}

export interface RunOptions {
  command: string;
  args: string[];
  cwd?: string;
  input?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
  shell?: boolean;
  verbatim?: boolean;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  maxBuffer?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  /** Spawn failure (e.g. ENOENT). */
  error?: string;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).on('error', () => child.kill());
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function lineSplitter(cb?: (l: string) => void): { push(c: string): void; flush(): void } {
  let buf = '';
  return {
    push(chunk) {
      if (!cb) return;
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        cb(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
    },
    flush() {
      if (cb && buf) cb(buf.replace(/\r$/, ''));
      buf = '';
    },
  };
}

export function runProcess(opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const maxBuffer = opts.maxBuffer ?? 32 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let done = false;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...(opts.env ?? {}) })) {
      if (v !== undefined) env[k] = v;
    }

    let child: ChildProcess;
    try {
      child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: opts.shell,
        windowsVerbatimArguments: opts.verbatim,
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      resolve({
        code: null,
        stdout,
        stderr,
        timedOut,
        aborted,
        durationMs: 0,
        error: (e as Error).message,
      });
      return;
    }

    const finish = (code: number | null, error?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      outSplit.flush();
      errSplit.flush();
      resolve({ code, stdout, stderr, timedOut, aborted, durationMs: Date.now() - start, error });
    };

    const outSplit = lineSplitter(opts.onStdoutLine);
    const errSplit = lineSplitter(opts.onStderrLine);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
      if (stdout.length < maxBuffer) stdout += c;
      outSplit.push(c);
    });
    child.stderr?.on('data', (c: string) => {
      if (stderr.length < maxBuffer) stderr += c;
      errSplit.push(c);
    });
    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(code));

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, opts.timeoutMs)
      : undefined;
    const onAbort = (): void => {
      aborted = true;
      killTree(child);
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdin?.on('error', () => undefined);
    if (opts.input !== undefined) child.stdin?.write(opts.input);
    child.stdin?.end();
  });
}

export function runLaunch(
  launch: Launch,
  args: string[],
  opts: Omit<RunOptions, 'command' | 'args' | 'verbatim'>,
): Promise<RunResult> {
  return runProcess({
    ...opts,
    command: launch.command,
    args: [...launch.prefixArgs, ...args],
    verbatim: launch.verbatim,
  });
}

/** Run a user-supplied shell command line (test/setup commands). */
export function runShell(
  command: string,
  opts: Omit<RunOptions, 'command' | 'args' | 'shell'>,
): Promise<RunResult> {
  return runProcess({ ...opts, command, args: [], shell: true });
}

function quoteWin(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

/**
 * Turn an executable path into something spawn() can run directly. npm `.cmd`
 * shims are unwrapped to the real .exe/.js they point to, because passing prompts
 * and JSON through cmd.exe is fragile.
 */
export async function resolveLaunch(file: string): Promise<Launch> {
  if (process.platform !== 'win32') return { command: file, prefixArgs: [] };
  const ext = path.extname(file).toLowerCase();
  if (ext === '.exe' || ext === '.com' || ext === '') return { command: file, prefixArgs: [] };
  if (ext === '.cmd' || ext === '.bat') {
    try {
      const text = await fs.readFile(file, 'utf8');
      const m = /"%(?:dp0|~dp0)%?[\\/]+([^"]+?\.(?:exe|js|cjs|mjs))"/i.exec(text);
      if (m) {
        const target = path.resolve(path.dirname(file), m[1].replace(/\\/g, path.sep));
        if (/\.exe$/i.test(target)) return { command: target, prefixArgs: [] };
        return { command: process.execPath, prefixArgs: [target] };
      }
    } catch {
      /* use cmd.exe fallback */
    }
    return { command: file, prefixArgs: [], verbatim: false };
  }
  return { command: file, prefixArgs: [] };
}

/** Quote helper for the cmd.exe fallback path. */
export function cmdLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteWin).join(' ');
}
