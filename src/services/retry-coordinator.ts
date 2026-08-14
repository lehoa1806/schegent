import type { PhaseResult, WorkflowRun } from '../state/workflow-run';
import {
  RetryHandler,
  type DelayedRetryWatchdog,
  type RetryHandlerDeps
} from '../controller/retry-handler';
import type { SanitizedLogger } from '../lib/logger';
import type { GuardedRunService } from './guarded-run-service';

export type RateLimitHandler = (cause: string, run: WorkflowRun) => Promise<void>;

/** One queue's outstanding delayed-retry deadline (Feature 093, T045). */
interface PendingRetry {
  readonly firesAt: number;
  readonly cause: string;
}

export interface RetryCoordinatorDeps
  extends Omit<RetryHandlerDeps, 'armDelayedRetry' | 'getGuardedRunService'> {
  readonly logger: SanitizedLogger;
  readonly watchdog?: DelayedRetryWatchdog | null;
  /**
   * BUG-006 — guarded-run service may be wired later (extension.activate
   * order). The coordinator stores the latest reference; `RetryHandler`
   * reads via callback.
   */
  readonly guardedRunService?: Pick<
    GuardedRunService,
    'transitionToScheduledRestore' | 'emitSystemPauseRestoreUnavailable'
  > | null;
}

/**
 * Feature 013 T097 - owns retry-adjacent controller wiring that is not part
 * of the phase loop itself: late watchdog injection, rate-limit pause
 * callback dispatch, and the RetryHandler facade used by RunDriver.
 */
export class RetryCoordinator {
  private watchdog: DelayedRetryWatchdog | null;
  private guardedRunService: Pick<
    GuardedRunService,
    'transitionToScheduledRestore' | 'emitSystemPauseRestoreUnavailable'
  > | null;
  private rateLimitHandler: RateLimitHandler | null = null;
  private readonly retryHandler: RetryHandler;
  private readonly logger: SanitizedLogger;
  private readonly getRetryCap: () => number;
  private readonly now: () => number;
  /**
   * Feature 093 (T045) — per-queue delayed-retry deadlines, multiplexed onto the
   * window's one watchdog timer.
   *
   * `CreditWatchdog` holds a single `setTimeout` handle because credits are an
   * account-level resource and there is one `/status` to poll. A delayed retry
   * is the opposite: it is one Run's backoff, and before this feature the two
   * were the same object because a window could only have one Run. With N Runs
   * the single handle produces two distinct defects — Run B's
   * `cancelPendingTimer()` silently discards Run A's armed retry (FR-024: a
   * lifecycle control must affect only the named queue's Run), and B arming a
   * shorter backoff replaces A's handle outright, so A's retry never fires.
   *
   * The registry keeps one deadline per queue and arms the watchdog for the
   * **earliest** outstanding one, re-arming the next when that one is claimed.
   * The watchdog itself is untouched: N logical timers, one physical timer, and
   * the workspace-scoped pause record it writes stays the single record it was.
   */
  private readonly pendingRetries = new Map<string, PendingRetry>();
  /** The deadline currently armed on the watchdog, if any. */
  private armed: { readonly queueId: string; readonly firesAt: number } | null = null;

  constructor(deps: RetryCoordinatorDeps) {
    this.watchdog = deps.watchdog ?? null;
    this.guardedRunService = deps.guardedRunService ?? null;
    this.logger = deps.logger;
    this.getRetryCap = deps.getRetryCap;
    this.now = deps.clock ?? (() => Date.now());
    this.retryHandler = new RetryHandler({
      ...deps,
      // Feature 093 (T045) — the handler arms through the coordinator, not
      // through the watchdog directly, so every arm is recorded against the
      // queue that made it. The coordinator forwards to the real watchdog.
      armDelayedRetry: (queueId, cause, delayMs) =>
        this.armDelayedRetry(queueId, cause, delayMs),
      getGuardedRunService: () => this.guardedRunService
    });
  }

  public setWatchdog(watchdog: DelayedRetryWatchdog | null): void {
    this.watchdog = watchdog;
  }

