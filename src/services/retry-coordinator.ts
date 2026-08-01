import type { PhaseResult, WorkflowRun } from '../state/workflow-run';
import {
  RetryHandler,
  type DelayedRetryWatchdog,
  type RetryHandlerDeps
} from '../controller/retry-handler';
import type { SanitizedLogger } from '../lib/logger';
import type { GuardedRunService } from './guarded-run-service';

export type RateLimitHandler = (cause: string, run: WorkflowRun) => Promise<void>;

export interface RetryCoordinatorDeps
  extends Omit<RetryHandlerDeps, 'getWatchdog' | 'getGuardedRunService'> {
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

  constructor(deps: RetryCoordinatorDeps) {
    this.watchdog = deps.watchdog ?? null;
    this.guardedRunService = deps.guardedRunService ?? null;
    this.logger = deps.logger;
    this.getRetryCap = deps.getRetryCap;
    this.retryHandler = new RetryHandler({
      ...deps,
      getWatchdog: () => this.watchdog,
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

  public cancelPendingTimer(): void {
    this.watchdog?.cancelPendingTimer();
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

  public async resumeExistingFromActivation(
    run: WorkflowRun,
    resumeExisting: () => Promise<void>
  ): Promise<void> {
    if (run.pendingRetryAt === null || run.pendingRetryCause === null) return;
    const delay = Math.max(0, run.pendingRetryAt - Date.now());
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
    if (!this.watchdog) {
      this.logger.warn(
        `resumeExistingFromActivation: watchdog not wired; cannot re-arm delayed retry for run ${run.id}`
      );
      return;
    }
    try {
      await this.watchdog.pauseAndPoll(run.pendingRetryCause, {
        durationOverrideMs: delay,
        skipStatusCheck: true
      });
    } catch (err) {
      this.logger.warn(
        `resumeExistingFromActivation: watchdog.pauseAndPoll failed for run ${run.id}: ${(err as Error).message}`
      );
    }
  }
}
