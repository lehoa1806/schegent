import type { PhaseRunner } from './phase-runner';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { QueueManager } from '../queue/queue-manager';
import type { SchegentStatusBar } from '../ui/status-bar';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkspaceLockManager } from '../state/lock';
import { RunSessionRegistry, type RunSession } from './run-session';
import { resolveControlTarget } from './sole-run-resolver';
import { shouldContinueConversation, clearedPauseFieldsOnResume } from './resume-pause-fields';
import type { SanitizedError, WorkflowRun } from '../state/workflow-run';
import type { RunActivityObservation } from '../monitor/activity-coalescer';
import { recordRunLiveness } from './run-liveness-recorder';
import type { FeatureRequest } from '../queue/feature-request';
import { DEFAULT_QUEUE_ID } from '../contracts/queue-identity';
import type { ClaudeCliMonitor } from '../monitor/claude-cli-monitor';
import type { HistoryStore } from '../state/history-store';
import { createHistoryRecorder, type HistoryRecorder } from '../services/history-recorder';
import { AutoDrainCoordinator } from '../services/auto-drain-coordinator';
import type { ExecutionLeasePort } from '../services/auto-drain-coordinator';
import { releaseExecutionLeaseForTerminalRun } from '../services/execution-lease-release';
import { ExecutionLeaseManager } from '../state/execution-lease';
import { EMPTY_CATALOG, type PipelineCatalog } from '../config/pipeline-config';
import { LockHeldError } from '../lib/errors';
import { DELAYED_RETRY_CAP } from '../contracts/retry-bounds';
import type { DelayedRetryWatchdog } from './retry-handler';
import { RunDriver } from '../services/run-driver';
import { RetryCoordinator, type RateLimitHandler } from '../services/retry-coordinator';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import { cleanupSessionArtifacts } from '../services/session-cleanup/session-cleanup-service';
import {
  deleteTaskWithSessionCleanup,
  type SessionCleanupRunner,
  type TaskDeletionOutcome
} from './task-deletion';
import { applyManualRetryOverride } from './manual-retry-override';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import { resolvePinnedRunnerKind } from '../config/pipeline-snapshot';
import { PhaseControlService, type MutationResult } from './phase-control-service';
import { WorkflowLifecycleAuditor } from './workflow-lifecycle-auditor';
import type { BackendAvailabilityProbe } from '../services/backend-capability-service';
import type { RawTranscriptMode } from '../state/workflow-run';
import type { TerminalTransitionCoordinator } from '../services/terminal-transition-coordinator';
import { buildMutationPlan, mutationPlanIsApproved } from '../services/mutation-plan';
import type { MutationPlanSnapshot } from '../state/workflow-run';
import type { RunCheckpointService } from '../services/run-checkpoint-service';
import type { RunMutationLedger } from '../services/run-mutation-ledger';
import { WorkflowRunFactory } from '../services/workflow-run-factory';

export interface WorkflowControllerOptions {
  cliPath: string;
  cwd: string;
  iterationCap: number;
  timeoutMs: number;
  /** FR-R3-075 — absolute per-invocation wall-clock bound; see extension.ts. */
  maxDurationMs?: number;
  inheritProcessEnv?: boolean;
  processEnvAllowlist?: readonly string[];
  skipProbing?: boolean;
  cliPathResolver?: (runnerKind: string) => string;
  defaultRunnerKind?: BackendRunnerKind;
  isAuditEvidenceAvailable?: () => boolean;
  /** Dynamic reader for `schegent.retry.forceContinueOnCap`; never cached. */
  getForceContinueOnRetryCap?: () => boolean;
}

export type { DelayedRetryWatchdog } from './retry-handler';
/** Re-exported so the seam keeps the import path its consumers already use. */
export type { SessionCleanupRunner } from './task-deletion';

