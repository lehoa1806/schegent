import { BUILT_IN_PHASES } from '../config/pipeline-config';
import { getOperatorActor } from '../lib/operator-attribution';
import type { SanitizedLogger } from '../lib/logger';
import type { QueueManager } from '../queue/queue-manager';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { WorkflowRun } from '../state/workflow-run';
import type { RetryCoordinator } from '../services/retry-coordinator';

export type MutationResult = { ok: true } | { ok: false; reason: string };

export type PhaseControlAuditEvent =
  | 'phase-pause-requested'
  | 'phase-paused'
  | 'phase-resumed'
  | 'phase-restarted'
  | 'phase-skipped'
  | 'phase-disabled'
  | 'phase-enabled'
  | 'phase-removed';

export type BreakpointAuditEvent =
  | 'phase-breakpoint-set'
  | 'phase-breakpoint-cleared'
  | 'phase-breakpoint-fired';

export interface PhaseControlAuditor {
  appendPhaseControl(
    eventType: PhaseControlAuditEvent,
    run: WorkflowRun,
    payload: Record<string, unknown>
  ): Promise<void>;
  emitTaskPaused(run: WorkflowRun): Promise<void>;
  emitPhaseJumped(run: WorkflowRun, phaseId: string): Promise<void>;
  appendBreakpoint(
    eventType: BreakpointAuditEvent,
    run: WorkflowRun,
    payload: Record<string, unknown>
  ): Promise<void>;
}

interface PhaseControlServiceDeps {
  readonly store: Pick<
    WorkspaceStateStore,
    'getRun' | 'setRun' | 'getQueue' | 'setWatchdog'
  >;
  // Feature 093 (T035) — the Pick shrank rather than grew. Phase B added
  // `queueIdForTask` here so each write could name its queue by re-deriving it
  // from the Run; C-1 threading supplies the queue as a parameter instead, so
  // both that resolver and the `findById(...)?.queueId` lookups the cascades
  // used are gone. A derivation that no longer has a caller is one fewer place
  // for the answer to differ.
  readonly queue: Pick<
    QueueManager,
    'cascadedPause' | 'cascadedResume' | 'setQueuePausedState'
  >;
  readonly logger: SanitizedLogger;
  readonly retryCoordinator: Pick<RetryCoordinator, 'cancelPendingTimer'>;
  // Feature 093 (T042) — the three deps that used to be the window's single
  // `RunDriver` / `IsContinueGate` pair are now queue-addressed seams. Each call
  // site below already had its `queueId` in hand, so nothing here needed to
  // start resolving a queue; what changed is that the answer comes from that
  // queue's `RunSession` instead of from the one driver a window used to have.
  // A queue with no session answers "not driving" and no-ops on the rest, which
  // is the correct reading: there is nothing to abort or cancel.
  /** Is this queue's session mid-drive? */
  readonly isDriving: (queueId: string) => boolean;
  readonly noteActivePhaseOverrideAbort: (
    queueId: string,
    runId: string,
    phaseId: string
  ) => void;
  /** Arm this queue's `-c` continuation gate for the drive that follows. */
  readonly armIsContinue: (queueId: string) => void;
  readonly cancelActive: (queueId: string) => void;
  readonly resumeExisting: (queueId: string, customPrompt?: string) => Promise<boolean>;
  readonly auditor: PhaseControlAuditor;
}

/**
 * Owns operator-driven phase mutation policy. The workflow controller remains
 * the public facade and injects runtime/audit effects explicitly so this state
 * machine cannot reach into activation or UI composition.
 *
 * Feature 093 (T035) — every entry point takes the `queueId` it acts on
 * (data-model §4, rule C-1). Nothing here resolves "the current Run": the
 * caller names the queue, the queue names the Run, and a control that cannot
 * name a queue is refused upstream rather than guessed at here.
 */
export class PhaseControlService {
  constructor(private readonly deps: PhaseControlServiceDeps) {}

