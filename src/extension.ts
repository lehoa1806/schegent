import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { WorkspaceStateStore } from './state/workspace-state';
import {
  getCanonicalWorkspaceRoot,
  disposeWorkspaceFolderPicker
} from './state/workspace-folder-picker';
import { resolveCliPath } from './config/cli-path-accessor';
import { maybeShowMultiRootWarning } from './state/multi-root-warning';
import { initCapabilityTrustResolver } from './state/capability-trust-resolver';
import { PhaseRunner } from './controller/phase-runner';
import { SchegentWorkflowController } from './controller/workflow-controller';
import { QueueScheduleWatchdog } from './controller/schedule-watchdog';
import { CreditWatchdog } from './watchdog/credit-watchdog';
import { AuditLogWriter } from './audit/audit-log-writer';
import { SessionArtifactRetentionService } from './services/session-retention/session-artifact-retention-service';
import { SanitizedLogger } from './lib/logger';
import {
  createRuntimeEvidenceWiring,
  type RuntimeEvidenceWiring
} from './activation/backend-wiring';
import { createConnectedRunService, registerStage2Ui } from './activation/ui-wiring';
import { SchegentOutputChannel } from './ui/output-channel';
import { forwardMigrationAuditEvents } from './state/migration-audit-forwarder';
import { runReset, type ResetHost, type ResetStageSupport } from './commands/reset';
import {
  completeInterruptedResetOnActivation,
  createResetStageSupport,
  recordCompletedInterruptedReset
} from './commands/reset-wiring';
import { StateProjector } from './ui/sidebar/state-projector';
import { buildBuilderLifecycleByKind } from './ui/sidebar/builder-lifecycle';
import { createWorkflowPipelineRefReader } from './ui/sidebar/workflow-pipeline-ref-source';
import {
  readGeneralSettings,
  readFatalSignaturesSetting,
  type GeneralSettingsConfig
} from './config/general-settings';
import { createAutoCompactOverrideAccessor } from './lib/auto-compact-override';
import { createPhaseBreakpointAccessor } from './controller/breakpoint-accessor';
import { SidebarViewProvider } from './ui/sidebar/sidebar-view-provider';
import { PlaceholderProjector } from './ui/sidebar/placeholder-projector';
import { checkLiveness, createLivenessProbe } from './services/process-liveness';
import { resumePersistedRuns } from './services/resume-decision';
import { createRunSafetyWiring } from './activation/run-safety-wiring';
import { isConfirmationsEnabled } from './state/confirmations-config';
import { GuardedRunService } from './services/guarded-run-service';
import { ScheduledStartCoordinator } from './services/scheduled-start-coordinator';
import { resolveRunOrigin } from './services/run-origin-resolver';
import { createPhaseLogTailWiring } from './activation/phase-log-tail-wiring';
import { createSidebarRouter } from './activation/sidebar-router-wiring';
import { wireBackendExecution } from './activation/backend-execution-wiring';
import { resolveWorkspaceSettings } from './activation/workspace-settings';
import { openWorkspaceSession } from './activation/workspace-session';

interface Stage2Wiring {
  readonly disposables: readonly vscode.Disposable[];
  /**
   * Feature FR-R3-006 — the two reset capabilities that only exist once stage 2
   * is up. Carried on the wiring rather than reached for through a module-level
   * reference, so a reset that runs across a teardown/reload cycle necessarily
   * talks to whichever stage 2 is current.
   */
  readonly reset: ResetStageSupport;
  dispose(): Promise<void>;
}