  /**
   * BUG-006 — late injection point. `GuardedRunService` may be constructed
   * after the controller in `extension.activate()`. Wiring it here enables
   * the rate-limit → scheduled-restore branch in `scheduleQueuePauseAndFail`.
   */
  public setGuardedRunService(
    service: Pick<
      GuardedRunService,
      'transitionToScheduledRestore' | 'emitSystemPauseRestoreUnavailable'
    > | null
  ): void {
    this.guardedRunService = service;
  }

  public setRateLimitHandler(handler: RateLimitHandler): void {
    this.rateLimitHandler = handler;
  }

  /**
   * Feature 093 (T045) — arm `queueId`'s delayed-retry deadline.
   *
   * Recording precedes arming so a queue's deadline survives even when another
   * queue's is the one physically armed: the registry is the source of truth and
   * the watchdog handle is a projection of its earliest entry.
   */
  public async armDelayedRetry(
    queueId: string,
    cause: string,
    delayMs: number
  ): Promise<void> {
    const firesAt = this.now() + Math.max(0, delayMs);
    if (!this.watchdog) {
      this.logger.warn(
        `armDelayedRetry: watchdog not wired; persisted retry deadline ${firesAt} for queue ${queueId} cannot be re-armed without restart`
      );
      return;
    }
    this.pendingRetries.set(queueId, { firesAt, cause });
    await this.reconcileArmedTimer();
  }

  /**
   * Cancel a pending delayed-retry timer.
   *
   * Feature 093 (T045) — `queueId` names whose deadline to drop. Omitting it is
   * the window-wide form and drops every queue's, which is what a Clean All
   * means; the two are not interchangeable. Before this feature the parameter
   * did not exist because there was one deadline, so "cancel the pending timer"
   * and "cancel this Run's pending timer" were the same sentence. With N Runs an
   * unaddressed cancel from one queue's control path would discard a sibling's
   * armed retry, which FR-024 forbids: a lifecycle control affects only the
   * queue it names.
   *
   * Synchronous by contract — every call site is a control path that cannot
   * await. The physical timer is cleared inline; re-arming the next-earliest
   * deadline needs the watchdog's async `pauseAndPoll`, so it is dispatched and
   * its failure logged rather than thrown into a caller that cannot handle it.
   */
  public cancelPendingTimer(queueId?: string): void {
    if (queueId === undefined) {
      this.pendingRetries.clear();
      this.armed = null;
      this.watchdog?.cancelPendingTimer();
      return;
    }
    this.pendingRetries.delete(queueId);
    // Clear the physical timer unless a *different* queue owns it. Sibling
    // protection is the whole of what FR-024 asks for here, and nothing
    // narrower is safe: when `armed` is null the handle is not a tracked
    // per-queue deadline, and declining to clear it would silently drop a
    // cancel the caller already established was warranted — it gates on the
    // Run's persisted `pendingRetryAt`, which outlives this in-memory registry
    // across a restart and can therefore be set for a queue the registry has
    // not re-armed yet. Unconditional-when-unowned is also the pre-feature
    // behavior byte for byte, since a single-queue window has `armed` either
    // null or equal to the queue being cancelled.
    if (this.armed === null || this.armed.queueId === queueId) {
      this.armed = null;
      this.watchdog?.cancelPendingTimer();
    }
    void this.reconcileArmedTimer().catch((err) =>
      this.logger.warn(
        `cancelPendingTimer: re-arming the next delayed retry failed: ${(err as Error).message}`
      )
    );
  }

  /** True while `queueId` has a delayed-retry deadline that has not elapsed. */
  public hasPendingDelayedRetry(queueId: string): boolean {
    return this.pendingRetries.has(queueId);
  }

  /**
   * Feature 093 (T045) — remove and return every queue whose delayed-retry
   * deadline has elapsed, then re-arm the next-earliest.
   *
   * The watchdog's resume callback is window-level (one credit balance, one
   * `/status`), so it fires once and asks who it was for. Queues whose deadline
   * is still in the future keep their entry and are not resumed — without this
   * a short backoff on one queue would resume a sibling mid-backoff, because
   * `resumeExisting` does not consult `pendingRetryAt`.
   */
  public claimElapsedDelayedRetries(): readonly string[] {
    const at = this.now();
    const due: string[] = [];
    for (const [queueId, retry] of this.pendingRetries) {
      if (retry.firesAt <= at) due.push(queueId);
    }
    for (const queueId of due) this.pendingRetries.delete(queueId);
    if (this.armed !== null && due.includes(this.armed.queueId)) this.armed = null;
    void this.reconcileArmedTimer().catch((err) =>
      this.logger.warn(
        `claimElapsedDelayedRetries: re-arming the next delayed retry failed: ${(err as Error).message}`
      )
    );
    return due;
  }