  public async pauseActivePhase(queueId: string): Promise<MutationResult> {
    this.deps.logger.info('Workflow operation triggered: pauseActivePhase');
    const run = this.deps.store.getRun(queueId);
    const isInRetryCountdown = run?.status === 'paused' && run.pendingRetryAt !== null;
    if (!run || (run.status !== 'running' && !isInRetryCountdown)) {
      return { ok: false, reason: 'no-run-in-flight' };
    }
    if (run.manualPauseAt !== null) return { ok: false, reason: 'run-already-paused' };
    // Feature 093 (T045) — address the cancel at this queue. Unaddressed, pausing
    // one Run mid-countdown discarded every sibling's armed retry too (FR-024).
    if (isInRetryCountdown) this.deps.retryCoordinator.cancelPendingTimer(queueId);

    const updated: WorkflowRun = {
      ...run,
      manualPauseAt: Date.now(),
      manualPauseCause: 'operator-paused'
    };
    await this.deps.store.setRun(queueId, updated);
    try {
      this.deps.cancelActive(queueId);
    } catch (err) {
      this.deps.logger.warn(
        `pauseActivePhase: cancelActive() threw; pause-cause already persisted, audit will still fire: ${(err as Error).message}`
      );
    }
    await this.deps.auditor.appendPhaseControl('phase-pause-requested', updated, {
      runId: updated.id,
      phaseId: updated.currentPhase,
      pausedDuringRetry: isInRetryCountdown
    });
    try {
      await this.deps.auditor.emitTaskPaused(updated);
    } catch (err) {
      this.deps.logger.warn(
        `pauseActivePhase: task-execution-paused audit failed: ${(err as Error).message}`
      );
    }

    // Feature 093 (T035) — this was `findById(run.featureId)?.queueId`, resolved
    // *after* the write and skipped when the Task row was gone. The threaded
    // queue answers the same question before the write and cannot disagree with
    // the queue the Run was just read from, so the null-guard's precondition now
    // holds by construction.
    await this.deps.queue.cascadedPause(queueId);
    return { ok: true };
  }

  public async resumeActivePhase(
    queueId: string,
    customPrompt?: string
  ): Promise<MutationResult> {
    this.deps.logger.info('Workflow operation triggered: resumeActivePhase');
    const run = this.deps.store.getRun(queueId);
    if (!run) return { ok: false, reason: 'no-run-in-flight' };
    if (run.manualPauseAt === null && run.pendingRetryAt === null) {
      return { ok: false, reason: 'run-not-paused' };
    }

    this.deps.armIsContinue(queueId);
    this.deps.retryCoordinator.cancelPendingTimer(queueId);
    const updated: WorkflowRun = {
      ...run,
      status: 'running',
      manualPauseAt: null,
      manualPauseCause: null,
      resumeTargetPhaseId: null,
      pendingRetryAt: null,
      pendingRetryCause: null,
      delayedRetryCount: run.pendingRetryAt !== null ? 0 : run.delayedRetryCount,
      ...(customPrompt ? { resumePrompt: customPrompt } : {})
    };
    await this.deps.store.setRun(queueId, updated);
    await this.deps.auditor.appendPhaseControl('phase-resumed', updated, {
      runId: updated.id,
      phaseId: updated.currentPhase,
      overrodePendingRetry: run.pendingRetryAt !== null
    });

    await this.deps.queue.cascadedResume(queueId);
    this.scheduleResume(queueId, 'resumeActivePhase resume failed');
    return { ok: true };
  }

