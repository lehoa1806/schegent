import { BUILT_IN_PHASES } from '../config/pipeline-config';
import { getOperatorActor } from '../lib/operator-attribution';
import type { SanitizedLogger } from '../lib/logger';
import type { QueueManager } from '../queue/queue-manager';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { WorkflowRun } from '../state/workflow-run';
import type { IsContinueGate } from './is-continue-gate';
import type { RetryCoordinator } from '../services/retry-coordinator';
import type { RunDriver } from '../services/run-driver';

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
  readonly queue: Pick<
    QueueManager,
    'findById' | 'cascadedPause' | 'cascadedResume' | 'setQueuePausedState'
  >;
  readonly logger: SanitizedLogger;
  readonly retryCoordinator: Pick<RetryCoordinator, 'cancelPendingTimer'>;
  readonly runDriver: Pick<RunDriver, 'running' | 'noteActivePhaseOverrideAbort'>;
  readonly isContinueGate: Pick<IsContinueGate, 'arm'>;
  readonly cancelActive: () => void;
  readonly resumeExisting: (customPrompt?: string) => Promise<boolean>;
  readonly auditor: PhaseControlAuditor;
}

/**
 * Owns operator-driven phase mutation policy. The workflow controller remains
 * the public facade and injects runtime/audit effects explicitly so this state
 * machine cannot reach into activation or UI composition.
 */
export class PhaseControlService {
  constructor(private readonly deps: PhaseControlServiceDeps) {}

