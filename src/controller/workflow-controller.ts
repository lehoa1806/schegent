import { randomUUID } from 'crypto';
import type { PhaseRunner } from './phase-runner';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { QueueManager } from '../queue/queue-manager';
import type { SchegentStatusBar } from '../ui/status-bar';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkspaceLockManager } from '../state/lock';
import { IsContinueGate } from './is-continue-gate';
import type { SanitizedError, WorkflowRun, WorkflowRunPipeline } from '../state/workflow-run';
import type { FeatureRequest } from '../queue/feature-request';
import type { ClaudeCliMonitor } from '../monitor/claude-cli-monitor';
import type { HistoryStore } from '../state/history-store';
import { HistoryRecorder } from '../services/history-recorder';
import { AutoDrainCoordinator } from '../services/auto-drain-coordinator';
import {
  BUILT_IN_CATALOG,
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
import { cleanupSessionArtifacts } from '../services/session-cleanup/session-cleanup-service';
import { DEFAULT_BACKEND, type BackendRunnerKind } from '../runner/backend-runner-factory';
import { resolvePinnedRunnerKind, snapshotPhaseDef } from '../config/pipeline-snapshot';
import { PhaseControlService, type MutationResult } from './phase-control-service';
import { WorkflowLifecycleAuditor } from './workflow-lifecycle-auditor';
import type { BackendAvailabilityProbe } from '../services/backend-capability-service';

export interface WorkflowControllerOptions {
  cliPath: string;
  cwd: string;
  iterationCap: number;
  timeoutMs: number;
  inheritProcessEnv?: boolean;
  processEnvAllowlist?: readonly string[];
  skipProbing?: boolean;
  cliPathResolver?: (runnerKind: string) => string;
  defaultRunnerKind?: BackendRunnerKind;
  isAuditEvidenceAvailable?: () => boolean;
}

export type { DelayedRetryWatchdog } from './retry-handler';
/**
 * Pluggable cleanup seam invoked after task deletion resolves a run ID.
 * Production uses `cleanupSessionArtifacts`; tests inject a deterministic
 * replacement without spying on non-configurable `fs.rm`.
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
  /** Best-effort lifecycle hook used for inactive session-artifact retention. */
  onRunTerminal?: (run: WorkflowRun) => Promise<void>;
  /** Host-owned bounded executable probe reused by the guarded run start. */
  backendCapabilities?: BackendAvailabilityProbe;
}

export interface StartNewOptions {
  pipelineId?: string;
}

