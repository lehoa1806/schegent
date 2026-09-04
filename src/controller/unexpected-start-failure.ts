// FR-R3-119 — the composition the controller does when a run start throws, moved
// out of `workflow-controller.ts` under the LOC gate that names this shape:
// "split new responsibilities into focused modules before adding more behavior".
//
// It is one cohesive span with one question — *a start failed; what does the
// workspace owe back?* — and the module boundary was already half-drawn: the
// classification half moved to `start-failure-classification.ts` under
// FR-R3-146, leaving the acting half as the largest private region in the
// controller. What moves here is that acting half, unchanged: the same order,
// the same three independently-caught failures, the same two things a terminal
// Run owes back (its execution lease, its session) before the drain.
//
// The dependency list is thirteen wide and that width is the honest measure of
// what the function touches — it is a composition, not a calculation. Naming
// each collaborator by the methods it actually needs is what keeps it readable
// and what lets a test drive the whole path with plain objects.

import type { SanitizedLogger } from '../lib/logger';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { QueueManager } from '../queue/queue-manager';
import type { SchegentStatusBar } from '../ui/status-bar';
import type { Notifier } from '../ui/notifications';
import type { HistoryRecorder } from '../services/history-recorder';
import type { RunSessionRegistry } from './run-session';
import type { WorkflowLifecycleAuditor } from './workflow-lifecycle-auditor';
import type { TerminalTransitionCoordinator } from '../services/terminal-transition-coordinator';
import type { SanitizedError, WorkflowRun } from '../state/workflow-run';
import type { FeatureRequest } from '../queue/feature-request';
import { classifyStartFailure } from './start-failure-classification';

export interface UnexpectedStartFailureDeps {
  readonly logger: Pick<SanitizedLogger, 'sanitize' | 'warn' | 'error'>;
  readonly store: Pick<WorkspaceStateStore, 'getRun'>;
  readonly queue: Pick<QueueManager, 'queueIdForTask' | 'finish'>;
  readonly statusBar: Pick<SchegentStatusBar, 'update'>;
  readonly notifier: Pick<Notifier, 'warn'>;
  readonly historyRecorder: Pick<HistoryRecorder, 'record'>;
  readonly lifecycleAuditor: Pick<
    WorkflowLifecycleAuditor,
    'emitRunEndedBreakpoints' | 'emitTaskExecutionEnded'
  >;
  /**
   * `| undefined` explicitly, not merely optional. The controller holds this
   * collaborator as `TerminalTransitionCoordinator | undefined` and passes it
   * positionally, so under `exactOptionalPropertyTypes` an absent key and an
   * explicit `undefined` are different types and only the first would type. The
   * distinction buys nothing here — the single call site is
   * `deps.terminalTransitions?.complete(...)`, which reads both the same way —
   * so the declaration says what the caller actually passes rather than forcing
   * a conditional spread to preserve a difference no reader can observe.
   */
  readonly terminalTransitions?:
    | Pick<TerminalTransitionCoordinator, 'begin' | 'complete'>
    | undefined;
  readonly sessions: Pick<RunSessionRegistry, 'disposeIfEnded'>;
  /** The controller's own write funnel — it resolves the queue from the Run. */
  readonly persist: (prev: WorkflowRun, next: WorkflowRun) => Promise<WorkflowRun>;
  /** Feature 092 (T132, FR-033a) — ends a terminal Run's execution lease. */
  readonly releaseExecutionLeaseForRun: (run: WorkflowRun) => Promise<void>;
  readonly scheduleAutoDrain: () => void;
}

export interface UnexpectedStartFailure {
  readonly feature: FeatureRequest;
  readonly startedRun: WorkflowRun | null;
  readonly description: string;
  readonly err: unknown;
}

function sanitizeUnexpectedError(
  logger: Pick<SanitizedLogger, 'sanitize'>,
  err: unknown
): string {
  const raw = err instanceof Error ? err.message : String(err);
  return logger.sanitize(raw.length > 0 ? raw : 'unknown workflow error');
}

