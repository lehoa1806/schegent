import type { PhaseResult, WorkflowRun } from '../state/workflow-run';
import {
  RetryHandler,
  type DelayedRetryWatchdog,
  type RetryHandlerDeps
} from '../controller/retry-handler';
import type { SanitizedLogger } from '../lib/logger';

export type RateLimitHandler = (cause: string, run: WorkflowRun) => Promise<void>;

export interface RetryCoordinatorDeps
  extends Omit<RetryHandlerDeps, 'getWatchdog'> {
  readonly logger: SanitizedLogger;
  readonly watchdog?: DelayedRetryWatchdog | null;
}

/**
 * Feature 013 T097 - owns retry-adjacent controller wiring that is not part
 * of the phase loop itself: late watchdog injection, rate-limit pause
 * callback dispatch, and the RetryHandler facade used by RunDriver.
 */
export class RetryCoordinator {
  private watchdog: DelayedRetryWatchdog | null;
  private rateLimitHandler: RateLimitHandler | null = null;
  private readonly retryHandler: RetryHandler;
  private readonly logger: SanitizedLogger;

  constructor(deps: RetryCoordinatorDeps) {
    this.watchdog = deps.watchdog ?? null;
    this.logger = deps.logger;
    this.retryHandler = new RetryHandler({
      ...deps,
      getWatchdog: () => this.watchdog
    });
  }

  public setWatchdog(watchdog: DelayedRetryWatchdog | null): void {
    this.watchdog = watchdog;
  }

  public setRateLimitHandler(handler: RateLimitHandler): void {
    this.rateLimitHandler = handler;
  }

  public cancelPendingTimer(): void {
    this.watchdog?.cancelPendingTimer();
  }

  public async handleDelayedRetry(
    run: WorkflowRun,
    iteration: number,
    phaseResult: PhaseResult,
    cause: 'rate_limit' | 'transient_error',
    resetsAtMs: number | null,
    rateLimitMessage: string | null
  ): Promise<WorkflowRun> {
    return this.retryHandler.handleDelayedRetry(
      run,
      iteration,
      phaseResult,
      cause,
      resetsAtMs,
      rateLimitMessage
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
    await this.watchdog.pauseAndPoll(run.pendingRetryCause, {
      durationOverrideMs: delay,
      skipStatusCheck: true
    });
  }
}