export interface WorkflowControllerDeps {
  monitor?: Pick<ClaudeCliMonitor, 'onStart'> | null;
  historyStore?: Pick<HistoryStore, 'append'> | null;
  catalog?: PipelineCatalog;
  auditWriter?: Pick<AuditLogWriter, 'append'> | null;
  watchdog?: DelayedRetryWatchdog | null;
  /** Dynamic reader for `schegent.retry.maxAttempts`. Falls back to DELAYED_RETRY_CAP. */
  getRetryCap?: () => number;
  /** Read only when a run is created; the result is frozen on WorkflowRun. */
  getRawTranscriptMode?: () => RawTranscriptMode;
  /**
   * Feature 034 — optional session-cleanup runner. Defaults to
   * `cleanupSessionArtifacts` from `services/session-cleanup`.
   */
  sessionCleanup?: SessionCleanupRunner;
  /** Best-effort lifecycle hook used for inactive session-artifact retention. */
  onRunTerminal?: (run: WorkflowRun) => Promise<void>;
  /** Host-owned bounded executable probe reused by the guarded run start. */
  backendCapabilities?: BackendAvailabilityProbe;
  terminalTransitions?: Pick<TerminalTransitionCoordinator, 'begin' | 'complete'>;
  requestGitApproval?: (plan: MutationPlanSnapshot) => Promise<boolean>;
  checkpoints?: Pick<RunCheckpointService, 'checkpoint'>;
  /**
   * FR-R3-004 — passed straight to the driver, which brackets every phase
   * dispatch with it so `checkpoints` can attribute a patch to one Run. Carried
   * beside `checkpoints` rather than folded into it because the two answer to
   * different lifetimes: one records continuously, the other only at a
   * Git-capable phase.
   */
  mutationLedger?: Pick<RunMutationLedger, 'observeBeforePhase' | 'observeAfterPhase'>;
  /**
   * Feature 092 (T051) — the per-queue execution lease the auto-drain claims at
   * step 6. Optional so the many tests that build a controller without one keep
   * working; absent, the controller mints a manager over the same store under
   * the same owner id as the workspace lock, which is exactly what
   * `extension.ts` passes in production.
   */
  executionLease?: ExecutionLeasePort;
}

export interface StartNewOptions {
  pipelineId?: string;
}

// Feature 093 (T049a) — the admission contract lives in its own module; see
// `./run-admission` for why the drain waits for admission and not completion.
import {
  NOTHING_TO_DRIVE,
  NOT_RESUMED,
  type RunAdmission,
  type ResumeAdmission
} from './run-admission';

export type { RunAdmission, ResumeAdmission } from './run-admission';
export type { MutationResult } from './phase-control-service';

export class SchegentWorkflowController {
  private readonly monitor: Pick<ClaudeCliMonitor, 'onStart'> | null;
  private catalog: PipelineCatalog;
  private readonly getRetryCapFn: (() => number) | null;
  // Feature 034 — pluggable session-cleanup runner; defaults to the
  // production helper from services/session-cleanup. Tests inject a
  // mock to exercise the success / failure branches deterministically.
  private readonly sessionCleanup: SessionCleanupRunner;
  private readonly historyRecorder: HistoryRecorder;
  /** Feature 092 (T132, FR-033a) — ends a terminal Run's execution lease. */
  private readonly releaseExecutionLeaseForRun: (run: WorkflowRun) => Promise<void>;
  private readonly executionLease: ExecutionLeasePort;
  private readonly autoDrainCoordinator: AutoDrainCoordinator;
  private readonly retryCoordinator: RetryCoordinator;
  /**
   * Feature 093 (T042) — one driving context per *executing* queue, in place of
   * the single `runDriver` / `isContinueGate` pair a one-Run window needed. The
   * controller stays one per window: it constructs the `AutoDrainCoordinator`
   * below, and N controllers would mean N drain coordinators, which the
   * CLAUDE.md hard rule "Never add a second idle-pending enforcement site"
   * forbids outright.
   */
  private readonly sessions: RunSessionRegistry;
  private readonly phaseControlService: PhaseControlService;
  private readonly lifecycleAuditor: WorkflowLifecycleAuditor;
  private readonly terminalTransitions: WorkflowControllerDeps['terminalTransitions'];
  private readonly requestGitApproval: WorkflowControllerDeps['requestGitApproval'];
  private readonly runFactory: WorkflowRunFactory;

