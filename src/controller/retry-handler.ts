/**
 * Feature 034 Item 047 — extracted delayed-retry state machine.
 *
 * No `vscode` import. The handler encapsulates:
 *   - `handleDelayedRetry` — persist `paused` state, compute backoff,
 *     append `retry-scheduled` audit, arm watchdog.
 *   - `scheduleQueuePauseAndFail` — invoked when `delayedRetryCount`
 *     reaches the configured cap; pauses the queue with reason
 *     `retry-cap-exhausted:<runId>` and emits `queue-paused`.
 *   - `maybeEmitRetryRecovered` — reset retry counters and emit
 *     `retry-recovered` when a phase finishes `clean` after a prior
 *     delayed retry.
 *
 * CLAUDE.md hard rules preserved:
 *   - The `pendingRetryAt` / `pendingRetryCause` pair invariant
 *     (both-null or both-non-null) is maintained at every write.
 *   - The `retry-scheduled` audit payload carries the **pre-buffer**
 *     parsed `resetsAtMs` (NOT `resetsAtMs + RETRY_BUFFER_MS`) so the
 *     buffered retry is derivable from the audit log alone.
 *   - The dynamic backoff trusts the parsed `resetsAtMs` regardless of
 *     distance from now; `DELAYED_RETRY_CAP` bounds total attempts.
 */

import type {
  DelayedRetryCause,
  PhaseResult,
  WorkflowRun
} from '../state/workflow-run';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { QueueManager } from '../queue/queue-manager';
import type { SchegentStatusBar } from '../ui/status-bar';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import { backoffForCause } from './rate-limit-backoff';
// BUG-006 — system-armed scheduled-restore transition.
import type { GuardedRunService } from '../services/guarded-run-service';
import { SCHEDULED_START_MAX_HORIZON_MS } from '../services/guarded-run-service';
import { extractResetTimestamp } from '../parser/rate-limit-reset-extractor';
import { RETRY_BUFFER_MS } from './retry-constants';

export interface DelayedRetryWatchdog {
  pauseAndPoll(
    cause: string,
    options?: { durationOverrideMs?: number; skipStatusCheck?: boolean }
  ): Promise<void>;
  cancelPendingTimer(): void;
}

export interface RetryHandlerDeps {
  store: WorkspaceStateStore;
  queue: QueueManager;
  statusBar: SchegentStatusBar;
  notifier: Notifier;
  logger: SanitizedLogger;
  /**
   * Feature 093 (T045) — arm this Run's delayed-retry deadline, addressed by the
   * queue it belongs to.
   *
   * Replaces the former `getWatchdog()` lazy read, which handed the handler the
   * window's one `CreditWatchdog` and let it call `pauseAndPoll` directly. That
   * was correct while a window had one Run: there was one deadline, so one timer
   * held it. With N Runs the deadline is per queue, and the handler must say
   * whose it is arming — `RetryCoordinator` owns the registry that keeps N
   * deadlines from collapsing onto one handle, and it is still the coordinator
   * that talks to the watchdog. Late wiring is preserved: the coordinator reads
   * its watchdog reference at the moment of the call, exactly as this callback
   * used to.
   */
  armDelayedRetry: (queueId: string, cause: string, delayMs: number) => Promise<void>;
  auditWriter: Pick<AuditLogWriter, 'append'> | null;
  getRetryCap: () => number;
  persistTransition: (prev: WorkflowRun, next: WorkflowRun) => Promise<WorkflowRun>;
  /**
   * BUG-006 — lazy reader for the guarded-run service. Optional for tests
   * and back-compat; when present, `scheduleQueuePauseAndFail` converts a
   * rate-limit-family retry-cap-exhausted pause into a system-armed
   * scheduled restore via `transitionToScheduledRestore`. When omitted,
   * the legacy operator-paused lifecycle is preserved.
   */
  getGuardedRunService?: () => Pick<
    GuardedRunService,
    'transitionToScheduledRestore' | 'emitSystemPauseRestoreUnavailable'
  > | null;
  /** Injectable clock for tests; default = Date.now */
  clock?: () => number;
}

export type DelayedRetryAuditEvent =
  | 'retry-scheduled'
  | 'retry-manual'
  | 'retry-recovered'
  | 'queue-paused';

