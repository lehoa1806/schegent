import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { WorkspaceStateStore } from './state/workspace-state';
import {
  getCanonicalWorkspaceRoot,
  disposeWorkspaceFolderPicker
} from './state/workspace-folder-picker';
import { resolveCliPath } from './config/cli-path-accessor';
import { SchegentWorkflowController } from './controller/workflow-controller';
import { SanitizedLogger } from './lib/logger';
import {
  createRuntimeEvidenceWiring,
  type RuntimeEvidenceWiring
} from './activation/backend-wiring';
import { registerStage2Ui } from './activation/ui-wiring';
import { registerGuardedCommand } from './activation/guarded-command-registration';
import { Notifier } from './ui/notifications';
import { SchegentOutputChannel } from './ui/output-channel';
import { runReset, type ResetHost, type ResetStageSupport } from './commands/reset';
import {
  completeInterruptedResetOnActivation,
  createResetStageSupport,
} from './commands/reset-wiring';
import { StateProjector } from './ui/sidebar/state-projector';
import { SidebarViewProvider } from './ui/sidebar/sidebar-view-provider';
import { PlaceholderProjector } from './ui/sidebar/placeholder-projector';
import { GuardedRunService } from './services/guarded-run-service';
import { createSidebarRouter } from './activation/sidebar-router-wiring';
import { wireBackendExecution } from './activation/backend-execution-wiring';
import { resolveWorkspaceSettings } from './activation/workspace-settings';
import { openWorkspaceSession } from './activation/workspace-session';
import { wireScheduledWork } from './activation/scheduled-work-wiring';
import { wireEvidence } from './activation/evidence-wiring';
import { wireLivePicture } from './activation/live-picture-wiring';
import { wirePhaseExecution } from './activation/phase-execution-wiring';
import { createStage2Producers, type Stage2Producers } from './activation/stage2-producers';
import { wireTrustGrant } from './activation/trust-grant-wiring';
import { closeStage2Resources } from './activation/stage2-teardown';

/**
 * FR-R3-136 (FR-005) — the one live read of Workspace Trust in this file, and a
 * function rather than a value so every taker re-decides when it acts. Four
 * inline copies were four places for one to become a captured boolean.
 */
const isWorkspaceTrusted = (): boolean => vscode.workspace.isTrusted;

// FR-R3-137 (FR-010) — the host teardown, module-scoped so `deactivate()` can await it.
let hostTeardown: (() => Promise<void>) | null = null;

interface Stage2Wiring {
  readonly disposables: readonly vscode.Disposable[];
  /**
   * Feature FR-R3-006 — the two reset capabilities that only exist once stage 2
   * is up. Carried on the wiring rather than reached for through a module-level
   * reference, so a reset that runs across a teardown/reload cycle necessarily
   * talks to whichever stage 2 is current.
   */
  readonly reset: ResetStageSupport;
  /**
   * FR-R3-136 (FR-010) — what a later trust grant calls. On the wiring for the
   * same reason `reset` is: a reload replaces the graph, and a grant arriving
   * after one must reach the CURRENT producers, not a disposed lock.
   */
  readonly producers: Stage2Producers;
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

  // FR-R3-136 — why the guard helper depends on nothing from Stage 2.
  // `schegent.reset` is registered here and stays reachable with no folder open,
  // so a guard needing a store or a lock could not be applied to it. This
  // `Notifier` is not a second notification path: it is a stateless wrapper over
  // three `vscode.window.show*Message` calls, available before `wireStage2`.
  const stage1Notifier = new Notifier(vscode.window);

  context.subscriptions.push(
    registerGuardedCommand(
      {
        isWorkspaceTrusted,
        notifier: stage1Notifier,
        logger
      },
      'schegent.reset',
      () => runReset({ store, logger, host: resetHost })
    )
  );

