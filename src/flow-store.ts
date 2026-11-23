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
  const view = boundedView(stored, limit, rel);
  return {
    status: 'succeeded',
    text: view.text,
    truncated: view.truncated || meta.storedTruncated,
    originalBytes: meta.originalBytes,
    path: rel,
  };
}
