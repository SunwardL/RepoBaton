/**
 * One execution slot for the whole server process.
 *
 * The slot is taken synchronously, before any await, so two requests arriving in the
 * same tick cannot both pass the check. Starting a run, approving, rejecting and
 * resuming all need the slot; reading runs and events never do.
 */
export class BusyError extends Error {
  runId?: string;
  constructor(runId?: string) {
    super(runId ? `another run is already executing (${runId})` : 'another run is already executing');
    this.name = 'BusyError';
    this.runId = runId;
  }
}

export interface SlotHolder {
  /** Known once the run exists; a new run only learns its id after creation. */
  runId?: string;
  label: string;
  abort: AbortController;
}

export class ExecutionSlot {
  private holder: SlotHolder | null = null;

  get current(): SlotHolder | null {
    return this.holder;
  }

  /**
   * Run `work` while holding the slot. Throws BusyError at once if it is taken.
   * The slot is released when `work` settles, whatever the outcome.
   */
  async run<T>(label: string, work: (holder: SlotHolder) => Promise<T>): Promise<T> {
    if (this.holder) throw new BusyError(this.holder.runId);
    const holder: SlotHolder = { label, abort: new AbortController() };
    this.holder = holder;
    try {
      return await work(holder);
    } finally {
      this.holder = null;
    }
  }

  /** Abort the running work if it belongs to `runId`. */
  cancel(runId: string): boolean {
    if (this.holder?.runId !== runId) return false;
    this.holder.abort.abort();
    return true;
  }
}