export class RetryHandler {
  constructor(private readonly deps: RetryHandlerDeps) {}

  /**
   * Schedule a delayed retry for the given run.
   *
   * @param run                Pre-mutation snapshot.
   * @param iteration          Iteration count at the moment of failure.
   * @param phaseResult        The failed phase result to append.
   * @param cause              Normalized retry cause.
   * @param resetsAtMs         Parsed pre-buffer reset epoch (null when
   *                           unavailable; fixed-fallback path applies).
   * @param rateLimitMessage   CLI-reported message for debug logging.
   * @param originalCause      Feature 066 — pre-normalization cause
   *                           string (e.g., `'out-of-credits'`). Drives
   *                           the past-timestamp safety guard in
   *                           `backoffForCause`.
   * @returns                  The persisted post-mutation run.
   */
  async handleDelayedRetry(
    run: WorkflowRun,
    iteration: number,
    phaseResult: PhaseResult,
    cause: DelayedRetryCause,
    resetsAtMs: number | null,
    rateLimitMessage: string | null,
    originalCause?: string
  ): Promise<WorkflowRun> {
    const retryCap = this.deps.getRetryCap();
    // FR-006 — the configured cap-th failure trips the delayed-retry pause.
    if (run.delayedRetryCount >= retryCap - 1) {
      return this.scheduleQueuePauseAndFail(run, iteration, phaseResult, cause);
    }
    const backoff = backoffForCause(cause, resetsAtMs, undefined, originalCause);
    const scheduledAt = Date.now() + backoff;
    // Bugfix 2026-05-15 — BUG-002 (FR-017 / SC-009). Surface the
    // CLI-reported rate-limit message + parsed epoch + computed backoff
    // before the audit event. SanitizedLogger.write applies
    // SECRET_PATTERNS redaction at emit time (CLAUDE.md "never sanitize
    // twice"). Gated by the operator's runtimeLogLevel; the sink
    // suppresses the line when debug capture is off.
    this.deps.logger.debug('delayed-retry: scheduling backoff', {
      cause,
      resetsAtMs,
      rateLimitMessage,
      backoffMs: backoff,
      scheduledAt
    });
    const nextCount = run.delayedRetryCount + 1;
    const updated: WorkflowRun = {
      ...run,
      status: 'paused',
      currentIteration: iteration,
      lastTransitionAt: Date.now(),
      phasesCompleted: [...run.phasesCompleted, phaseResult],
      pendingRetryAt: scheduledAt,
      pendingRetryCause: cause,
      delayedRetryCount: nextCount
    };
    const persisted = await this.deps.persistTransition(run, updated);
    this.deps.statusBar.update(persisted.id, { kind: 'paused', phase: persisted.currentPhase });
    // Feature 027 FR-012/FR-013 — `resetsAtMs` is the pre-buffer parsed
    // epoch (NOT `+ RETRY_BUFFER_MS`); operators reading the audit log
    // can derive the buffered retry as `resetsAtMs + 60_000`. Null when
    // the parser found no reset (fixed-fallback path) or when the cause
    // is `transient_error`.
    await this.appendAudit('retry-scheduled', {
      runId: persisted.id,
      phase: persisted.currentPhase,
      iteration,
      payload: {
        runId: persisted.id,
        phaseId: persisted.currentPhase,
        cause,
        scheduledAt,
        delayedRetryCount: nextCount,
        resetsAtMs
      },
      outcome: 'info'
    });
    // Feature 093 (T045) — the deadline belongs to this Run's queue, so the arm
    // names it. `run.featureId` is the task the Run advances and the queue that
    // owns the task owns the Run, so the queue is derivable here and needs no
    // new parameter on the retry path.
    await this.deps.armDelayedRetry(
      this.deps.queue.queueIdForTask(persisted.featureId),
      cause,
      backoff
    );
    return persisted;
  }

