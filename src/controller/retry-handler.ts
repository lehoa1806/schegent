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
 *     buffered wakeup is derivable from the audit log alone.
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
   * Lazy reader for the delayed-retry watchdog. The watchdog is constructed
   * AFTER the controller (see `setWatchdog`), so the handler reads via a
   * callback at the moment of use. This preserves the original
   * `this.watchdog` late-read semantics from inline code.
   */
  getWatchdog: () => DelayedRetryWatchdog | null;
  auditWriter: Pick<AuditLogWriter, 'append'> | null;
  getRetryCap: () => number;
  persistTransition: (prev: WorkflowRun, next: WorkflowRun) => Promise<WorkflowRun>;
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
   * @returns                  The persisted post-mutation run.
   */
  async handleDelayedRetry(
    run: WorkflowRun,
    iteration: number,
    phaseResult: PhaseResult,
    cause: DelayedRetryCause,
    resetsAtMs: number | null,
    rateLimitMessage: string | null
  ): Promise<WorkflowRun> {
    const retryCap = this.deps.getRetryCap();
    // FR-006 — the configured cap-th failure trips the delayed-retry pause.
    if (run.delayedRetryCount >= retryCap - 1) {
      return this.scheduleQueuePauseAndFail(run, iteration, phaseResult, cause);
    }
    const backoff = backoffForCause(cause, resetsAtMs);
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
    this.deps.statusBar.update({ kind: 'paused', phase: persisted.currentPhase });
    // Feature 027 FR-012/FR-013 — `resetsAtMs` is the pre-buffer parsed
    // epoch (NOT `+ RETRY_BUFFER_MS`); operators reading the audit log
    // can derive the buffered wakeup as `resetsAtMs + 60_000`. Null when
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
    const watchdog = this.deps.getWatchdog();
    if (watchdog) {
      await watchdog.pauseAndPoll(cause, {
        durationOverrideMs: backoff,
        skipStatusCheck: true
      });
    } else {
      this.deps.logger.warn(
        `handleDelayedRetry: watchdog not wired; persisted retry deadline ${scheduledAt} cannot be re-armed without restart`
      );
    }
    return persisted;
  }

  /**
   * Cap reached — pause the queue with reason `retry-cap-exhausted:<runId>`
   * and emit `queue-paused` with `cause` + final `delayedRetryCount`.
   * Sets pendingRetryAt/Cause back to null (terminal — no further retry).
   */
  async scheduleQueuePauseAndFail(
    run: WorkflowRun,
    iteration: number,
    phaseResult: PhaseResult,
    cause: DelayedRetryCause
  ): Promise<WorkflowRun> {
    const retryCap = this.deps.getRetryCap();
    const updated: WorkflowRun = {
      ...run,
      status: 'paused',
      currentIteration: iteration,
      lastTransitionAt: Date.now(),
      phasesCompleted: [...run.phasesCompleted, phaseResult],
      pendingRetryAt: null,
      pendingRetryCause: null,
      delayedRetryCount: retryCap
    };
    const persisted = await this.deps.persistTransition(run, updated);
    this.deps.statusBar.update({ kind: 'paused', phase: persisted.currentPhase });
    await this.deps.queue.setQueuePausedState(
      true,
      undefined,
      `retry-cap-exhausted:${persisted.id}`,
      'retry-cap'
    );
    // Mark the in-flight task as paused so queue list shows 'paused' status.
    await this.deps.queue.pause(persisted.featureId, 'phase-paused');
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
