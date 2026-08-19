import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import * as path from 'node:path';
import { WorkspaceStateStore } from './state/workspace-state';
import { WorkspaceLockManager } from './state/lock';
import { ExecutionLeaseManager } from './state/execution-lease';
import { createDiskOwnershipFs } from './state/ownership-fs';
import {
  getCanonicalWorkspaceRoot,
  disposeWorkspaceFolderPicker
} from './state/workspace-folder-picker';
import { resolveCliPath } from './config/cli-path-accessor';
import { maybeShowMultiRootWarning } from './state/multi-root-warning';
import { initCapabilityTrustResolver } from './state/capability-trust-resolver';
import { QueueManager } from './queue/queue-manager';
import { DEFAULT_QUEUE_ID } from './queue/queue-registry';
import { resolveBackendKind } from './runner/backend-runner-factory';
import { BackendRunnerRegistry } from './runner/backend-runner-registry';
import { resolveProcessEnvironmentPolicy } from './runner/spawn-env';
import { PromptBuilder } from './runner/prompt-builder';
import { PhaseRunner } from './controller/phase-runner';
import { SchegentWorkflowController } from './controller/workflow-controller';
import { QueueScheduleWatchdog } from './controller/schedule-watchdog';
import { CreditWatchdog } from './watchdog/credit-watchdog';
import { AuditLogWriter } from './audit/audit-log-writer';
import { RawTranscriptWriter } from './audit/raw-transcript-writer';
import { SessionArtifactRetentionService } from './services/session-retention/session-artifact-retention-service';
import { SanitizedLogger } from './lib/logger';
import {
  createRuntimeEvidenceWiring,
  createBackendDiagnosticsWiring,
  warnIfEnvironmentIsUnrestricted,
  type RuntimeEvidenceWiring
} from './activation/backend-wiring';
import { warnIfScaffoldingMissing } from './activation/workspace-scaffolding';
import { createConnectedRunService, registerStage2Ui } from './activation/ui-wiring';
import { SchegentOutputChannel } from './ui/output-channel';
import { SchegentStatusBar } from './ui/status-bar';
import { Notifier } from './ui/notifications';
import { forwardMigrationAuditEvents } from './state/migration-audit-forwarder';
import { runReset, type ResetHost, type ResetStageSupport } from './commands/reset';
import {
  completeInterruptedResetOnActivation,
  createResetStageSupport,
  recordCompletedInterruptedReset
} from './commands/reset-wiring';
import { StateProjector } from './ui/sidebar/state-projector';
import { createWorkflowPipelineRefReader } from './ui/sidebar/workflow-pipeline-ref-source';
import {
  readGeneralSettings,
  writeGeneralSettings,
  readFatalSignaturesSetting,
  type GeneralSettingsConfig
} from './config/general-settings';
import { validateWorkspaceSettings } from './config/settings-schema-validator';
import { createAutoCompactOverrideAccessor } from './lib/auto-compact-override';
import { createPhaseBreakpointAccessor } from './controller/breakpoint-accessor';
import { SidebarViewProvider } from './ui/sidebar/sidebar-view-provider';
import { MessageRouter } from './ui/sidebar/message-router';
import { PlaceholderProjector } from './ui/sidebar/placeholder-projector';
import { ClaudeCliMonitor } from './monitor/claude-cli-monitor';
import { createCliTransportSink } from './monitor/cli-transport-sink';
import type { RunActivityObservation } from './monitor/activity-coalescer';
import { TelemetrySamplerImpl } from './telemetry/telemetry-sampler';
import { psShellOut } from './telemetry/platform/platform-ps';
import { windowsShellOut } from './telemetry/platform/platform-windows';
import type { TelemetrySnapshot } from './telemetry/telemetry-snapshot';
import { RATE_LIMIT_MATCHERS } from './parser/credit-error-detector';
import { HistoryStore } from './state/history-store';
import { createRunSafetyWiring } from './activation/run-safety-wiring';
import { isConfirmationsEnabled } from './state/confirmations-config';
import { coerceModels } from './config/pipeline-config-loader';
import type { CatalogConfigReader } from './config/pipeline-config-loader';
import { loadAndReportCatalog } from './activation/catalog-loading';
import type { PipelineCatalog } from './config/pipeline-config';
import { readWorkflowLayers, type WorkflowConfigReader } from './config/workflow-config';
import { createWorkflowConfigReader } from './activation/workflow-config-reader';
import { GuardedRunService } from './services/guarded-run-service';
import { ScheduledStartCoordinator } from './services/scheduled-start-coordinator';
import { readMetrics } from './metrics/metrics-service';
import { AuditPointerResolver } from './services/history/audit-pointer-resolver';
import { HistoryEvidenceService } from './services/history/history-evidence-service';
import { createPhaseLogService } from './services/phase-log';
import { createPhaseLogTailWiring } from './activation/phase-log-tail-wiring';

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

  const config = vscode.workspace.getConfiguration('schegent', vscode.Uri.file(workspaceRoot));
  // Feature 056 follow-on — one-shot drift guard. Compares every layer
  // (workspace folder / workspace / global) against SETTINGS_SCHEMA and
  // emits a sanitized warn per finding. Operator typos (e.g. a hand-set
  // `loop.maxIterations: 0`) surface in the runtime log at activation
  // instead of producing a confusing downstream reject. Sync, no I/O.
  validateWorkspaceSettings(config, logger, new Set());
  const cliPath = config.get<string>('cli.path', 'claude');
  const processEnvironmentPolicy = resolveProcessEnvironmentPolicy({
    inheritEnvironment: config.get<boolean>('cli.inheritEnvironment', true),
    // Feature 098 (PRIV-02) — fallback mirrors the manifest default, which
    // moved `inherit` -> `allowlist`. An absent contribution must not
    // silently restore full ambient-environment forwarding.
    mode: config.get<unknown>('cli.environmentMode', 'allowlist'),
    allowlist: config.get<unknown>('cli.environmentAllowlist', [])
  });
  const iterationCap = config.get<number>('loop.maxIterations', 10);
  const pollIntervalMinutes = config.get<number>('watchdog.pollIntervalMinutes', 30);
  const timeoutSeconds = config.get<number>('invocation.timeoutSeconds', 5400);
  const rotationSizeMB = config.get<number>('audit.rotation.sizeMB', 5);
  const rotationMaxAgeDays = config.get<number>('audit.rotation.maxAgeDays', 30);
  const catalogReader: CatalogConfigReader = createCatalogReader(workspaceRoot);
  const workflowConfigReader: WorkflowConfigReader = createWorkflowConfigReader(workspaceRoot);
  const initialLoad = loadAndReportCatalog(catalogReader, logger, workflowConfigReader);
  let activeCatalog: PipelineCatalog = initialLoad.catalog;
  let activePhasePrecedence: import('./config/phase-precedence').PhasePrecedenceProjection =
    initialLoad.phasePrecedence;
  let activePhaseCatalog = initialLoad.phaseCatalog;
  let activePipelineCatalog = initialLoad.pipelineCatalog;
  let activeWorkflowCatalog = initialLoad.workflowCatalog;
  // Feature FR-R3-003 (T295) — point both leases at storage two extension hosts
  // can both see, now that the workspace root is known. Until this call the store
  // arbitrates through a `Memento`-backed adapter, which is correct for one host
  // and is exactly the assumption finding REL-01 was about. `.schegent/` is
  // covered by its own `.gitignore` (`*`), and an ownership record carries owner
  // ids and timestamps only — never a workspace path.
  // Feature FR-R3-005 (T330) — one expression, read twice: the adapter's
  // containment root and the registry's directory are the same path by
  // construction, so they cannot drift into a guard that proves membership of
  // a tree the registry does not write to.
  const ownershipDir = path.join(workspaceRoot, '.schegent', 'ownership');
  store.useOwnershipStorage(createDiskOwnershipFs(ownershipDir), ownershipDir);
  const lock = new WorkspaceLockManager(store, ownerId);
  // Feature 092 (T049, FR-031) — the execution half of the lock split. Same
  // owner id as the workspace lock so a crash strands both together, but a
  // separate manager over a separate key: holding a queue's execution lease
  // must never make this window primary.
  const executionLeases = new ExecutionLeaseManager(store, ownerId);
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  disposables.push(statusBarItem);
  const statusBar = new SchegentStatusBar(statusBarItem);
  const notifier = new Notifier({
    showInformationMessage: (m) => vscode.window.showInformationMessage(m),
    showWarningMessage: (m) => vscode.window.showWarningMessage(m),
    showErrorMessage: (m) => vscode.window.showErrorMessage(m)
  });
  warnIfEnvironmentIsUnrestricted(processEnvironmentPolicy, workspaceRoot, logger);
  // The extension also activates via the implicit `onView:schegent.sidebar` event,
  // so `workspaceContains:.specify/` does not imply the directory is there.
  warnIfScaffoldingMissing(workspaceRoot, logger, notifier);

  const queue = new QueueManager(store, logger);
  // Feature 083 (US6, FR-041) — the single source of "which Workflows consume a
  // Pipeline?" for both the Library list (FR-002) and gate 13 (FR-022a). The
  // callbacks re-read on every call so a `schegent.workflows` reload, which
  // reassigns `activeWorkflowCatalog`, reaches the next gate decision.
  const collectAllWorkflowPipelineRefs = createWorkflowPipelineRefReader({
    listRequests: () => queue.list(),
    listWorkflowRecords: () => activeWorkflowCatalog.records
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
      runRepairEvents
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
  // FR-R3-008 (T377) — the monitor observes activity long before the controller
  // that persists it exists, so the recorder is late-bound in the same shape as
  // `telemetryProjector` below. Until the controller is constructed there is no
  // Run to stamp, and a dropped observation costs at most one coalescing
  // interval of resolution.
  let livenessRecorder: { recordRunActivity: (o: RunActivityObservation) => void } | null = null;
  const monitor = new ClaudeCliMonitor({
    stallThresholdMs: 90_000,
    rateLimitMatchers: RATE_LIMIT_MATCHERS,
    monotonicNow: () => {
      const perf = (globalThis as { performance?: { now: () => number } }).performance;
      return perf ? perf.now() : Date.now();
    },
    now: () => new Date(),
    audit: auditWriter,
    // Feature FR-R3-007 — CLI output goes to the bounded sink, not `audit.log`.
    // The root is re-read per emit rather than closed over: a host outlives one
    // folder, and the destination and its containment root are derived together
    // so the two cannot disagree.
    transport: createCliTransportSink(
      () => getCanonicalWorkspaceRoot()?.uri.fsPath ?? null,
      logger
    ),
    activity: {
      record: (observation) => {
        livenessRecorder?.recordRunActivity(observation);
      }
    },
    logger
  });
  // Sampler is created before its late-bound projector and runner hooks.
  const telemetryShellOut =
    process.platform === 'win32' ? windowsShellOut : psShellOut;
  let telemetryProjector: { updateTelemetry: (snap: TelemetrySnapshot | null) => void } | null =
    null;
  const sampler = new TelemetrySamplerImpl({
    shellOutFn: telemetryShellOut,
    logger,
    onSample: (snap) => {
      telemetryProjector?.updateTelemetry(snap);
    }
  });
  disposables.push({ dispose: () => sampler.dispose() });
  // Invocation runners are lazy and share one monitor hook.
  const backendKind = resolveBackendKind(
    vscode.workspace.getConfiguration('schegent.backend').get<string>('runner'),
    logger
  );
  const runnerRegistry = new BackendRunnerRegistry({
    // Feature 093 (T046) — forward each event to the Run that produced it.
    // The hook stays one window-level function; only the addressing changes.
    monitorHook: (event) => {
      if (event.kind === 'started') {
        monitor.onSpawnPid(event.runId, event.pid);
        if (event.pid !== null) {
          sampler.start(event.pid, Date.now());
        }
      } else if (event.kind === 'stdout-chunk') {
        monitor.onStdoutChunk(event.runId, event.chunk);
      } else if (event.kind === 'stderr-chunk') {
        monitor.onStderrChunk(event.runId, event.chunk);
      } else if (event.kind === 'exited') {
        monitor.onExit(event.runId, {
          exitCode: event.exitCode,
          signal: event.signal,
          killed: event.killed,
          timedOut: event.timedOut
        });
        sampler.stop({ signal: event.signal as NodeJS.Signals | null });
      }
    },
    probeTransport: true,
    logger
  }, backendKind);
  // Stage 2 teardown cancels workspace-bound subprocesses.
  disposables.push({ dispose: () => runnerRegistry.cancelAll() });
  let capabilityProjector: Pick<StateProjector, 'kick'> | null = null;
  const backendDiagnostics = createBackendDiagnosticsWiring({
    workspaceRoot,
    claudePath: cliPath,
    environmentPolicy: processEnvironmentPolicy,
    audit: auditWriter,
    logger,
    onDidChange: () => capabilityProjector?.kick()
  });
  const backendCapabilities = backendDiagnostics.capabilities;
  const backendPing = backendDiagnostics.ping;
  disposables.push(backendDiagnostics);
  const historyStore = new HistoryStore(store);
  const promptBuilder = new PromptBuilder();
  const rawTranscript = new RawTranscriptWriter(
    workspaceRoot,
    logger,
    undefined,
    evidenceHealth
  );
  const verboseAccessor = {
    isVerboseDiagnosticsEnabled: () =>
      vscode.workspace
        .getConfiguration('schegent', vscode.Uri.file(workspaceRoot))
        .get<boolean>('logging.verbose', false)
  };
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
    await store.setRun(queueId, { ...current, lastRetryDecision: decision });
  };
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
    lastRetryDecisionSink
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
    evidenceHealth
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
      catalog: activeCatalog,
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
  livenessRecorder = controller;

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
      queueId
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
    // Feature 098 (T058 / FR-031a) — a schedule that comes due with nothing
    // imported meets the refusal a manual launch meets, and the operator is
    // told in the same words. Read through `activeCatalog` rather than
    // captured, so a catalog imported into after the coordinator was built is
    // the one the gate sees.
    emptyCatalogGate: {
      isCatalogEmpty: () => activeCatalog.pipelinesById.size === 0,
      onRefused: (refusal) => notifier.warn(refusal.message)
    }
  });
  try {
    await scheduledStartCoordinator.reArm();
  } catch (err) {
    logger.warn(`scheduled-start re-arm failed: ${(err as Error).message}`);
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
    runnerRegistry.getOrCreate(),
    store,
    statusBar,
    logger,
    {
      pollIntervalMs: pollIntervalMinutes * 60 * 1000,
      cliPath: resolveCliPath(backendKind, workspaceRoot, cliPath),
      cwd: workspaceRoot,
      timeoutMs: 60 * 1000
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
    isPrimary: () => lock.isHeld(),
    // Feature 098 (FR-031a) — the same gate the coordinator's `emptyCatalogGate`
    // reads, for the same reason. `refuseOnEmptyCatalog` leaves the queue
    // `idle-pending` with its deadline persisted and its timer dropped, which is
    // precisely what this sweep recovers; without the gate here the watchdog
    // would undo that refusal on its next tick. Read through `activeCatalog`
    // rather than captured, so an import lifts the hold.
    isCatalogEmpty: () => activeCatalog.pipelinesById.size === 0,
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
    getCatalog: () => activeCatalog,
    defaultRunnerKind: backendKind,
    // Re-read scalar settings on each projection.
    getGeneralSettings: () =>
      readGeneralSettings(
        vscode.workspace.getConfiguration('schegent', vscode.Uri.file(workspaceRoot)) as unknown as GeneralSettingsConfig
      ),
    getSessionArtifacts: () => sessionRetention.getUsage(),
    getEvidenceHealth: () => evidenceHealth.getSnapshot(),
    // Feature 026 — UI-only per-phase precedence projection. Re-read on
    // every snapshot so a catalog reload triggered by
    // `onDidChangeConfiguration('schegent.phases')` reaches the webview
    // within the FR-017 1s budget. Never persisted; never logged.
    getPhasePrecedence: () => activePhasePrecedence,
    getPhaseCatalog: () => activePhaseCatalog,
    // Feature 082 — authoritative Pipeline catalog for the Library and Builder.
    getPipelineCatalog: () => activePipelineCatalog,
    // Feature 082 (FR-002) — the Workflows each Pipeline still resolves for,
    // so the Library can show what a change would affect. Same collector as the
    // removal gate's `readWorkflowPipelineRefs` (FR-022a, 083 FR-041).
    getWorkflowPipelineRefs: collectAllWorkflowPipelineRefs,
    // Feature 083 — authoritative Workflow catalog (the definition sense) for
    // the Library and Builder. Re-resolved with the Pipeline catalog it was
    // validated against, so a `schegent.pipelines` change refreshes both.
    getWorkflowCatalog: () => activeWorkflowCatalog,
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
    getConnectedRuns: () => connectedRuns.listProjections()
  });
  capabilityProjector = projector;
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
  telemetryProjector = projector;

  // Feature 059 (US1, T012) — wire the per-capability trust resolver. The
  // resolver re-reads `workspace.isTrusted` + the three `schegent.trust.*`
  // settings on every call (no cache); its only stateful surface is a
  // pair of disposables that fire `projector.kick()` when the operator
  // grants workspace trust or edits any of the three trust keys.
  // Contract: specs/059-fine-grained-trust-scopes/contracts/
  // capability-trust-resolver-contract.md.
  initCapabilityTrustResolver(context, () => projector.kick());

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
        if (
          event.affectsConfiguration('schegent.phases') ||
          event.affectsConfiguration('schegent.pipelines') ||
          event.affectsConfiguration('schegent.defaultPipelineId') ||
          event.affectsConfiguration('schegent.models') || // 096 — reload models
          // Feature 083 — a Workflow layer edit re-resolves the whole catalog.
          event.affectsConfiguration('schegent.workflows')
        ) {
          const reload = loadAndReportCatalog(catalogReader, logger, workflowConfigReader);
          activeCatalog = reload.catalog;
          activePhasePrecedence = reload.phasePrecedence;
          activePhaseCatalog = reload.phaseCatalog;
          activePipelineCatalog = reload.pipelineCatalog;
          activeWorkflowCatalog = reload.workflowCatalog;
          controller.setCatalog(activeCatalog);
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

  const sidebarRouter = new MessageRouter({
    executeCommand: (id, ...args) => vscode.commands.executeCommand(id, ...args),
    queueRemover: queue,
    queueOps: queue,
    phaseOps: controller,
    // Feature FR-R3-003 (T300) — the fenced record, not the mirror. `Memento` is
    // per extension host, so `!isForeignLockHeld()` could only ever read a lock
    // this window wrote: a reclaimed window kept answering `true` and kept
    // admitting mutating commands. `hasPrimacy()` carries the fencing token
    // issued at acquisition and fails closed.
    isPrimary: () => lock.hasPrimacy(),
    // Workspace-trust gate (defense-in-depth alongside the primary-host
    // gate). Mutating IPC is rejected when VS Code reports the workspace
    // is not trusted, blocking malicious workspaces from triggering
    // `CMD_SAVE_*` even if the operator clicks through the sidebar.
    isTrusted: () => vscode.workspace.isTrusted,
    notifyWarning: (message) => notifier.warn(`Schegent: ${message}.`),
    logger,
    audit: auditWriter,
    updateConfig: async (key, value, scope = 'workspace') => {
      const config = vscode.workspace.getConfiguration('schegent', vscode.Uri.file(workspaceRoot));
      await config.update(
        key,
        value,
        scope === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace
      );
    },
    readPhaseConfig: () => ({ user: catalogReader.getPhases('user') ?? [],
      workspace: catalogReader.getPhases('workspace') ?? [] }),
    readPipelineConfig: () => ({ user: catalogReader.getPipelines('user') ?? [],
      workspace: catalogReader.getPipelines('workspace') ?? [] }),
    // Feature 083 — read fresh per save so the revision gate compares against the
    // layer as it stands now, not as it stood when the catalog last resolved.
    readWorkflowConfig: () => readWorkflowLayers(workflowConfigReader),
    // Feature 096 — Model Catalog's one writable layer is 'workspace' (research.md
    // Decision 6), so this reads that scope only, fresh per call, same reason as
    // readWorkflowConfig above — not activeCatalog.models, which is the merged
    // user+workspace view and would let the revision gate react to a layer this
    // command never writes.
    readModelsConfig: () => coerceModels(catalogReader.getModels('workspace')),
    getCatalog: () => activeCatalog,
    guardedRun: guardedRunService,
    defaultRunnerKind: backendKind,
    // Feature 082 (US7, FR-022a) / 083 (FR-041) — the consumer side of the
    // Pipeline removal gate, from the same collector that feeds the Library's
    // consuming-Workflow list (FR-002) so the two can never disagree about who
    // a consumer is.
    readWorkflowPipelineRefs: collectAllWorkflowPipelineRefs,
    // Feature 091 (T014, FR-010/FR-011) — the supply the command router was
    // declared to take and never received, so every `prior-output` reference
    // refused as `prior-run-not-found` regardless of what the Run recorded.
    //
    // `outputsFor` keeps the two FR-011 answers apart: `null` for a Run this
    // host cannot find, `[]` for a Run it found that recorded nothing. The
    // distinction lives in the store rather than in this expression precisely
    // because a `?.`-and-`?? null` written here is one edit away from
    // collapsing it.
    readPriorRunOutputs: (runId) => historyStore.outputsFor(runId),
    connectedRuns,
    // Feature 011 — typed transactional writer used by CMD_SAVE_GENERAL_SETTINGS.
    // Feature 019 — on success that touches a runtime-log key, clear
    // the sink's suppression for both the previous and the new
    // resolved paths so an operator's correction unlocks the next emit
    // without extension reload.
    writeGeneralSettings: async (updates) => {
      const config = vscode.workspace.getConfiguration(
        'schegent',
        vscode.Uri.file(workspaceRoot)
      );
      const previousPath = runtimeLogAccessor.read()?.path ?? null;
      return writeGeneralSettings(
        config as unknown as GeneralSettingsConfig,
        updates,
        {
          onRuntimeLogSettingChanged: () => {
            // Feature 056 Track 9 — clear ALL tracked paths so a save
            // of `logging.runtimeLogMaxBytes` /
            // `logging.runtimeLogMaxGenerations` also drops the lazy
            // `bytesOnDisk` seed for every path; the next emit
            // re-stats the file under the new policy. Safe because
            // the only state we drop is recoverable on the next emit.
            runtimeLogSink.clearAllSuppression();
            // Belt-and-suspenders: clear the previous path even if the
            // save changed only the path key. clearAllSuppression()
            // above already cleared everything, but the explicit calls
            // are kept for clarity should the all-clear be narrowed
            // again in a future refactor.
            runtimeLogSink.clearSuppression(previousPath);
            const nextPath = runtimeLogAccessor.read()?.path ?? null;
            if (nextPath && nextPath !== previousPath) {
              runtimeLogSink.clearSuppression(nextPath);
            }
          }
        }
      );
    },
    // Feature 063 — `CMD_SET_CONFIRM_SUPPRESSION` persistence. The
    // handler validates the action key against `KNOWN_ACTION_KEYS`
    // before calling this; we just write through to the memento and
    // let the projector pick up the change on its next push.
    setConfirmSuppression: async (actionKey, suppressed) => {
      await store.setConfirmSuppression(actionKey, suppressed);
      projector.kick();
    },
    dismissMigrationNotice: async () => {
      // FR-R3-002 (T280) — named explicitly. `composeWorkflowSnapshot` reads
      // `migrationNotice` off the Default queue, so the dismissal has to write
      // the entry the notice is rendered from or the banner never clears.
      const changed = await store.updateQueue((cur) => ({
        queue: cur.migrationNotice === 'pending'
          ? { ...cur, migrationNotice: 'dismissed', updatedAt: Date.now() }
          : cur,
        result: cur.migrationNotice === 'pending'
      }), DEFAULT_QUEUE_ID);
      if (!changed) return;
      projector.kick();
    },
    // Feature 020 — phase-log read adapter. Resolves the selection
    // tuple against the projector snapshot, threads sanitize +
    // verbose-setting reader, returns the typed wire-format response.
    // Sanitization happens once at the IPC boundary inside
    // `readIterationManifest`; on-disk bytes are never altered (010
    // T10). Caps default to 4 KiB per field / 500 entries (T029).
    phaseLogService: createPhaseLogService({
      workspaceRoot,
      sanitize: (s) => logger.sanitize(s),
      readVerboseSetting: () =>
        vscode.workspace
          .getConfiguration('schegent.logging', vscode.Uri.file(workspaceRoot))
          .get<boolean>('verbose') === true,
      getSnapshot: () => projector.getCurrentSnapshot(),
      // Feature 020 BUG-001 — resolve FeatureRequest.id (the task id
      // visible in the webview) to FeatureRequest.runId (the UUID that
      // names the .schegent/sessions/<runId>/ directory on disk). These
      // are distinct UUIDs: the former is generated at enqueue time,
      // the latter at workflow-start time (WorkflowRun.id).
      resolveRunId: (taskId) => queue.findById(taskId)?.runId ?? null
    }),
    // Feature 020 — phase-log tail adapter (T049). Validates the
    // selection against the current snapshot (`not-in-flight` if the
    // task or phase has moved on) before delegating to the registry.
    phaseLogTailService: phaseLogTail.phaseLogTailService,
    // Feature 084 — Phase export adapter (FR-018, FR-019, research R3).
    // Mirrors `src/commands/export-audit.ts`: the host owns the dialog and the
    // write, so no location crosses the IPC boundary in either direction. The
    // dialog seeds its name field from the workspace root and the suggested
    // name; where the operator actually saves is never returned, logged, or
    // audited. Overwrite consent is the dialog's own (FR-018).
    saveProcessYamlDocument: async ({ suggestedFileName, text }) => {
      try {
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(workspaceRoot, suggestedFileName)),
          filters: { YAML: ['yaml', 'yml'] },
          saveLabel: 'Export document'
        });
        if (!target) return { outcome: 'canceled' as const };
        await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
        return { outcome: 'saved' as const };
      } catch (err) {
        logger.warn(
          `extension: phase export write failed: ${logger.sanitize(
            (err as Error).message ?? 'unknown error'
          )}`
        );
        return { outcome: 'failed' as const, message: 'Could not write the document.' };
      }
    },
    // Feature 084 — Phase import preflight adapter (FR-020, FR-020a, R3).
    // The host owns the dialog and the read; the webview supplies no location
    // and is told none. Reads the chosen file exactly once and returns the raw
    // bytes: decoding is the parser's job, because invalid UTF-8 and a leading
    // byte-order mark are refusals this format states rather than repairs.
    // Nothing is locked, watched, copied, or retained past this call (FR-031).
    openProcessYamlDocument: async () => {
      try {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          defaultUri: vscode.Uri.file(workspaceRoot),
          filters: { YAML: ['yaml', 'yml'] },
          openLabel: 'Inspect document'
        });
        const target = picked?.[0];
        if (!target) return { outcome: 'canceled' as const };
        const bytes = await vscode.workspace.fs.readFile(target);
        return { outcome: 'read' as const, bytes };
      } catch (err) {
        logger.warn(
          `extension: phase import read failed: ${logger.sanitize(
            (err as Error).message ?? 'unknown error'
          )}`
        );
        return { outcome: 'failed' as const, message: 'Could not read the document.' };
      }
    },
    // Feature 073 — metrics read adapter. Full-file scan of
    // `.schegent/audit.log` on every CMD_READ_METRICS call (T009/T010).
    // Workspace root reaches the reader only via this closure — the
    // handler never resolves it directly.
    metricsService: {
      read: (req) => readMetrics(workspaceRoot, req, logger)
    },
    // FR-R3-010 — history evidence drill-down. Same shape as the metrics
    // adapter above and for the same reason: the workspace root reaches the
    // corpus reader through this closure and nowhere else.
    historyEvidenceService: new HistoryEvidenceService({
      historyStore,
      resolver: new AuditPointerResolver({ workspaceRoot, logger }),
      evidenceHealth
    }),
    // Feature 073 — existing session-scoped correlation id, reused (not
    // newly minted) for the metrics-view-opened audit payload
    // (contracts/metrics-view-opened-event.md).
    sessionId: ownerId,
    metricsViewOpenedState,
    backendPingService: backendPing
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
    getCatalog: () => activeCatalog,
    controller,
    queue,
    lock,
    historyStore,
    getWorkspaceFolders: () => vscode.workspace.workspaceFolders
  });
  phaseLogTail.bindDashboardBridge(uiWiring.dashboardBridge);
  output.log(`activated; cli=${cliPath}, cap=${iterationCap}, pollIntervalMin=${pollIntervalMinutes}`);

  await watchdog.reattachOnActivation();

  // Feature 011 FR-013 — restart handshake. If the persisted run has a
  // pending delayed-retry deadline, re-arm the watchdog (or resume
  // immediately if it has already elapsed).
  await controller.resumeExistingFromActivation();

  // Stage 2 always reclaims the workspace lock if the prior holder is gone or the lock is
  // stale. This decouples primary-window status from run-resumption: even when no run is
  // persisted, this window must be primary so the sidebar mounts as enabled. See plan.md
  // "Activation Lifecycle" rule and FR-041(c).
  const lockResult = await lock.tryAcquire();
  // Feature 093 (T037/T039) — C-4 aggregate. A window that crashed mid-
  // concurrency persisted several Runs, and each is re-armed on the queue that
  // owns it. With one entry this is the previous behavior exactly.
  if (lockResult.acquired) {
    for (const [queueId, persistedRun] of Object.entries(store.getRunMap())) {
      if (persistedRun.status !== 'running') continue;
      logger.info(`activation: resuming run ${persistedRun.id} at ${persistedRun.currentPhase}`);
      void controller.resumeExisting(queueId);
    }
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

function createCatalogReader(workspaceRoot: string): CatalogConfigReader {
  return {
    getPhases(scope) {
      const inspect = vscode.workspace
        .getConfiguration('schegent', vscode.Uri.file(workspaceRoot))
        .inspect<readonly unknown[]>('phases');
      if (!inspect) return undefined;
      return scope === 'workspace' ? inspect.workspaceValue : inspect.globalValue;
    },
    getPipelines(scope) {
      const inspect = vscode.workspace
        .getConfiguration('schegent', vscode.Uri.file(workspaceRoot))
        .inspect<readonly unknown[]>('pipelines');
      if (!inspect) return undefined;
      return scope === 'workspace' ? inspect.workspaceValue : inspect.globalValue;
    },
    getModels(scope) {
      const inspect = vscode.workspace
        .getConfiguration('schegent', vscode.Uri.file(workspaceRoot))
        .inspect<readonly unknown[]>('models');
      if (!inspect) return undefined;
      return scope === 'workspace' ? inspect.workspaceValue : inspect.globalValue;
    },
    getDefaultPipelineId(scope) {
      const inspect = vscode.workspace
        .getConfiguration('schegent', vscode.Uri.file(workspaceRoot))
        .inspect<string>('defaultPipelineId');
      if (!inspect) return undefined;
      return scope === 'workspace'
        ? inspect.workspaceValue
        : inspect.globalValue ?? inspect.defaultValue;
    }
  };
}

export function deactivate(): void {
  // disposables registered to context.subscriptions will run automatically.
  // Feature 058 — release the workspace-folder-picker subscription and clear
  // its memoized canonical folder so a fresh activation rebuilds from a clean
  // state. Idempotent and never throws.
  disposeWorkspaceFolderPicker();
}