  /**
   * Cap reached — pause the queue with reason `retry-cap-exhausted:<runId>`
   * and emit `queue-paused` with `cause` + final `delayedRetryCount`.
   * Sets pendingRetryAt/Cause back to null (terminal — no further retry).
   *
   * BUG-006 — when `cause === 'rate_limit'` AND `GuardedRunService` is
   * wired AND `extractResetTimestamp` returns a finite epoch in the
   * future within the 7-day horizon, the queue is transitioned to
   * `idle-pending` with `scheduledStartSource = 'system-rate-limit-recovery'`
   * instead of the legacy `operator-paused` lifecycle. The in-flight
   * pointer is preserved so the Activity Feed binding remains stable
   * across the restore window. When parsing fails or the parsed value is
   * unusable, the legacy lifecycle is preserved and
   * `system-pause-restore-unavailable` is emitted alongside `queue-paused`.
   */
  async scheduleQueuePauseAndFail(
    run: WorkflowRun,
    iteration: number,
    phaseResult: PhaseResult,
    cause: DelayedRetryCause
  ): Promise<WorkflowRun> {
    const clock = this.deps.clock ?? (() => Date.now());
    const retryCap = this.deps.getRetryCap();
    const updated: WorkflowRun = {
      ...run,
      status: 'paused',
      currentIteration: iteration,
      lastTransitionAt: clock(),
      phasesCompleted: [...run.phasesCompleted, phaseResult],
      pendingRetryAt: null,
      pendingRetryCause: null,
      delayedRetryCount: retryCap
    };
    const persisted = await this.deps.persistTransition(run, updated);
    this.deps.statusBar.update(persisted.id, { kind: 'paused', phase: persisted.currentPhase });

    // BUG-006 — evaluate whether the rate-limit branch can perform a
    // system-armed scheduled restore. All four conditions must hold:
    //   1. cause is in the rate-limit family (normalized to 'rate_limit').
    //   2. GuardedRunService is wired (production extension activation).
    //   3. extractResetTimestamp returns a finite epoch.
    //   4. The buffered restore target is in the future and inside the
    //      7-day horizon (SCHEDULED_START_MAX_HORIZON_MS, FR-009c).
    //
    // Bugfix 2026-05-23 — BUG-008: FR-028 is reserved for genuine
    // rate-limit failures (non-zero exit). Even though detector-layer
    // (T073) and parser-layer (T075) guards prevent `cause ===
    // 'rate_limit'` from co-occurring with `exitCode === 0` in the
    // normal flow, this ingress guard is the final belt: it ensures no
    // synthetic-failure-context path can reach
    // `transitionToScheduledRestore` against a successful invocation.
    const guarded = this.deps.getGuardedRunService?.() ?? null;
    const invocationExitCode = phaseResult.exitCode;
    const isGenuineRateLimitFailure =
      cause === 'rate_limit' && invocationExitCode !== 0;
    let scheduledRestoreAt: number | null = null;
    let fallbackReason: 'unparseable-reset' | 'past-reset' | 'over-horizon-reset' | null = null;
    if (isGenuineRateLimitFailure && guarded) {
      const now = clock();
      const { resetsAtMs } = extractResetTimestamp(
        phaseResult.stdoutSummary,
        phaseResult.stderrSummary,
        now,
        // BUG-009 — `isGenuineRateLimitFailure` guarantees `exitCode !== 0`,
        // so `allowed_warning` records carry load-bearing reset epochs.
        { includeWarningStatus: true }
      );
      if (resetsAtMs === null || !Number.isFinite(resetsAtMs)) {
        fallbackReason = 'unparseable-reset';
      } else {
        // Apply the same buffered floor used by `backoffForCause` so the
        // restore target lines up with what the delayed-retry path would
        // have computed if there were retry budget left.
        const buffered = resetsAtMs + RETRY_BUFFER_MS;
        if (buffered <= now) {
          fallbackReason = 'past-reset';
        } else if (buffered > now + SCHEDULED_START_MAX_HORIZON_MS) {
          fallbackReason = 'over-horizon-reset';
        } else {
          scheduledRestoreAt = buffered;
        }
      }
    }

    if (scheduledRestoreAt !== null && guarded) {
      // System-armed scheduled restore path: preserve the in-flight binding
      // and emit the additive `system-pause-scheduled-restore` event.
      await this.deps.queue.pause(
        persisted.featureId,
        'phase-paused',
        /* preserveInFlightForRestore */ true
      );
      await guarded.transitionToScheduledRestore({
        scheduledStartAt: scheduledRestoreAt,
        scheduledStartSource: 'system-rate-limit-recovery',
        transitionReason: 'retry-cap-exhausted',
        pauseCauseCategory: 'rate-limit'
      });
      await this.appendAudit('queue-paused', {
        runId: persisted.id,
        phase: persisted.currentPhase,
        iteration,
        payload: {
          runId: persisted.id,
          reason: 'retry-cap-exhausted',
          cause,
          delayedRetryCount: persisted.delayedRetryCount,
          // BUG-006 — record the system-armed restore so operators reading
          // the audit log alone can derive the lifecycle transition.
          scheduledRestoreAt,
          scheduledStartSource: 'system-rate-limit-recovery'
        },
        outcome: 'info'
      });
      this.deps.notifier.warn(
        `Schegent: delayed-retry cap (${persisted.delayedRetryCount}) exhausted on ${persisted.currentPhase}. Auto-resume scheduled.`
      );
      return persisted;
    }

    // Legacy / fallback path — operator-paused lifecycle preserved.
    await this.deps.queue.setQueuePausedState(
      true,
      undefined,
      `retry-cap-exhausted:${persisted.id}`,
      'retry-cap'
    );
    await this.deps.queue.pause(persisted.featureId, 'phase-paused');
    // Bugfix 2026-05-23 — BUG-008: emit `system-pause-restore-unavailable`
    // only on genuine rate-limit failures (`exitCode !== 0`). A successful
    // invocation that somehow reached this fallback path is NOT an
    // FR-028 candidate; emitting the warn-level event would mis-attribute
    // the pause as a rate-limit restoration gap.
    if (isGenuineRateLimitFailure && guarded && fallbackReason !== null) {
      await guarded.emitSystemPauseRestoreUnavailable({
        pauseCauseCategory: 'rate-limit',
        fallbackReason
      });
    }
    await this.appendAudit('queue-paused', {
      runId: persisted.id,
      phase: persisted.currentPhase,
      iteration,
      payload: {
        runId: persisted.id,
        reason: 'retry-cap-exhausted',
        cause,
        delayedRetryCount: persisted.delayedRetryCount
      },
      outcome: 'info'
    });
    this.deps.notifier.warn(
      `Schegent: delayed-retry cap (${persisted.delayedRetryCount}) exhausted on ${persisted.currentPhase}. Queue paused.`
    );
    return persisted;
  }