  public async pauseActivePhase(): Promise<MutationResult> {
    this.deps.logger.info('Workflow operation triggered: pauseActivePhase');
    const run = this.deps.store.getRun();
    const isInRetryCountdown = run?.status === 'paused' && run.pendingRetryAt !== null;
    if (!run || (run.status !== 'running' && !isInRetryCountdown)) {
      return { ok: false, reason: 'no-run-in-flight' };
    }
    if (run.manualPauseAt !== null) return { ok: false, reason: 'run-already-paused' };
    if (isInRetryCountdown) this.deps.retryCoordinator.cancelPendingTimer();

    const updated: WorkflowRun = {
      ...run,
      manualPauseAt: Date.now(),
      manualPauseCause: 'operator-paused'
    };
    await this.deps.store.setRun(updated);
    try {
      this.deps.cancelActive();
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

    const queueId = this.deps.queue.findById(run.featureId)?.queueId ?? null;
    if (queueId) await this.deps.queue.cascadedPause(queueId);
    return { ok: true };
  }

  public async resumeActivePhase(customPrompt?: string): Promise<MutationResult> {
    this.deps.logger.info('Workflow operation triggered: resumeActivePhase');
    const run = this.deps.store.getRun();
    if (!run) return { ok: false, reason: 'no-run-in-flight' };
    if (run.manualPauseAt === null && run.pendingRetryAt === null) {
      return { ok: false, reason: 'run-not-paused' };
    }

    this.deps.isContinueGate.arm();
    this.deps.retryCoordinator.cancelPendingTimer();
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
    await this.deps.store.setRun(updated);
    await this.deps.auditor.appendPhaseControl('phase-resumed', updated, {
      runId: updated.id,
      phaseId: updated.currentPhase,
      overrodePendingRetry: run.pendingRetryAt !== null
    });

    const queueId = this.deps.queue.findById(run.featureId)?.queueId ?? null;
    if (queueId) await this.deps.queue.cascadedResume(queueId);
    this.scheduleResume('resumeActivePhase resume failed');
    return { ok: true };
  }

  public async restartActivePhase(): Promise<MutationResult> {
    this.deps.logger.info('Workflow operation triggered: restartActivePhase');
    const run = this.deps.store.getRun();
    if (!run) return { ok: false, reason: 'no-run-in-flight' };
    this.deps.retryCoordinator.cancelPendingTimer();
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
    await this.deps.store.setRun(updated);
    if (hadPendingRetry || run.delayedRetryCount > 0) {
      const queueState = this.deps.store.getQueue();
      const expectedReason = `retry-cap-exhausted:${run.id}`;
      if (queueState.paused && queueState.pausedReason === expectedReason) {
        await this.deps.queue.setQueuePausedState(false, undefined, null);
      }
    }
    await this.deps.auditor.appendPhaseControl('phase-restarted', updated, {
      runId: updated.id,
      phaseId: updated.currentPhase,
      clearedPendingRetry: hadPendingRetry
    });
    if (!this.deps.runDriver.running) {
      this.scheduleResume('restartActivePhase resume failed');
    }
    return { ok: true };
  }

  public async skipPhase(phaseId: string): Promise<MutationResult> {
    this.deps.logger.info('Workflow operation triggered: skipPhase', { phaseId });
    const result = await this.setPhaseOverride(phaseId, 'skipped', 'phase-skipped');
    if (!result.ok) return result;

    const run = this.deps.store.getRun();
    if (run?.currentPhase !== phaseId) return result;
    if (run.status === 'running') {
      this.deps.runDriver.noteActivePhaseOverrideAbort(run.id, phaseId);
      await this.deps.auditor.emitPhaseJumped(run, phaseId);
      this.deps.cancelActive();
    } else if (run.status === 'paused') {
      await this.resumeActivePhase();
    } else if (run.status === 'failed' && run.pendingRetryAt !== null) {
      await this.deps.store.setRun({
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
      this.deps.retryCoordinator.cancelPendingTimer();
      this.scheduleResume('skipPhase resume failed');
    } else if (run.status === 'failed') {
      await this.deps.store.setRun({
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
      this.scheduleResume('skipPhase resume (terminal) failed');
    }
    return result;
  }

  public async disablePhase(phaseId: string): Promise<MutationResult> {
    this.deps.logger.info('Workflow operation triggered: disablePhase', { phaseId });
    return this.setPhaseOverride(phaseId, 'disabled', 'phase-disabled');
  }

  public async enablePhase(phaseId: string): Promise<MutationResult> {
    this.deps.logger.info('Workflow operation triggered: enablePhase', { phaseId });
    const run = this.deps.store.getRun();
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
    await this.deps.store.setRun(updated);
    await this.deps.auditor.appendPhaseControl('phase-enabled', updated, {
      runId: updated.id,
      phaseId
    });
    return { ok: true };
  }

  public async setPhaseBreakpoint(runId: string, phaseId: string): Promise<MutationResult> {
    this.deps.logger.info('Workflow operation triggered: setPhaseBreakpoint', {
      runId,
      phaseId
    });
    const run = this.deps.store.getRun();
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
    await this.deps.store.setRun(updated);
    await this.deps.auditor.appendBreakpoint('phase-breakpoint-set', updated, {
      runId: updated.id,
      phaseId,
      actor: 'operator'
    });
    return { ok: true };
  }

  public async clearPhaseBreakpoint(runId: string, phaseId: string): Promise<MutationResult> {
    this.deps.logger.info('Workflow operation triggered: clearPhaseBreakpoint', {
      runId,
      phaseId
    });
    const run = this.deps.store.getRun();
    if (!run || run.id !== runId) return { ok: false, reason: 'run-not-in-flight' };
    if (!run.phaseBreakpoints.some((entry) => entry.phaseId === phaseId)) {
      return { ok: false, reason: 'breakpoint-not-set' };
    }
    const updated: WorkflowRun = {
      ...run,
      phaseBreakpoints: run.phaseBreakpoints.filter((entry) => entry.phaseId !== phaseId),
      lastTransitionAt: Date.now()
    };
    await this.deps.store.setRun(updated);
    await this.deps.auditor.appendBreakpoint('phase-breakpoint-cleared', updated, {
      runId: updated.id,
      phaseId,
      cause: 'operator'
    });
    return { ok: true };
  }

  public async removeTaskPhase(
    taskId: string,
    phaseId: string
  ): Promise<MutationResult & { priorPhaseState?: string; runId?: string }> {
    this.deps.logger.info('Workflow operation triggered: removeTaskPhase', {
      taskId,
      phaseId
    });
    const run = this.deps.store.getRun();
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
    await this.deps.store.setRun(updated);
    if (run.currentPhase === phaseId && run.status === 'running') {
      this.deps.runDriver.noteActivePhaseOverrideAbort(run.id, phaseId);
      this.deps.cancelActive();
    }
    return { ok: true, priorPhaseState, runId: updated.id };
  }

  private async setPhaseOverride(
    phaseId: string,
    action: 'skipped' | 'disabled',
    eventType: 'phase-skipped' | 'phase-disabled'
  ): Promise<MutationResult> {
    const run = this.deps.store.getRun();
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
    await this.deps.store.setRun(updated);
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

  private scheduleResume(message: string): void {
    setImmediate(() => {
      void this.deps.resumeExisting().catch((err) =>
        this.deps.logger.warn(`${message}: ${(err as Error).message}`)
      );
    });
  }
}