export async function reportUnexpectedStartFailure(
  deps: UnexpectedStartFailureDeps,
  input: UnexpectedStartFailure
): Promise<void> {
  const { feature, startedRun, description, err } = input;

  // FR-R3-146 (FR-005) — what kind of event this is, decided once.
  //
  // The code, the message, the log level and its wording, the status-bar detail
  // and the operator notification were five separate ternaries over one question.
  // They are now one answer, in `start-failure-classification.ts`, which is also
  // where the reasoning for each shape lives.
  const report = classifyStartFailure(err, feature.id, (raw) => deps.logger.sanitize(raw));

  // Feature 093 (T023) — pattern B, the failing Task names its own queue.
  //
  // The id comparison **survives** the conversion, and is not the one-slot
  // artifact T040 sweeps out. It answers "did the Run we started get as far as
  // being persisted?", which stays a real question once the read is
  // queue-addressed: `startNew` assigns `run` before it writes it, so a
  // `setRun` that itself threw leaves `startedRun` set while the queue still
  // holds whatever preceded it. Without the comparison that predecessor would
  // be failed and history-recorded in place of the Run that actually failed.
  const latestRun = deps.store.getRun(deps.queue.queueIdForTask(feature.id));
  const activeRun = startedRun && latestRun?.id === startedRun.id ? latestRun : startedRun;
  const lastError: SanitizedError = {
    code: report.code,
    message: report.message,
    phase: activeRun?.currentPhase ?? null,
    iteration: activeRun?.currentIteration ?? null,
    at: Date.now()
  };

  deps.logger[report.level](report.logLine);

  let terminalRun: WorkflowRun | null = null;
  if (activeRun && (activeRun.status === 'running' || activeRun.status === 'paused')) {
    const failed: WorkflowRun = {
      ...activeRun,
      status: 'failed',
      lastTransitionAt: Date.now(),
      lastError,
      pendingRetryAt: null,
      pendingRetryCause: null,
      manualPauseAt: null,
      manualPauseCause: null,
      resumeTargetPhaseId: null
    };
    try {
      terminalRun = await deps.persist(activeRun, failed);
      await deps.lifecycleAuditor.emitRunEndedBreakpoints(terminalRun);
    } catch (persistErr) {
      deps.logger.error(
        `failed to persist unexpected workflow failure: ${sanitizeUnexpectedError(deps.logger, persistErr)}`
      );
    }
  } else if (activeRun && activeRun.status === 'failed') {
    terminalRun = activeRun;
  }

  deps.statusBar.update(terminalRun?.id ?? startedRun?.id ?? feature.id, {
    kind: 'failed',
    ...(lastError.phase ? { phase: lastError.phase } : {}),
    detail: report.statusDetail
  });
  deps.notifier.warn(report.announcement);

  try {
    const finished = await deps.queue.finish(feature.id, 'failed', {
      code: lastError.code,
      message: lastError.message,
      ...(lastError.phase ? { phase: lastError.phase } : {}),
      correlationId: terminalRun?.id ?? startedRun?.id ?? feature.id
    });
    if (finished.ok === false) {
      deps.logger.error(`queue.finish refused (FR-R3-153): ${finished.reason}`);
    }
  } catch (queueErr) {
    deps.logger.error(
      `failed to mark queue item failed after unexpected workflow error: ${sanitizeUnexpectedError(deps.logger, queueErr)}`
    );
  }

  if (terminalRun && report.kind !== 'lock-held') {
    try {
      await deps.historyRecorder.record(terminalRun, description, 'failed');
    } catch (historyErr) {
      deps.logger.warn(
        `failed to record unexpected workflow failure in history: ${sanitizeUnexpectedError(deps.logger, historyErr)}`
      );
    }
    await deps.terminalTransitions?.complete(terminalRun, description);
    await deps.lifecycleAuditor.emitTaskExecutionEnded(terminalRun, 'failed', lastError.message);
  }

  // Feature 093 (T068b, FR-028) — the window-primacy release that stood here
  // is gone. 092's T136 retired the `withLock('drive-run', …)` wrapper because
  // primacy's tenure is the window's, but left the Run-scoped releases that
  // wrapper had company from. `release()` keeps no reference count, so one
  // unexpectedly-failed start dropped primacy for every sibling Run still
  // mid-phase. The per-queue execution lease below is the one a terminal Run
  // does owe back.
  //
  // Feature 092 (T132, FR-033a) — before the drain, so the sweep this
  // schedules can already see the queue as free.
  if (terminalRun) {
    await deps.releaseExecutionLeaseForRun(terminalRun);
  }
  // The session is the other thing it owes back, and on the same schedule.
  deps.sessions.disposeIfEnded(deps.queue.queueIdForTask(feature.id));
  deps.scheduleAutoDrain();
}