  public async restartActivePhase(queueId: string): Promise<MutationResult> {
    this.deps.logger.info('Workflow operation triggered: restartActivePhase');
    const run = this.deps.store.getRun(queueId);
    if (!run) return { ok: false, reason: 'no-run-in-flight' };
    this.deps.retryCoordinator.cancelPendingTimer(queueId);
    const hadPendingRetry = run.pendingRetryAt !== null;
    const updated: WorkflowRun = {
      ...run,
      status: 'running',
      currentIteration: 1,
      manualPauseAt: null,
      manualPauseCause: null,
      resumeTargetPhaseId: null,
      pendingRetryAt: null,
      pendingRetryCause: null,
      delayedRetryCount: 0,
      phaseOverrides: run.phaseOverrides.filter(
        (override) => override.phaseId !== run.currentPhase
      ),
      lastTransitionAt: Date.now()
    };
    await this.deps.store.setRun(queueId, updated);
    if (hadPendingRetry || run.delayedRetryCount > 0) {
      // Feature 093 (T035) — the retry-cap pause is recorded on the queue that
      // exhausted it, so the read is queue-addressed for the same reason the
      // Run read is; the ambient form asked the default queue about another
      // queue's pause reason.
      const queueState = this.deps.store.getQueue(queueId);
      const expectedReason = `retry-cap-exhausted:${run.id}`;
      if (queueState.paused && queueState.pausedReason === expectedReason) {
        await this.deps.queue.setQueuePausedState(false, queueId, null);
      }
    }
    await this.deps.auditor.appendPhaseControl('phase-restarted', updated, {
      runId: updated.id,
      phaseId: updated.currentPhase,
      clearedPendingRetry: hadPendingRetry
    });
    if (!this.deps.isDriving(queueId)) {
      this.scheduleResume(queueId, 'restartActivePhase resume failed');
    }
    return { ok: true };
  }

  public async skipPhase(queueId: string, phaseId: string): Promise<MutationResult> {
    this.deps.logger.info('Workflow operation triggered: skipPhase', { phaseId });
    const result = await this.setPhaseOverride(queueId, phaseId, 'skipped', 'phase-skipped');
    if (!result.ok) return result;

    const run = this.deps.store.getRun(queueId);
    if (run?.currentPhase !== phaseId) return result;
    if (run.status === 'running') {
      this.deps.noteActivePhaseOverrideAbort(queueId, run.id, phaseId);
      await this.deps.auditor.emitPhaseJumped(run, phaseId);
      this.deps.cancelActive(queueId);
    } else if (run.status === 'paused') {
      await this.resumeActivePhase(queueId);
    } else if (run.status === 'failed' && run.pendingRetryAt !== null) {
      await this.deps.store.setRun(queueId, {
        ...run,
        pendingRetryAt: null,
        pendingRetryCause: null
      });
      await this.deps.store.setWatchdog({
        paused: false,
        pausedSince: null,
        nextPollAt: null,
        pollIntervalMs: 0,
        cause: null,
        lastStatusOk: null
      });
      this.deps.retryCoordinator.cancelPendingTimer(queueId);
      this.scheduleResume(queueId, 'skipPhase resume failed');
    } else if (run.status === 'failed') {
      await this.deps.store.setRun(queueId, {
        ...run,
        status: 'running',
        lastError: null,
        delayedRetryCount: 0,
        pendingRetryAt: null,
        pendingRetryCause: null,
        manualPauseAt: null,
        manualPauseCause: null,
        resumeTargetPhaseId: null,
        lastTransitionAt: Date.now()
      });
      this.scheduleResume(queueId, 'skipPhase resume (terminal) failed');
    }
    return result;
  }

  public async disablePhase(queueId: string, phaseId: string): Promise<MutationResult> {
    this.deps.logger.info('Workflow operation triggered: disablePhase', { phaseId });
    return this.setPhaseOverride(queueId, phaseId, 'disabled', 'phase-disabled');
  }

  public async enablePhase(queueId: string, phaseId: string): Promise<MutationResult> {
    this.deps.logger.info('Workflow operation triggered: enablePhase', { phaseId });
    const run = this.deps.store.getRun(queueId);
    if (!run) return { ok: false, reason: 'no-run-in-flight' };
    if (!this.phaseExists(run, phaseId)) {
      return { ok: false, reason: 'phase-id-not-in-pipeline-snapshot' };
    }
    if (!run.phaseOverrides.some((override) => override.phaseId === phaseId)) {
      return { ok: false, reason: 'no-override-to-clear' };
    }
    const updated: WorkflowRun = {
      ...run,
      phaseOverrides: run.phaseOverrides.filter((override) => override.phaseId !== phaseId),
      lastTransitionAt: Date.now()
    };
    await this.deps.store.setRun(queueId, updated);
    await this.deps.auditor.appendPhaseControl('phase-enabled', updated, {
      runId: updated.id,
      phaseId
    });
    return { ok: true };
  }

