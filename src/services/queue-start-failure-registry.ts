// Feature 187 (T002, US1/US2) — FR-001..FR-004, FR-008.
//
// What a failed admission leaves behind. `AutoDrainCoordinator` refuses a drain
// at seven ordered steps; six of them are waits that a later trigger re-asks,
// and step 7 — the `admitNew`/`admitResume` call — is the one that can *throw*.
// No Run started, so no Run will terminate, and a terminal Run's registry-wide
// sweep is what re-asks every other refusal. Until this module existed, that
// throw's only trace was a log line.
//
// **In memory, and deliberately.** The drain is edge-triggered and activation
// sweeps every unheld queue on the next window start, so a persisted report
// would outlive the attempt it describes and be shown beside a newer attempt's
// result. A window's reports die with the window; the next window's first sweep
// produces its own.
//
// Keyed by **queue id**, not run id: the whole point is that no Run exists to
// key by. That is also why this is not `ProjectorBookkeepingRegistry` with
// another field — that registry keys by run id because an audit entry names its
// Run, and the two keyings are not interchangeable here.
//
// **NOT PRUNED, and that is a decision rather than an omission.** A queue
// deleted while carrying a report leaves an entry no reader can reach, because
// the projection only asks about queues that still exist. The bound is one small
// frozen object per queue id this window has ever *failed to start*, which for
// any real workspace is a handful, and all of it is released when the window
// ends. A `retainOnly(liveQueueIds)` sweep would be scaffolding for a leak that
// does not exist at this scale.

/** One queue's most recent failed start attempt. Frozen; latest wins. */
export interface QueueStartFailure {
  /** Which of the two admissions actually ran — they fail for unrelated reasons. */
  readonly admission: 'admitNew' | 'admitResume';
  /** Epoch millis, stamped by this registry's clock rather than by its caller. */
  readonly at: number;
  /**
   * The error's message, raw. Sanitizing happens at the projection seam, where
   * the sanitizer lives (`projectStartFailure`), so nothing here has to know
   * whether its reader is an operator surface or a test.
   */
  readonly message: string;
}

export class QueueStartFailureRegistry {
  private readonly byQueue = new Map<string, QueueStartFailure>();

  /**
   * The clock is injected because this registry — not the coordinator — owns the
   * timestamp. The coordinator reports *what* happened; the record says *when*.
   * Giving the drain a clock to pass would widen a module that has none.
   */
  constructor(private readonly now: () => number) {}

  /**
   * Records the failure, replacing any earlier one on the same queue. A history
   * would be a second and worse log; the log keeps the sequence (FR-011), and
   * what a surface needs is the answer to "did the last attempt fail".
   */
  recordFailure(
    queueId: string,
    failure: { readonly admission: 'admitNew' | 'admitResume'; readonly message: string }
  ): void {
    this.byQueue.set(
      queueId,
      Object.freeze({ admission: failure.admission, at: this.now(), message: failure.message })
    );
  }

  /**
   * Drops the report a later success supersedes. Idempotent: clearing a queue
   * that never failed is the ordinary case, since every successful start clears.
   */
  clear(queueId: string): void {
    this.byQueue.delete(queueId);
  }

  /** The queue's outstanding report, or `null` when its last attempt did not fail. */
  get(queueId: string): QueueStartFailure | null {
    return this.byQueue.get(queueId) ?? null;
  }
}
