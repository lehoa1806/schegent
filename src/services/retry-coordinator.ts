import type { PhaseResult, WorkflowRun } from '../state/workflow-run';
import { RetryHandler, type RetryHandlerDeps } from '../controller/retry-handler';
import type { SanitizedLogger } from '../lib/logger';
import type { GuardedRunService } from './guarded-run-service';
import type { UnattendedWakeup } from './unattended-eligibility';

export type RateLimitHandler = (cause: string, run: WorkflowRun) => Promise<void>;

/** One queue's outstanding delayed-retry deadline (Feature 093, T045). */
interface PendingRetry {
  readonly firesAt: number;
  readonly cause: string;
}

/**
 * FR-R4-F02 (contract U5) — the coordinator's timer, as a port so a test moves time itself. The
 * default is a real `setTimeout` that does not keep the host alive.
 */
export interface DeadlineTimer {
  set(fn: () => void, delayMs: number): { clear(): void };
}

/** A queue whose delayed-retry deadline has elapsed, as the wakeup the admission service takes. */
export type BackoffWakeup = Extract<UnattendedWakeup, { cause: 'backoff-elapsed' }>;

/**
 * The longest delay one platform timer takes (2^31 - 1 ms, about 24.8 days). A deadline further out
 * arms for this much, wakes, claims nothing (a claim takes only entries whose time has come), and
 * re-arms for what remains, so a long backoff is never clamped into an early resume.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const realTimer: DeadlineTimer = {
  set(fn, delayMs) {
    const handle = setTimeout(fn, delayMs);
    handle.unref();
    return { clear: () => clearTimeout(handle) };
  }
};

/** Fixed, so a failing handler leaks neither a queue, a Run nor an error message into the log. */
const BACKOFF_HANDLER_FAILED_LINE = 'retry coordinator: the backoff-elapsed handler failed';
const BACKOFF_NOT_WIRED_LINE = 'retry: a backoff elapsed before unattended admission was wired';

/**
 * FR-R4-F02 (TA5, contract U5 G17) — where an elapsed deadline goes. The admission service is built
 * after the controller, so the handler is bound late, as the rate-limit handler is. Every outcome it
 * reports back, whichever it was, re-arms the coordinator's earliest remaining deadline.
 */
export class BackoffHandOff {
  private handler: ((wakeup: BackoffWakeup) => unknown) | null = null;

  constructor(
    private readonly logger: Pick<SanitizedLogger, 'warn'>,
    private readonly noteOutcome: () => void
  ) {}

  public bind(handler: (wakeup: BackoffWakeup) => unknown): void {
    this.handler = handler;
  }

  /** The coordinator's `onBackoffElapsed`. */
  public handOff(wakeup: BackoffWakeup): unknown {
    if (this.handler === null) {
      this.logger.warn(BACKOFF_NOT_WIRED_LINE);
      return undefined;
    }
    const handled = this.handler(wakeup);
    void Promise.resolve(handled).then(this.noteOutcome, this.noteOutcome);
    return handled;
  }
}

