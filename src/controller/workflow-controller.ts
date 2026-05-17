import { randomUUID } from 'crypto';
import type { PhaseRunner } from './phase-runner';
import { composePhaseMessagePath } from './phase-runner';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { QueueManager } from '../queue/queue-manager';
import type { SchegentStatusBar } from '../ui/status-bar';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkspaceLockManager } from '../state/lock';
import { IsContinueGate } from './is-continue-gate';
import { PhaseSequencer, nextOverridesAfterSkip } from './phase-sequencer';
import type {
  PhaseResult,
  SanitizedError,
  WorkflowRun,
  WorkflowRunPipeline
} from '../state/workflow-run';
import type { FeatureRequest } from '../queue/feature-request';
import type { ClaudeCliMonitor } from '../monitor/claude-cli-monitor';
import type { HistoryStore } from '../state/history-store';
import { HistoryRecorder } from '../services/history-recorder';
import { AutoDrainCoordinator } from '../services/auto-drain-coordinator';
import type { PhaseName } from '../ui/sidebar/snapshot';
import {
  BUILT_IN_CATALOG,
  BUILT_IN_PHASES,
  BUILT_IN_PIPELINE,
  BUILT_IN_PIPELINE_ID,
  type PhaseDef,
  type PipelineCatalog
} from '../config/pipeline-config';
import { DELAYED_RETRY_CAP } from './retry-constants';
import { RetryHandler, type DelayedRetryWatchdog } from './retry-handler';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import { getOperatorActor } from '../lib/operator-attribution';
import { cleanupSessionArtifacts } from '../services/session-cleanup/session-cleanup-service';

export interface WorkflowControllerOptions {
  cliPath: string;
  cwd: string;
  iterationCap: number;
  timeoutMs: number;
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

export type RateLimitHandler = (cause: string, run: WorkflowRun) => Promise<void>;

export type MutationResult = { ok: true } | { ok: false; reason: string };

export class SchegentWorkflowController {
  private cancellationController: AbortController | null = null;
  private isRunning = false;
  private rateLimitHandler: RateLimitHandler | null = null;
  private carriedIssues: Array<{ tag?: string; summary: string }> | string[] = [];
  private readonly removedActivePhaseAborts = new Set<string>();
  /**
   * Feature 032 — transient session-continuation hint consumed by
   * `driveRun()` on the FIRST `runner.run()` call of a single dispatch
   * cycle. Entry points call `isContinueGate.arm()` BEFORE invoking
   * `resumeExisting()` / `driveRun()`; `driveRun()` consumes-and-resets
   * via `consume()` so subsequent iterations within the same drive
   * invocation carry `isContinue: false`. NEVER persisted.
   *
   * Feature 056 R5 — extracted to `is-continue-gate.ts` so the arm /
   * consume semantics live in a single tiny class that can't be
   * misused from outside the controller.
   */
  private readonly isContinueGate = new IsContinueGate();

  private readonly monitor: Pick<ClaudeCliMonitor, 'onStart'> | null;
  private readonly auditWriter: Pick<AuditLogWriter, 'append'> | null;
  private watchdog: DelayedRetryWatchdog | null;
  private catalog: PipelineCatalog;
  private readonly getRetryCapFn: (() => number) | null;
  // Feature 034 — pluggable session-cleanup runner; defaults to the
  // production helper from services/session-cleanup. Tests inject a
  // mock to exercise the success / failure branches deterministically.
  private readonly sessionCleanup: SessionCleanupRunner;
  // Feature 013 — Wave 7 (US7 / T098, T099): decomposed services.
  private readonly historyRecorder: HistoryRecorder;
  private readonly autoDrainCoordinator: AutoDrainCoordinator;
  // Feature 034 Item 047 — delayed-retry state machine extracted into a
  // collaborator so the controller stays focused on orchestration. The
  // handler closes over the controller's persistTransition + getRetryCap
  // surface so persisted-state shape and retry-cap math stay centralised.
  private readonly retryHandler: RetryHandler;
  // Feature 034 Item 047 (completion) — pure next-phase decision module.
  // The sequencer wraps `transition()` with run-state awareness
  // (phaseOverrides, phaseBreakpoints, verify-phase non-clean, manual-
  // pause-mid-run). Stateless: a single instance is reused across runs.
  private readonly sequencer: PhaseSequencer = new PhaseSequencer();

