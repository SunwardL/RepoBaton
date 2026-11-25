import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { STEP_ID_PATTERN } from './flow-types.ts';
import { boundedView, cutUtf8, type StepOutput } from './flow-render.ts';
import { redactDiagnostic } from './redact.ts';
import { exists, readJson, writeFileAtomic, writeJson } from './util.ts';

/** Stored output cap, matching the existing raw artifact cap. */
export const MAX_STORED_DEFAULT = 2_000_000;
/** Default and hard ceiling for the part injected into a later prompt. */
export const MAX_INJECT_DEFAULT = 32 * 1024;
export const MAX_INJECT_HARD = 256 * 1024;

export interface StepMetaInput {
  status: string;
  startedAt: string;
  finishedAt?: string;
  agent?: string;
  sessionId?: string;
  exitCode?: number;
  error?: string;
}

export interface StepMeta extends StepMetaInput {
  /** Size of the redacted output before the storage cut. */
  originalBytes: number;
  storedBytes: number;
  storedTruncated: boolean;
  /** Checksum of what is on disk, checked again on every read. */
  sha256: string;
}

/** Directory for one step. The id is validated so it can never point outside the run directory. */
export function stepDir(runDir: string, stepId: string): string {
  if (!STEP_ID_PATTERN.test(stepId)) throw new Error(`步骤 id 不合法：${JSON.stringify(stepId)}`);
  return path.join(runDir, 'steps', stepId);
}

const relativeOutput = (stepId: string) => `steps/${stepId}/output.txt`;

/** Keep a redacted, bounded record of the exact input sent on this attempt. */
export async function writeStepPrompt(runDir: string, stepId: string, attempt: number, prompt: string): Promise<{ attempt: number; sha256: string; truncated: boolean; originalBytes: number }> {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('invalid prompt attempt');
  const masked = redactDiagnostic(prompt);
  const originalBytes = Buffer.byteLength(masked);
  const cut = cutUtf8(masked, MAX_INJECT_HARD);
  const stored = cut.cut ? `${cut.text}\n[提示词记录已截断，原始 ${originalBytes} 字节]\n` : cut.text;
  await writeFileAtomic(path.join(stepDir(runDir, stepId), `prompt-${attempt}.txt`), stored, 0o600);
  return { attempt, sha256: createHash('sha256').update(stored).digest('hex'), truncated: cut.cut, originalBytes };
}

export async function readStepPrompt(runDir: string, stepId: string, ref: { attempt: number; sha256: string }): Promise<string> {
  if (!Number.isSafeInteger(ref.attempt) || ref.attempt < 1 || !/^[0-9a-f]{64}$/.test(ref.sha256)) throw new Error('invalid prompt record');
  const text = await fs.readFile(path.join(stepDir(runDir, stepId), `prompt-${ref.attempt}.txt`), 'utf8');
  if (createHash('sha256').update(text).digest('hex') !== ref.sha256) throw new Error('prompt record is corrupt');
  return text;
}

/**
 * Stores a step's output. Masking happens before the storage cut: a secret that straddles the cut
 * would otherwise leave an unmasked prefix on disk.
 */
export async function writeStepOutput(
  runDir: string,
  stepId: string,
  output: string,
  input: StepMetaInput,
  opts: { maxStoredBytes?: number } = {},
): Promise<{ meta: StepMeta; file: string }> {
  const dir = stepDir(runDir, stepId);
  const masked = redactDiagnostic(output);
  const originalBytes = Buffer.byteLength(masked);
  const cap = opts.maxStoredBytes ?? MAX_STORED_DEFAULT;
  const cut = cutUtf8(masked, cap);
  const stored = cut.cut
    ? `${cut.text}\n[已截断：原始 ${originalBytes} 字节，只保存了前 ${Buffer.byteLength(cut.text)} 字节]\n`
    : cut.text;
  const file = path.join(dir, 'output.txt');
  await writeFileAtomic(file, stored);
  const meta: StepMeta = {
    ...input,
    error: input.error === undefined ? undefined : redactDiagnostic(input.error),
    originalBytes,
    storedBytes: Buffer.byteLength(stored),
    storedTruncated: cut.cut,
    sha256: createHash('sha256').update(stored).digest('hex'),
  };
  await writeJson(path.join(dir, 'meta.json'), meta);
  return { meta, file };
}

export interface ReadOptions {
  maxInjectBytes?: number;
}

/**
 * Reads a stored output in the shape the renderer needs. A missing step, a failed step or a file
 * that no longer matches its recorded checksum never yields text.
 */
export async function readStepOutput(runDir: string, stepId: string, opts: ReadOptions = {}): Promise<StepOutput> {
  const rel = relativeOutput(stepId);
  const dir = stepDir(runDir, stepId);
  const empty = (status: string): StepOutput => ({ status, text: '', truncated: false, originalBytes: 0, path: rel });
  const metaFile = path.join(dir, 'meta.json');
  if (!(await exists(metaFile))) return empty('missing');
  let meta: StepMeta;
  try {
    meta = await readJson<StepMeta>(metaFile);
  } catch {
    return empty('corrupt');
  }
  if (meta.status !== 'succeeded') return empty(meta.status);
  let stored: string;
  try {
    stored = await fs.readFile(path.join(dir, 'output.txt'), 'utf8');
  } catch {
    return empty('corrupt');
  }
  if (createHash('sha256').update(stored).digest('hex') !== meta.sha256) return empty('corrupt');
  const limit = Math.min(opts.maxInjectBytes ?? MAX_INJECT_DEFAULT, MAX_INJECT_HARD);
  // When the stored copy is already partial, the marker must not claim the full text is in the file.
  const view = boundedView(stored, limit, meta.storedTruncated ? undefined : rel);
  return {
    status: 'succeeded',
    text: view.text,
    truncated: view.truncated || meta.storedTruncated,
    storedTruncated: meta.storedTruncated,
    originalBytes: meta.originalBytes,
    path: rel,
  };
}

/**
 * The only way a command step gets the path of an earlier output: the status and the checksum are
 * checked first, exactly as for prompt injection. `commandEnv` only assembles paths and does not check.
 */
export async function stepOutputFile(runDir: string, stepId: string): Promise<{ ok: true; file: string } | { ok: false; reason: string }> {
  const o = await readStepOutput(runDir, stepId);
  if (o.status !== 'succeeded') return { ok: false, reason: `步骤 ${stepId} 没有可用输出（状态：${o.status}）` };
  return { ok: true, file: path.join(stepDir(runDir, stepId), 'output.txt') };
}