  // FR-R3-136 (FR-010) — a later grant reaches the CURRENT producers, which is
  // why the thunk and not the value: `wireTrustGrant` carries the rest.
  context.subscriptions.push(
    wireTrustGrant({ logger, getProducers: () => stage2?.producers ?? null })
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

  // FR-R3-137 (FR-010) — published so `deactivate()` can AWAIT it. This entry
  // opened `void stage2?.dispose()`, and VS Code disposes `context.subscriptions`
  // synchronously: the promise carrying the transport flush, the lease release and
  // the lock release was discarded at the one moment the three had to finish. It
  // nulls itself, so whichever of the two paths fires second is a no-op.
  hostTeardown = async (): Promise<void> => {
    hostTeardown = null;
    const output = activeOutput; // read first: `tearDownStage2` clears it
    await tearDownStage2();
    output?.dispose();
    activePlaceholder.dispose();
  };
  context.subscriptions.push({ dispose: () => void hostTeardown?.() });

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
  const { catalogReader, catalogStore, catalogSession, catalogLifecycle, lock,
    executionLeases, queueStartFailures, statusBar, notifier, queue, startMountProbe } = session;
  // FR-R3-119 — extracted to `src/activation/evidence-wiring.ts`: the audit
  // writer, the retention sweep, and the two thunks that tell them what is still
  // live. The migration events are passed rather than re-derived — the store
  // reports them once, and asking twice returns nothing or re-runs a migration.
  const {
    auditWriter,
    sessionRetention,
    collectAllWorkflowPipelineRefs,
    protectedSessionRunIds,
    replayEvidenceBacklog
  } = await wireEvidence({
    workspaceRoot,
    logger,
    store,
    queue,
    notifier,
    evidenceHealth,
    catalogSession,
    rotationSizeMB,
    rotationMaxAgeDays,
    completedResetGeneration,
    v6MigrationEvents,
    v7MigrationEvents,
    v11MigrationEvents,
    v12MigrationEvents,
    runRepairEvents
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
    hostSubscriptions: context.subscriptions,
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
  // FR-R3-119 — extracted to `src/activation/phase-execution-wiring.ts`: the four
  // call-time setting accessors, the retry-decision sink, the phase runner and the
  // run-safety net. The accessors are grouped because they share one reason —
  // `AGENTS.md` carries four separate "never cache the X setting on long-lived
  // runner state" rules, one per accessor, and they read better as one rule
  // applied four times than as four unrelated options.
  const { phaseRunner, runSafety } = await wirePhaseExecution({
    context,
    workspaceRoot,
    logger,
    store,
    queue,
    notifier,
    auditWriter,
    historyStore,
    rawTranscript,
    promptBuilder,
    runnerRegistry,
    evidenceHealth,
    sessionRetention,
    protectedSessionRunIds,
    readUncontainedAllowed,
    verboseAccessor
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
      isAuditEvidenceAvailable: () => evidenceHealth.getSnapshot().audit.status !== 'unavailable',
      // Read per phase invocation, never cached at activation, so flipping the
      // setting mid-run takes effect on the next phase.
      getForceContinueOnRetryCap: () => vscode.workspace
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
      startFailures: queueStartFailures,
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
    // FR-R3-136 (FR-008) — admission is re-decided at the moment of the write,
    // not at the moment this service was built.
    isWorkspaceTrusted,
    lock,
    queue,
    controller,
    logger,
    audit: auditWriter,
    store
  });

  // FR-R3-119 — extracted to `src/activation/scheduled-work-wiring.ts`: the three
  // things that act on a clock. 168 lines for seventeen bindings in and three out.
  const {
    watchdog,
    queueScheduleWatchdog,
    scheduledStartCoordinator
  } = wireScheduledWork({
    workspaceRoot,
    cliPath,
    logger,
    store,
    queue,
    controller,
    auditWriter,
    notifier,
    statusBar,
    lock,
    guardedRunService,
    runnerRegistry,
    catalogSession,
    backendKind,
    pollIntervalMinutes,
    processEnvironmentPolicy
  });

  // FR-R3-136 — the four recovery landmarks moved to `stage2-producers.ts` with
  // the election gating them; `elect-before-recovering` reads them there now.
  // FR-R3-119 — extracted to `src/activation/live-picture-wiring.ts`: the state
  // projector, the connected-run service it reads, and the phase-log tail.
  //
  // The first region taken from the coupled core rather than the edges, and the
  // binding count says so — 22, where every earlier region ran nine to eighteen.
  // Two of them are `backend`'s setters passed individually rather than the whole
  // bundle: the projector is built in there, so the calls that bind it belong
  // there too, and naming the two functions is narrower than handing over an
  // object to reach them.
  const { projector, connectedRuns, phaseLogTail, refreshCatalog } = wireLivePicture({
    context,
    workspaceRoot,
    ownerId,
    logger,
    isWorkspaceTrusted,
    store,
    queue,
    controller,
    historyStore,
    auditWriter,
    statusBar,
    monitor,
    watchdog,
    catalogSession,
    evidenceHealth,
    sessionRetention,
    webviewLogSink,
    disposables,
    backendKind,
    backendCapabilities,
    backendPing,
    protectedSessionRunIds,
    queueStartFailures,
    collectAllWorkflowPipelineRefs,
    bindCapabilityProjector: backend.bindCapabilityProjector,
    bindTelemetryProjector: backend.bindTelemetryProjector
  });

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

  // FR-R3-103 (FR-046) — a lost fence terminates this window's children.
  context.subscriptions.push(lock.onFenceLost(() => controller.abortOnSupersession()));

  // FR-R3-136 (FR-009…FR-012) — THE TRUST GATE. Everything above constructs or
  // subscribes and writes nothing, which is why the fence line stays on this side;
  // `stage2-producers.ts` carries why the split falls on the act, not construction.
  const producers = createStage2Producers({
    isWorkspaceTrusted,
    logger,
    store,
    auditWriter,
    lock,
    controller,
    watchdog,
    scheduledStartCoordinator,
    replayEvidenceBacklog,
    runSafety,
    backendCapabilities,
    startMountProbe,
    refreshCatalog
  });
  await producers.run();

  const dispose = async (): Promise<void> => {
    // FR-R3-137 (T1530c) — the resources, transport descriptor included; why in the module.
    await closeStage2Resources({
      sync: [uiWiring, projector, watchdog, queueScheduleWatchdog, statusBar],
      disposables,
      transport: backend.transport
    });
    // Feature 092 (T049) — drop every queue lease this window holds before the
    // workspace lock, so a window that is shutting down never leaves a queue
    // claimed while advertising itself as no longer primary. Both releases stay
    // in THIS file: AGENTS.md rule 4 puts primacy's release at `dispose()` here.
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
    stage2: { disposables, reset: resetSupport, producers, dispose },
    projector,
    dispatch: (cmd, ack) => sidebarRouter.dispatch(cmd, ack),
    output
  };
}

export async function deactivate(): Promise<void> {
  // FR-R3-137 (FR-010) — awaited, which is the whole point: VS Code awaits a
  // `Thenable` returned from `deactivate`, and does not await a `Disposable`.
  await hostTeardown?.();
  // Feature 058 — release the workspace-folder-picker subscription and clear
  // its memoized canonical folder so a fresh activation rebuilds from a clean
  // state. Idempotent and never throws.
  disposeWorkspaceFolderPicker();
}