export interface RetryCoordinatorDeps
  extends Omit<RetryHandlerDeps, 'armDelayedRetry' | 'getGuardedRunService'> {
  readonly logger: SanitizedLogger;
  /** FR-R4-F02 (U5 G16) — the coordinator arms its own timer; the default is a real one. */
  readonly timer?: DeadlineTimer;
  /**
   * FR-R4-F02 (U5 G17) — called once per queue whose deadline has elapsed, in deadline order, and
   * never awaited: a Run that runs for hours must not hold the timer that wakes the next queue.
   */
  readonly onBackoffElapsed: (wakeup: BackoffWakeup) => unknown;
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
 * of the phase loop itself: rate-limit pause callback dispatch, the per-queue
 * delayed-retry deadlines on a timer of its own, and the RetryHandler facade
 * used by RunDriver.
 */
export class RetryCoordinator {
  private guardedRunService: Pick<
    GuardedRunService,
    'transitionToScheduledRestore' | 'emitSystemPauseRestoreUnavailable'
  > | null;
  private rateLimitHandler: RateLimitHandler | null = null;
  private readonly retryHandler: RetryHandler;
  private readonly logger: SanitizedLogger;
  private readonly getRetryCap: () => number;
  private readonly now: () => number;
  private readonly timer: DeadlineTimer;
  private readonly onBackoffElapsed: (wakeup: BackoffWakeup) => unknown;
  /**
   * Feature 093 (T045) — per-queue delayed-retry deadlines, on one physical timer.
   *
   * A delayed retry is one Run's backoff. With N Runs the deadline is per queue, and a single handle
   * produces two distinct defects — one queue's `cancelPendingTimer()` silently discards a sibling's
   * armed retry (FR-024: a lifecycle control must affect only the named queue's Run), and a queue
   * arming a shorter backoff replaces the handle outright, so the longer one never fires.
   *
   * The registry keeps one deadline per queue and arms the timer for the **earliest** outstanding
   * one, re-arming the next when that one is claimed.
   *
   * FR-R4-F02 (U5 G16) — the timer is the coordinator's OWN. It used to be the credit watchdog's,
   * shared with the credit poll, so a delayed retry carried a skip flag across a boundary it did not
   * own, and a fire that landed while the watchdog's resume was still in progress was dropped. The
   * watchdog now polls credits only.
   */
  private readonly pendingRetries = new Map<string, PendingRetry>();
  /** The deadline currently armed, with the handle that can clear it. */
  private armed: {
    readonly queueId: string;
    readonly firesAt: number;
    readonly handle: { clear(): void };
  } | null = null;

  constructor(deps: RetryCoordinatorDeps) {
    this.timer = deps.timer ?? realTimer;
    this.onBackoffElapsed = deps.onBackoffElapsed;
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
   * Recording precedes arming so a queue's deadline survives even when another queue's is the one
   * physically armed: the registry is the source of truth and the timer is a projection of its
   * earliest entry.
   */
  public async armDelayedRetry(queueId: string, cause: string, delayMs: number): Promise<void> {
    this.pendingRetries.set(queueId, { firesAt: this.now() + Math.max(0, delayMs), cause });
    this.reconcileArmedTimer();
  }

  /**
   * Cancel a pending delayed-retry deadline.
   *
   * Feature 093 (T045) — `queueId` names whose deadline to drop. Omitting it is the window-wide
   * form and drops every queue's, which is what a Clean All means; the two are not interchangeable.
   * An unaddressed cancel from one queue's control path would discard a sibling's armed retry, which
   * FR-024 forbids: a lifecycle control affects only the queue it names.
   *
   * Synchronous by contract (FR-R4-F02 U5 G19): every call site is a control path that cannot await,
   * and with the coordinator's own timer there is nothing asynchronous left in it.
   */
  public cancelPendingTimer(queueId?: string): void {
    if (queueId === undefined) {
      this.pendingRetries.clear();
      this.disarm();
      return;
    }
    this.pendingRetries.delete(queueId);
    if (this.armed?.queueId === queueId) this.disarm();
    this.reconcileArmedTimer();
  }

  /** True while `queueId` has a delayed-retry deadline that has not elapsed. */
  public hasPendingDelayedRetry(queueId: string): boolean {
    return this.pendingRetries.has(queueId);
  }

  /**
   * Remove and return every queue whose delayed-retry deadline has elapsed, then re-arm the
   * next-earliest. Destructive by design: the elapsed deadlines are consumed, so a second read does
   * not resume them twice. A queue whose deadline is still in the future keeps its entry.
   */
  public claimElapsedDelayedRetries(): readonly string[] {
    const claimed = this.claim().map((wakeup) => wakeup.queueId);
    this.reconcileArmedTimer();
    return claimed;
  }

  /**
   * FR-R4-F02 (U5 G18) — an admission reported its outcome. The earliest remaining deadline is
   * recomputed from the registry alone, so whatever the outcome was (admitted, refused for capacity,
   * failed, canceled) the armed handle ends on `min(pendingRetries.firesAt)`, or cleared when the map
   * is empty. The handle is replaced rather than trusted: a handle the coordinator believes is armed
   * but the platform has lost would otherwise keep a queue's deadline from ever firing.
   */
  public noteAdmissionOutcome(): void {
    this.disarm();
    this.reconcileArmedTimer();
  }

  /** Take only the entries whose time has come (U5 G20), in deadline order. */
  private claim(): BackoffWakeup[] {
    const at = this.now();
    const due = [...this.pendingRetries.entries()]
      .filter(([, retry]) => retry.firesAt <= at)
      .sort((a, b) => a[1].firesAt - b[1].firesAt);
    for (const [queueId] of due) this.pendingRetries.delete(queueId);
    return due.map(([queueId, retry]) => ({
      cause: 'backoff-elapsed' as const,
      queueId,
      deadline: retry.firesAt
    }));
  }

  private disarm(): void {
    this.armed?.handle.clear();
    this.armed = null;
  }

  /**
   * Point the one physical timer at the earliest outstanding deadline.
   *
   * Idempotent: re-arming for the deadline already armed is a no-op, so the common case (one queue in
   * backoff) arms exactly once.
   */
  private reconcileArmedTimer(): void {
    let next: { queueId: string; retry: PendingRetry } | null = null;
    for (const [queueId, retry] of this.pendingRetries) {
      if (next === null || retry.firesAt < next.retry.firesAt) next = { queueId, retry };
    }
    if (next === null) {
      this.disarm();
      return;
    }
    if (this.armed?.queueId === next.queueId && this.armed.firesAt === next.retry.firesAt) return;
    this.disarm();
    const delay = Math.min(Math.max(0, next.retry.firesAt - this.now()), MAX_TIMER_DELAY_MS);
    this.armed = {
      queueId: next.queueId,
      firesAt: next.retry.firesAt,
      handle: this.timer.set(() => this.onTimerFire(), delay)
    };
  }

  /**
   * The armed timer fired (U5 G17): claim what is due, hand each claimed queue on without awaiting
   * it, and re-arm the earliest that remains before returning. An early or clamped wake claims
   * nothing and simply re-arms.
   */
  private onTimerFire(): void {
    this.armed = null;
    for (const wakeup of this.claim()) this.dispatch(wakeup);
    this.reconcileArmedTimer();
  }

  /** Never awaits and never throws: one queue's failing handler must not cost a sibling its wakeup. */
  private dispatch(wakeup: BackoffWakeup): void {
    try {
      void Promise.resolve(this.onBackoffElapsed(wakeup)).catch(() => {
        this.logger.warn(BACKOFF_HANDLER_FAILED_LINE);
      });
    } catch {
      this.logger.warn(BACKOFF_HANDLER_FAILED_LINE);
    }
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
   * Feature 093 (T045) — `queueId` names the queue whose persisted deadline is being re-armed. After
   * a crash mid-concurrency the activation sweep can find several Runs each holding its own
   * `pendingRetryAt`, and each re-arm has to enter the registry under its own key or the last one
   * read would be the only one that survived.
   *
   * FR-R4-F02 (contract U2 G6) — a deadline that elapsed while the host was down is a
   * `backoff-elapsed` wakeup, handed to `onBackoffElapsed` like any other, in place of the direct
   * resume it used to schedule: it is selected by the same eligibility decision and admitted through
   * the same capacity method.
   */
  public async resumeExistingFromActivation(queueId: string, run: WorkflowRun): Promise<void> {
    if (run.pendingRetryAt === null || run.pendingRetryCause === null) return;
    const delay = run.pendingRetryAt - this.now();
    if (delay <= 0) {
      this.dispatch({ cause: 'backoff-elapsed', queueId, deadline: run.pendingRetryAt });
      return;
    }
    await this.armDelayedRetry(queueId, run.pendingRetryCause, delay);
  }
}