  /**
   * After a `clean` phase outcome with a non-zero `delayedRetryCount`,
   * reset counters and emit `retry-recovered`. No-op when the run had
   * no prior delayed retry.
   */
  async maybeEmitRetryRecovered(run: WorkflowRun, outcome: string): Promise<WorkflowRun> {
    if (outcome !== 'clean') return run;
    if (run.delayedRetryCount === 0) return run;
    const priorCount = run.delayedRetryCount;
    const reset: WorkflowRun = {
      ...run,
      delayedRetryCount: 0,
      pendingRetryAt: null,
      pendingRetryCause: null
    };
    const persisted = await this.deps.persistTransition(run, reset);
    await this.appendAudit('retry-recovered', {
      runId: persisted.id,
      phase: persisted.currentPhase,
      iteration: persisted.currentIteration,
      payload: {
        runId: persisted.id,
        phaseId: persisted.currentPhase,
        priorDelayedRetryCount: priorCount
      },
      outcome: 'success'
    });
    return persisted;
  }

  /**
   * Public hook for the controller's manual-retry path. Emits the
   * `retry-manual` audit event the same way the handler emits its own
   * lifecycle events, so the operator-initiated retry shares the audit
   * pipeline (and the `appendDelayedRetryAudit` log line on failure).
   */
  async appendManualRetryAudit(inputs: {
    runId: string;
    phase: string;
    iteration: number;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.appendAudit('retry-manual', { ...inputs, outcome: 'info' });
  }

  private async appendAudit(
    eventType: DelayedRetryAuditEvent,
    inputs: {
      runId: string;
      phase: string;
      iteration: number;
      payload: Record<string, unknown>;
      outcome: 'info' | 'success' | 'failure';
    }
  ): Promise<void> {
    if (!this.deps.auditWriter) return;
    try {
      await this.deps.auditWriter.append({
        runId: inputs.runId,
        phase: inputs.phase,
        iteration: inputs.iteration,
        eventType,
        payload: inputs.payload,
        outcome: inputs.outcome
      });
    } catch (err) {
      this.deps.logger.warn(
        `delayed-retry audit append failed: ${(err as Error).message}`
      );
    }
  }
}
