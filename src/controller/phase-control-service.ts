import { getOperatorActor } from '../lib/operator-attribution';
import type { SanitizedLogger } from '../lib/logger';
import type { QueueManager } from '../queue/queue-manager';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { PhaseOverride, WorkflowRun } from '../state/workflow-run';
import type { RetryCoordinator } from '../services/retry-coordinator';
import { plannedTotalPatch } from '../services/run-planned-total';
import { decidePhaseControl, isRunInRetryCountdown, phaseExists } from './phase-control-decision';

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
    'getRun' | 'setRun' | 'getQueue' | 'setWatchdog' | 'runCommitClaim'
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
    if (!run) return { ok: false, reason: 'no-run-in-flight' };
    // FR-R3-151 — the shared classifier replicates the running/retry-countdown
    // and already-paused checks that used to be inline here, so Pause is
    // enforced by the same rule set as every other Phase-control operation.
    const decision = decidePhaseControl({ operation: 'pause', run, targetPhaseId: run.currentPhase });
    if (!decision.eligible) return { ok: false, reason: decision.reason };
    // Same predicate `decidePhaseControl`'s 'pause' branch just decided
    // eligibility with (phase-control-decision.ts) — shared, not re-derived,
    // so this can't silently disagree with the eligibility check above it.
    const isInRetryCountdown = isRunInRetryCountdown(run);
    // Feature 093 (T045) — address the cancel at this queue. Unaddressed, pausing
    // one Run mid-countdown discarded every sibling's armed retry too (FR-024).
    if (isInRetryCountdown) this.deps.retryCoordinator.cancelPendingTimer(queueId);

    const updated: WorkflowRun = {
      ...run,
      manualPauseAt: Date.now(),
      manualPauseCause: 'operator-paused'
    };
    await this.deps.store.setRun(queueId, updated, this.deps.store.runCommitClaim(queueId));
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
    const decision = decidePhaseControl({ operation: 'resume', run, targetPhaseId: run.currentPhase });
    if (!decision.eligible) return { ok: false, reason: decision.reason };

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
    await this.deps.store.setRun(queueId, updated, this.deps.store.runCommitClaim(queueId));
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
    // FR-R3-151 (FR-002) — a terminal Run (completed/canceled) must refuse
    // Restart even though a Run record exists; this used to be the only
    // check here, which is the confirmed defect this classifier call closes.
    const decision = decidePhaseControl({ operation: 'restart', run, targetPhaseId: run.currentPhase });
    if (!decision.eligible) return { ok: false, reason: decision.reason };
    this.deps.retryCoordinator.cancelPendingTimer(queueId);
    const hadPendingRetry = run.pendingRetryAt !== null;
    const nextOverrides = run.phaseOverrides.filter(
      (override) => override.phaseId !== run.currentPhase
    );
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
      phaseOverrides: nextOverrides,
      // FR-R3-008 (T378) — restarting the active phase clears its override, so
      // the phase is back in the plan and the recorded denominator has to say so
      // in this write. Deriving it later from `phaseOverrides` would be a second
      // rule for the same number.
      ...plannedTotalPatch(run, nextOverrides),
      lastTransitionAt: Date.now()
    };
    await this.deps.store.setRun(queueId, updated, this.deps.store.runCommitClaim(queueId));
    if (hadPendingRetry || run.delayedRetryCount > 0) {
      // Feature 093 (T035) — the retry-cap pause is recorded on the queue that
      // exhausted it, so the read is queue-addressed for the same reason the
      // Run read is; the ambient form asked the default queue about another
      // queue's pause reason.
      const queueState = this.deps.store.getQueue(queueId);
      const expectedReason = `retry-cap-exhausted:${run.id}`;
      // FR-R3-011 — pausedness reads from the one persisted value; the reason
      // string is a live field on the same record and is matched as before.
      if (queueState.queueLifecycle === 'operator-paused' && queueState.pausedReason === expectedReason) {
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
    const run = this.deps.store.getRun(queueId);
    // FR-R3-151 (FR-004) — the confirmed defect was accepting a phaseId that
    // is not the current Phase at all. Deliberately no run.status==='running'
    // gate here: the recovery branches below already treat 'paused' and
    // 'failed' Runs as legitimate skip-to-recover starting points, so the
    // classifier's 'skip' branch only checks phase-currency, not run status.
    const decision = decidePhaseControl({ operation: 'skip', run, targetPhaseId: phaseId });
    if (!decision.eligible) return { ok: false, reason: decision.reason };
    // Unreachable at runtime — the classifier's 'skip' branch already
    // rejects a null `run` above; kept as the type guard the write below
    // needs, and so `run` can be threaded into `setPhaseOverride` instead of
    // re-fetched there.
    if (!run) return { ok: false, reason: 'no-run-in-flight' };

    const result = await this.setPhaseOverride(queueId, run, phaseId, 'skipped', 'phase-skipped');
    if (!result.ok) return result;

    const runAfterOverride = this.deps.store.getRun(queueId);
    if (runAfterOverride?.currentPhase !== phaseId) return result;
    if (runAfterOverride.status === 'running') {
      this.deps.noteActivePhaseOverrideAbort(queueId, runAfterOverride.id, phaseId);
      await this.deps.auditor.emitPhaseJumped(runAfterOverride, phaseId);
      this.deps.cancelActive(queueId);
    } else if (runAfterOverride.status === 'paused') {
      await this.resumeActivePhase(queueId);
    } else if (runAfterOverride.status === 'failed' && runAfterOverride.pendingRetryAt !== null) {
      await this.deps.store.setRun(queueId, {
        ...runAfterOverride,
        pendingRetryAt: null,
        pendingRetryCause: null
      },
        this.deps.store.runCommitClaim(queueId)
      );
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
    } else if (runAfterOverride.status === 'failed') {
      await this.deps.store.setRun(queueId, {
        ...runAfterOverride,
        status: 'running',
        lastError: null,
        delayedRetryCount: 0,
        pendingRetryAt: null,
        pendingRetryCause: null,
        manualPauseAt: null,
        manualPauseCause: null,
        resumeTargetPhaseId: null,
        lastTransitionAt: Date.now()
      },
        this.deps.store.runCommitClaim(queueId)
      );
      this.scheduleResume(queueId, 'skipPhase resume (terminal) failed');
    }
    return result;
  }

  public async disablePhase(queueId: string, phaseId: string): Promise<MutationResult> {
    this.deps.logger.info('Workflow operation triggered: disablePhase', { phaseId });
    const run = this.deps.store.getRun(queueId);
    // FR-R3-151 (FR-005) — the confirmed defect was accepting a phaseId that
    // had already started (active or completed); Disable now refuses unless
    // the target is still future.
    const decision = decidePhaseControl({ operation: 'disable', run, targetPhaseId: phaseId });
    if (!decision.eligible) return { ok: false, reason: decision.reason };
    // Unreachable at runtime — same reasoning as `skipPhase` above.
    if (!run) return { ok: false, reason: 'no-run-in-flight' };
    return this.setPhaseOverride(queueId, run, phaseId, 'disabled', 'phase-disabled');
  }

  public async enablePhase(queueId: string, phaseId: string): Promise<MutationResult> {
    this.deps.logger.info('Workflow operation triggered: enablePhase', { phaseId });
    const run = this.deps.store.getRun(queueId);
    if (!run) return { ok: false, reason: 'no-run-in-flight' };
    // FR-R3-151 (FR-006) — the confirmed defect was accepting Enable whenever
    // *any* override existed for the phase, regardless of its action or
    // whether the phase was still future. The classifier requires both.
    const decision = decidePhaseControl({ operation: 'enable', run, targetPhaseId: phaseId });
    if (!decision.eligible) return { ok: false, reason: decision.reason };
    const nextOverrides = run.phaseOverrides.filter((override) => override.phaseId !== phaseId);
    const updated: WorkflowRun = {
      ...run,
      phaseOverrides: nextOverrides,
      // FR-R3-008 (T378) — re-enabling a phase puts work back into the plan, so
      // the total grows in the same write and reported progress falls. That is
      // honest: there is more left to do than there was a moment ago.
      ...plannedTotalPatch(run, nextOverrides),
      lastTransitionAt: Date.now()
    };
    await this.deps.store.setRun(queueId, updated, this.deps.store.runCommitClaim(queueId));
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
    const matchedRun = run && run.id === runId ? run : null;
    // FR-R3-151 (FR-001) — set-breakpoint routes through the same shared
    // classifier as every other Phase-control operation; its refusal reasons
    // are unchanged from before this feature (phase-unknown/phase-in-flight/
    // phase-completed/phase-overridden/breakpoint-already-set).
    const decision = decidePhaseControl({ operation: 'set-breakpoint', run: matchedRun, targetPhaseId: phaseId });
    if (!decision.eligible) return { ok: false, reason: decision.reason };
    // Unreachable at runtime — the classifier's 'set-breakpoint' branch
    // already rejects a null `run` with this exact reason
    // (phase-control-decision.ts), so `decision.eligible` above is always
    // `false` when `matchedRun` is `null`. TypeScript cannot see through
    // that opaque call to narrow `matchedRun` itself, so this stays as the
    // type guard the write below needs; the string literal is provably
    // never independently reached, not a second copy that could drift.
    if (!matchedRun) return { ok: false, reason: 'run-not-in-flight' };
    const entry = { phaseId, setAt: Date.now(), actor: 'operator' as const };
    const updated: WorkflowRun = {
      ...matchedRun,
      phaseBreakpoints: [...matchedRun.phaseBreakpoints, entry],
      lastTransitionAt: Date.now()
    };
    await this.deps.store.setRun(queueId, updated, this.deps.store.runCommitClaim(queueId));
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
    const matchedRun = run && run.id === runId ? run : null;
    const decision = decidePhaseControl({ operation: 'clear-breakpoint', run: matchedRun, targetPhaseId: phaseId });
    if (!decision.eligible) return { ok: false, reason: decision.reason };
    // Unreachable at runtime — same reasoning as `setPhaseBreakpoint` above:
    // the classifier's 'clear-breakpoint' branch already rejects a null
    // `run` with this exact reason, kept only as the type guard TypeScript
    // needs since it cannot narrow `matchedRun` through that opaque call.
    if (!matchedRun) return { ok: false, reason: 'run-not-in-flight' };
    const updated: WorkflowRun = {
      ...matchedRun,
      phaseBreakpoints: matchedRun.phaseBreakpoints.filter((entry) => entry.phaseId !== phaseId),
      lastTransitionAt: Date.now()
    };
    await this.deps.store.setRun(queueId, updated, this.deps.store.runCommitClaim(queueId));
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
    // FR-R3-151 (FR-007; Feature 022 FR-008–FR-013) — routed through the
    // shared classifier for census coverage, but Delete's own eligibility
    // (any visible Phase state) is deliberately unchanged: the classifier's
    // 'delete' branch is permissive by design and the task-id/phase-id/
    // already-removed checks below remain this method's own.
    const decision = decidePhaseControl({ operation: 'delete', run, targetPhaseId: phaseId });
    if (!decision.eligible) return { ok: false, reason: decision.reason };
    if (!run) return { ok: false, reason: 'no-run-in-flight' };
    if (run.featureId !== taskId) return { ok: false, reason: 'unknown-task-id' };
    if (!phaseExists(run, phaseId)) return { ok: false, reason: 'unknown-phase-id' };
    if (
      run.phaseOverrides.some(
        (override) => override.phaseId === phaseId && override.action === 'removed'
      )
    ) {
      return { ok: false, reason: 'phase-already-removed' };
    }
    const priorPhaseState = this.describePhaseState(run, phaseId);
    const nextOverrides: PhaseOverride[] = [
      ...run.phaseOverrides.filter((existing) => existing.phaseId !== phaseId),
      {
        phaseId,
        action: 'removed',
        setAt: Date.now(),
        actor: getOperatorActor(),
        priorPhaseState
      }
    ];
    const updated: WorkflowRun = {
      ...run,
      phaseOverrides: nextOverrides,
      // FR-R3-008 (T378) — a removed phase leaves the plan, so it leaves the
      // denominator in the same write. Both sides of the progress fraction
      // exclude the same override set, which is what keeps the driver's later
      // `result: 'skipped'` record from pushing progress past 100%.
      ...plannedTotalPatch(run, nextOverrides),
      lastTransitionAt: Date.now()
    };
    await this.deps.store.setRun(queueId, updated, this.deps.store.runCommitClaim(queueId));
    if (run.currentPhase === phaseId && run.status === 'running') {
      this.deps.noteActivePhaseOverrideAbort(queueId, run.id, phaseId);
      this.deps.cancelActive(queueId);
    }
    return { ok: true, priorPhaseState, runId: updated.id };
  }

  private async setPhaseOverride(
    queueId: string,
    run: WorkflowRun,
    phaseId: string,
    action: 'skipped' | 'disabled',
    eventType: 'phase-skipped' | 'phase-disabled'
  ): Promise<MutationResult> {
    // FR-R3-151 — eligibility is decided by the caller (skipPhase/
    // disablePhase) via decidePhaseControl before this writer runs; `run` is
    // the same Run that call already validated, threaded in rather than
    // re-fetched, so there is one read of the store per mutation instead of
    // two and no second `!run` narrowing check to keep in sync with it.
    const override = {
      phaseId,
      action,
      setAt: Date.now(),
      actor: getOperatorActor()
    };
    const hadBreakpoint = run.phaseBreakpoints.some((entry) => entry.phaseId === phaseId);
    const nextOverrides: PhaseOverride[] = [
      ...run.phaseOverrides.filter((existing) => existing.phaseId !== phaseId),
      override
    ];
    const updated: WorkflowRun = {
      ...run,
      phaseOverrides: nextOverrides,
      // FR-R3-008 (T378) — skip and disable both narrow the plan, so both narrow
      // the recorded total here. This is the write the acceptance criterion names:
      // overriding a phase that has not run yet raises reported progress, because
      // the numerator is unchanged and there is less left to do.
      ...plannedTotalPatch(run, nextOverrides),
      phaseBreakpoints: run.phaseBreakpoints.filter((entry) => entry.phaseId !== phaseId),
      lastTransitionAt: Date.now()
    };
    await this.deps.store.setRun(queueId, updated, this.deps.store.runCommitClaim(queueId));
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
