/**
 * FR-R3-008 (T375) — the thing that stands between one stdout line and one
 * memento write.
 *
 * Every persisted liveness update is a `setRun(queueId, …)`, which is a
 * whole-map read-modify-write on the store's serialize chain. A phase that emits
 * 10,000 lines emits 10,000 chunks' worth of activity, and forwarding each one
 * would reintroduce DATA-01's write amplification in `globalState`, a medium with
 * no rotation and no bound. So the monitor tells this class about every chunk and
 * this class forwards at most one observation per interval per Run.
 *
 * The bound is `1 + floor(elapsed / intervalMs)` writes for a Run, whatever the
 * line count: the first observation flushes on its leading edge, and every later
 * one flushes only once the interval has passed since the last flush.
 */

/**
 * How coarse a liveness stamp is allowed to be.
 *
 * Chosen against the two readers of the field. `computeFreshness` calls output
 * within 30 s `live` and within 90 s `slowing`, so a 15 s interval keeps a
 * genuinely streaming Run inside the `live` band across a reload — a 30 s
 * interval would leave it flickering to `slowing` on the strength of the
 * coalescing alone. And the monitor's own stall threshold is 90 s, so a Run this
 * class reports as quiet for two intervals is quiet by the in-memory reckoning
 * too, rather than merely under-sampled.
 */
export const ACTIVITY_COALESCE_INTERVAL_MS = 15_000;

/**
 * One coalesced observation: when the CLI last said something, and how much it
 * has said during this phase invocation.
 *
 * The counters are the monitor's per-invocation totals, which `onStart` resets,
 * and there is no line content and no path here by construction — this shape is
 * the whole of what crosses into the state tier.
 */
export interface RunActivityObservation {
  readonly runId: string;
  /** UTC ms, from the monitor's injected wall clock. */
  readonly at: number;
  readonly stdoutLines: number;
  readonly stderrLines: number;
}

/**
 * Where a flushed observation goes. MUST NOT throw: it is called from the
 * monitor's chunk path, and an exception there would abort the parse of a chunk
 * whose lines still need recording. The production handler is
 * `WorkflowController.recordRunActivity`, which absorbs its own failures.
 */
export interface ActivityRecorder {
  record(observation: RunActivityObservation): void;
}

export interface ActivityCoalescerOptions {
  /** The monitor's monotonic clock, so a wall-clock jump cannot widen or collapse the interval. */
  readonly monotonicNow: () => number;
  readonly recorder: ActivityRecorder;
  readonly intervalMs?: number;
}

export class ActivityCoalescer {
  private readonly lastFlushMonotonic = new Map<string, number>();
  private readonly monotonicNow: () => number;
  private readonly recorder: ActivityRecorder;
  private readonly intervalMs: number;

  constructor(opts: ActivityCoalescerOptions) {
    this.monotonicNow = opts.monotonicNow;
    this.recorder = opts.recorder;
    this.intervalMs = opts.intervalMs ?? ACTIVITY_COALESCE_INTERVAL_MS;
  }

  /**
   * Note that a Run produced output. Forwards it, or drops it.
   *
   * Dropped observations are **discarded, not buffered**: there is no timer here
   * and nothing scheduled for later. A timer would have to be cleared per Run on
   * dispose, and — worse — it would fire after the phase ended, writing a
   * liveness stamp into a record the driver may already have moved to a terminal
   * status. Dropping is sound because the next chunk carries a strictly better
   * observation than the one being dropped: a later timestamp and counters at
   * least as high. The cost is that the persisted stamp trails the true last
   * output by up to one interval, which `RunLiveness` documents.
   */
  public note(observation: RunActivityObservation): void {
    const now = this.monotonicNow();
    const last = this.lastFlushMonotonic.get(observation.runId);
    if (last !== undefined && now - last < this.intervalMs) return;
    this.lastFlushMonotonic.set(observation.runId, now);
    this.recorder.record(observation);
  }

  /**
   * Drop a Run's coalescing window.
   *
   * Called when its invocation ends, so the next invocation of the same Run
   * flushes on its own leading edge instead of inheriting the previous phase's
   * window and staying silent for up to an interval. This deliberately does not
   * flush a final observation: see `RunLiveness` for why the exact end-of-phase
   * totals are the audit summary's job, not this field's.
   */
  public forget(runId: string): void {
    this.lastFlushMonotonic.delete(runId);
  }

  public dispose(): void {
    this.lastFlushMonotonic.clear();
  }
}