  constructor(
    runner: PhaseRunner,
    private readonly store: WorkspaceStateStore,
    private readonly queue: QueueManager,
    private readonly statusBar: SchegentStatusBar,
    private readonly notifier: Notifier,
    private readonly logger: SanitizedLogger,
    // Feature 093 (T068b, FR-028) — a parameter, no longer a property. It is
    // read twice during construction (`lock.id` for the lease owner, the manager
    // for the driver deps) and never after. Keeping it a property would leave a
    // primacy handle reachable from every Run-scoped method, which is how the
    // two releases below got there.
    lock: WorkspaceLockManager,
    private readonly options: WorkflowControllerOptions,
    deps: WorkflowControllerDeps = {}
  ) {
    this.monitor = deps.monitor ?? null;
    const auditWriter = deps.auditWriter ?? null;
    this.catalog = deps.catalog ?? EMPTY_CATALOG;
    this.getRetryCapFn = deps.getRetryCap ?? null;
    this.sessionCleanup = deps.sessionCleanup ?? cleanupSessionArtifacts;
    this.terminalTransitions = deps.terminalTransitions;
    this.requestGitApproval = deps.requestGitApproval;
    this.runFactory = new WorkflowRunFactory({
      getCatalog: () => this.catalog,
      defaultRunnerKind: options.defaultRunnerKind,
      getRawTranscriptMode: deps.getRawTranscriptMode,
      requestGitApproval: deps.requestGitApproval,
      // FR-R3-008 (T373) — the same cap the driver enforces, frozen onto the Run
      // so the progress denominator cannot move under it. `options.iterationCap`
      // is read at activation and is not refreshed on configuration change, so a
      // Run created after a settings edit still freezes the value this host is
      // actually running with rather than one the operator has since typed.
      getIterationCap: () => options.iterationCap,
      logger
    });
    // Feature 103 (T031) — the deps literal this site and
    // `createRunSafetyWiring` both spelled out now lives with the class, in
    // `createHistoryRecorder`; the three choices inside it are documented there.
    this.historyRecorder = createHistoryRecorder({
      historyStore: deps.historyStore ?? null,
      logger,
      queue,
      store,
      workspaceRoot: options.cwd
    });
    // Feature 092 (T132, FR-033a) — one manager, addressed by both ends of the
    // tenure: the drain claims at step 6, the terminal transition releases.
    const executionLease = deps.executionLease ?? new ExecutionLeaseManager(store, lock.id);
    // FR-R3-077 (T1038) — the commit points now REQUIRE a claim, and this is where
    // the store learns who can answer for one. Bound here rather than in the
    // constructor because the lease manager is resolved here, and bound
    // unconditionally so a window that composes a controller cannot end up with
    // fenced commit points and no source to fence them against.
    store.bindRunClaimSource(executionLease);
    // FR-R3-070 (feature 152) — the resume seam claims through the same
    // manager the drain and the terminal release share, so a resumed Run's
    // lease is returned by the one existing release path.
    this.executionLease = executionLease;
    this.releaseExecutionLeaseForRun = (run) =>
      releaseExecutionLeaseForTerminalRun({ queue, executionLease, logger }, run);
    this.autoDrainCoordinator = new AutoDrainCoordinator({
      store,
      queue,
      executionLease,
      controller: this,
      // Same adapter shape `extension.ts` uses for the queue's lifecycle hook:
      // the writer's entry type is stricter than the port's, so the widening
      // happens once, here, at the seam.
      auditWriter: auditWriter
        ? { append: (entry) => auditWriter.append(entry as never) }
        : null,
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
    // Feature 093 (T041-T043) — the driver moved from a field to a per-session
    // factory. Every dep below is unchanged and still shared by reference; what
    // is now per-queue is the driver instance itself, and with it the private
    // run-loop state its re-entrancy guard protects.
    this.sessions = new RunSessionRegistry((isContinueGate) => new RunDriver({
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
      isContinueGate,
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
      emitRunSnapshotDeclined: (run, payload) =>
        this.lifecycleAuditor.emitRunSnapshotDeclined(run, payload),
      emitOutputTargetRefusedAtDispatch: (run, payload) =>
        this.lifecycleAuditor.emitOutputTargetRefusedAtDispatch(run, payload),
      onRunTerminal: deps.onRunTerminal,
      terminalTransitions: deps.terminalTransitions,
      checkpoints: deps.checkpoints,
      mutationLedger: deps.mutationLedger,
      scheduleAutoDrain: () => this.scheduleAutoDrain(),
      releaseExecutionLease: (run) => this.releaseExecutionLeaseForRun(run)
    }), (queueId) => store.getRun(queueId));
    this.phaseControlService = new PhaseControlService({
      store,
      queue,
      logger,
      retryCoordinator: this.retryCoordinator,
      // Feature 093 (T042) — the three session-scoped deps became queue-addressed
      // seams. Every call site in the service already had its `queueId` in hand,
      // so what changed is that the answer now comes from that queue's session
      // instead of from the window's one driver.
      isDriving: (queueId) => this.sessions.peek(queueId)?.driver.running === true,
      noteActivePhaseOverrideAbort: (queueId, runId, phaseId) =>
        this.sessions.peek(queueId)?.driver.noteActivePhaseOverrideAbort(runId, phaseId),
      armIsContinue: (queueId) => this.sessions.acquire(queueId).isContinueGate.arm(),
      cancelActive: (queueId) => this.cancelActive(queueId),
      resumeExisting: (queueId, customPrompt) => this.resumeExisting(queueId, customPrompt),
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
   * Feature 093 (T045) — the watchdog's resume callback is window-level, so it
   * asks the coordinator which queues its fire was actually for. Claiming is
   * destructive by design: the elapsed deadlines are removed and the next
   * outstanding one is re-armed, so a second read does not resume them twice.
   */
  public claimElapsedDelayedRetries(): readonly string[] {
    return this.retryCoordinator.claimElapsedDelayedRetries();
  }

  /** True while `queueId`'s delayed-retry backoff has not yet elapsed. */
  public hasPendingDelayedRetry(queueId: string): boolean {
    return this.retryCoordinator.hasPendingDelayedRetry(queueId);
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

  /**
   * Feature 092 (T051) — addressed. An operator restart names the queue it
   * restarted; the default keeps every pre-092 caller pointing at the default
   * queue, which is the only queue those callers ever had.
   */
  public async drainQueuedWork(queueId: string = DEFAULT_QUEUE_ID): Promise<void> {
    await this.autoDrainCoordinator.drainIfIdle(queueId);
  }

  /**
   * Feature 093 (T049a) — resolve once every auto-drained Run has terminated.
   *
   * `drainQueuedWork` above used to answer this by accident: it awaited the
   * whole Run, so its resolution meant both "the queue was offered work" and
   * "that work is over". Those are two moments now, and this is the second one.
   * It is a separate call precisely so the drain's own callers do not
   * accidentally re-serialize the sweep by awaiting it.
   */
  public async drainedRunsSettled(): Promise<void> {
    await this.autoDrainCoordinator.settled();
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

  /**
   * Feature 093 (T042) — window-scoped: is *any* session driving? This is the
   * C-4 aggregate shape SC-012 exempts, and it is what the two remaining
   * consumers actually mean — drain step 4b ("is this window busy?", deleted by
   * T081) and Clean All's runner-ack probe ("has everything stopped?").
   */
  public get running(): boolean {
    return this.sessions.all().some((session) => session.driver.running);
  }

  /**
   * Feature 093 (T072, FR-014, RS-1) — the number of live Runs this window
   * holds, which is the count the concurrency cap bounds.
   *
   * Deliberately not `running` above. `running` asks whether any driver is
   * *currently executing a phase* and goes false the moment every Run is
   * paused; this asks how many Runs this window owns, and a paused Run still
   * owns its queue, its lease, and its slot (FR-014a). Conflating them would
   * make a resume refusable once the cap refilled behind it.
   */
  public get liveRunCount(): number {
    return this.sessions.size;
  }

  /**
   * Cancel one queue's Run, or every Run in the window when no queue is named.
   *
   * Feature 093 (T042) — the unaddressed form is deliberate, not a leftover
   * ambient read: `clear-all.ts` and the queue manager's `CleanAllRunnerAckProbe`
   * mean "stop everything in this window", and with one session it is identical
   * to the pre-feature behavior. Callers that mean one Run — `cancel.ts`,
   * `deleteTask`, the phase controls — name their queue.
   */
  public cancelActive(queueId?: string): void {
    const targets: readonly (RunSession | null)[] =
      queueId === undefined ? this.sessions.all() : [this.sessions.peek(queueId)];
    for (const session of targets) session?.driver.cancelActive();
  }

  public async startNew(
    feature: FeatureRequest,
    featureDir: string | null,
    options: StartNewOptions = {}
  ): Promise<void> {
    await (await this.admitNew(feature, featureDir, options)).completed;
  }

  /**
   * Feature 093 (T049a) — admit a Run and hand back the promise of its
   * execution instead of awaiting it here.
   *
   * `startNew` above resolves when the Run *finishes*, which is what every
   * caller meaning "run this and tell me when it is done" already depends on,
   * and it is preserved byte for byte by delegating. The drain means something
   * else: it promotes a queue and moves on to the next one. A drain that awaited
   * the Run would offer work to exactly one queue per sweep and leave the rest
   * waiting for that Run to terminate — which is the serialization this feature
   * exists to remove, surviving inside the sweep after step 4b is deleted, where
   * no test for the deleted gate would find it.
   *
   * The seam is `markInFlight`, not the spawn. Once the Task is in flight the
   * queue's capacity, the workspace's in-flight count and `sessions.size` all
   * see the new Run, so the rest of a sweep evaluates its gates against current
   * counts rather than against a Run it cannot yet observe. Everything before
   * that point is admission, and a failure there is a Run that never came into
   * existence — precisely the case CLAUDE.md's lease rule assigns to the drain's
   * step 7 release rather than to `releaseExecutionLeaseForRun()`.
   */
  public async admitNew(
    feature: FeatureRequest,
    featureDir: string | null,
    options: StartNewOptions = {}
  ): Promise<RunAdmission> {
    this.logger.info(`Workflow operation triggered: startNew`, { featureId: feature.id, featureDir, options });
    let run: WorkflowRun | null = null;
    try {
      // Feature 098 (T026, US3, FR-033b) — no guard here, because that would be a
      // second refusal site. `''` is not nullish, so an empty catalog's empty
      // `defaultPipelineId` reaches `create()` and is refused there, `run` left null.
      run = await this.runFactory.create(feature, featureDir,
        options.pipelineId ?? feature.pipelineId ?? this.catalog.defaultPipelineId
      );
      // Feature 093 (T023) — pattern B. The Task is in hand, so its queue is
      // resolved through the one existing resolver rather than a second copy of
      // the `?? DEFAULT_QUEUE_ID` rule. The row is present here — `markInFlight`
      // on the next line requires it — so the resolver's removed-Task fallback
      // is not reachable from this call.
      const queueId = this.queue.queueIdForTask(feature.id);
      await this.store.setRun(queueId, run, this.store.runCommitClaim(queueId));
      await this.queue.markInFlight(feature.id, run.id, false);
      // The `catch` below covered the drive too before the split, so it keeps
      // covering it — attached synchronously, so a rejection is never briefly
      // unhandled while the caller decides whether to await.
      const admitted = run;
      return {
        completed: this.driveSession(queueId, admitted, feature.description).catch((err) =>
          this.handleUnexpectedStartFailure(feature, admitted, feature.description, err)
        )
      };
    } catch (err) {
      await this.handleUnexpectedStartFailure(feature, run, feature.description, err);
      return NOTHING_TO_DRIVE;
    }
  }

  /**
   * Feature 093 (T042/T044) — drive a queue's Run on that queue's session and
   * dispose the session iff the Run ended.
   *
   * The disposal decision sits here, after `drive()` returns, rather than inside
   * `persistTransition`: the driver is still doing terminal bookkeeping when it
   * writes the terminal record, and tearing its session down mid-write would
   * flip `controller.running` to false while the Run is still finishing. The
   * `finally` covers the throwing path too — a Run that dies takes its own
   * session with it and no sibling's (RS-5).
   *
   * `disposeIfEnded` is the whole RS-3/RS-4 rule; a paused Run leaves this
   * method with its session, its lease, and its cap slot intact.
   */
  private async driveSession(
    queueId: string,
    run: WorkflowRun,
    description: string
  ): Promise<void> {
    try {
      await this.sessions.acquire(queueId).driver.drive(run, description);
    } finally {
      this.sessions.disposeIfEnded(queueId);
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
      
    // Feature 093 (T023) — pattern B, the failing Task names its own queue.
    //
    // The id comparison **survives** the conversion, and is not the one-slot
    // artifact T040 sweeps out. It answers "did the Run we started get as far as
    // being persisted?", which stays a real question once the read is
    // queue-addressed: `startNew` assigns `run` before it writes it, so a
    // `setRun` that itself threw leaves `startedRun` set while the queue still
    // holds whatever preceded it. Without the comparison that predecessor would
    // be failed and history-recorded in place of the Run that actually failed.
    const latestRun = this.store.getRun(this.queue.queueIdForTask(feature.id));
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

    this.statusBar.update(terminalRun?.id ?? startedRun?.id ?? feature.id, {
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
      await this.terminalTransitions?.complete(terminalRun, description);
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
      await this.releaseExecutionLeaseForRun(terminalRun);
    }
    this.scheduleAutoDrain();
  }

  private sanitizeUnexpectedError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return this.logger.sanitize(raw.length > 0 ? raw : 'unknown workflow error');
  }

  /**
   * Feature 092 (T052) — a terminating Run frees a slot under the workspace
   * ceiling, and that slot belongs to whichever queue the round-robin cursor
   * reaches next, not to the queue that just finished. So the post-terminal
   * drain sweeps the registry rather than re-draining one queue.
   */
  private scheduleAutoDrain(): void {
    void this.autoDrainCoordinator.drainAll().catch((err) =>
      this.logger.warn(`auto-drain failed: ${(err as Error).message}`)
    );
  }

  /**
   * Resumes the currently persisted run if it is in a legal resumable state
   * (paused, pending-retry, or failed/bugfix-terminal).
   */
  public async resumeExisting(queueId: string, customPrompt?: string): Promise<boolean> {
    const admission = await this.admitResume(queueId, customPrompt);
    await admission.completed;
    return admission.resumed;
  }

  /**
   * Feature 093 (T049a) — the resume half of the admission seam, on the same
   * terms as `admitNew`. `resumed` is decidable at admission because every
   * refusal in `resumeExistingOnQueue` returns before `markInFlight`, so the
   * drain still learns whether to fall through to a fresh start without waiting
   * for the resumed Run to finish.
   */
  public async admitResume(queueId: string, customPrompt?: string): Promise<ResumeAdmission> {
    try {
      return await this.resumeExistingOnQueue(queueId, customPrompt);
    } finally {
      // Feature 093 (T044) — every early return below leaves without driving,
      // and an entry point may already have armed this queue's gate (which
      // creates the session). Without this the refused resume would strand a
      // session holding a cap slot for a Run that never started.
      this.sessions.disposeIfEnded(queueId);
    }
  }

  private async resumeExistingOnQueue(
    queueId: string,
    customPrompt?: string
  ): Promise<ResumeAdmission> {
    this.logger.info(`Workflow operation triggered: resumeExisting`);
    const run = this.store.getRun(queueId);
    if (!run) return NOT_RESUMED;
    if (run.status === 'completed' || run.status === 'canceled') return NOT_RESUMED;

    if (customPrompt) {
      await this.store.setRun(queueId, {
        ...run,
        resumePrompt: customPrompt
      },
        this.store.runCommitClaim(queueId)
      );
    }

    const feature = this.queue.findById(run.featureId);
    if (!feature) {
      this.logger.warn(`resume: feature ${run.featureId} no longer in queue`);
      return NOT_RESUMED;
    }
    // Feature 032 — derive the continuation hint at resume entry, BEFORE the
    // `clearedPauseFieldsOnResume` spread below erases what it reads. Both
    // per-cause rules live in `resume-pause-fields.ts`. The explicit
    // `isContinueGate` (armed by `resumeActivePhase` / `retryPhaseNow`) takes
    // effect downstream in `RunDriver.drive()` regardless of what we derive.
    if (shouldContinueConversation(run)) {
      this.sessions.acquire(queueId).isContinueGate.arm();
    }
    const defaultRunnerKind = resolvePinnedRunnerKind(
      run.defaultRunnerKind, run.lastCliSessionRunnerKind, this.options.defaultRunnerKind
    );
    // Feature 098 (T026, US3, FR-025) — a pre-009 Run has no `pipeline` snapshot,
    // and this synthesized the built-in one: the Run resumed a sequence the host
    // chose rather than the one it started, recorded only as an `info` line. With
    // no built-in layer to synthesize from, and a pre-release product with no
    // installed base to migrate, the resume is refused instead and the operator
    // re-launches from an imported definition.
    const pipeline = run.pipeline;
    if (!pipeline) {
      this.logger.warn(
        `resume: run ${run.id} carries no pipeline snapshot; refusing rather than substituting one`
      );
      return NOT_RESUMED;
    }
    // FR-R3-001 — a composed Run that was already in flight when this feature
    // landed carries no `envelope`, because the field did not exist when it was
    // created. `resolveRunOutputs` reads the envelope and nothing else, so
    // without this the operator's declared targets would be probed not at all
    // and the Run would record no outputs — the silent semantic loss this
    // feature exists to remove, reintroduced at exactly one seam.
    //
    // `feature.runPlan` is not a second source: it is the same envelope
    // `validateRunRequest()` froze for this Run, aliased rather than rebuilt.
    // Nothing under `src/` writes `runPlan` after enqueue, so the row cannot have
    // drifted from what the Run was created against. It is guarded on the field's
    // absence, so a Run created after this feature never reaches the right-hand
    // side and the execution path is still the only reader of the envelope.
    const envelope = run.envelope ?? feature.runPlan;
    if (!run.envelope && envelope) {
      this.logger.info(`workflow-run.envelope-backfilled runId=${run.id}`);
    }
    const mutationPlan = run.mutationPlan ?? buildMutationPlan(pipeline);
    let gitApprovalReceipt = run.gitApprovalReceipt;
    if (
      mutationPlan.gitCapablePhaseIds.length > 0 &&
      !mutationPlanIsApproved(mutationPlan, gitApprovalReceipt)
    ) {
      const approved = await (this.requestGitApproval?.(mutationPlan) ?? Promise.resolve(true));
      if (!approved) return NOT_RESUMED;
      gitApprovalReceipt = {
        approvedAt: Date.now(),
        planFingerprint: mutationPlan.fingerprint,
        approvedPhaseIds: mutationPlan.gitCapablePhaseIds
      };
    }
    // FR-R3-070 — the resume path claims its queue's execution lease the way
    // the drain's step 6 does, so activation ordering is defence in depth
    // rather than the only defence. `tryAcquire` admits unclaimed, already-
    // ours, and stale, so a drain-covered or paused resume re-affirms rather
    // than double-claims; the terminal transition releases as it always did.
    const leaseClaim = await this.executionLease.tryAcquire(queueId);
    if (!leaseClaim.acquired) {
      this.logger.warn(
        `resume: queue ${queueId} execution lease held by another window; declining`
      );
      return NOT_RESUMED;
    }
    if (this.executionLease.hasLease && !(await this.executionLease.hasLease(queueId))) {
      await Promise.resolve(this.executionLease.release(queueId)).catch(() => undefined);
      this.logger.warn(
        `resume: execution lease for queue ${queueId} could not be verified; declining`
      );
      return NOT_RESUMED;
    }
    const next: WorkflowRun = {
      ...run,
      status: 'running',
      lastError: null,
      pipeline,
      defaultRunnerKind,
      mutationPlan,
      // Absent stays absent: a Run with no plan on either side adds no key and
      // serializes exactly as it did before this feature (T267).
      ...(envelope ? { envelope } : {}),
      ...(gitApprovalReceipt ? { gitApprovalReceipt } : {}),
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
        : {}),
      ...clearedPauseFieldsOnResume(run)
    };
    await this.store.setRun(queueId, next, this.store.runCommitClaim(queueId));
    await this.queue.markInFlight(feature.id, next.id, true);
    // Admitted. `driveSession` carries its own `finally` disposal, so the drive
    // is handed back rather than awaited (T049a).
    return { resumed: true, completed: this.driveSession(queueId, next, feature.description) };
  }

  /**
   * FR-R3-008 (T377) — persist a coalesced liveness observation. The rule lives
   * in `recordRunLiveness`, which is where its four guards are recorded; this is
   * the seam the monitor's late-bound recorder is bound to, and it exists because
   * the store is a private field of this class.
   */
  public recordRunActivity(observation: RunActivityObservation): void {
    recordRunLiveness({ store: this.store, logger: this.logger }, observation);
  }

  /**
   * Feature 093 (T035/T036) — resolve the queue a phase control acts on, then
   * delegate. The resolution rule lives in `resolveControlTarget`; see there for
   * why an unaddressed control refuses rather than picks a queue. This folds the
   * resolve-or-refuse preamble the eight controls below would otherwise repeat
   * verbatim, which is how they are kept from drifting apart one at a time.
   */
  private async control(
    queueId: string | undefined,
    act: (queueId: string) => Promise<MutationResult>
  ): Promise<MutationResult> {
    const target = resolveControlTarget(queueId, this.store.getRunMap());
    return target.ok ? act(target.queueId) : target;
  }

  public async pauseActivePhase(queueId?: string): Promise<MutationResult> {
    return this.control(queueId, (q) => this.phaseControlService.pauseActivePhase(q));
  }

  public async resumeActivePhase(
    customPrompt?: string,
    queueId?: string
  ): Promise<MutationResult> {
    return this.control(queueId, (q) =>
      this.phaseControlService.resumeActivePhase(q, customPrompt)
    );
  }

  public async restartActivePhase(queueId?: string): Promise<MutationResult> {
    return this.control(queueId, (q) => this.phaseControlService.restartActivePhase(q));
  }

  public async skipPhase(phaseId: string, queueId?: string): Promise<MutationResult> {
    return this.control(queueId, (q) => this.phaseControlService.skipPhase(q, phaseId));
  }

  public async disablePhase(phaseId: string, queueId?: string): Promise<MutationResult> {
    return this.control(queueId, (q) => this.phaseControlService.disablePhase(q, phaseId));
  }

  public async enablePhase(phaseId: string, queueId?: string): Promise<MutationResult> {
    return this.control(queueId, (q) => this.phaseControlService.enablePhase(q, phaseId));
  }

  public async setPhaseBreakpoint(
    runId: string,
    phaseId: string,
    queueId?: string
  ): Promise<MutationResult> {
    return this.control(queueId, (q) =>
      this.phaseControlService.setPhaseBreakpoint(q, runId, phaseId)
    );
  }

  public async clearPhaseBreakpoint(
    runId: string,
    phaseId: string,
    queueId?: string
  ): Promise<MutationResult> {
    return this.control(queueId, (q) =>
      this.phaseControlService.clearPhaseBreakpoint(q, runId, phaseId)
    );
  }
  /**
   * The ordering constraints and their reasoning live in `task-deletion.ts`.
   * `cancelActive` is one of this class's own methods and the lease release a
   * bound field, so both are handed over as seams.
   */
  public async deleteTask(taskId: string): Promise<TaskDeletionOutcome> {
    return deleteTaskWithSessionCleanup(
      {
        logger: this.logger,
        queue: this.queue,
        store: this.store,
        cancelActive: (queueId) => this.cancelActive(queueId),
        releaseExecutionLeaseForRun: this.releaseExecutionLeaseForRun,
        sessionCleanup: this.sessionCleanup,
        workspaceRoot: this.options.cwd
      },
      taskId
    );
  }

  public async removeTaskPhase(
    taskId: string,
    phaseId: string
  ): Promise<MutationResult & { priorPhaseState?: string; runId?: string }> {
    // Feature 093 (T036) — no `resolveControlQueue` fallback here: this control
    // already names its target by Task, so the queue is derived rather than
    // inferred, and the ambiguity the helper guards against cannot arise.
    return this.phaseControlService.removeTaskPhase(
      this.queue.queueIdForTask(taskId),
      taskId,
      phaseId
    );
  }
  /** The transaction and its reasoning live in `manual-retry-override.ts`. */
  public async retryPhaseNow(queueId?: string): Promise<MutationResult> {
    return applyManualRetryOverride(
      {
        logger: this.logger,
        store: this.store,
        queue: this.queue,
        sessions: this.sessions,
        retryCoordinator: this.retryCoordinator,
        resumeExisting: (q) => this.resumeExisting(q)
      },
      queueId
    );
  }

  /**
   * Feature 011 — restart handshake. Called from `extension.activate()`
   * right after `store.initialize()`. If the persisted run has a pending
   * retry timestamp, re-arm the watchdog (or resume immediately if the
   * deadline has already passed). Per contracts/delayed-retry.md §Restart
   * handshake (FR-013).
   */
  public async resumeExistingFromActivation(): Promise<void> {
    // Feature 093 (T036/T039) — activation is the C-4 aggregate case: it is not
    // resuming "the" Run, it is re-arming every Run the workspace persisted, and
    // after a crash mid-concurrency there can be several. Each is then addressed
    // by its own queue. With one entry this is the previous behavior exactly.
    for (const [queueId, run] of Object.entries(this.store.getRunMap())) {
      await this.retryCoordinator.resumeExistingFromActivation(queueId, run, async () => {
        await this.resumeExisting(queueId);
      });
    }
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
    // Feature 093 (T036) — pattern C-2: the driver's write funnel resolves its
    // queue from the Run it is persisting, so a transition can no longer land on
    // a sibling's record.
    //
    // The `latest?.id === next.id` comparison **survives** the conversion, and is
    // recorded here as a justified survivor for T040's sweep. Map addressing
    // removes the case it could not previously distinguish — `latest` being some
    // *other queue's* Run — but not the one it was written for: this queue's Run
    // can still have been replaced (`deleteTask` cancels and the drain starts the
    // next Task) while the aborting driver is mid-flight. Dropping the check
    // would merge that successor's `phaseOverrides` into this Run's write.
    const queueId = this.queue.queueIdForTask(next.featureId);
    const latest = this.store.getRun(queueId);
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
    await this.terminalTransitions?.begin(merged);
    await this.store.setRun(queueId, merged, this.store.runCommitClaim(queueId));
    return merged;
  }
}