export type { MutationResult } from './phase-control-service';

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
  private catalog: PipelineCatalog;
  private readonly getRetryCapFn: (() => number) | null;
  // Feature 034 — pluggable session-cleanup runner; defaults to the
  // production helper from services/session-cleanup. Tests inject a
  // mock to exercise the success / failure branches deterministically.
  private readonly sessionCleanup: SessionCleanupRunner;
  private readonly historyRecorder: HistoryRecorder;
  private readonly autoDrainCoordinator: AutoDrainCoordinator;
  private readonly retryCoordinator: RetryCoordinator;
  private readonly runDriver: RunDriver;
  private readonly phaseControlService: PhaseControlService;
  private readonly lifecycleAuditor: WorkflowLifecycleAuditor;

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
    const auditWriter = deps.auditWriter ?? null;
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
      auditWriter,
      getRetryCap: () => this.retryCap,
      persistTransition: (prev, next) => this.persistTransition(prev, next)
    });
    this.lifecycleAuditor = new WorkflowLifecycleAuditor(auditWriter, logger);
    this.runDriver = new RunDriver({
      runner,
      store,
      queue,
      statusBar,
      notifier,
      logger,
      lock,
      options,
      backendCapabilities: deps.backendCapabilities,
      monitor: this.monitor,
      historyRecorder: this.historyRecorder,
      retryCoordinator: this.retryCoordinator,
      isContinueGate: this.isContinueGate,
      persistTransition: (prev, next) => this.persistTransition(prev, next),
      appendPhaseControlAudit: (eventType, run, payload) =>
        this.lifecycleAuditor.appendPhaseControl(eventType, run, payload),
      appendRunnerProbeFailedAudit: (run, payload) =>
        this.lifecycleAuditor.appendRunnerProbeFailed(run, payload),
      appendBreakpointAudit: (eventType, run, payload) =>
        this.lifecycleAuditor.appendBreakpoint(eventType, run, payload),
      emitRunEndedBreakpointAudit: (run) =>
        this.lifecycleAuditor.emitRunEndedBreakpoints(run),
      emitTaskLifecycleAudit: (eventType, run, payload) =>
        this.lifecycleAuditor.emitTaskLifecycle(eventType, run, payload),
      emitOptionalPhaseFailureContinued: (run, payload) =>
        this.lifecycleAuditor.emitOptionalPhaseFailureContinued(run, payload),
      onRunTerminal: deps.onRunTerminal,
      scheduleAutoDrain: () => this.scheduleAutoDrain()
    });
    this.phaseControlService = new PhaseControlService({
      store,
      queue,
      logger,
      retryCoordinator: this.retryCoordinator,
      runDriver: this.runDriver,
      isContinueGate: this.isContinueGate,
      cancelActive: () => this.cancelActive(),
      resumeExisting: (customPrompt) => this.resumeExisting(customPrompt),
      auditor: {
        appendPhaseControl: (eventType, run, payload) =>
          this.lifecycleAuditor.appendPhaseControl(eventType, run, payload),
        emitTaskPaused: (run) =>
          this.lifecycleAuditor.emitTaskLifecycle('task-execution-paused', run, {
            taskId: run.featureId,
            runId: run.id,
            pauseCause: 'operator-paused' as const
          }),
        emitPhaseJumped: (run, phaseId) =>
          this.lifecycleAuditor.emitPhaseJumped(run, phaseId),
        appendBreakpoint: (eventType, run, payload) =>
          this.lifecycleAuditor.appendBreakpoint(eventType, run, payload)
      }
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
        defaultRunnerKind: this.options.defaultRunnerKind ?? DEFAULT_BACKEND,
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
      await this.queue.markInFlight(feature.id, run.id, false);
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
        await this.lifecycleAuditor.emitRunEndedBreakpoints(terminalRun);
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

  private resolvePipelineSnapshot(requestedId: string, defaultRunnerKind = this.options.defaultRunnerKind ?? DEFAULT_BACKEND): WorkflowRunPipeline {
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
        phases.push(snapshotPhaseDef(def, defaultRunnerKind));
      } else {
        this.logger.warn(
          `pipeline '${pipeline.id}' references unknown phase '${phaseId}'; substituting 'done'`
        );
        const done = this.catalog.phasesById.get('done');
        if (done) phases.push(snapshotPhaseDef(done, defaultRunnerKind));
      }
    }
    if (!phases.some((p) => p.id === 'done')) {
      const done = this.catalog.phasesById.get('done');
      if (done) phases.push(snapshotPhaseDef(done, defaultRunnerKind));
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

  private synthesizeLegacyPipeline(defaultRunnerKind: BackendRunnerKind): WorkflowRunPipeline {
    return this.resolvePipelineSnapshot(BUILT_IN_PIPELINE_ID, defaultRunnerKind);
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
    const defaultRunnerKind = resolvePinnedRunnerKind(
      run.defaultRunnerKind, run.lastCliSessionRunnerKind, this.options.defaultRunnerKind
    );
    let pipeline = run.pipeline;
    if (!pipeline) {
      pipeline = this.synthesizeLegacyPipeline(defaultRunnerKind);
      this.logger.info(
        `workflow-run.migrated runId=${run.id} fromSchema=pre-009 toPipeline=${BUILT_IN_PIPELINE_ID}`
      );
    }
    const next: WorkflowRun = {
      ...run,
      status: 'running',
      lastError: null,
      pipeline,
      defaultRunnerKind,
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
    await this.queue.markInFlight(feature.id, next.id, true);
    await this.runDriver.drive(next, feature.description);
    return true;
  }

  public async pauseActivePhase(): Promise<MutationResult> {
    return this.phaseControlService.pauseActivePhase();
  }

  public async resumeActivePhase(customPrompt?: string): Promise<MutationResult> {
    return this.phaseControlService.resumeActivePhase(customPrompt);
  }

  public async restartActivePhase(): Promise<MutationResult> {
    return this.phaseControlService.restartActivePhase();
  }

  public async skipPhase(phaseId: string): Promise<MutationResult> {
    return this.phaseControlService.skipPhase(phaseId);
  }

  public async disablePhase(phaseId: string): Promise<MutationResult> {
    return this.phaseControlService.disablePhase(phaseId);
  }

  public async enablePhase(phaseId: string): Promise<MutationResult> {
    return this.phaseControlService.enablePhase(phaseId);
  }

  public async setPhaseBreakpoint(runId: string, phaseId: string): Promise<MutationResult> {
    return this.phaseControlService.setPhaseBreakpoint(runId, phaseId);
  }

  public async clearPhaseBreakpoint(runId: string, phaseId: string): Promise<MutationResult> {
    return this.phaseControlService.clearPhaseBreakpoint(runId, phaseId);
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
    return this.phaseControlService.removeTaskPhase(taskId, phaseId);
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
