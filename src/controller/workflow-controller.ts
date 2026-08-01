import { randomUUID } from 'crypto';
import type { PhaseRunner } from './phase-runner';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { QueueManager } from '../queue/queue-manager';
import type { SchegentStatusBar } from '../ui/status-bar';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkspaceLockManager } from '../state/lock';
import { IsContinueGate } from './is-continue-gate';
import type {
  SanitizedError,
  WorkflowRun,
  WorkflowRunPipeline
} from '../state/workflow-run';
import type { FeatureRequest } from '../queue/feature-request';
import type { ClaudeCliMonitor } from '../monitor/claude-cli-monitor';
import type { HistoryStore } from '../state/history-store';
import { HistoryRecorder } from '../services/history-recorder';
import { AutoDrainCoordinator } from '../services/auto-drain-coordinator';
import {
  BUILT_IN_CATALOG,
  BUILT_IN_PHASES,
  BUILT_IN_PIPELINE,
  BUILT_IN_PIPELINE_ID,
  type PhaseDef,
  type PipelineCatalog
} from '../config/pipeline-config';
import { LockHeldError } from '../lib/errors';
import { DELAYED_RETRY_CAP } from './retry-constants';
import type { DelayedRetryWatchdog } from './retry-handler';
import { RunDriver } from '../services/run-driver';
import { RetryCoordinator, type RateLimitHandler } from '../services/retry-coordinator';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import { getOperatorActor } from '../lib/operator-attribution';
import { cleanupSessionArtifacts } from '../services/session-cleanup/session-cleanup-service';

export interface WorkflowControllerOptions {
  cliPath: string;
  cwd: string;
  iterationCap: number;
  timeoutMs: number;
  inheritProcessEnv?: boolean;
  perPhaseRulesEnabled: boolean;
}

// Feature 034 Item 047 — `DelayedRetryWatchdog` shape moved to
// src/controller/retry-handler.ts (the handler is the primary consumer).
// Re-exported here for backward compatibility with existing imports
// from `src/watchdog/` and `src/extension.ts`.
export type { DelayedRetryWatchdog } from './retry-handler';

/**
 * Feature 034 — pluggable session-cleanup runner. Production wires the
 * default `cleanupSessionArtifacts` from `services/session-cleanup`;
 * tests inject a mock to exercise the success / failure branches
 * deterministically without spying on `fs.rm` (which is non-configurable
 * on `node:fs/promises`). The runner is invoked from `deleteTask` after
 * the existing queue-removal resolves with a non-null `runId`.
 */
export type SessionCleanupRunner = (input: {
  workspaceRoot: string;
  runId: string;
  logger: SanitizedLogger;
}) => Promise<boolean>;

export interface WorkflowControllerDeps {
  monitor?: Pick<ClaudeCliMonitor, 'onStart'> | null;
  historyStore?: Pick<HistoryStore, 'append'> | null;
  catalog?: PipelineCatalog;
  auditWriter?: Pick<AuditLogWriter, 'append'> | null;
  watchdog?: DelayedRetryWatchdog | null;
  /** Dynamic reader for `schegent.retry.maxAttempts`. Falls back to DELAYED_RETRY_CAP. */
  getRetryCap?: () => number;
  /**
   * Feature 034 — optional session-cleanup runner. Defaults to
   * `cleanupSessionArtifacts` from `services/session-cleanup`.
   */
  sessionCleanup?: SessionCleanupRunner;
}

export interface StartNewOptions {
  pipelineId?: string;
}

export type MutationResult = { ok: true } | { ok: false; reason: string };

export class SchegentWorkflowController {
  /**
   * Feature 032 — transient session-continuation hint consumed by
   * `RunDriver.drive()` on the FIRST `runner.run()` call of a single dispatch
   * cycle. Entry points call `isContinueGate.arm()` BEFORE invoking
   * `resumeExisting()` / `RunDriver.drive()`; `RunDriver` consumes-and-resets
   * via `consume()` so subsequent iterations within the same invocation carry
   * `isContinue: false`. NEVER persisted.
   *
   * Feature 056 R5 — extracted to `is-continue-gate.ts` so the arm /
   * consume semantics live in a single tiny class that can't be
   * misused from outside the controller.
   */
  private readonly isContinueGate = new IsContinueGate();

  private readonly monitor: Pick<ClaudeCliMonitor, 'onStart'> | null;
  private readonly auditWriter: Pick<AuditLogWriter, 'append'> | null;
  private catalog: PipelineCatalog;
  private readonly getRetryCapFn: (() => number) | null;
  // Feature 034 — pluggable session-cleanup runner; defaults to the
  // production helper from services/session-cleanup. Tests inject a
  // mock to exercise the success / failure branches deterministically.
  private readonly sessionCleanup: SessionCleanupRunner;
  // Feature 013 — Wave 7 (US7 / T098, T099): decomposed services.
  private readonly historyRecorder: HistoryRecorder;
  private readonly autoDrainCoordinator: AutoDrainCoordinator;
  private readonly retryCoordinator: RetryCoordinator;
  private readonly runDriver: RunDriver;