  public async setPhaseBreakpoint(
    queueId: string,
    runId: string,
    phaseId: string
  ): Promise<MutationResult> {
    this.deps.logger.info('Workflow operation triggered: setPhaseBreakpoint', {
      runId,
      phaseId
    });
    // Feature 093 (T040) — this `id !== runId` comparison is a **justified
    // survivor** of the identity-reconciliation sweep. The others existed only
    // because a caller read the one ambient Run slot and had to ask afterwards
    // whether the slot still held the Run it meant. Here `runId` arrives from
    // the webview payload: it is the operator's *named target*, and the check
    // answers "is the Run you pointed at still the one on this queue?" — a
    // staleness answer the operator is entitled to, not an artifact of the slot.
    // Under N concurrent Runs it gets stricter, not looser: `queueId` narrows to
    // one Run and `runId` confirms it is that Run, so a breakpoint can no longer
    // land on a successor that took the queue between render and click.
    const run = this.deps.store.getRun(queueId);
    if (!run || run.id !== runId) return { ok: false, reason: 'run-not-in-flight' };
    if (!this.phaseExists(run, phaseId)) return { ok: false, reason: 'phase-unknown' };
    if (run.currentPhase === phaseId) return { ok: false, reason: 'phase-in-flight' };
    if (run.phasesCompleted.some((entry) => entry.phase === phaseId)) {
      return { ok: false, reason: 'phase-completed' };
    }
    if (run.phaseOverrides.some((override) => override.phaseId === phaseId)) {
      return { ok: false, reason: 'phase-overridden' };
    }
    if (run.phaseBreakpoints.some((entry) => entry.phaseId === phaseId)) {
      return { ok: false, reason: 'breakpoint-already-set' };
    }
    const entry = { phaseId, setAt: Date.now(), actor: 'operator' as const };
    const updated: WorkflowRun = {
      ...run,
      phaseBreakpoints: [...run.phaseBreakpoints, entry],
      lastTransitionAt: Date.now()
    };
    await this.deps.store.setRun(queueId, updated);
    await this.deps.auditor.appendBreakpoint('phase-breakpoint-set', updated, {
      runId: updated.id,
      phaseId,
      actor: 'operator'
    });
    return { ok: true };
  }

  public async clearPhaseBreakpoint(
    queueId: string,
    runId: string,
    phaseId: string
  ): Promise<MutationResult> {
    this.deps.logger.info('Workflow operation triggered: clearPhaseBreakpoint', {
      runId,
      phaseId
    });
    // Feature 093 (T040) — justified survivor, same reasoning as
    // `setPhaseBreakpoint` above: `runId` is the operator's named target, so the
    // comparison validates their selection rather than reconciling a slot.
    const run = this.deps.store.getRun(queueId);
    if (!run || run.id !== runId) return { ok: false, reason: 'run-not-in-flight' };
    if (!run.phaseBreakpoints.some((entry) => entry.phaseId === phaseId)) {
      return { ok: false, reason: 'breakpoint-not-set' };
    }
    const updated: WorkflowRun = {
      ...run,
      phaseBreakpoints: run.phaseBreakpoints.filter((entry) => entry.phaseId !== phaseId),
      lastTransitionAt: Date.now()
    };
    await this.deps.store.setRun(queueId, updated);
    await this.deps.auditor.appendBreakpoint('phase-breakpoint-cleared', updated, {
      runId: updated.id,
      phaseId,
      cause: 'operator'
    });
    return { ok: true };
  }

