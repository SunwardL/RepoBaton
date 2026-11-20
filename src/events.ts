import { promises as fs } from 'node:fs';
import path from 'node:path';
import { redactDeep, redactDiagnostic } from './redact.ts';
import { ensureDir, exists, nowIso } from './util.ts';

/**
 * One line of <run>/events.jsonl. Consumers (CLI --follow, the UI) rely only on
 * this shape, so extend it by adding optional fields, never by changing meaning.
 */
export interface RunEvent {
  /** Monotonic per run, starting at 1. Lets a reader resume with "after seq N". */
  seq: number;
  ts: string;
  runId: string;
  type: EventType;
  stage?: string;
  /** Short human-readable text. Never contains secrets. */
  message: string;
  data?: Record<string, unknown>;
}

export type EventType =
  | 'run.started'
  | 'run.resumed'
  | 'run.interrupted'
  | 'run.finished'
  | 'stage.started'
  | 'stage.finished'
  | 'agent.started'
  | 'agent.progress'
  | 'agent.failed'
  | 'test.finished'
  | 'review.decided'
  | 'plan.ready'
  | 'log.info'
  | 'log.warn'
  | 'log.error';

export interface EventSink {
  emit(type: EventType, message: string, extra?: { stage?: string; data?: Record<string, unknown> }): void;
  /** Resolves when every emitted event has been written. */
  flush(): Promise<void>;
}

export const noopSink: EventSink = { emit() {}, flush: async () => undefined };

export function eventsFile(runDir: string): string {
  return path.join(runDir, 'events.jsonl');
}

/** Appends events to a run's JSONL file in order, tolerating a restart (seq continues). */
export class FileEventSink implements EventSink {
  private file: string;
  private runId: string;
  private seq = 0;
  private chain: Promise<void>;

  private constructor(file: string, runId: string, startSeq: number) {
    this.file = file;
    this.runId = runId;
    this.seq = startSeq;
    this.chain = Promise.resolve();
  }

  static async open(runDir: string, runId: string): Promise<FileEventSink> {
    await ensureDir(runDir);
    const file = eventsFile(runDir);
    const existing = (await exists(file)) ? await readEvents(file) : [];
    const last = existing.length ? existing[existing.length - 1].seq : 0;
    return new FileEventSink(file, runId, last);
  }

  emit(type: EventType, message: string, extra: { stage?: string; data?: Record<string, unknown> } = {}): void {
    const event: RunEvent = {
      seq: ++this.seq,
      ts: nowIso(),
      runId: this.runId,
      type,
      stage: extra.stage,
      message: redactDiagnostic(message),
      data: extra.data ? redactDeep(extra.data, { assignments: true }) : undefined,
    };
    const line = JSON.stringify(event) + '\n';
    // Serialised appends keep lines whole and ordered even under concurrent emits.
    this.chain = this.chain.then(() => fs.appendFile(this.file, line, 'utf8')).catch(() => undefined);
  }

  flush(): Promise<void> {
    return this.chain;
  }
}

/** Parse a JSONL events file. A torn last line (crash mid-write) is skipped, not fatal. */
export async function readEvents(file: string, afterSeq = 0): Promise<RunEvent[]> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: RunEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as RunEvent;
      if (typeof ev.seq === 'number' && ev.seq > afterSeq) out.push(ev);
    } catch {
      /* torn or corrupt line */
    }
  }
  return out;
}

/** Statuses after which a run writes no more events until someone resumes it. */
export const SETTLED_STATUSES = ['succeeded', 'failed', 'cancelled', 'needs-human', 'awaiting-plan-approval', 'interrupted'];

export interface FollowOptions {
  /** Only deliver events with seq greater than this. */
  afterSeq?: number;
  pollMs?: number;
  signal?: AbortSignal;
  /** Called between polls; return true once the run will not produce more events. */
  isSettled: () => Promise<boolean>;
  onEvent: (event: RunEvent) => void;
}

/**
 * Deliver existing events, then new ones as they are appended, until the run
 * settles (or the signal aborts). A final read after "settled" catches events
 * written between the last poll and the status change.
 */
export async function followEvents(file: string, opts: FollowOptions): Promise<number> {
  let last = opts.afterSeq ?? 0;
  const pollMs = opts.pollMs ?? 400;
  const drain = async (): Promise<void> => {
    for (const ev of await readEvents(file, last)) {
      last = ev.seq;
      opts.onEvent(ev);
    }
  };
  for (;;) {
    await drain();
    if (opts.signal?.aborted) break;
    if (await opts.isSettled()) {
      await drain();
      break;
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, pollMs);
      opts.signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
    });
  }
  return last;
}

/** One terminal line per event; progress lines are indented so stages stand out. */
export function formatEventLine(ev: RunEvent): string {
  const time = ev.ts.slice(11, 19);
  const tag = ev.stage ? `[${ev.stage}]` : '';
  switch (ev.type) {
    case 'agent.progress':
      return `${time}     ${ev.message}`;
    case 'agent.failed': {
      const kind = typeof ev.data?.kind === 'string' ? ` (${ev.data.kind})` : '';
      return `${time} ${tag} FAILED${kind}: ${ev.message}`;
    }
    case 'run.finished':
      return `${time} == ${String(ev.data?.status ?? '')}${ev.message && ev.message !== ev.data?.status ? `: ${ev.message}` : ''}`;
    case 'run.started':
    case 'run.resumed':
      return `${time} == ${ev.type === 'run.started' ? 'started' : 'resumed'}: ${ev.message}`;
    case 'stage.started':
      return `${time} -- ${ev.message}`;
    default:
      return `${time} ${tag} ${ev.message}`.replace(/\s+/g, ' ');
  }
}