  constructor(
    private readonly runner: PhaseRunner,
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
    this.watchdog = deps.watchdog ?? null;
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
      controller: this
    });
    this.retryHandler = new RetryHandler({
      store,
      queue,
      statusBar,
      notifier,
      logger,
      getWatchdog: () => this.watchdog,
      auditWriter: this.auditWriter,
      getRetryCap: () => this.retryCap,
      persistTransition: (prev, next) => this.persistTransition(prev, next)
    });
  }

  /**
   * Feature 011 — late injection point. The watchdog is constructed AFTER
   * the controller in `extension.activate()` because the watchdog's resume
   * callback closes over the controller. The activate path calls
   * `setWatchdog()` once both are constructed.
   */
  public setWatchdog(watchdog: DelayedRetryWatchdog | null): void {
    this.watchdog = watchdog;
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
    this.rateLimitHandler = handler;
  }

  public setCatalog(catalog: PipelineCatalog): void {
    this.catalog = catalog;
  }

  public getCatalog(): PipelineCatalog {
    return this.catalog;
  }

  public get running(): boolean {
    return this.isRunning;
  }

  public cancelActive(): void {
    this.cancellationController?.abort();
  }

  public async startNew(
    feature: FeatureRequest,
    featureDir: string | null,
    options: StartNewOptions = {}
  ): Promise<void> {
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
      await this.driveRun(run, feature.description);
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
    const message = this.sanitizeUnexpectedError(err).slice(0, 240);
    const latestRun = this.store.getRun();
    const activeRun =
      startedRun && latestRun?.id === startedRun.id
        ? latestRun
        : startedRun;
    const lastError: SanitizedError = {
      code: 'unexpected-controller-error',
      message,
      phase: activeRun?.currentPhase ?? null,
      iteration: activeRun?.currentIteration ?? null,
      at: Date.now()
    };

    this.logger.error(`workflow ${feature.id} failed unexpectedly: ${message}`);

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

    if (terminalRun) {
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

  public async resumeExisting(): Promise<boolean> {
    const run = this.store.getRun();
    if (!run) return false;
    if (run.status === 'completed' || run.status === 'canceled') return false;
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
    // `retryPhaseNow`) takes effect downstream in `driveRun()`
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
      pendingRetryCause: null
    };
    await this.store.setRun(next);
    await this.queue.markInFlight(feature.id, next.id);
    await this.driveRun(next, feature.description);
    return true;
  }

  public async pauseActivePhase(): Promise<MutationResult> {
    const run = this.store.getRun();
    // Allow pausing both running phases AND phases in delayed-retry countdown
    const isInRetryCountdown = run?.status === 'paused' && run.pendingRetryAt !== null;
    if (!run || (run.status !== 'running' && !isInRetryCountdown)) {
      return { ok: false, reason: 'no-run-in-flight' };
    }
    if (run.manualPauseAt !== null) return { ok: false, reason: 'run-already-paused' };
    // Cancel the watchdog timer when pausing during retry countdown
    if (isInRetryCountdown) {
      this.watchdog?.cancelPendingTimer();
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

  public async resumeActivePhase(): Promise<MutationResult> {
    const run = this.store.getRun();
    if (!run) return { ok: false, reason: 'no-run-in-flight' };
    if (run.manualPauseAt === null && run.pendingRetryAt === null) {
      return { ok: false, reason: 'run-not-paused' };
    }
    // Feature 032 — operator resume continues the paused phase's
    // conversation. Arm the dispatch hint BEFORE clearing the pause /
    // retry fields so `driveRun()` can consume it on the first
    // post-resume `runner.run()` call. Distinguishes resume from
    // restart: `restartActivePhase` does NOT arm this gate.
    this.isContinueGate.arm();
    this.watchdog?.cancelPendingTimer();
    const updated: WorkflowRun = {
      ...run,
      status: 'running',
      manualPauseAt: null,
      manualPauseCause: null,
      // Feature 028 — clear resume target when leaving any paused state.
      resumeTargetPhaseId: null,
      pendingRetryAt: null,
      pendingRetryCause: null,
      delayedRetryCount: run.pendingRetryAt !== null ? 0 : run.delayedRetryCount
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
    const run = this.store.getRun();
    if (!run) return { ok: false, reason: 'no-run-in-flight' };
    // Cancel any active watchdog timer and clear retry state immediately
    this.watchdog?.cancelPendingTimer();
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
        await this.queue.setPaused(false, null);
      }
    }
    await this.appendPhaseControlAudit('phase-restarted', updated, {
      runId: updated.id,
      phaseId: updated.currentPhase,
      clearedPendingRetry: hadPendingRetry
    });
    if (!this.isRunning) {
      setImmediate(() => {
        void this.resumeExisting().catch((err) =>
          this.logger.warn(`restartActivePhase resume failed: ${(err as Error).message}`)
        );
      });
    }
    return { ok: true };
  }

  public async skipPhase(phaseId: string): Promise<MutationResult> {
    return this.setPhaseOverride(phaseId, 'skipped', 'phase-skipped');
  }

  public async disablePhase(phaseId: string): Promise<MutationResult> {
    return this.setPhaseOverride(phaseId, 'disabled', 'phase-disabled');
  }

  public async enablePhase(phaseId: string): Promise<MutationResult> {
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
      this.removedActivePhaseAborts.add(this.phaseRemovalAbortKey(run.id, phaseId));
      this.cancelActive();
    }
    return { ok: true, priorPhaseState, runId: updated.id };
  }

  private async driveRun(initial: WorkflowRun, description: string): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('controller already running; ignoring duplicate driveRun');
      return;
    }
    this.isRunning = true;
    this.cancellationController = new AbortController();
    let run = initial;
    let previousPhaseMessage: Readonly<Record<string, string>> | null = null;
    // Feature 032 — capture-and-reset the continuation hint at driveRun
    // entry. Only the FIRST `runner.run()` call inside the loop applies
    // the flag; subsequent phase / loop iterations within this same
    // driveRun invocation are fresh. The instance gate is reset
    // immediately so a re-entrant or cascaded invocation cannot
    // inadvertently inherit it.
    let pendingIsContinue = this.isContinueGate.consume();
    // Feature 034 Item 046 — auto-release lock wrapper. The body below
    // calls `session.retain()` on every pause-style exit (breakpoint,
    // delayed-retry, rate-limit, verify pause, manual pause) so the lock
    // survives for the upcoming resume. Terminal paths (failed,
    // completed, cancelled, unexpected break) leave `retain` unset; the
    // wrapper's `finally` releases the lock. Every exit path is covered
    // uniformly by the wrapper.
    try {
      await this.lock.withLock('drive-run', async (session) => {
       while (run.currentPhase !== 'done' && run.status === 'running') {
        // Non-null asserted: `this.cancellationController` is assigned
        // before this withLock call (line 646) and reset only in the
        // outer `finally` after the wrapper resolves. Any in-body
        // reassignment (after a phase-removal abort, see below) replaces
        // it with a fresh AbortController — never null.
        if (this.cancellationController!.signal.aborted) {
          run = await this.persistTransition(run, { ...run, status: 'canceled' });
          await this.emitRunEndedBreakpointAudit(run);
          await this.historyRecorder.record(run, description, 'canceled');
          break;
        }

        const preDecision = this.sequencer.decideBeforePhase({
          run,
          iterationCap: this.options.iterationCap,
          now: Date.now()
        });
        if (preDecision.kind === 'skip-phase') {
          const { override: phaseOverride, skippedResult, transition: decision } = preDecision;
          const advanced: WorkflowRun = {
            ...run,
            phaseOverrides: nextOverridesAfterSkip(run, phaseOverride),
            currentPhase: decision.kind === 'advance' ? decision.nextPhase : run.currentPhase,
            currentIteration: decision.kind === 'advance' ? decision.nextIteration : run.currentIteration,
            lastTransitionAt: Date.now(),
            phasesCompleted: [...run.phasesCompleted, skippedResult]
          };
          run = await this.persistTransition(run, advanced);
          previousPhaseMessage = null;
          await this.appendPhaseControlAudit(
            phaseOverride.action === 'disabled'
              ? 'phase-disabled'
              : phaseOverride.action === 'removed'
                ? 'phase-removed'
                : 'phase-skipped',
            run,
            {
              runId: run.id,
              phaseId: skippedResult.phase,
              disabledByOverride: phaseOverride.action === 'disabled',
              removedByOverride: phaseOverride.action === 'removed'
            }
          );
          continue;
        }

        const iteration = preDecision.iteration;
        this.statusBar.update({
          kind: 'running',
          phase: run.currentPhase,
          iteration,
          iterationCap: this.options.iterationCap
        });

        const phaseStartedAt = Date.now();
        if (this.monitor) {
          try {
            this.monitor.onStart(run.id, run.currentPhase as PhaseName, null);
          } catch {
            // monitor errors must not propagate
          }
        }
        const activePhaseDef = preDecision.activePhaseDef;
        // Feature 032 — consume-and-reset the continuation hint on this
        // dispatch only. The flag is true only on the FIRST iteration of
        // the loop following a resume/retry entry point that armed it.
        const dispatchIsContinue = pendingIsContinue;
        pendingIsContinue = false;
        const output = await this.runner.run({
          phase: run.currentPhase,
          phaseDef: activePhaseDef,
          pipelineId: run.pipeline?.id ?? BUILT_IN_PIPELINE_ID,
          iteration,
          iterationCap: this.options.iterationCap,
          featureDescription: description,
          featureDir: run.featureDir || null,
          carriedIssues: this.carriedIssues,
          cliPath: this.options.cliPath,
          cwd: this.options.cwd,
          timeoutMs: activePhaseDef?.timeoutSeconds
            ? activePhaseDef.timeoutSeconds * 1000
            : this.options.timeoutMs,
          runId: run.id,
          phaseMessagePath: composePhaseMessagePath({
            cwd: this.options.cwd,
            runId: run.id,
            pipelineId: run.pipeline?.id ?? BUILT_IN_PIPELINE_ID,
            phaseId: run.currentPhase,
            iteration
          }),
          previousPhaseMessage,
          cancellationSignal: this.cancellationController!.signal as unknown as {
            aborted: boolean;
            addEventListener(event: 'abort', cb: () => void): void;
          },
          // Feature 032 — `isContinue` is set only on the first iteration
          // following a resume/retry entry-point arm. All other
          // dispatches (loop iterations, phase advancements, fresh runs)
          // pass `false`.
          isContinue: dispatchIsContinue
        });
        if (this.removedActivePhaseAborts.delete(this.phaseRemovalAbortKey(run.id, run.currentPhase))) {
          const latestRun = this.store.getRun();
          if (latestRun?.id === run.id) {
            run = latestRun;
          }
          this.cancellationController = new AbortController();
          continue;
        }

        // Feature 034 Item 047 (completion) — single sequencer call that
        // classifies the runner's output into a typed next-action. The
        // controller below switches on `postDecision.kind` and owns all
        // state persistence + audit + queue + status-bar + lock retention.
        // The pre-runner `phaseStartedAt` is reused to stamp `startedAt` on
        // the phaseResult; `endedAt` becomes `Date.now()` at decision time.
        const postDecision = this.sequencer.decideAfterPhase({
          run,
          output,
          iteration,
          iterationCap: this.options.iterationCap,
          activePhaseDef,
          latestRun: this.store.getRun(),
          now: Date.now()
        });
        for (const w of postDecision.warnings) {
          this.logger.warn(w);
        }

        // Feature 028 US2 — breakpoint fired in the runner before the CLI was
        // invoked. Filter the consumed entry out, emit `phase-breakpoint-cleared`
        // with cause 'consumed-by-fire', set `manualPauseCause` to
        // `breakpoint-paused`, stash the marked phase id in `resumeTargetPhaseId`,
        // cascade-pause the host queue, and release the lock. Resume re-invokes
        // the marked phase via the standard pipeline (T036).
        if (postDecision.kind === 'pause-breakpoint') {
          const consumedPhaseId = postDecision.consumedPhaseId;
          const now = Date.now();
          const paused: WorkflowRun = {
            ...run,
            status: 'paused',
            currentIteration: iteration,
            manualPauseAt: now,
            manualPauseCause: 'breakpoint-paused',
            resumeTargetPhaseId: consumedPhaseId,
            phaseBreakpoints: run.phaseBreakpoints.filter(
              (bp) => bp.phaseId !== consumedPhaseId
            ),
            lastTransitionAt: now
          };
          run = await this.persistTransition(run, paused);
          await this.appendBreakpointAudit('phase-breakpoint-cleared', run, {
            runId: run.id,
            phaseId: consumedPhaseId,
            cause: 'consumed-by-fire'
          });
          this.statusBar.update({ kind: 'paused', phase: run.currentPhase });
          const feature = this.queue.findById(run.featureId);
          const queueId = feature?.queueId ?? null;
          if (queueId) {
            await this.queue.cascadedPause(queueId);
          }
          session.retain();
          break;
        }

        previousPhaseMessage =
          output.phaseMessage && output.phaseMessage.entryCount > 0
            ? output.phaseMessage.entries
            : null;

        // Stamp `startedAt` from the pre-runner timestamp; the sequencer
        // synthesizes the rest of the PhaseResult shape from `output`.
        const phaseResult: PhaseResult = {
          ...postDecision.phaseResult,
          startedAt: phaseStartedAt
        };

        if (postDecision.kind === 'pause-delayed-retry') {
          run = await this.retryHandler.handleDelayedRetry(
            run,
            iteration,
            phaseResult,
            postDecision.cause,
            postDecision.resetsAtMs,
            postDecision.rateLimitMessage
          );
          session.retain();
          break;
        }

        if (postDecision.kind === 'pause-rate-limit') {
          const paused: WorkflowRun = {
            ...run,
            status: 'paused',
            currentIteration: iteration,
            lastTransitionAt: Date.now(),
            phasesCompleted: [...run.phasesCompleted, phaseResult]
          };
          run = await this.persistTransition(run, paused);
          this.statusBar.update({ kind: 'paused', phase: run.currentPhase });
          if (this.rateLimitHandler) {
            await this.rateLimitHandler(postDecision.cause, run);
          }
          // Lock intentionally retained for resume.
          session.retain();
          break;
        }

        if (postDecision.kind === 'fail') {
          // FR-005 — fatal-CLI cause surfaces via lastError.message. The
          // text was already sanitized exactly once when the audit-log-
          // writer persisted the phase-end record; we reuse the same
          // post-sanitization string the runner returned to us as a
          // warning. Cap-exhaustion (FR-010) emits 'cap_exhausted'
          // through the same decision.cause channel (US2).
          //
          // FR-010 — emit a terminal phase-end with cause: 'cap_exhausted'
          // when the transition engine exhausted the iteration cap with a
          // truthy retryCondition. The runner already emitted a success-
          // shaped phase-end for the LLM-level outcome; this is the
          // controller-level addendum the audit-events contract requires.
          if (postDecision.capExhausted) {
            await this.runner.appendCapExhaustedPhaseEnd({
              runId: run.id,
              phase: run.currentPhase,
              iteration,
              pipelineId: run.pipeline?.id,
              phaseDef: activePhaseDef
            });
          }
          const sanitized: SanitizedError = {
            code: 'invocation-failed',
            message: postDecision.baseMessage.slice(0, 240),
            phase: run.currentPhase,
            iteration,
            at: Date.now()
          };
          const failed: WorkflowRun = {
            ...run,
            status: 'failed',
            currentIteration: iteration,
            lastTransitionAt: Date.now(),
            phasesCompleted: [...run.phasesCompleted, phaseResult],
            lastError: sanitized
          };
          run = await this.persistTransition(run, failed);
          await this.emitRunEndedBreakpointAudit(run);
          this.statusBar.update({ kind: 'failed', phase: run.currentPhase, detail: sanitized.message });
          this.notifier.warn(`Schegent: ${run.currentPhase} failed — ${sanitized.message}. Run "Schegent: Resume" to retry.`);
          await this.queue.finish(run.featureId, 'failed', {
            code: sanitized.code,
            message: sanitized.message,
            phase: sanitized.phase ?? undefined,
            correlationId: run.id
          });
          await this.historyRecorder.record(run, description, 'failed');
          break;
        }

        this.carriedIssues = pickCarriedIssues(output.result);

        // Feature 026 FR-016 — verify phases pause on non-clean outcomes
        // instead of silently advancing. Pause keeps `currentPhase`
        // unchanged so the next resumeExisting() re-invokes the failing
        // verify phase. The queue task pause cause stays `'phase-paused'`
        // (reuse, no new literal).
        if (postDecision.kind === 'pause-verify') {
          const paused: WorkflowRun = {
            ...run,
            status: 'paused',
            currentIteration: iteration,
            lastTransitionAt: Date.now(),
            phasesCompleted: [...run.phasesCompleted, phaseResult]
          };
          run = await this.persistTransition(run, paused);
          await this.queue.pause(run.featureId, 'phase-paused');
          await this.appendPhaseControlAudit('phase-paused', run, {
            runId: run.id,
            phaseId: run.currentPhase
          });
          this.statusBar.update({ kind: 'paused', phase: run.currentPhase });
          session.retain();
          break;
        }

        if (postDecision.kind === 'break-unexpected') {
          break;
        }

        if (postDecision.kind === 'pause-manual') {
          const decision = postDecision.transition;
          const latestRun = this.store.getRun()!;
          const paused: WorkflowRun = {
            ...latestRun,
            status: 'paused',
            currentPhase: decision.kind === 'advance' ? decision.nextPhase : latestRun.currentPhase,
            currentIteration:
              decision.kind === 'advance' || decision.kind === 'loop'
                ? decision.nextIteration
                : latestRun.currentIteration,
            lastTransitionAt: Date.now(),
            phasesCompleted: [...latestRun.phasesCompleted, phaseResult]
          };
          run = await this.persistTransition(latestRun, paused);
          await this.queue.pause(run.featureId, 'phase-paused');
          await this.appendPhaseControlAudit('phase-paused', run, {
            runId: run.id,
            phaseId: phaseResult.phase,
            nextPhaseId: run.currentPhase,
            nextIteration: run.currentIteration
          });
          this.statusBar.update({ kind: 'paused', phase: phaseResult.phase });
          session.retain();
          break;
        }

        // postDecision.kind === 'advance-or-loop'
        // Feature 011 — FR-007: on a clean outcome after one or more
        // delayed retries, reset the counter and emit `retry-recovered`
        // before persisting the advance.
        run = await this.retryHandler.maybeEmitRetryRecovered(run, output.outcome);

        const decision = postDecision.transition;
        const advanced: WorkflowRun = {
          ...run,
          currentPhase: decision.kind === 'advance' ? decision.nextPhase : run.currentPhase,
          currentIteration:
            decision.kind === 'advance' || decision.kind === 'loop'
              ? decision.nextIteration
              : run.currentIteration,
          lastTransitionAt: Date.now(),
          phasesCompleted: [...run.phasesCompleted, phaseResult]
        };
        run = await this.persistTransition(run, advanced);
      }

      if (run.currentPhase === 'done' && run.status === 'running') {
        const completed: WorkflowRun = { ...run, status: 'completed', lastTransitionAt: Date.now() };
        run = await this.persistTransition(run, completed);
        await this.emitRunEndedBreakpointAudit(run);
        this.statusBar.update({ kind: 'completed' });
        this.notifier.info(`Schegent: workflow ${run.featureId} completed.`);
        await this.queue.finish(run.featureId, 'completed');
        await this.historyRecorder.record(run, description, 'completed');
      }
      });
    } finally {
      this.isRunning = false;
      this.cancellationController = null;
      this.carriedIssues = [];
      this.scheduleAutoDrain();
    }
  }

  /**
   * Feature 011 — manual override for an active delayed-retry run.
   * Wired to `CMD_RETRY_PHASE_NOW` from the webview and the
   * `schegent.retryPhaseNow` command. Per contracts/delayed-retry.md
   * §Manual override.
   */
  public async retryPhaseNow(): Promise<MutationResult> {
    const run = this.store.getRun();
    if (!run) return { ok: false, reason: 'no-active-run' };
    if (run.pendingRetryAt === null || run.pendingRetryCause === null) {
      return { ok: false, reason: 'not-pending-retry' };
    }
    if (this.isRunning) return { ok: false, reason: 'already-retrying' };

    // Feature 032 — manual override of a delayed retry is a continuation
    // (same semantics as the watchdog-fired retry). Arm the gate before
    // clearing `pendingRetryCause` below so `driveRun()` consumes it.
    this.isContinueGate.arm();
    this.watchdog?.cancelPendingTimer();

    const queueState = this.store.getQueue();
    const expectedReason = `retry-cap-exhausted:${run.id}`;
    const queueUnpaused = queueState.paused && queueState.pausedReason === expectedReason;
    if (queueUnpaused) {
      await this.queue.setPaused(false, null);
    }

    const priorCount = run.delayedRetryCount;
    const updated: WorkflowRun = {
      ...run,
      delayedRetryCount: 0,
      pendingRetryAt: null,
      pendingRetryCause: null
    };
    await this.store.setRun(updated);
    await this.retryHandler.appendManualRetryAudit({
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
    if (run.pendingRetryAt === null || run.pendingRetryCause === null) return;
    const delay = Math.max(0, run.pendingRetryAt - Date.now());
    if (delay === 0) {
      // Deadline elapsed while the extension was offline — resume on
      // next tick so callers can finish their activation hooks.
      // Feature 032 — the persisted state already has
      // `pendingRetryCause !== null`, so `resumeExisting()` will derive
      // `isContinue: true` from the state. No explicit arming needed
      // here; the state-derivation path covers it.
      setImmediate(() => {
        void this.resumeExisting().catch((err) =>
          this.logger.warn(`resumeExistingFromActivation resume failed: ${(err as Error).message}`)
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

  // Feature 034 Item 047 — rate-limit family + cause normalization +
  // dynamic-backoff computation live in
  // src/controller/rate-limit-backoff.ts. The controller delegates via
  // module-level `toDelayedRetryCause` / `backoffForCause` imports so the
  // dynamic-backoff math is unit-testable in isolation. Semantics
  // (027 FR-009..016) preserved byte-for-byte; CLAUDE.md hard rule
  // "dynamic backoff trusts parsed resetsAtMs; DELAYED_RETRY_CAP bounds
  // attempts" remains in force.

  // Feature 034 Item 047 — `handleDelayedRetry`, `scheduleQueuePauseAndFail`,
  // `maybeEmitRetryRecovered`, and `appendDelayedRetryAudit` moved to
  // src/controller/retry-handler.ts. The controller delegates via
  // `this.retryHandler.<method>()`. State-shape, audit-payload, and
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
            // between driveRun iterations. Preserve the latest store state so
            // external writes are not overwritten by stale `next` values.
            // The breakpoint branch in driveRun explicitly filters the
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

  private phaseRemovalAbortKey(runId: string, phaseId: string): string {
    return `${runId}:${phaseId}`;
  }
}

function pickCarriedIssues(
  result: import('../parser/stdout-parser').InvocationResult
): Array<{ tag?: string; summary: string }> | string[] {
  if (result.kind === 'open_questions') return result.questions;
  if (result.kind === 'remaining_issues') return result.issues;
  return [];
}