  /**
   * Point the window's one watchdog timer at the earliest outstanding deadline.
   *
   * Idempotent: re-arming for the deadline already armed is a no-op, so the
   * common case (one queue in backoff) issues exactly the one `pauseAndPoll` the
   * pre-feature path issued, and `store.setWatchdog` is written no more often
   * than before.
   */
  private async reconcileArmedTimer(): Promise<void> {
    const watchdog = this.watchdog;
    if (!watchdog) return;
    let next: { queueId: string; retry: PendingRetry } | null = null;
    for (const [queueId, retry] of this.pendingRetries) {
      if (next === null || retry.firesAt < next.retry.firesAt) next = { queueId, retry };
    }
    if (next === null) {
      if (this.armed !== null) {
        this.armed = null;
        watchdog.cancelPendingTimer();
      }
      return;
    }
    if (this.armed?.queueId === next.queueId && this.armed.firesAt === next.retry.firesAt) {
      return;
    }
    this.armed = { queueId: next.queueId, firesAt: next.retry.firesAt };
    await watchdog.pauseAndPoll(next.retry.cause, {
      durationOverrideMs: Math.max(0, next.retry.firesAt - this.now()),
      skipStatusCheck: true
    });
  }

  /**
   * True when the current failure would consume the final configured retry.
   * RunDriver uses this read-only decision to convert an optional phase into
   * terminal failure evidence before RetryHandler mutates run/queue pause
   * state. Required phases continue through the existing handler unchanged.
   */
  public isRetryCapExhaustedOnNextFailure(run: WorkflowRun): boolean {
    return run.delayedRetryCount >= this.getRetryCap() - 1;
  }

  public async handleDelayedRetry(
    run: WorkflowRun,
    iteration: number,
    phaseResult: PhaseResult,
    cause: 'rate_limit' | 'transient_error',
    resetsAtMs: number | null,
    rateLimitMessage: string | null,
    originalCause?: string
  ): Promise<WorkflowRun> {
    return this.retryHandler.handleDelayedRetry(
      run,
      iteration,
      phaseResult,
      cause,
      resetsAtMs,
      rateLimitMessage,
      originalCause
    );
  }

  public async maybeEmitRetryRecovered(
    run: WorkflowRun,
    outcome: string
  ): Promise<WorkflowRun> {
    return this.retryHandler.maybeEmitRetryRecovered(run, outcome);
  }

  public async appendManualRetryAudit(input: {
    runId: string;
    phase: string;
    iteration: number;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.retryHandler.appendManualRetryAudit(input);
  }

  public async handleRateLimitPause(cause: string, run: WorkflowRun): Promise<void> {
    if (!this.rateLimitHandler) return;
    await this.rateLimitHandler(cause, run);
  }

  /**
   * Feature 093 (T045) — `queueId` names the queue whose persisted deadline is
   * being re-armed. After a crash mid-concurrency the activation sweep can find
   * several Runs each holding its own `pendingRetryAt`, and each re-arm has to
   * enter the registry under its own key or the last one read would be the only
   * one that survived.
   */
  public async resumeExistingFromActivation(
    queueId: string,
    run: WorkflowRun,
    resumeExisting: () => Promise<void>
  ): Promise<void> {
    if (run.pendingRetryAt === null || run.pendingRetryCause === null) return;
    const delay = Math.max(0, run.pendingRetryAt - this.now());
    if (delay === 0) {
      setImmediate(() => {
        void resumeExisting().catch((err) =>
          this.logger.warn(
            `resumeExistingFromActivation resume failed: ${(err as Error).message}`
          )
        );
      });
      return;
    }
    try {
      await this.armDelayedRetry(queueId, run.pendingRetryCause, delay);
    } catch (err) {
      this.logger.warn(
        `resumeExistingFromActivation: re-arming the delayed retry failed for run ${run.id}: ${(err as Error).message}`
      );
    }
  }
}
