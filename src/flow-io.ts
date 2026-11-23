import { promises as fs } from 'node:fs';
import path from 'node:path';
import { badFilePath } from './flow.ts';
import type { InputRef } from './flow-types.ts';

/** `run-tests_2` -> `RUN_TESTS_2`. Two ids that map to the same name are rejected at validation. */
export function envName(stepId: string): string {
  return stepId.toUpperCase().replace(/-/g, '_');
}

export interface CommandEnvSource {
  /** Path of the file holding the task description. */
  taskFile: string;
  refs: InputRef[];
  /** Stored output file of a finished step. */
  outputFile: (step: string) => string;
  exitCode: (step: string) => number | undefined;
  /** Absolute path of a worktree file after the real-path check. */
  resolvedFile: (relative: string) => string;
}

/**
 * `RB_FILE_<n>` counts file references only, starting at 1, in the order they appear in `inputs`.
 * A task or step reference before a file does not shift the number. Documentation and the editor
 * hint use this same function so there is one rule.
 */
export function commandEnvNames(refs: InputRef[]): string[] {
  const names: string[] = [];
  let files = 0;
  for (const ref of refs) {
    switch (ref.kind) {
      case 'task': names.push('RB_TASK_FILE'); break;
      case 'step-output': names.push(`RB_STEP_${envName(ref.step)}_OUTPUT_FILE`); break;
      case 'step-exit-code': names.push(`RB_STEP_${envName(ref.step)}_EXIT_CODE`); break;
      case 'file': names.push(`RB_FILE_${++files}`); break;
    }
  }
  return names;
}

/**
 * Builds the environment a command step receives. Values are never spliced into the command line:
 * text goes through files (so size is not limited by the environment block) and only paths and
 * exit codes are variables. The variable VALUES are not interpreted by the engine or the shell, but
 * a command that expands them inside its own shell text must still quote them (paths may contain
 * spaces, & or %); that part is the command author's responsibility.
 */
export function commandEnv(src: CommandEnvSource): Record<string, string> {
  const env: Record<string, string> = {};
  const names = commandEnvNames(src.refs);
  src.refs.forEach((ref, index) => {
    const name = names[index];
    switch (ref.kind) {
      case 'task':
        env[name] = src.taskFile;
        break;
      case 'step-output':
        env[name] = src.outputFile(ref.step);
        break;
      case 'step-exit-code': {
        const code = src.exitCode(ref.step);
        if (code !== undefined) env[name] = String(code);
        break;
      }
      case 'file':
        env[name] = src.resolvedFile(ref.path);
        break;
    }
  });
  return env;
}

export type ReadResult =
  | { ok: true; text: string; bytes: number; truncated: boolean; realPath: string }
  | { ok: false; reason: string };

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Reads a file named by a `{{file:...}}` reference. The string check in `badFilePath` cannot see a
 * link inside the worktree that points elsewhere, so the real path is resolved and compared with
 * the real worktree root, and `.git`/`.repobaton` are re-checked on the resolved path.
 */
export async function readWorktreeFile(root: string, relative: string, opts: { maxBytes: number }): Promise<ReadResult> {
  const bad = badFilePath(relative);
  if (bad) return { ok: false, reason: bad };
  let realRoot: string;
  let real: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    return { ok: false, reason: '工作区不存在' };
  }
  try {
    real = await fs.realpath(path.resolve(realRoot, relative));
  } catch {
    return { ok: false, reason: `文件不存在：${relative}` };
  }
  if (!inside(realRoot, real)) return { ok: false, reason: `${relative} 实际指向工作区之外，已拒绝` };
  const parts = path.relative(realRoot, real).split(path.sep);
  if (parts.some((s) => s.toLowerCase() === '.git' || s.toLowerCase() === '.repobaton')) {
    return { ok: false, reason: `${relative} 实际指向 .git 或 .repobaton，已拒绝` };
  }
  const stat = await fs.stat(real);
  if (!stat.isFile()) return { ok: false, reason: `${relative} 不是普通文件` };
  const handle = await fs.open(real, 'r');
  try {
    const size = stat.size;
    const take = Math.min(size, opts.maxBytes);
    const buf = Buffer.alloc(take);
    const { bytesRead } = await handle.read(buf, 0, take, 0);
    const head = buf.subarray(0, bytesRead);
    if (head.includes(0)) return { ok: false, reason: `${relative} 看起来是二进制文件，不能作为文本引用` };
    // A cut in the middle of a multi-byte character would decode to U+FFFD; drop the partial tail.
    let end = head.length;
    if (size > opts.maxBytes) {
      let back = end;
      while (back > 0 && end - back < 4 && (head[back - 1] & 0xc0) === 0x80) back--;
      if (back > 0) {
        const lead = head[back - 1];
        const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
        if (end - (back - 1) < need) end = back - 1;
      }
    }
    return { ok: true, text: head.subarray(0, end).toString('utf8'), bytes: size, truncated: size > opts.maxBytes, realPath: real };
  } finally {
    await handle.close();
  }
}
