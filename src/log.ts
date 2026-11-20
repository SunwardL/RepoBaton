import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { stripAnsi } from './util.ts';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  stage(stage: string, msg: string): void;
  detail(msg: string): void;
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number, s: string): string => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);

export function createLogger(opts: { file?: string; quiet?: boolean; verbose?: boolean } = {}): Logger {
  if (opts.file) mkdirSync(path.dirname(opts.file), { recursive: true });
  const write = (level: string, msg: string): void => {
    if (!opts.file) return;
    try {
      appendFileSync(opts.file, `${new Date().toISOString()} ${level} ${stripAnsi(msg)}\n`);
    } catch {
      /* logging must never break a run */
    }
  };
  const out = (s: string): void => {
    if (!opts.quiet) process.stderr.write(s + '\n');
  };
  return {
    info(msg) {
      out(msg);
      write('INFO', msg);
    },
    warn(msg) {
      out(c(33, `! ${msg}`));
      write('WARN', msg);
    },
    error(msg) {
      out(c(31, `x ${msg}`));
      write('ERROR', msg);
    },
    stage(stage, msg) {
      out(`${c(36, `[${stage}]`)} ${msg}`);
      write('STAGE', `[${stage}] ${msg}`);
    },
    detail(msg) {
      if (opts.verbose) out(c(90, `    ${msg}`));
      write('DETAIL', msg);
    },
  };
}

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  stage() {},
  detail() {},
};