  public async removeTaskPhase(
    queueId: string,
    taskId: string,
    phaseId: string
  ): Promise<MutationResult & { priorPhaseState?: string; runId?: string }> {
    this.deps.logger.info('Workflow operation triggered: removeTaskPhase', {
      taskId,
      phaseId
    });
    const run = this.deps.store.getRun(queueId);
    if (!run) return { ok: false, reason: 'no-run-in-flight' };
    if (run.featureId !== taskId) return { ok: false, reason: 'unknown-task-id' };
    if (!this.phaseExists(run, phaseId)) return { ok: false, reason: 'unknown-phase-id' };
    if (
      run.phaseOverrides.some(
        (override) => override.phaseId === phaseId && override.action === 'removed'
      )
    ) {
      return { ok: false, reason: 'phase-already-removed' };
    }
    const priorPhaseState = this.describePhaseState(run, phaseId);
    const updated: WorkflowRun = {
      ...run,
      phaseOverrides: [
        ...run.phaseOverrides.filter((existing) => existing.phaseId !== phaseId),
        {
          phaseId,
          action: 'removed',
          setAt: Date.now(),
          actor: getOperatorActor(),
          priorPhaseState
        }
      ],
      lastTransitionAt: Date.now()
    };
    await this.deps.store.setRun(queueId, updated);
    if (run.currentPhase === phaseId && run.status === 'running') {
      this.deps.noteActivePhaseOverrideAbort(queueId, run.id, phaseId);
      this.deps.cancelActive(queueId);
    }
    return { ok: true, priorPhaseState, runId: updated.id };
  }

  private async setPhaseOverride(
    queueId: string,
    phaseId: string,
    action: 'skipped' | 'disabled',
    eventType: 'phase-skipped' | 'phase-disabled'
  ): Promise<MutationResult> {
    const run = this.deps.store.getRun(queueId);
    if (!run) return { ok: false, reason: 'no-run-in-flight' };
    if (!this.phaseExists(run, phaseId)) {
      return { ok: false, reason: 'phase-id-not-in-pipeline-snapshot' };
    }
    const override = {
      phaseId,
      action,
      setAt: Date.now(),
      actor: getOperatorActor()
    };
    const hadBreakpoint = run.phaseBreakpoints.some((entry) => entry.phaseId === phaseId);
    const updated: WorkflowRun = {
      ...run,
      phaseOverrides: [
        ...run.phaseOverrides.filter((existing) => existing.phaseId !== phaseId),
        override
      ],
      phaseBreakpoints: run.phaseBreakpoints.filter((entry) => entry.phaseId !== phaseId),
      lastTransitionAt: Date.now()
    };
    await this.deps.store.setRun(queueId, updated);
    await this.deps.auditor.appendPhaseControl(eventType, updated, {
      runId: updated.id,
      phaseId,
      disabledByOverride: action === 'disabled'
    });
    if (hadBreakpoint) {
      await this.deps.auditor.appendBreakpoint('phase-breakpoint-cleared', updated, {
        runId: updated.id,
        phaseId,
        cause: 'override-applied'
      });
    }
    return { ok: true };
  }

  private phaseExists(run: WorkflowRun, phaseId: string): boolean {
    return (run.pipeline?.phases ?? BUILT_IN_PHASES).some((phase) => phase.id === phaseId);
  }

  private describePhaseState(run: WorkflowRun, phaseId: string): string {
    if (run.currentPhase === phaseId) {
      return run.status === 'running' || run.status === 'paused' ? 'active' : run.status;
    }
    const completed = run.phasesCompleted.find((phase) => phase.phase === phaseId);
    if (completed) return completed.result === 'skipped' ? 'skipped' : completed.result;
    const override = run.phaseOverrides.find((entry) => entry.phaseId === phaseId);
    return override?.action ?? 'future';
  }

  private scheduleResume(queueId: string, message: string): void {
    setImmediate(() => {
      void this.deps.resumeExisting(queueId).catch((err) =>
        this.deps.logger.warn(`${message}: ${(err as Error).message}`)
      );
    });
  }
}