export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new SanitizedLogger();
  const ownerId = `schegent-${process.pid}-${randomUUID().slice(0, 8)}`;

  // Stage-1 evidence sinks capture activation diagnostics even without a workspace.
  const { runtimeLogAccessor, runtimeLogSink, evidenceHealth, webviewLogSink } =
    createRuntimeEvidenceWiring(context, logger);

  // Stage 1 — always-on sidebar registration. Must happen before any workspace-folder
  // or store-initialize guard so the view is available even when the workspace is empty
  // or the workspace state cannot be migrated. See plan.md "Activation Lifecycle".
  const placeholder = new PlaceholderProjector({ reason: 'no-workspace' });
  const sidebarProvider = new SidebarViewProvider({
    extensionRoot: context.extensionUri.fsPath,
    projector: placeholder,
    logger
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarViewProvider.viewId, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    { dispose: () => sidebarProvider.dispose() },
    { dispose: () => placeholder.dispose() }
  );

  const store = new WorkspaceStateStore({
    get: <T>(key: string) => context.workspaceState.get<T>(key),
    update: (key, value) => context.workspaceState.update(key, value)
  }, logger);

  let stage2: Stage2Wiring | null = null;
  let activeOutput: SchegentOutputChannel | null = null;
  let activePlaceholder: PlaceholderProjector = placeholder;

  // Feature 058 — pre-warm the canonical-folder picker so its
  // `onDidChangeWorkspaceFolders` cache-invalidator is registered BEFORE
  // the extension's own listener below. This way, when VS Code fires a
  // workspace-folders change, the picker resets its memoized value first
  // and the extension's listener observes a fresh canonical folder when
  // it calls `getCanonicalWorkspaceRoot()` via `ensureStage2()`.
  void getCanonicalWorkspaceRoot();

  const ensureStage2 = async (): Promise<void> => {
    if (stage2) return;
    const folder = getCanonicalWorkspaceRoot();
    if (!folder) return;
    const wiring = await wireStage2({
      context,
      logger,
      ownerId,
      workspaceRoot: folder.uri.fsPath,
      store,
      onInitFailure: () => {
        const replacement = new PlaceholderProjector({ reason: 'init-failed' });
        activePlaceholder.dispose();
        activePlaceholder = replacement;
        sidebarProvider.setProjector(replacement);
      },
      runtimeLogSink,
      runtimeLogAccessor,
      evidenceHealth,
      webviewLogSink
    });
    if (!wiring) return;
    stage2 = wiring.stage2;
    sidebarProvider.setProjector(wiring.projector);
    sidebarProvider.setDispatch(wiring.dispatch);
    activeOutput = wiring.output;
  };

  const tearDownStage2 = async (): Promise<void> => {
    if (!stage2) return;
    const previous = stage2;
    stage2 = null;
    sidebarProvider.setDispatch(null);
    const replacement = new PlaceholderProjector({ reason: 'no-workspace' });
    activePlaceholder.dispose();
    activePlaceholder = replacement;
    sidebarProvider.setProjector(replacement);
    activeOutput = null;
    await previous.dispose();
  };

  // Feature FR-R3-006 — the reset transaction's host seam. Registered here
  // rather than immediately after the store because it needs `ensureStage2` and
  // `tearDownStage2`, and reset composes with that existing lifecycle instead of
  // adding a second stop/start path. Every member reads `stage2` at call time,
  // so the audit append after a reload reaches the *new* wiring's writer rather
  // than the disposed one it started with.
  const resetHost: ResetHost = {
    support: () => stage2?.reset ?? null,
    stopProducers: tearDownStage2,
    reload: ensureStage2
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('schegent.reset', () =>
      runReset({ store, logger, host: resetHost })
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      const hasFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
      if (hasFolder && !stage2) {
        await ensureStage2();
      } else if (!hasFolder && stage2) {
        await tearDownStage2();
      }
    })
  );

  context.subscriptions.push({
    dispose() {
      void stage2?.dispose();
      activeOutput?.dispose();
      activePlaceholder.dispose();
    }
  });

  // Stage 2 — workspace-bound wiring. Only proceeds when a workspace folder is open.
  await ensureStage2();
}

interface Stage2Result {
  readonly stage2: Stage2Wiring;
  readonly projector: StateProjector;
  readonly dispatch: (
    command: import('./ui/sidebar/messages').SidebarCommand,
    ack: (msg: import('./ui/sidebar/messages').CommandAckMessage) => Thenable<boolean> | Promise<boolean>
  ) => void | Promise<void>;
  readonly output: SchegentOutputChannel;
}

interface Stage2Inputs {
  readonly context: vscode.ExtensionContext;
  readonly logger: SanitizedLogger;
  readonly ownerId: string;
  readonly workspaceRoot: string;
  readonly store: WorkspaceStateStore;
  readonly onInitFailure: () => void;
  readonly runtimeLogSink: RuntimeEvidenceWiring['runtimeLogSink'];
  readonly runtimeLogAccessor: RuntimeEvidenceWiring['runtimeLogAccessor'];
  readonly evidenceHealth: RuntimeEvidenceWiring['evidenceHealth'];
  readonly webviewLogSink: RuntimeEvidenceWiring['webviewLogSink'];
}