  constructor(
    runner: PhaseRunner,
    private readonly store: WorkspaceStateStore,
    private readonly queue: QueueManager,
    private readonly statusBar: SchegentStatusBar,
    private readonly notifier: Notifier,
    private readonly logger: SanitizedLogger,
    private readonly lock: WorkspaceLockManager,
    private readonly options: WorkflowControllerOptions,
    deps: WorkflowControllerDeps = {}
  ) {
    this.monitor = deps.monitor ?? null;
    this.auditWriter = deps.auditWriter ?? null;
    this.catalog = deps.catalog ?? BUILT_IN_CATALOG;
    this.getRetryCapFn = deps.getRetryCap ?? null;
    this.sessionCleanup = deps.sessionCleanup ?? cleanupSessionArtifacts;
    this.historyRecorder = new HistoryRecorder({
      historyStore: deps.historyStore ?? null,
      logger
    });
    this.autoDrainCoordinator = new AutoDrainCoordinator({
      store,
      queue,
      lock,
      controller: this,
      logger
    });
    this.retryCoordinator = new RetryCoordinator({
      store,
      queue,
      statusBar,
      notifier,
      logger,
      watchdog: deps.watchdog ?? null,
      auditWriter: this.auditWriter,
      getRetryCap: () => this.retryCap,
      persistTransition: (prev, next) => this.persistTransition(prev, next)
    });
    this.runDriver = new RunDriver({
      runner,
      store,
      queue,
      statusBar,
      notifier,
      logger,
      lock,
      options,
      monitor: this.monitor,
      historyRecorder: this.historyRecorder,
      retryCoordinator: this.retryCoordinator,
      isContinueGate: this.isContinueGate,
      persistTransition: (prev, next) => this.persistTransition(prev, next),
      appendPhaseControlAudit: (eventType, run, payload) =>
        this.appendPhaseControlAudit(eventType, run, payload),
      appendBreakpointAudit: (eventType, run, payload) =>
        this.appendBreakpointAudit(eventType, run, payload),
      emitRunEndedBreakpointAudit: (run) => this.emitRunEndedBreakpointAudit(run),
      emitTaskLifecycleAudit: (eventType, run, payload) =>
        this.emitTaskLifecycleAudit(eventType, run, payload),
      scheduleAutoDrain: () => this.scheduleAutoDrain()
    });
  }

  /**
   * Feature 011 — late injection point. The watchdog is constructed AFTER
   * the controller in `extension.activate()` because the watchdog's resume
   * callback closes over the controller. The activate path calls
   * `setWatchdog()` once both are constructed.
   */
  public setWatchdog(watchdog: DelayedRetryWatchdog | null): void {
    this.retryCoordinator.setWatchdog(watchdog);
  }

  /**
   * BUG-006 — late injection point. `GuardedRunService` is constructed
   * after the controller in `extension.activate()`. Wiring it here enables
   * the retry-handler's rate-limit-family → scheduled-restore branch.
   */
  public setGuardedRunService(
    service: Parameters<RetryCoordinator['setGuardedRunService']>[0]
  ): void {
    this.retryCoordinator.setGuardedRunService(service);
  }

  /**
   * Dynamic retry cap — reads `schegent.retry.maxAttempts` via the injected
   * callback, falling back to the compile-time DELAYED_RETRY_CAP constant.
   */
  private get retryCap(): number {
    const configured = this.getRetryCapFn?.() ?? DELAYED_RETRY_CAP;
    return Math.max(1, Math.min(DELAYED_RETRY_CAP, Math.trunc(configured)));
  }

  public async drainQueuedWork(): Promise<void> {
    await this.autoDrainCoordinator.drainIfIdle();
  }

  public setRateLimitHandler(handler: RateLimitHandler): void {
    this.retryCoordinator.setRateLimitHandler(handler);
  }

  public setCatalog(catalog: PipelineCatalog): void {
    this.catalog = catalog;
  }

  public getCatalog(): PipelineCatalog {
    return this.catalog;
  }

  public get running(): boolean {
    return this.runDriver.running;
  }

  public cancelActive(): void {
    this.runDriver.cancelActive();
  }

  public async startNew(
    feature: FeatureRequest,
    featureDir: string | null,
    options: StartNewOptions = {}
  ): Promise<void> {
    this.logger.info(`Workflow operation triggered: startNew`, { featureId: feature.id, featureDir, options });
    let run: WorkflowRun | null = null;
    try {
      const pipelineSnapshot = this.resolvePipelineSnapshot(
        options.pipelineId ?? feature.pipelineId ?? this.catalog.defaultPipelineId
      );
      const startPhase = featureDir
        ? this.firstPhaseAfterSpecify(pipelineSnapshot)
        : pipelineSnapshot.phases[0]?.id ?? 'done';
      run = {
        id: randomUUID(),
        featureId: feature.id,
        featureDir: featureDir ?? '',
        status: 'running',
        currentPhase: startPhase,
        currentIteration: 0,
        startedAt: Date.now(),
        lastTransitionAt: Date.now(),
        phasesCompleted: [],
        lastError: null,
        pipeline: pipelineSnapshot,
        // Feature 011 — delayed-retry fields start at zero / null.
        delayedRetryCount: 0,
        pendingRetryAt: null,
        pendingRetryCause: null,
        // Feature 017 — per-run phase overrides and manual pause pair start empty/null.
        phaseOverrides: [],
        manualPauseAt: null,
        manualPauseCause: null,
        // Feature 028 — per-run future-phase breakpoints and resume target start empty/null.
        phaseBreakpoints: [],
        resumeTargetPhaseId: null
      };
      await this.store.setRun(run);
      await this.queue.markInFlight(feature.id, run.id);
      // Feature 072 — emit task-execution-started after markInFlight succeeds.
      await this.emitTaskLifecycleAudit('task-execution-started', run, {
        taskId: feature.id,
        runId: run.id,
        queueId: feature.queueId ?? '',
        pipelineId: run.pipeline?.id ?? '',
        isResume: false
      });
      await this.runDriver.drive(run, feature.description);
    } catch (err) {
      await this.handleUnexpectedStartFailure(feature, run, feature.description, err);
    }
  }

