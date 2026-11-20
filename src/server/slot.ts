/**
 * One execution slot per Git repository, held by this server process.
 *
 * Different repositories can each run a task at the same time; a second task on
 * the same repository is refused. The slot is taken synchronously, before any
 * await, so two requests arriving in the same tick cannot both pass the check.
 * Starting a run, approving, rejecting and resuming all need the slot; reading
 * runs and events never does.
 */
export class BusyError extends Error {
  runId?: string;
  repoKey: string;
  constructor(repoKey: string, runId?: string) {
    super(runId ? `this repository is already executing a run (${runId})` : 'this repository is already executing a run');
    this.name = 'BusyError';
    this.repoKey = repoKey;
    this.runId = runId;
  }
}

export interface SlotHolder {
  /** Known once the run exists; a new run only learns its id after creation. */
  runId?: string;
  label: string;
  abort: AbortController;
  startedAt: number;
}

export class ExecutionSlots {
  private holders = new Map<string, SlotHolder>();

  current(repoKey: string): SlotHolder | null {
    return this.holders.get(repoKey) ?? null;
  }

  /** Every repository that is executing something right now. */
  active(): Array<{ repoKey: string; holder: SlotHolder }> {
    return [...this.holders].map(([repoKey, holder]) => ({ repoKey, holder }));
  }

  /** Is this run being executed by this server right now? */
  isExecuting(runId: string): boolean {
    for (const h of this.holders.values()) if (h.runId === runId) return true;
    return false;
  }

  /**
   * Run `work` while holding the repository's slot. Throws BusyError at once if
   * it is taken. The slot is released when `work` settles, whatever the outcome.
   */
  async run<T>(repoKey: string, label: string, work: (holder: SlotHolder) => Promise<T>): Promise<T> {
    const taken = this.holders.get(repoKey);
    if (taken) throw new BusyError(repoKey, taken.runId);
    const holder: SlotHolder = { label, abort: new AbortController(), startedAt: Date.now() };
    this.holders.set(repoKey, holder);
    try {
      return await work(holder);
    } finally {
      this.holders.delete(repoKey);
    }
  }

  /** Abort the work in `repoKey` if it belongs to `runId`. */
  cancel(repoKey: string, runId: string): boolean {
    const h = this.holders.get(repoKey);
    if (!h || h.runId !== runId) return false;
    h.abort.abort();
    return true;
  }

  abortAll(): void {
    for (const h of this.holders.values()) h.abort.abort();
  }
}