async function wireStage2(inputs: Stage2Inputs): Promise<Stage2Result | null> {
  const {
    context,
    logger,
    ownerId,
    workspaceRoot,
    store,
    onInitFailure,
    runtimeLogSink,
    runtimeLogAccessor,
    evidenceHealth,
    webviewLogSink
  } = inputs;
  evidenceHealth.reset();
  const disposables: vscode.Disposable[] = [];

  const channel = vscode.window.createOutputChannel('Schegent');
  disposables.push(channel);
  const output = new SchegentOutputChannel(channel, logger);

  // Feature FR-R3-006 (T346) — finish a reset the previous host did not survive,
  // *before* `initialize()`, so the migration chain sees the state the operator
  // asked for rather than a half-cleared one. Reasoning in `reset-wiring.ts`.
  const completedResetGeneration = await completeInterruptedResetOnActivation(store, logger);

  // Feature 030 — `initialize()` returns the v5 → v6 migration audit events;
  // they are forwarded through `auditWriter.append` once the writer exists
  // (constructed below). Empty array when no migration occurred.
  let v6MigrationEvents: readonly import('./state/queue-state-migrator').StateMigratedV5ToV6AuditEvent[] = [];
  // Feature 065 — v6 → v7 migration audit events; same forwarding contract.
  let v7MigrationEvents: readonly import('./state/queue-state-migrator').StateMigratedV6ToV7AuditEvent[] = [];
  // Feature 093 — v10 → v11 per-queue Run-record reshape; same forwarding
  // contract, and destructured here rather than left on the result object,
  // which is how feature 092's v10 events went unaudited.
  let v11MigrationEvents: readonly import('./state/run-state-migrator').RunStateMigrationAuditEvent[] = [];
  // FR-R3-010 — v11 → v12 per-queue history partition; same forwarding contract,
  // and destructured here for the same reason.
  let v12MigrationEvents: readonly import('./state/history-state-migrator').HistoryStateMigrationAuditEvent[] = [];
  let runRepairEvents: readonly import('./state/workflow-run-migrator').WorkflowRunRepairedAuditEvent[] = [];
  try {
    const initResult = await store.initialize();
    v6MigrationEvents = initResult.v6MigrationEvents;
    v7MigrationEvents = initResult.v7MigrationEvents;
    v11MigrationEvents = initResult.v11MigrationEvents;
    v12MigrationEvents = initResult.v12MigrationEvents;
    runRepairEvents = initResult.runRepairEvents;
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Schegent: ${(err as Error).message}`,
      'Open Reset Command'
    ).then((selection) => {
      if (selection === 'Open Reset Command') {
        void vscode.commands.executeCommand('schegent.reset');
      }
    });
    onInitFailure();
    for (const d of disposables) d.dispose();
    return null;
  }

  // FR-R3-119 — extracted to `src/activation/workspace-settings.ts`. Two bindings
  // in, nine values out, no side effects: configuration resolution that lived in
  // the composition root only because that is where it was first written.
  const {
    cliPath,
    processEnvironmentPolicy,
    iterationCap,
    pollIntervalMinutes,
    timeoutSeconds,
    maxDurationSeconds,
    rotationSizeMB,
    rotationMaxAgeDays
  } = resolveWorkspaceSettings({ workspaceRoot, logger });
  // FR-R3-119 — extracted to `src/activation/workspace-session.ts`: what this
  // window owns (catalog, both leases, the primacy claim) and the UI shell that
  // reports it. Six bindings in, ten out.
  //
  // `getHistoryStore` is a getter because `catalogStore`'s retained-history
  // enumerator reads it inside a thunk and the store is built ~180 lines below.
  // Passing the value would reorder activation to suit an extraction; the getter
  // preserves the lazy read the original comment describes.
  const session = await openWorkspaceSession({
    workspaceRoot,
    ownerId,
    logger,
    store,
    disposables,
    processEnvironmentPolicy,
    getHistoryStore: () => historyStore
  });
  const {
    catalogReader,
    catalogStore,
    catalogSession,
    catalogLifecycle,
    lock,
    executionLeases,
    lockResult,
    statusBar,
    notifier,
    queue
  } = session;
  // Feature 083 (US6, FR-041) — the single source of "which Workflows consume a
  // Pipeline?" for both the Library list (FR-002) and gate 13 (FR-022a). The
  // callbacks re-read on every call so a Workflow catalog reload, which
  // reassigns `catalogSession.workflowCatalog`, reaches the next gate decision.
  const collectAllWorkflowPipelineRefs = createWorkflowPipelineRefReader({
    listRequests: () => queue.list(),
    listWorkflowRecords: () => catalogSession.workflowCatalog.records
  });
  const auditWriter = new AuditLogWriter(
    {
      workspaceRoot,
      rotationSizeBytes: rotationSizeMB * 1024 * 1024,
      rotationMaxAgeMs: rotationMaxAgeDays * 24 * 60 * 60 * 1000
    },
    logger,
    evidenceHealth
  );

  // Forward all state-migration audit events (v5→v6, v6→v7, v10→v11, v11→v12,
  // workflow-run repair) through the sanitized audit writer. Helper preserves
  // the append-error best-effort semantics — never blocks activation.
  await forwardMigrationAuditEvents(
    {
      v6MigrationEvents,
      v7MigrationEvents,
      v11MigrationEvents,
      v12MigrationEvents,
      runRepairEvents,
      // FR-R3-111 — drained where the writer exists; `initialize()` buffers it before that.
      quarantineEvents: store.drainRunQuarantineEvents()
    },
    auditWriter,
    logger
  );

  // Feature FR-R3-006 (T346, T348) — record the interrupted reset this
  // activation finished, now that there is a writer to record it with.
  if (completedResetGeneration !== null) {
    await recordCompletedInterruptedReset(auditWriter, logger, completedResetGeneration);
  }

  const sessionRetention = new SessionArtifactRetentionService({
    workspaceRoot,
    logger,
    audit: auditWriter,
    policy: () => {
      const settings = readGeneralSettings(
        vscode.workspace.getConfiguration(
          'schegent',
          vscode.Uri.file(workspaceRoot)
        ) as unknown as GeneralSettingsConfig
      );
      return {
        maxAgeMs: settings.sessionRetentionMaxAgeDays * 24 * 60 * 60 * 1000,
        maxBytes: settings.sessionRetentionMaxBytes
      };
    }
  });
  const protectedSessionRunIds = (): ReadonlySet<string> => {
    // Feature 093 (T037/T039) — C-4 aggregate. Retention protects the session
    // directory of *every* Run still in flight, which is what the sweep needed
    // all along; the ambient read could only ever name one, so under N Runs it
    // would have left N-1 session groups eligible for deletion while their Runs
    // were still writing into them.
    const protectedIds = new Set<string>();
    for (const run of Object.values(store.getRunMap())) {
      if (run.status === 'running' || run.status === 'paused') protectedIds.add(run.id);
    }
    return protectedIds;
  };
  // Sweep once at activation. The service is fail-soft and restricts deletion
  // to exact inactive run groups below `.schegent/sessions`; `audit.log` lives
  // outside that root and is never a candidate.
  await sessionRetention.sweep(protectedSessionRunIds());

  // Feature 058 — one-shot activation guard for multi-root workspaces.
  // Emits `multi-root.warning-shown` (folder count + canonical folder
  // NAME only, NEVER fsPath) and a non-blocking informational toast.
  // The helper is internally one-shot per activation and respects
  // `schegent.multiRoot.suppressWarning` (window-scope). Window-scope
  // reads omit the resource URI so VS Code resolves the value from
  // the active `.code-workspace`.
  void maybeShowMultiRootWarning({
    workspaceFolders: vscode.workspace.workspaceFolders,
    canonicalFolder: getCanonicalWorkspaceRoot(),
    suppressWarning: vscode.workspace
      .getConfiguration('schegent')
      .get<boolean>('multiRoot.suppressWarning', false),
    auditWriter,
    notifier
  });
  // FR-R3-119 — extracted to `src/activation/backend-execution-wiring.ts`. 148
  // lines constructing the monitor, sampler, runner registry and their
  // collaborators, behind the narrowest input boundary of any candidate region:
  // nine bindings, against 22 and 30 for the two alternatives.
  //
  // The three `bind*` calls below replace three `let x = null` declarations that
  // were captured by closures in that region and reassigned ~280 lines further
  // down. Returning them as values would have left those closures holding `null`
  // — no compile error, no failing test, and the monitor silently stops
  // recording activity. The binding is named at both ends now.
  const backend = wireBackendExecution({
    workspaceRoot,
    cliPath,
    logger,
    store,
    auditWriter,
    disposables,
    evidenceHealth,
    processEnvironmentPolicy
  });
  const {
    monitor,
    runnerRegistry,
    historyStore,
    promptBuilder,
    rawTranscript,
    backendKind,
    backendCapabilities,
    backendPing,
    readUncontainedAllowed,
    verboseAccessor
  } = backend;
  const fatalSignaturesAccessor = {
    readOperatorAdditions: () =>
      readFatalSignaturesSetting(
        vscode.workspace.getConfiguration('schegent', vscode.Uri.file(workspaceRoot))
      )
  };
  const autoCompactOverrideAccessor = createAutoCompactOverrideAccessor(
    () => vscode.workspace.getConfiguration('schegent', vscode.Uri.file(workspaceRoot)),
    logger
  );
  // Feature 093 (T037) — C-3, bind at construction. The accessor is handed a
  // resolver rather than an ambient thunk: its own method names the Run by id,
  // and this binding answers that id from the whole record — the C-4 aggregate
  // SC-012 exempts, not a Run reached without a queue. T041 rebinds the same
  // resolver per session, where the queue is known and only that queue is read.
  const phaseBreakpointAccessor = createPhaseBreakpointAccessor(
    (runId) => Object.values(store.getRunMap()).find((run) => run.id === runId) ?? null
  );
  const lastRetryDecisionSink = async (
    runId: string,
    decision: import('./state/workflow-run').LastRetryDecision
  ) => {
    // Feature 093 (T047) — the decision names its Run, so the write names that
    // Run's queue. T037's interim binding had no identity to work from and so
    // declined whenever more than one Run existed, which is the same defect
    // read defensively: a decision that belonged to a real Run went nowhere.
    // Run ids are unique across queues, so this resolves to exactly one entry —
    // the C-4 aggregate read SC-012 exempts, not a Run reached without a queue.
    const entry = Object.entries(store.getRunMap()).find(([, run]) => run.id === runId);
    if (entry === undefined) return;
    const [queueId, current] = entry;
    await store.setRun(queueId, { ...current, lastRetryDecision: decision }, store.runCommitClaim(queueId));
  };
  // FR-R3-064 — the posture accessor: the same reader, called per emission
  // instead of once at activation. The difference between the two uses is WHEN,
  // not WHAT; passing the registry's captured boolean here would record an
  // activation-time posture for a Run happening now.
  const backendPostureAccessor = { isUncontainedAllowed: readUncontainedAllowed };
  const phaseRunner = new PhaseRunner(
    runnerRegistry,
    promptBuilder,
    auditWriter,
    logger,
    rawTranscript,
    verboseAccessor,
    fatalSignaturesAccessor,
    autoCompactOverrideAccessor,
    null,
    phaseBreakpointAccessor,
    lastRetryDecisionSink,
    backendPostureAccessor,
    // FR-R3-080 (T1075) — the refused-write drain. Without it a refusal reaches
    // the log and stops there, which is the state this item exists to leave.
    evidenceHealth
  );
  const runSafety = await createRunSafetyWiring({
    context,
    workspaceRoot,
    store,
    queue,
    historyStore,
    logger,
    rawTranscript,
    sessionRetention,
    protectedSessionRunIds,
    evidenceHealth,
    auditWriter,
    notifier
  });

  const controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    statusBar,
    notifier,
    logger,
    lock,
    {
      cliPath,
      cwd: workspaceRoot,
      iterationCap,
      timeoutMs: timeoutSeconds * 1000,
      maxDurationMs: maxDurationSeconds * 1000,
      inheritProcessEnv: processEnvironmentPolicy.inheritProcessEnv,
      processEnvAllowlist: processEnvironmentPolicy.processEnvAllowlist,
      defaultRunnerKind: backendKind,
      isAuditEvidenceAvailable: () =>
        evidenceHealth.getSnapshot().audit.status !== 'unavailable',
      // Read per phase invocation, never cached at activation, so flipping the
      // setting mid-run takes effect on the next phase.
      getForceContinueOnRetryCap: () =>
        vscode.workspace
          .getConfiguration('schegent', vscode.Uri.file(workspaceRoot))
          .get<boolean>('retry.forceContinueOnCap', false) === true,
      // Feature 074 — resolve CLI binary path per-runner-kind. Reads the
      // setting per-invocation (never cached at activation) so the operator
      // can change `schegent.agy.path` without restarting VS Code.
      cliPathResolver: (runnerKind: string) => resolveCliPath(runnerKind, workspaceRoot, cliPath)
    },
    {
      monitor,
      historyStore,
      catalog: catalogSession.catalog,
      auditWriter,
      backendCapabilities,
      // Feature 092 (T051) — the same manager the deactivate path releases,
      // so one window holds one set of leases regardless of which seam
      // claimed them.
      executionLease: executionLeases,
      ...runSafety,
      getRetryCap: () => {
        // Feature 056 Track 4 (FR-023..FR-026) — the configured retry
        // cap shares the same window as `DELAYED_RETRY_CAP = 5`. Earlier
        // versions advertised [1, 20] but silently saturated; now the
        // package contribution, host validator, and accessor agree on
        // [1, 5] so the operator-facing knob and the persistence
        // invariant are honest.
        const cfg = vscode.workspace.getConfiguration('schegent', vscode.Uri.file(workspaceRoot));
        const value = cfg.get<number>('retry.maxAttempts', 5);
        return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5
          ? value
          : 5;
      },
      getRawTranscriptMode: () => {
        // Feature 098 (PRIV-02) — both the fallback and the invalid-value
        // landing spot mirror the manifest default, which moved `always` ->
        // `errors-only`. A raw transcript is unredacted prompt, source and
        // model output; an unreadable setting must not resolve to retaining
        // one for every successful run.
        const value = vscode.workspace
          .getConfiguration('schegent', vscode.Uri.file(workspaceRoot))
          .get<string>('logging.rawTranscriptMode', 'errors-only');
        return value === 'always' || value === 'off' ? value : 'errors-only';
      }
    }
  );

  // FR-R3-008 (T377) — close the late binding opened above the monitor.
  backend.bindLivenessRecorder(controller);

  const guardedRunService = new GuardedRunService({
    lock,
    queue,
    controller,
    logger,
    audit: auditWriter,
    store
  });

  // Feature 065 (T009, T011) — the scheduled-start coordinator owns the
  // single in-process `setTimeout` driving `idle-pending → running`
  // transitions. `reArm()` runs once at activation (after the v7 lift)
  // to re-arm any persisted future schedule or, if the target moment has
  // already elapsed while the host was offline, fire the FR-012 transition
  // immediately. `onFire` clears the persisted schedule fields and invokes
  // the existing auto-drain path so promotion goes through the normal
  // lock-acquire route.
  // FR-R3-002 (T282/T285) — the one promotion path a scheduled start takes,
  // addressed by queue. Both the coordinator's `onFire` and the watchdog's
  // recovery sweep call this, so there is exactly one place that clears a
  // queue's schedule fields and exactly one that asks the drain gate to
  // promote it. The watchdog does not become a second idle-pending gate;
  // `AutoDrainCoordinator.drainIfIdle(queueId)` stays the only enforcement
  // site and this hop is how the watchdog *asks* it.
  const promoteScheduledQueue = async (queueId: string): Promise<void> => {
    await store.updateQueue(
      (queueState) => ({
        queue: {
          ...queueState,
          queueLifecycle: 'active-empty',
          scheduledStartAt: null,
          scheduledStartSource: null,
          updatedAt: Date.now()
        },
        result: undefined
      }),
      queueId,
      store.runCommitClaim(queueId)
    );
    await controller.drainQueuedWork(queueId);
  };

  const scheduledStartCoordinator = new ScheduledStartCoordinator({
    store,
    auditWriter,
    logger,
    onFire: promoteScheduledQueue,
    // Feature 065 (T049b) — surface the transient FR-017a / SC-009 hint
    // on the status bar when a scheduled start fires. 4000 ms is the
    // mid-point of the 3000..5000 ms window mandated by FR-017a.
    onFiredObserver: () => {
      statusBar.showTransient('schegent: scheduled start fired', 4000);
    },
    // Feature 065 (T053 / FR-014) — at fire time, probe whether the
    // workspace lock is held by a competing process. When true, the
    // coordinator emits `scheduled-start-superseded { lock-unavailable }`
    // and leaves the armed deadline persisted; `QueueScheduleWatchdog` below
    // retries it once this window is primary. The operator is NOT prompted.
    isForeignLockHeld: () => lock.isForeignLockHeld(),
    // FR-R3-070 — the authoritative fire-time predicate beside the probe; a
    // window whose fence lapsed after election must not promote a schedule.
    hasPrimacy: () => lock.hasPrimacy(),
    // Feature 098 (T058 / FR-031a) — a schedule that comes due with nothing
    // imported meets the refusal a manual launch meets, and the operator is
    // told in the same words. Read through `catalogSession.catalog` rather than
    // captured, so a catalog imported into after the coordinator was built is
    // the one the gate sees.
    emptyCatalogGate: {
      isCatalogEmpty: () => catalogSession.catalog.pipelinesById.size === 0,
      onRefused: (refusal) => void notifier.warn(refusal.message) // advisory
    }
  });
  if (lockResult.acquired) {
    try {
      await scheduledStartCoordinator.reArm();
    } catch (err) {
      logger.warn(`scheduled-start re-arm failed: ${(err as Error).message}`);
    }
  } else {
    // FR-R3-070 — non-primary: no re-arm. Persisted schedules stay exactly as
    // they are, addressable by the primary window's coordinator and watchdog.
    logger.info('scheduled-start re-arm skipped: window is not primary');
  }

  // Feature 065 (T036/T037) — late-wire the pause/resume cancel + audit
  // hooks so QueueManager.setQueuePausedState can clear an outstanding
  // schedule and emit the lifecycle audit trail without taking a
  // construction-time dependency on the coordinator.
  queue.setScheduledStartCancelHook({
    cancel: (queueId, reason) => scheduledStartCoordinator.cancel(queueId, reason)
  });
  queue.setLifecycleAuditHook({
    append: (entry) =>
      auditWriter.append({
        runId: entry.runId,
        phase: entry.phase,
        iteration: entry.iteration,
        eventType: entry.eventType,
        outcome: entry.outcome,
        payload: entry.payload
      } as never)
  });

  const watchdog = new CreditWatchdog(
    // FR-R3-056 — deferred: constructing here refused at ACTIVATION, killing the
    // extension before it could say why.
    () => runnerRegistry.getOrCreate(),
    store,
    statusBar,
    logger,
    {
      pollIntervalMs: pollIntervalMinutes * 60 * 1000,
      cliPath: resolveCliPath(backendKind, workspaceRoot, cliPath),
      cwd: workspaceRoot,
      timeoutMs: 60 * 1000,
      environmentPolicy: processEnvironmentPolicy
    },
    async () => {
      // Feature 093 (T037/T039) — C-4 aggregate. Credits returning un-blocks
      // every Run that was waiting on them; the watchdog is per window because
      // the credit balance is, but the resume it triggers is per queue.
      //
      // Feature 093 (T045) — the window has one timer and N queues can be in
      // backoff, so the fire is claimed first: elapsed deadlines are consumed
      // and the next-earliest is re-armed. A queue whose own backoff is still
      // running is then skipped, because `resumeExisting` does not consult
      // `pendingRetryAt` and would otherwise resume it early on a sibling's
      // shorter deadline. A queue with no deadline at all is not in a delayed
      // retry — that is the credit-poll arm, and it resumes as it always did.
      // FR-R3-070 — the sweep runs long after activation, so primacy is
      // re-checked at fire time with the authoritative predicate rather than
      // trusted from the activation-era election result.
      if (!(await lock.hasPrimacy())) {
        logger.warn('watchdog resume sweep skipped: window is not primary');
        return;
      }
      controller.claimElapsedDelayedRetries();
      for (const queueId of Object.keys(store.getRunMap())) {
        if (controller.hasPendingDelayedRetry(queueId)) continue;
        await controller.resumeExisting(queueId);
      }
    }
  );

  // Feature 011 — late-inject the watchdog now that both are constructed.
  // The watchdog's resume callback closes over `controller`, so it has to
  // be built after the controller; the controller's delayed-retry path
  // calls `watchdog.pauseAndPoll(...)` so we wire it back here.
  controller.setWatchdog(watchdog);

  // BUG-006 — late-inject the guarded-run service so the retry handler can
  // convert a retry-cap-exhausted rate-limit pause into a system-armed
  // scheduled restore (FR-026). `GuardedRunService` is constructed earlier
  // in this activate path (search for `new GuardedRunService`).
  controller.setGuardedRunService(guardedRunService);

  const queueScheduleWatchdog = new QueueScheduleWatchdog({
    getQueueStates: () => store.getQueueStates(),
    hasArmedTimer: (queueId) => scheduledStartCoordinator.hasActiveTimer(queueId),
    promote: promoteScheduledQueue,
    isPrimary: () => lock.hasPrimacy(),
    // Feature 098 (FR-031a) — the same gate the coordinator's `emptyCatalogGate`
    // reads, for the same reason. `refuseOnEmptyCatalog` leaves the queue
    // `idle-pending` with its deadline persisted and its timer dropped, which is
    // precisely what this sweep recovers; without the gate here the watchdog
    // would undo that refusal on its next tick. Read through `catalogSession.catalog`
    // rather than captured, so an import lifts the hold.
    isCatalogEmpty: () => catalogSession.catalog.pipelinesById.size === 0,
    logger,
    audit: auditWriter
  });
  queueScheduleWatchdog.start();

  controller.setRateLimitHandler(async (cause) => {
    notifier.info(`Schegent: paused (${cause}). Watchdog will poll every ${pollIntervalMinutes} min.`);
    await watchdog.pauseAndPoll(cause);
  });

  const connectedRuns = createConnectedRunService(store, historyStore);
  const projector = new StateProjector({
    store,
    audit: auditWriter,
    ownerId,
    logger,
    monitor,
    history: historyStore,
    getCatalog: () => catalogSession.catalog,
    defaultRunnerKind: backendKind,
    // Re-read scalar settings on each projection.
    getGeneralSettings: () =>
      readGeneralSettings(
        vscode.workspace.getConfiguration('schegent', vscode.Uri.file(workspaceRoot)) as unknown as GeneralSettingsConfig
      ),
    getSessionArtifacts: () => sessionRetention.getUsage(),
    getEvidenceHealth: () => evidenceHealth.getSnapshot(),
    getPhaseCatalog: () => catalogSession.phaseCatalog,
    // Feature 082 — authoritative Pipeline catalog for the Library and Builder.
    getPipelineCatalog: () => catalogSession.pipelineCatalog,
    // Feature 082 (FR-002) — the Workflows each Pipeline still resolves for,
    // so the Library can show what a change would affect. Feature 100 (T513b)
    // left this as the collector's only consumer: the Pipeline removal gate it
    // used to share went with the whole-array save, and the deactivate blocker
    // that replaced it reads active stored definitions instead (FR-025b).
    getWorkflowPipelineRefs: collectAllWorkflowPipelineRefs,
    // Feature 083 — authoritative Workflow catalog (the definition sense) for
    // the Library and Builder. Re-resolved with the Pipeline catalog it was
    // validated against, so a Pipeline catalog change refreshes both.
    getWorkflowCatalog: () => catalogSession.workflowCatalog,
    // Feature 101 (FR-005, FR-007) — the lifecycle facts behind those three
    // resolutions. Rebuilt on every compose from the session's current snapshot,
    // which is the same read the resolutions came from, so a row and its badge
    // cannot describe two different states of the store.
    getBuilderLifecycle: () => buildBuilderLifecycleByKind(catalogSession.definitions),
    // Feature 063 — surface `schegent.ui.confirmations.enable` into the
    // snapshot so the webview's `useConfirm` helper can short-circuit
    // without an IPC round-trip. Re-read on every projection; the
    // `onDidChangeConfiguration` listener below already kicks the
    // projector for any `schegent.*` change.
    getConfirmationsEnabled: () => isConfirmationsEnabled(),
    getDebugLogTail: () => webviewLogSink.getEntries(),
    getAvailableModels: () => backendCapabilities.getAvailableModels(),
    getAvailableBackends: () => backendCapabilities.getAvailableBackends(),
    getBackendPingState: () => backendPing.getState(),
    getConnectedRuns: () => connectedRuns.listProjections(),
    // Feature 103 (T031, FR-003) — both callers and both cadences: see `resolveRunOrigin`.
    getRunOrigin: (taskId) => resolveRunOrigin(store.getConnectedRuns(), taskId)
  });
  backend.bindCapabilityProjector(projector);
  projector.start();
  // Background-only: activation is not blocked on installed CLI processes.
  void backendCapabilities.scan();
  disposables.push(evidenceHealth.subscribe((health) => {
    statusBar.setEvidenceHealth(health.overall);
    projector.kick();
  }));
  webviewLogSink.setOnAppend(() => projector.kick());
  // Feature 033 — bind the deferred telemetry projector reference now that
  // the projector exists. The sampler's `onSample` closure consults this
  // pointer on every emission (and is a no-op until binding).
  backend.bindTelemetryProjector(projector);

  // Feature 059 (US1, T012) — wire the per-capability trust resolver. The
  // resolver re-reads `workspace.isTrusted` + the three `schegent.trust.*`
  // settings on every call (no cache); its only stateful surface is a
  // pair of disposables that fire `projector.kick()` when the operator
  // grants workspace trust or edits any of the three trust keys.
  // Contract: specs/059-fine-grained-trust-scopes/contracts/
  // capability-trust-resolver-contract.md.
  initCapabilityTrustResolver(context, () => projector.kick());

  /**
   * Re-read the store, re-resolve, and tell the two consumers that cache it.
   *
   * Feature 099 (T493b, FR-054) — wired in as `refreshCatalog` on the save router;
   * `CatalogSession.refresh` carries why a store write is what triggers it.
   */
  async function refreshCatalog(): Promise<void> {
    await catalogSession.refresh();
    controller.setCatalog(catalogSession.catalog);
    projector.kick();
  }

  if (typeof vscode.workspace.onDidChangeConfiguration === 'function') {
    disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('schegent.watchdog.pollIntervalMinutes')) {
          const updatedConfig = vscode.workspace.getConfiguration(
            'schegent',
            vscode.Uri.file(workspaceRoot)
          );
          const updatedMinutes = updatedConfig.get<number>('watchdog.pollIntervalMinutes', 30);
          watchdog.setPollInterval(updatedMinutes * 60 * 1000, 'config-change');
        }
        if (
          event.affectsConfiguration('schegent.logging.sessionRetentionMaxAgeDays') ||
          event.affectsConfiguration('schegent.logging.sessionRetentionMaxBytes')
        ) {
          void sessionRetention.sweep(protectedSessionRunIds()).then(() => projector.kick());
        }
        // Feature 099 (T493b, FR-054) — the three retired definition settings
        // keys are gone, so the three arms that reloaded on
        // them are gone with them; a definition change now arrives as a store
        // write and re-resolves through `refreshCatalog` below. The two survivors
        // are still configuration and still reload here.
        if (
          event.affectsConfiguration('schegent.defaultPipelineId') ||
          event.affectsConfiguration('schegent.models') // 096 — reload models
        ) {
          void refreshCatalog();
        }
        if (
          event.affectsConfiguration('schegent.cli.path') ||
          event.affectsConfiguration('schegent.codex.path') ||
          event.affectsConfiguration('schegent.agy.path') ||
          event.affectsConfiguration('schegent.backend.probeTimeoutSeconds')
        ) {
          void backendCapabilities.scan();
        }
        // Feature 011 — any schegent.* change triggers a re-projection
        // so the Settings surface reflects the new value within FR-017.
        if (event.affectsConfiguration('schegent')) {
          projector.kick();
        }
      })
    );
  }

  // Feature 020 — phase-log tail wiring (T049). Registry, task-leave
  // subscription and snapshot-validating adapter all live in the wiring module;
  // the reasoning for each is recorded there.
  const phaseLogTail = createPhaseLogTailWiring({
    workspaceRoot,
    projector,
    queue,
    auditWriter,
    logger
  });
  disposables.push(phaseLogTail);

  // Feature 073 — constructed once per activation so its lifetime matches
  // "session" per contracts/metrics-view-opened-event.md.
  const metricsViewOpenedState = { emitted: false };

  // FR-R3-119 — extracted to `src/activation/sidebar-router-wiring.ts`. This was
  // the largest independent span in `wireStage2`: 240 lines constructing one
  // collaborator. `context`, `output` and `config` are not passed because the
  // router reads none of them — they were in scope, which is not the same thing.
  const sidebarRouter = createSidebarRouter({
    logger,
    ownerId,
    workspaceRoot,
    store,
    queue,
    controller,
    lock,
    notifier,
    auditWriter,
    historyStore,
    guardedRunService,
    backendKind,
    metricsViewOpenedState,
    projector,
    catalogStore,
    catalogReader,
    catalogSession,
    catalogLifecycle,
    connectedRuns,
    backendPing,
    evidenceHealth,
    phaseLogTail,
    runtimeLogSink,
    runtimeLogAccessor,
    refreshCatalog
  });

  const uiWiring = registerStage2Ui({
    extensionRoot: context.extensionUri.fsPath,
    workspaceRoot,
    projector,
    dispatch: (cmd, ack) => sidebarRouter.dispatch(cmd, ack),
    guardedRunService,
    store,
    auditWriter,
    notifier,
    logger,
    getCatalog: () => catalogSession.catalog,
    controller,
    queue,
    lock,
    historyStore,
    getWorkspaceFolders: () => vscode.workspace.workspaceFolders
  });
  phaseLogTail.bindDashboardBridge(uiWiring.dashboardBridge);
  output.log(`activated; cli=${cliPath}, cap=${iterationCap}, pollIntervalMin=${pollIntervalMinutes}`);

  if (lockResult.acquired) {
    await watchdog.reattachOnActivation();
  } else {
    // FR-R3-070 — non-primary: the persisted poll deadline remains for the
    // primary window to reattach.
    logger.info('watchdog reattach skipped: window is not primary');
  }

  // Feature 011 FR-013 — restart handshake. If the persisted run has a
  // pending delayed-retry deadline, re-arm the watchdog (or resume
  // immediately if it has already elapsed).
  if (lockResult.acquired) {
    await controller.resumeExistingFromActivation();
  } else {
    // FR-R3-070 — the path that used to fire setImmediate(resumeExisting)
    // before the election was decided; the elapsed deadline stays persisted.
    logger.info('delayed-retry re-arm skipped: window is not primary');
  }

  // FR-R3-070 — the election itself moved above the recovery installers.
  // Primary-window status stays decoupled from run-resumption: even with no
  // run persisted, this window must be primary so the sidebar mounts enabled.
  // Feature 093 (T037/T039) — C-4 aggregate. A window that crashed mid-
  // concurrency persisted several Runs, and each is re-armed on the queue that
  // owns it. With one entry this is the previous behavior exactly.
  // FR-R3-103 (FR-046) — a lost fence terminates this window's children.
  context.subscriptions.push(lock.onFenceLost(() => controller.abortOnSupersession()));

  if (lockResult.acquired) {
    // FR-R3-103 — ask whether the previous host's tree is still alive before resuming.
    const probe = createLivenessProbe();
    void resumePersistedRuns({
      // Filtered HERE: this file is on the status-literal allowlist and
      // `resume-decision.ts` is not, which is the right way round — the policy module
      // should not know the status vocabulary.
      runs: () =>
        Object.entries(store.getRunMap()).filter(([, run]) => run.status === 'running'),
      liveness: (identity) => checkLiveness(identity, probe),
      appendAudit: async (entry) => {
        await auditWriter.append({ ...entry, payload: { ...entry.payload } });
      },
      resume: (queueId) => void controller.resumeExisting(queueId),
      notify: (message) => void vscode.window.showWarningMessage(message),
      log: (message) => logger.info(message)
    });
  }

  const dispose = async (): Promise<void> => {
    uiWiring.dispose();
    projector.dispose();
    watchdog.dispose();
    queueScheduleWatchdog.dispose();
    statusBar.dispose();
    for (const d of disposables) {
      try {
        d.dispose();
      } catch {
        // ignore disposal errors
      }
    }
    // Feature 092 (T049) — drop every queue lease this window holds before the
    // workspace lock, so a window that is shutting down never leaves a queue
    // claimed while advertising itself as no longer primary.
    await executionLeases.releaseAll();
    await lock.release();
  };

  // Feature FR-R3-006 (T342, T344, T345, T348) — the reset transaction's
  // stage-2 half. `dispose()` above is the rest of it.
  const resetSupport: ResetStageSupport = createResetStageSupport({
    controller,
    auditWriter,
    logger
  });

  return {
    stage2: { disposables, reset: resetSupport, dispose },
    projector,
    dispatch: (cmd, ack) => sidebarRouter.dispatch(cmd, ack),
    output
  };
}

export function deactivate(): void {
  // disposables registered to context.subscriptions will run automatically.
  // Feature 058 — release the workspace-folder-picker subscription and clear
  // its memoized canonical folder so a fresh activation rebuilds from a clean
  // state. Idempotent and never throws.
  disposeWorkspaceFolderPicker();
}