  private async handleUnexpectedStartFailure(
    feature: FeatureRequest,
    startedRun: WorkflowRun | null,
    description: string,
    err: unknown
  ): Promise<void> {
    const isLockHeld = err instanceof LockHeldError;
    const message = isLockHeld 
      ? `Another VS Code window holds the workspace lock`
      : this.sanitizeUnexpectedError(err).slice(0, 240);
      
    const latestRun = this.store.getRun();
    const activeRun =
      startedRun && latestRun?.id === startedRun.id
        ? latestRun
        : startedRun;
    const lastError: SanitizedError = {
      code: isLockHeld ? 'lock-held' : 'unexpected-controller-error',
      message,
      phase: activeRun?.currentPhase ?? null,
      iteration: activeRun?.currentIteration ?? null,
      at: Date.now()
    };

    if (isLockHeld) {
      this.logger.warn(`workflow ${feature.id} rejected: workspace lock held by ${this.logger.sanitize((err as LockHeldError).ownerId)}`);
    } else {
      this.logger.error(`workflow ${feature.id} failed unexpectedly: ${message}`);
    }

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
        terminalRun = await this.persistTransition(activeRun, failed);
        await this.emitRunEndedBreakpointAudit(terminalRun);
      } catch (persistErr) {
        this.logger.error(
          `failed to persist unexpected workflow failure: ${this.sanitizeUnexpectedError(persistErr)}`
        );
      }
    } else if (activeRun && activeRun.status === 'failed') {
      terminalRun = activeRun;
    }

    this.statusBar.update({
      kind: 'failed',
      ...(lastError.phase ? { phase: lastError.phase } : {}),
      detail: message
    });
    this.notifier.warn(`Schegent: workflow failed unexpectedly — ${message}.`);

    try {
      await this.queue.finish(feature.id, 'failed', {
        code: lastError.code,
        message: lastError.message,
        ...(lastError.phase ? { phase: lastError.phase } : {}),
        correlationId: terminalRun?.id ?? startedRun?.id ?? feature.id
      });
    } catch (queueErr) {
      this.logger.error(
        `failed to mark queue item failed after unexpected workflow error: ${this.sanitizeUnexpectedError(queueErr)}`
      );
    }

    if (terminalRun && !isLockHeld) {
      try {
        await this.historyRecorder.record(terminalRun, description, 'failed');
      } catch (historyErr) {
        this.logger.warn(
          `failed to record unexpected workflow failure in history: ${this.sanitizeUnexpectedError(historyErr)}`
        );
      }
    }

    await this.lock.release().catch(() => undefined);
    this.scheduleAutoDrain();
  }

  private sanitizeUnexpectedError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return this.logger.sanitize(raw.length > 0 ? raw : 'unknown workflow error');
  }

  private scheduleAutoDrain(): void {
    void this.autoDrainCoordinator.drainIfIdle().catch((err) =>
      this.logger.warn(`auto-drain failed: ${(err as Error).message}`)
    );
  }

  private resolvePipelineSnapshot(requestedId: string): WorkflowRunPipeline {
    let pipeline = this.catalog.pipelinesById.get(requestedId);
    if (!pipeline) {
      if (requestedId !== BUILT_IN_PIPELINE_ID) {
        this.logger.warn(
          `pipeline '${requestedId}' not found in catalog; falling back to '${BUILT_IN_PIPELINE_ID}'`
        );
      }
      pipeline = this.catalog.pipelinesById.get(BUILT_IN_PIPELINE_ID) ?? BUILT_IN_PIPELINE;
    }
    const phases: PhaseDef[] = [];
    for (const phaseId of pipeline.phases) {
      const def = this.catalog.phasesById.get(phaseId);
      if (def) {
        phases.push(def);
      } else {
        this.logger.warn(
          `pipeline '${pipeline.id}' references unknown phase '${phaseId}'; substituting 'done'`
        );
        const done = this.catalog.phasesById.get('done');
        if (done) phases.push(done);
      }
    }
    if (!phases.some((p) => p.id === 'done')) {
      const done = this.catalog.phasesById.get('done');
      if (done) phases.push(done);
    }
    return Object.freeze({
      id: pipeline.id,
      name: pipeline.name,
      phases: Object.freeze([...phases])
    });
  }

  private firstPhaseAfterSpecify(pipeline: WorkflowRunPipeline): string {
    const specifyIdx = pipeline.phases.findIndex((p) => p.id === 'speckit-specify');
    if (specifyIdx >= 0 && specifyIdx + 1 < pipeline.phases.length) {
      return pipeline.phases[specifyIdx + 1].id;
    }
    return pipeline.phases[0]?.id ?? 'done';
  }

  private synthesizeLegacyPipeline(): WorkflowRunPipeline {
    return this.resolvePipelineSnapshot(BUILT_IN_PIPELINE_ID);
  }
  /**
   * Resumes the currently persisted run if it is in a legal resumable state
   * (paused, pending-retry, or failed/bugfix-terminal).
   */
  public async resumeExisting(customPrompt?: string): Promise<boolean> {
    this.logger.info(`Workflow operation triggered: resumeExisting`);
    const run = this.store.getRun();
    if (!run) return false;
    if (run.status === 'completed' || run.status === 'canceled') return false;

    if (customPrompt) {
      await this.store.setRun({
        ...run,
        resumePrompt: customPrompt
      });
    }

    const feature = this.queue.findById(run.featureId);
    if (!feature) {
      this.logger.warn(`resume: feature ${run.featureId} no longer in queue`);
      return false;
    }
    // Feature 032 — derive the continuation hint at resume entry, BEFORE
    // clearing the pause-cause fields below. Two derivation triggers:
    //   1. `pendingRetryCause !== null` — watchdog-fired delayed retry
    //      (transient_error or rate_limit). The retry continues the
    //      failed invocation's conversation.
    //   2. `manualPauseCause !== null` — queue-paused-mid-run cascade
    //      where the queue manager cleared its own field but the
    //      controller never had a chance to clear them via an entry
    //      point. (Operator and breakpoint resumes use the entry-point
    //      arm path below and clear the field BEFORE reaching here.)
    // The explicit `isContinueGate` (armed by `resumeActivePhase` /
    // `retryPhaseNow`) takes effect downstream in `RunDriver.drive()`
    // regardless of what we derive here.
    if (run.pendingRetryCause !== null || run.manualPauseCause !== null) {
      this.isContinueGate.arm();
    }
    let pipeline = run.pipeline;
    if (!pipeline) {
      pipeline = this.synthesizeLegacyPipeline();
      this.logger.info(
        `workflow-run.migrated runId=${run.id} fromSchema=pre-009 toPipeline=${BUILT_IN_PIPELINE_ID}`
      );
    }
    const next: WorkflowRun = {
      ...run,
      status: 'running',
      lastError: null,
      pipeline,
      pendingRetryAt: null,
      pendingRetryCause: null,
      // When resuming a run that was terminally failed (operator retry),
      // reset the retry cap so the phase gets a fresh set of attempts.
      // Also clear stale manual-pause fields that may linger from the
      // failed state.
      ...(run.status === 'failed'
        ? {
            delayedRetryCount: 0,
            manualPauseAt: null,
            manualPauseCause: null,
            resumeTargetPhaseId: null
          }
        : {})
    };
    await this.store.setRun(next);
    await this.queue.markInFlight(feature.id, next.id);
    // Feature 072 — emit task-execution-started with isResume=true.
    await this.emitTaskLifecycleAudit('task-execution-started', next, {
      taskId: feature.id,
      runId: next.id,
      queueId: feature.queueId ?? '',
      pipelineId: next.pipeline?.id ?? '',
      isResume: true
    });
    await this.runDriver.drive(next, feature.description);
    return true;
  }

  public async pauseActivePhase(): Promise<MutationResult> {
    this.logger.info(`Workflow operation triggered: pauseActivePhase`);
    const run = this.store.getRun();
    // Allow pausing both running phases AND phases in delayed-retry countdown
    const isInRetryCountdown = run?.status === 'paused' && run.pendingRetryAt !== null;
    if (!run || (run.status !== 'running' && !isInRetryCountdown)) {
      return { ok: false, reason: 'no-run-in-flight' };
    }
    if (run.manualPauseAt !== null) return { ok: false, reason: 'run-already-paused' };
    // Cancel the watchdog timer when pausing during retry countdown
    if (isInRetryCountdown) {
      this.retryCoordinator.cancelPendingTimer();
    }
    const updated: WorkflowRun = {
      ...run,
      manualPauseAt: Date.now(),
      manualPauseCause: 'operator-paused'
    };
    await this.store.setRun(updated);
    // Feature 033 US1 — Aggressive Pause (FR-001 / FR-002).
    // Persist the pause-cause first (above), then immediately abort the
    // active CLI subprocess. The existing runner pipeline observes the
    // AbortController signal and sends SIGTERM right away; the
    // `SIGKILL_DELAY_MS = 2000` window inside `runClaudeCli` escalates to
    // SIGKILL if the subprocess does not exit gracefully. Audit AFTER the
    // abort so the `phase-pause-requested` event reflects the kill
    // request, not just the persisted intent.
    //
    // The kill is wrapped in try/catch so an unexpected throw from the
    // AbortController never strands the run in a state where (a) the
    // persisted pause-cause IS visible to consumers but (b) the
    // `phase-pause-requested` audit was never emitted. Persisted state
    // and audit log stay in lockstep on every path through this method.
    try {
      this.cancelActive();
    } catch (err) {
      this.logger.warn(
        `pauseActivePhase: cancelActive() threw; pause-cause already persisted, audit will still fire: ${(err as Error).message}`
      );
    }
    await this.appendPhaseControlAudit('phase-pause-requested', updated, {
      runId: updated.id,
      phaseId: updated.currentPhase,
      pausedDuringRetry: isInRetryCountdown
    });
    // Feature 072 — emit task-execution-paused for task-level diagnostics.
    await this.emitTaskLifecycleAudit('task-execution-paused', updated, {
      taskId: updated.featureId,
      runId: updated.id,
      pauseCause: 'operator-paused' as const
    });
    // Feature 028 — US1: cascade-pause the host queue so no further tasks
    // dispatch while the operator reviews the paused phase. Idempotent when
    // the queue is already operator-paused (operator wins). The audit log
    // distinguishes the source via the `queue-paused { source: 'cascade' }`
    // payload emitted by the queue manager.
    const feature = this.queue.findById(run.featureId);
    const queueId = feature?.queueId ?? null;
    if (queueId) {
      await this.queue.cascadedPause(queueId);
    }
    return { ok: true };
  }

  public async resumeActivePhase(customPrompt?: string): Promise<MutationResult> {
    this.logger.info(`Workflow operation triggered: resumeActivePhase`);
    const run = this.store.getRun();
    if (!run) return { ok: false, reason: 'no-run-in-flight' };
    if (run.manualPauseAt === null && run.pendingRetryAt === null) {
      return { ok: false, reason: 'run-not-paused' };
    }
    // Feature 032 — operator resume continues the paused phase's
    // conversation. Arm the dispatch hint BEFORE clearing the pause /
    // retry fields so `RunDriver.drive()` can consume it on the first
    // post-resume `runner.run()` call. Distinguishes resume from
    // restart: `restartActivePhase` does NOT arm this gate.
    this.isContinueGate.arm();
    this.retryCoordinator.cancelPendingTimer();
    const updated: WorkflowRun = {
      ...run,
      status: 'running',
      manualPauseAt: null,
      manualPauseCause: null,
      // Feature 028 — clear resume target when leaving any paused state.
      resumeTargetPhaseId: null,
      pendingRetryAt: null,
      pendingRetryCause: null,
      delayedRetryCount: run.pendingRetryAt !== null ? 0 : run.delayedRetryCount,
      ...(customPrompt ? { resumePrompt: customPrompt } : {})
    };
    await this.store.setRun(updated);
    await this.appendPhaseControlAudit('phase-resumed', updated, {
      runId: updated.id,
      phaseId: updated.currentPhase,
      overrodePendingRetry: run.pendingRetryAt !== null
    });
    // Feature 028 — US1: cascade-resume the host queue ONLY if the queue's
    // pauseSource is 'cascade' (i.e. our own pauseActivePhase installed it).
    // An operator queue-pause that happened independently MUST survive the
    // phase resume — `cascadedResume` is a no-op in that case (FR-004).
    const feature = this.queue.findById(run.featureId);
    const queueId = feature?.queueId ?? null;
    if (queueId) {
      await this.queue.cascadedResume(queueId);
    }
    setImmediate(() => {
      void this.resumeExisting().catch((err) =>
        this.logger.warn(`resumeActivePhase resume failed: ${(err as Error).message}`)
      );
    });
    return { ok: true };
  }

  public async restartActivePhase(): Promise<MutationResult> {
    this.logger.info(`Workflow operation triggered: restartActivePhase`);
    const run = this.store.getRun();
    if (!run) return { ok: false, reason: 'no-run-in-flight' };
    // Cancel any active watchdog timer and clear retry state immediately
    this.retryCoordinator.cancelPendingTimer();
    const hadPendingRetry = run.pendingRetryAt !== null;
    const updated: WorkflowRun = {
      ...run,
      status: 'running',
      currentIteration: 1,
      manualPauseAt: null,
      manualPauseCause: null,
      // Feature 028 — clear resume target on restart.
      resumeTargetPhaseId: null,
      pendingRetryAt: null,
      pendingRetryCause: null,
      delayedRetryCount: 0,
      phaseOverrides: run.phaseOverrides.filter((override) => override.phaseId !== run.currentPhase),
      lastTransitionAt: Date.now()
    };
    await this.store.setRun(updated);
    // If queue was paused due to cap exhaustion, unpause it
    if (hadPendingRetry || run.delayedRetryCount > 0) {
      const queueState = this.store.getQueue();
      const expectedReason = `retry-cap-exhausted:${run.id}`;
      if (queueState.paused && queueState.pausedReason === expectedReason) {
        await this.queue.setQueuePausedState(false, undefined, null);
      }
    }
    await this.appendPhaseControlAudit('phase-restarted', updated, {
      runId: updated.id,
      phaseId: updated.currentPhase,
      clearedPendingRetry: hadPendingRetry
    });
    if (!this.runDriver.running) {
      setImmediate(() => {
        void this.resumeExisting().catch((err) =>
          this.logger.warn(`restartActivePhase resume failed: ${(err as Error).message}`)
        );
      });
    }
    return { ok: true };
  }

  public async skipPhase(phaseId: string): Promise<MutationResult> {
    this.logger.info(`Workflow operation triggered: skipPhase`, { phaseId });
    const result = await this.setPhaseOverride(phaseId, 'skipped', 'phase-skipped');
    if (!result.ok) return result;

    const run = this.store.getRun();
    if (run && run.currentPhase === phaseId) {
      if (run.status === 'running') {
        // Feature 071 — Jump to next step. Cancel the active runner so the
        // skip takes effect immediately instead of waiting for the phase to finish.
        this.runDriver.noteActivePhaseOverrideAbort(run.id, phaseId);
        this.cancelActive();
      } else if (run.status === 'paused') {
        // Feature 071 — If the phase is currently paused, resume it so the
        // engine evaluates the override and advances to the next phase.
        await this.resumeActivePhase();
      } else if (run.status === 'failed' && run.pendingRetryAt !== null) {
        // Feature 071 — If the phase is in backoff, clear the backoff state and
        // wake up the pipeline so the skip takes effect immediately.
        await this.store.setRun({
          ...run,
          pendingRetryAt: null,
          pendingRetryCause: null
        });
        await this.store.setWatchdog({
          paused: false,
          pausedSince: null,
          nextPollAt: null,
          pollIntervalMs: 0,
          cause: null,
          lastStatusOk: null
        });
        this.retryCoordinator.cancelPendingTimer();
        setImmediate(() => {
          void this.resumeExisting().catch((err) =>
            this.logger.warn(`skipPhase resume failed: ${(err as Error).message}`)
          );
        });
      } else if (run.status === 'failed') {
        // Terminal failure (no backoff pending). Clear the error state,
        // reset the retry cap, and wake up the pipeline so the skip
        // override takes effect and the run advances to the next phase.
        await this.store.setRun({
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
        setImmediate(() => {
          void this.resumeExisting().catch((err) =>
            this.logger.warn(`skipPhase resume (terminal) failed: ${(err as Error).message}`)
          );
        });
      }
    }
    return result;
  }

  public async disablePhase(phaseId: string): Promise<MutationResult> {
    this.logger.info(`Workflow operation triggered: disablePhase`, { phaseId });
    return this.setPhaseOverride(phaseId, 'disabled', 'phase-disabled');
  }

  public async enablePhase(phaseId: string): Promise<MutationResult> {
    this.logger.info(`Workflow operation triggered: enablePhase`, { phaseId });
    const run = this.store.getRun();
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
    await this.store.setRun(updated);
    await this.appendPhaseControlAudit('phase-enabled', updated, { runId: updated.id, phaseId });
    return { ok: true };
  }

  // Feature 028 US2 — set a one-shot future-phase breakpoint.
  // Validation per data-model.md §7:
  //   - runId must match the in-flight run.
  //   - phaseId must be in the run's pipeline snapshot.
  //   - phase must NOT be the currently in-flight phase.
  //   - phase must NOT already be in phasesCompleted.
  //   - phase must NOT carry a skipped/disabled/removed override.
  //   - phase must NOT already have a breakpoint armed.
  public async setPhaseBreakpoint(runId: string, phaseId: string): Promise<MutationResult> {
    this.logger.info(`Workflow operation triggered: setPhaseBreakpoint`, { runId, phaseId });
    const run = this.store.getRun();
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
    await this.store.setRun(updated);
    await this.appendBreakpointAudit('phase-breakpoint-set', updated, {
      runId: updated.id,
      phaseId,
      actor: 'operator'
    });
    return { ok: true };
  }

  // Feature 028 US2 — clear a previously-armed breakpoint.
  public async clearPhaseBreakpoint(runId: string, phaseId: string): Promise<MutationResult> {
    this.logger.info(`Workflow operation triggered: clearPhaseBreakpoint`, { runId, phaseId });
    const run = this.store.getRun();
    if (!run || run.id !== runId) return { ok: false, reason: 'run-not-in-flight' };
    if (!run.phaseBreakpoints.some((entry) => entry.phaseId === phaseId)) {
      return { ok: false, reason: 'breakpoint-not-set' };
    }
    const updated: WorkflowRun = {
      ...run,
      phaseBreakpoints: run.phaseBreakpoints.filter((entry) => entry.phaseId !== phaseId),
      lastTransitionAt: Date.now()
    };
    await this.store.setRun(updated);
    await this.appendBreakpointAudit('phase-breakpoint-cleared', updated, {
      runId: updated.id,
      phaseId,
      cause: 'operator'
    });
    return { ok: true };
  }

  public async deleteTask(taskId: string): Promise<{
    ok: boolean;
    reason?: string;
    queueId?: string;
    taskId?: string;
    priorStatus?: string;
    runId?: string | null;
    /**
     * Feature 034 — additive field. Always populated on `ok: true`
     * (`true` iff the cleanup succeeded for both targets; `false` when
     * `runId` was null OR at least one sub-op failed). Omitted on
     * `ok: false` because the rejection path bypasses cleanup entirely.
     */
    sessionCleaned?: boolean;
  }> {
    this.logger.info(`Workflow operation triggered: deleteTask`, { taskId });
    const feature = this.queue.findById(taskId);
    if (feature?.status === 'in-flight') {
      const run = this.store.getRun();
      if (run?.featureId === feature.id && run.status === 'running') {
        this.cancelActive();
        await this.store.setRun({
          ...run,
          status: 'canceled',
          lastTransitionAt: Date.now()
        });
        await this.lock.release().catch(() => undefined);
      }
    }
    const removed = await this.queue.removeTask(taskId);
    if (!removed.ok) {
      // Rejection branch — bypass cleanup; do NOT set sessionCleaned.
      return removed;
    }
    // Feature 034 — best-effort cleanup of the per-runId session tree
    // and the sibling raw transcript file. The cleanup is awaited but
    // ALWAYS resolves; an I/O failure surfaces as `sessionCleaned: false`
    // (with exactly one sanitized warn) and NEVER rolls back the queue
    // removal. See specs/034-task-deletion-cleanup/contracts/session-
    // cleanup.md.
    let sessionCleaned = false;
    if (typeof removed.runId === 'string' && removed.runId.length > 0) {
      sessionCleaned = await this.sessionCleanup({
        workspaceRoot: this.options.cwd,
        runId: removed.runId,
        logger: this.logger
      });
    }
    return { ...removed, sessionCleaned };
  }

  public async removeTaskPhase(
    taskId: string,
    phaseId: string
  ): Promise<MutationResult & { priorPhaseState?: string; runId?: string }> {
    this.logger.info(`Workflow operation triggered: removeTaskPhase`, { taskId, phaseId });
    const run = this.store.getRun();
    if (!run) return { ok: false, reason: 'no-run-in-flight' };
    if (run.featureId !== taskId) return { ok: false, reason: 'unknown-task-id' };
    if (!this.phaseExists(run, phaseId)) {
      return { ok: false, reason: 'unknown-phase-id' };
    }
    if (run.phaseOverrides.some((override) => override.phaseId === phaseId && override.action === 'removed')) {
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
    await this.store.setRun(updated);
    if (run.currentPhase === phaseId && run.status === 'running') {
      this.runDriver.noteActivePhaseOverrideAbort(run.id, phaseId);
      this.cancelActive();
    }
    return { ok: true, priorPhaseState, runId: updated.id };
  }

  /**
   * Feature 011 — manual override for an active delayed-retry run.
   * Wired to `CMD_RETRY_PHASE_NOW` from the webview and the
   * `schegent.retryPhaseNow` command. Per contracts/delayed-retry.md
   * §Manual override.
   */
  public async retryPhaseNow(): Promise<MutationResult> {
    this.logger.info(`Workflow operation triggered: retryPhaseNow`);
    const run = this.store.getRun();
    if (!run) return { ok: false, reason: 'no-active-run' };
    if (run.pendingRetryAt === null || run.pendingRetryCause === null) {
      return { ok: false, reason: 'not-pending-retry' };
    }
    if (this.runDriver.running) return { ok: false, reason: 'already-retrying' };

    // Feature 032 — manual override of a delayed retry is a continuation
    // (same semantics as the watchdog-fired retry). Arm the gate before
    // clearing `pendingRetryCause` below so `RunDriver.drive()` consumes it.
    this.isContinueGate.arm();
    this.retryCoordinator.cancelPendingTimer();

    const queueState = this.store.getQueue();
    const expectedReason = `retry-cap-exhausted:${run.id}`;
    const queueUnpaused = queueState.paused && queueState.pausedReason === expectedReason;
    if (queueUnpaused) {
      await this.queue.setQueuePausedState(false, undefined, null);
    }

    const priorCount = run.delayedRetryCount;
    const updated: WorkflowRun = {
      ...run,
      delayedRetryCount: 0,
      pendingRetryAt: null,
      pendingRetryCause: null
    };
    await this.store.setRun(updated);
    await this.retryCoordinator.appendManualRetryAudit({
      runId: run.id,
      phase: run.currentPhase,
      iteration: run.currentIteration,
      payload: {
        runId: run.id,
        phaseId: run.currentPhase,
        prevDelayedRetryCount: priorCount,
        queueUnpaused
      }
    });

    setImmediate(() => {
      void this.resumeExisting().catch((err) =>
        this.logger.warn(`retryPhaseNow resume failed: ${(err as Error).message}`)
      );
    });
    return { ok: true };
  }

  /**
   * Feature 011 — restart handshake. Called from `extension.activate()`
   * right after `store.initialize()`. If the persisted run has a pending
   * retry timestamp, re-arm the watchdog (or resume immediately if the
   * deadline has already passed). Per contracts/delayed-retry.md §Restart
   * handshake (FR-013).
   */
  public async resumeExistingFromActivation(): Promise<void> {
    const run = this.store.getRun();
    if (!run) return;
    await this.retryCoordinator.resumeExistingFromActivation(run, async () => {
      await this.resumeExisting();
    });
  }

  // Feature 034 Item 047 — rate-limit family + cause normalization +
  // dynamic-backoff computation live in
  // src/controller/rate-limit-backoff.ts. The controller delegates via
  // module-level `toDelayedRetryCause` / `backoffForCause` imports so the
  // dynamic-backoff math is unit-testable in isolation. Semantics
  // (027 FR-009..016) preserved byte-for-byte; CLAUDE.md hard rule
  // "dynamic backoff trusts parsed resetsAtMs; DELAYED_RETRY_CAP bounds
  // attempts" remains in force.

  // Feature 013 T097 / 034 Item 047 — retry/watchdog/rate-limit orchestration
  // is owned by RetryCoordinator, which delegates phase retry state-machine
  // work to src/controller/retry-handler.ts. State-shape, audit-payload, and
  // CLAUDE.md hard-rule semantics (pause-cause pair invariant, pre-buffer
  // resetsAtMs in audit, DELAYED_RETRY_CAP bounds attempts) preserved.

  private async appendPhaseControlAudit(
    eventType:
      | 'phase-pause-requested'
      | 'phase-paused'
      | 'phase-resumed'
      | 'phase-restarted'
      | 'phase-skipped'
      | 'phase-disabled'
      | 'phase-enabled'
      | 'phase-removed',
    run: WorkflowRun,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.auditWriter) return;
    try {
      await this.auditWriter.append({
        runId: run.id,
        phase: run.currentPhase,
        iteration: run.currentIteration,
        eventType,
        payload,
        outcome: 'info'
      });
    } catch (err) {
      this.logger.warn(`phase-control audit append failed: ${(err as Error).message}`);
    }
  }

  // Feature 072 — emit task-execution-* lifecycle audit events.
  // Separate from appendPhaseControlAudit to keep the event type union
  // clean (task-execution-* vs. phase-*).
  private async emitTaskLifecycleAudit(
    eventType: 'task-execution-started' | 'task-execution-ended' | 'task-execution-paused',
    run: WorkflowRun,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.auditWriter) return;
    try {
      await this.auditWriter.append({
        runId: run.id,
        phase: run.currentPhase,
        iteration: run.currentIteration,
        eventType,
        payload,
        outcome: 'info'
      });
    } catch (err) {
      this.logger.warn(`task-lifecycle audit append failed (${eventType}): ${(err as Error).message}`);
    }
  }

  // Feature 028 — emit `phase-breakpoint-cleared { cause: 'run-ended' }` for
  // each remaining breakpoint when the run terminates (completed / failed /
  // canceled). The terminal `WorkflowRun` is the source of truth — the audit
  // events are an evidence trail. The terminal run's `phaseBreakpoints` may
  // remain populated or be cleared; the audit log records the lifecycle.
  private async emitRunEndedBreakpointAudit(run: WorkflowRun): Promise<void> {
    if (run.phaseBreakpoints.length === 0) return;
    for (const bp of run.phaseBreakpoints) {
      await this.appendBreakpointAudit('phase-breakpoint-cleared', run, {
        runId: run.id,
        phaseId: bp.phaseId,
        cause: 'run-ended'
      });
    }
  }

  private async appendBreakpointAudit(
    eventType:
      | 'phase-breakpoint-set'
      | 'phase-breakpoint-cleared'
      | 'phase-breakpoint-fired',
    run: WorkflowRun,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.auditWriter) return;
    try {
      await this.auditWriter.append({
        runId: run.id,
        phase: run.currentPhase,
        iteration: run.currentIteration,
        eventType,
        payload,
        outcome: 'info'
      });
    } catch (err) {
      this.logger.warn(`breakpoint audit append failed: ${(err as Error).message}`);
    }
  }

  private async setPhaseOverride(
    phaseId: string,
    action: 'skipped' | 'disabled',
    eventType: 'phase-skipped' | 'phase-disabled'
  ): Promise<MutationResult> {
    const run = this.store.getRun();
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
    const hadBreakpoint = run.phaseBreakpoints.some((bp) => bp.phaseId === phaseId);
    const updated: WorkflowRun = {
      ...run,
      phaseOverrides: [
        ...run.phaseOverrides.filter((existing) => existing.phaseId !== phaseId),
        override
      ],
      phaseBreakpoints: run.phaseBreakpoints.filter((bp) => bp.phaseId !== phaseId),
      lastTransitionAt: Date.now()
    };
    await this.store.setRun(updated);
    await this.appendPhaseControlAudit(eventType, updated, {
      runId: updated.id,
      phaseId,
      disabledByOverride: action === 'disabled'
    });
    if (hadBreakpoint) {
      await this.appendBreakpointAudit('phase-breakpoint-cleared', updated, {
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
    if (completed) {
      return completed.result === 'skipped' ? 'skipped' : completed.result;
    }
    const override = run.phaseOverrides.find((entry) => entry.phaseId === phaseId);
    if (override) return override.action;
    return 'future';
  }

  private async persistTransition(_prev: WorkflowRun, next: WorkflowRun): Promise<WorkflowRun> {
    const latest = this.store.getRun();
    const merged =
      latest?.id === next.id
        ? {
            ...next,
            phaseOverrides: latest.phaseOverrides,
            // Feature 028 — phaseBreakpoints may be mutated by external
            // operator commands (setPhaseBreakpoint / clearPhaseBreakpoint)
            // between RunDriver iterations. Preserve the latest store state so
            // external writes are not overwritten by stale `next` values.
            // The breakpoint branch in RunDriver explicitly filters the
            // consumed entry before calling persistTransition with the new
            // `next.phaseBreakpoints`; that explicit write wins via the
            // `next.phaseBreakpoints !== _prev.phaseBreakpoints` check.
            phaseBreakpoints:
              next.phaseBreakpoints !== _prev.phaseBreakpoints
                ? next.phaseBreakpoints
                : latest.phaseBreakpoints
          }
        : next;
    await this.store.setRun(merged);
    return merged;
  }

}
