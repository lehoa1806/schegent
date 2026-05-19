import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsPromises } from 'node:fs';
import { WorkspaceStateStore } from './state/workspace-state';
import { WorkspaceLockManager } from './state/lock';
import {
  getCanonicalWorkspaceRoot,
  disposeWorkspaceFolderPicker
} from './state/workspace-folder-picker';
import { maybeShowMultiRootWarning } from './state/multi-root-warning';
import { initCapabilityTrustResolver } from './state/capability-trust-resolver';
import { QueueManager } from './queue/queue-manager';
import { resetPromptTransportCache } from './runner/claude-cli';
import { createBackendRunner, resolveBackendKind } from './runner/backend-runner-factory';
import { PromptBuilder } from './runner/prompt-builder';
import { PhaseRunner } from './controller/phase-runner';
import { SchegentWorkflowController } from './controller/workflow-controller';
import { QueueScheduleWatchdog } from './controller/schedule-watchdog';
import { CreditWatchdog } from './watchdog/credit-watchdog';
import { AuditLogWriter } from './audit/audit-log-writer';
import { RawTranscriptWriter } from './audit/raw-transcript-writer';
import { SanitizedLogger } from './lib/logger';
import {
  RuntimeLogSink,
  createRuntimeLogAccessor
} from './lib/runtime-log';
import { SchegentOutputChannel } from './ui/output-channel';
import { SchegentStatusBar } from './ui/status-bar';
import { Notifier } from './ui/notifications';
import { runAuto } from './commands/auto';
import { runEnqueue } from './commands/enqueue';
import { runSchedule } from './commands/schedule';
import { runResume } from './commands/resume';
import { runCancel } from './commands/cancel';
import { runRestartCanceledTask } from './commands/restart-canceled-task';
import { runReset } from './commands/reset';
import { runShowAuditLog } from './commands/show-audit';
import {
  runRetryQueuedItem,
  runMoveQueuedItemUp,
  runMoveQueuedItemDown,
  runClearCompleted,
  runClearFailed,
  runPauseQueue,
  runResumeQueue
} from './commands/queue-ops';
import { runRerunFromHistory } from './commands/rerun-from-history';
import { runShowActiveRun } from './commands/show-active-run';
import { runOpenDashboard } from './commands/open-dashboard';
import { runRetryActiveRun } from './commands/retry-active-run';
import { runRetryPhaseNow } from './commands/retry-phase-now';
import { DashboardBridge } from './ui/dashboard/dashboard-bridge';
import { StateProjector } from './ui/sidebar/state-projector';
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
import { FileInitialTailReader } from './ui/sidebar/initial-tail-reader';
import { PlaceholderProjector } from './ui/sidebar/placeholder-projector';
import { ClaudeCliMonitor } from './monitor/claude-cli-monitor';
import { TelemetrySamplerImpl } from './telemetry/telemetry-sampler';
import { psShellOut } from './telemetry/platform/platform-ps';
import { windowsShellOut } from './telemetry/platform/platform-windows';
import type { TelemetrySnapshot } from './telemetry/telemetry-snapshot';
import { RATE_LIMIT_MATCHERS } from './parser/credit-error-detector';
import { HistoryStore } from './state/history-store';
import { loadCatalog, type CatalogConfigReader } from './config/pipeline-config-loader';
import { projectPhasePrecedence } from './config/phase-precedence';
import type { PipelineCatalog } from './config/pipeline-config';
import { GuardedRunService } from './services/guarded-run-service';
import {
  createPhaseLogService,
  PhaseLogTailRegistry,
  type PhaseLogTailSubscriptionToken,
  type PhaseLogTailRegistryAuditEvent
} from './services/phase-log';
import type {
  PhaseLogEntryPushMessage,
  StartPhaseLogTailRequest,
  StartPhaseLogTailResponse,
  StopPhaseLogTailRequest,
  StopPhaseLogTailResponse
} from './contracts/sidebar-ipc';
import { DaemonManager, defaultCommandRunner } from './wakeup/daemon-manager';
import { installerFactory } from './wakeup/platforms/installer-registry';
import { InvocationLog } from './wakeup/invocation-log';
import { createSaveWakeUpSettingsHandler } from './wakeup/save-handler';
import { createManualWakeUpTrigger } from './wakeup/manual-trigger';
import { activateWakeUp, deactivateWakeUp, type ActivationDeps as WakeUpActivationDeps } from './wakeup/activation';
import { readSettings as readWakeUpSettings, type WakeUpConfig } from './wakeup/settings';
import { readSessionBlock } from './wakeup/session-log-reader';
import type { ReadWakeupSessionLogResponse } from './contracts/sidebar-ipc';

interface Stage2Wiring {
  readonly disposables: readonly vscode.Disposable[];
  dispose(): Promise<void>;
}

// Feature 014 — tracked at module scope so the top-level `deactivate()`
// hook can invoke `deactivateWakeUp(...)` without re-resolving deps. The
// per-extension-instance reference is replaced on each Stage 2 wire and
// cleared on tear-down.
let activeWakeUpDeps: WakeUpActivationDeps | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new SanitizedLogger();
  const ownerId = `schegent-${process.pid}-${randomUUID().slice(0, 8)}`;

  // Feature 019 — Runtime debug log sink. Wired in Stage 1 so DEBUG records
  // captured before Stage 2 wiring (or in workspace-less hosts) are routed
  // through the same filter / suppression machinery. The accessor reads
  // settings per emit, so toggles in `settings.json` apply on the next
  // emit without extension reload.
  // Allowed roots for absolute `runtimeLogFilePath` values. Computed
  // lazily because workspace folders can change after activation.
  // `globalStorageUri` is per-extension and persistent; the OS tmpdir
  // and operator's home directory are stable for the process lifetime.
  // Anything outside these four roots is rejected at read time —
  // closes the gap where a malicious workspace settings file could
  // target `/etc/passwd.log` or another sensitive location.
  const runtimeLogAccessor = createRuntimeLogAccessor(
    () => vscode.workspace.getConfiguration('schegent'),
    () => getCanonicalWorkspaceRoot()?.uri.fsPath ?? null,
    logger,
    () => {
      const roots: string[] = [];
      const wsRoot = getCanonicalWorkspaceRoot()?.uri.fsPath;
      if (wsRoot) roots.push(wsRoot);
      roots.push(context.globalStorageUri.fsPath);
      try {
        roots.push(os.tmpdir());
      } catch {
        // tmpdir is documented to throw on some embedded platforms.
      }
      try {
        roots.push(os.homedir());
      } catch {
        // homedir can throw if the OS user has no home.
      }
      return roots;
    }
  );
  const runtimeLogSink = new RuntimeLogSink({
    accessor: runtimeLogAccessor,
    fallbackLogger: logger
  });
  logger.addSink(runtimeLogSink);

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
      onInitFailure: () => {
        const replacement = new PlaceholderProjector({ reason: 'init-failed' });
        activePlaceholder.dispose();
        activePlaceholder = replacement;
        sidebarProvider.setProjector(replacement);
      },
      runtimeLogSink,
      runtimeLogAccessor
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
  readonly onInitFailure: () => void;
  readonly runtimeLogSink: RuntimeLogSink;
  readonly runtimeLogAccessor: ReturnType<typeof createRuntimeLogAccessor>;
}

async function wireStage2(inputs: Stage2Inputs): Promise<Stage2Result | null> {
  const {
    context,
    logger,
    ownerId,
    workspaceRoot,
    onInitFailure,
    runtimeLogSink,
    runtimeLogAccessor
  } = inputs;
  const disposables: vscode.Disposable[] = [];

  const channel = vscode.window.createOutputChannel('Schegent');
  disposables.push(channel);
  const output = new SchegentOutputChannel(channel, logger);

  const store = new WorkspaceStateStore({
    get: <T>(key: string) => context.workspaceState.get<T>(key),
    update: (key, value) => context.workspaceState.update(key, value)
  }, logger);

  // Feature 030 — `initialize()` returns the v5 → v6 migration audit events;
  // they are forwarded through `auditWriter.append` once the writer exists
  // (constructed below). Empty array when no migration occurred.
  let v6MigrationEvents: readonly import('./state/queue-state-migrator').StateMigratedV5ToV6AuditEvent[] = [];
  let runRepairEvents: readonly import('./state/workflow-run-migrator').WorkflowRunRepairedAuditEvent[] = [];
  try {
    const initResult = await store.initialize();
    v6MigrationEvents = initResult.v6MigrationEvents;
    runRepairEvents = initResult.runRepairEvents;
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Schegent: ${(err as Error).message}`,
      'Open Reset Command'
    );
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
  const inheritProcessEnv = config.get<boolean>('cli.inheritEnvironment', true);
  const iterationCap = config.get<number>('loop.maxIterations', 10);
  const pollIntervalMinutes = config.get<number>('watchdog.pollIntervalMinutes', 30);
  const timeoutSeconds = config.get<number>('invocation.timeoutSeconds', 1800);
  const rotationSizeMB = config.get<number>('audit.rotation.sizeMB', 5);
  const rotationMaxAgeDays = config.get<number>('audit.rotation.maxAgeDays', 30);
  const rulesPerPhase = config.get<boolean>('rules.injectPerPhase', false);

  const catalogReader: CatalogConfigReader = createCatalogReader(workspaceRoot);
  const initialLoad = loadAndReportCatalog(catalogReader, logger);
  let activeCatalog: PipelineCatalog = initialLoad.catalog;
  // Feature 026 — cached per-phase precedence projection. Re-computed
  // each time `schegent.phases` (etc.) change. UI-only — never persisted.
  let activePhasePrecedence: import('./config/phase-precedence').PhasePrecedenceProjection =
    initialLoad.phasePrecedence;

  const lock = new WorkspaceLockManager(store, ownerId);

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  disposables.push(statusBarItem);
  const statusBar = new SchegentStatusBar(statusBarItem);

  const notifier = new Notifier({
    showInformationMessage: (m) => vscode.window.showInformationMessage(m),
    showWarningMessage: (m) => vscode.window.showWarningMessage(m),
    showErrorMessage: (m) => vscode.window.showErrorMessage(m)
  });

  const queue = new QueueManager(store, logger);
  const auditWriter = new AuditLogWriter(
    {
      workspaceRoot,
      rotationSizeBytes: rotationSizeMB * 1024 * 1024,
      rotationMaxAgeMs: rotationMaxAgeDays * 24 * 60 * 60 * 1000
    },
    logger
  );

  // Feature 030 — forward any v5 → v6 migration audit events through the
  // sanitized `auditWriter.append` pipeline. Empty array when no migration
  // occurred (fresh workspace OR already-v6 state).
  for (const event of v6MigrationEvents) {
    try {
      await auditWriter.append({
        runId: '',
        phase: 'state-migration',
        iteration: 0,
        eventType: event.type,
        payload: {
          fromVersion: event.fromVersion,
          toVersion: event.toVersion,
          sourceQueueCount: event.sourceQueueCount,
          pendingTaskCount: event.pendingTaskCount,
          inFlightTaskCount: event.inFlightTaskCount,
          inheritedPausedState: event.inheritedPausedState,
          coalesceRule: event.coalesceRule
        },
        outcome: 'success'
      });
    } catch (err) {
      logger.warn(`state-migrated audit append failed: ${(err as Error).message}`);
    }
  }
  for (const event of runRepairEvents) {
    try {
      await auditWriter.append({
        runId: event.runId,
        phase: 'state-migration',
        iteration: 0,
        eventType: event.type,
        payload: {
          pipelineId: event.pipelineId,
          repair: event.repair,
          removedPhaseCount: event.removedPhaseCount,
          removedBreakpointCount: event.removedBreakpointCount,
          remainingPhaseCount: event.remainingPhaseCount
        },
        outcome: 'success'
      });
    } catch (err) {
      logger.warn(`workflow-run-repaired audit append failed: ${(err as Error).message}`);
    }
  }

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

  const monitor = new ClaudeCliMonitor({
    stallThresholdMs: 90_000,
    rateLimitMatchers: RATE_LIMIT_MATCHERS,
    monotonicNow: () => {
      const perf = (globalThis as { performance?: { now: () => number } }).performance;
      return perf ? perf.now() : Date.now();
    },
    now: () => new Date(),
    audit: auditWriter,
    logger
  });
  // Feature 033 — TelemetrySampler. Polls the active subprocess every 2 s
  // via `ps` (macOS / Linux) or `powershell.exe` (Windows), feeds parsed
  // snapshots into `stateProjector.updateTelemetry()`. Constructed BEFORE
  // the runner so the monitor-hook callback below can call
  // `sampler.start()` / `sampler.stop()` from the `started` / `exited`
  // events. `onSample` defers to the projector via a thunk because the
  // projector is constructed later in this activation.
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
  context.subscriptions.push({ dispose: () => sampler.dispose() });
  // Feature 034 Item 050 — backend selection. The factory picks the
  // concrete `BackendRunner` based on `schegent.backend.runner`. Default is
  // `'claude'`; unknown values collapse to the default with a WARN log.
  const backendKind = resolveBackendKind(
    vscode.workspace.getConfiguration('schegent.backend').get<string>('runner'),
    logger
  );
  const cliRunner = createBackendRunner(backendKind, {
    monitorHook: (event) => {
      if (event.kind === 'started') {
        monitor.onSpawnPid(event.pid);
        if (event.pid !== null) {
          sampler.start(event.pid, Date.now());
        }
      } else if (event.kind === 'stdout-chunk') {
        monitor.onStdoutChunk(event.chunk);
      } else if (event.kind === 'stderr-chunk') {
        monitor.onStderrChunk(event.chunk);
      } else if (event.kind === 'exited') {
        monitor.onExit({
          exitCode: event.exitCode,
          signal: event.signal,
          killed: event.killed,
          timedOut: event.timedOut
        });
        sampler.stop({ signal: event.signal as NodeJS.Signals | null });
      }
    },
    // Feature 013 Wave 8 (US8): probe `claude --help` once per activation
    // to pick the safest available prompt transport. Falls back to `-p`
    // when the CLI doesn't advertise `--prompt-file` / `--prompt-stdin`.
    // Only relevant for the Claude adapter; Codex ignores this flag.
    probeTransport: true,
    logger
  });
  const historyStore = new HistoryStore(store);
  const promptBuilder = new PromptBuilder();
  const rawTranscript = new RawTranscriptWriter(workspaceRoot, logger);
  // Feature 010 FR-024: read schegent.logging.verbose on every invocation
  // — never cached on a long-lived object — so toggling mid-run applies
  // to the next phase invocation.
  const verboseAccessor = {
    isVerboseDiagnosticsEnabled: () =>
      vscode.workspace
        .getConfiguration('schegent', vscode.Uri.file(workspaceRoot))
        .get<boolean>('logging.verbose', false)
  };
  // Feature 011 FR-033: read schegent.fatalSignatures on every invocation.
  // Goes through the same general-settings validator so a malformed
  // workspace value degrades gracefully to the built-in floor.
  const fatalSignaturesAccessor = {
    readOperatorAdditions: () =>
      readFatalSignaturesSetting(
        vscode.workspace.getConfiguration('schegent', vscode.Uri.file(workspaceRoot))
      )
  };
  // Feature 012 FR-006: read schegent.claude.autoCompactPctOverride on every
  // invocation — never cached on the runner — so toggling mid-run applies
  // to the next phase invocation.
  const autoCompactOverrideAccessor = createAutoCompactOverrideAccessor(
    () => vscode.workspace.getConfiguration('schegent', vscode.Uri.file(workspaceRoot)),
    logger
  );
  // Feature 028 — US2: re-read `WorkflowRun.phaseBreakpoints` at every
  // phase dispatch boundary (never cached on the runner) so a breakpoint
  // added via the sidebar mid-run applies to the very next phase
  // invocation. The closure pulls the live run from the workspace store
  // — same no-cache contract as the settings accessors above.
  const phaseBreakpointAccessor = createPhaseBreakpointAccessor(() => store.getRun());
  const phaseRunner = new PhaseRunner(
    cliRunner,
    promptBuilder,
    auditWriter,
    logger,
    rawTranscript,
    verboseAccessor,
    fatalSignaturesAccessor,
    autoCompactOverrideAccessor,
    null,
    phaseBreakpointAccessor
  );

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
      inheritProcessEnv,
      perPhaseRulesEnabled: rulesPerPhase
    },
    {
      monitor,
      historyStore,
      catalog: activeCatalog,
      auditWriter,
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
      }
    }
  );

  const guardedRunService = new GuardedRunService({
    lock,
    queue,
    controller,
    logger,
    audit: auditWriter,
    store,
    cliPathProvider: () => cliPath,
    workspaceRoot
  });

  const watchdog = new CreditWatchdog(
    cliRunner,
    store,
    statusBar,
    logger,
    {
      pollIntervalMs: pollIntervalMinutes * 60 * 1000,
      cliPath,
      cwd: workspaceRoot,
      timeoutMs: 60 * 1000
    },
    async () => {
      await controller.resumeExisting();
    }
  );

  // Feature 011 — late-inject the watchdog now that both are constructed.
  // The watchdog's resume callback closes over `controller`, so it has to
  // be built after the controller; the controller's delayed-retry path
  // calls `watchdog.pauseAndPoll(...)` so we wire it back here.
  controller.setWatchdog(watchdog);

  const queueScheduleWatchdog = new QueueScheduleWatchdog({
    getRegistry: () => store.getQueueRegistry(),
    queue,
    drain: () => controller.drainQueuedWork(),
    isPrimary: () => lock.isHeld(),
    logger,
    audit: auditWriter
  });
  queueScheduleWatchdog.start();

  controller.setRateLimitHandler(async (cause) => {
    notifier.info(`Schegent: paused (${cause}). Watchdog will poll every ${pollIntervalMinutes} min.`);
    await watchdog.pauseAndPoll(cause);
  });

  // Feature 014/024 — Wake up wiring. The same user-data wakeup
  // directory backs scheduler settings, runner mirrors, manual
  // invocations, and the newest-attempts snapshot projection.
  const wakeUpHomeDir = vscode.Uri.joinPath(context.globalStorageUri, 'wakeup').fsPath;
  const wakeUpRunnerPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'wakeup-runner.js').fsPath;
  const wakeUpInvocationLog = new InvocationLog(wakeUpHomeDir);
  const wakeUpDaemonManager = new DaemonManager({
    installerFactory,
    commandRunner: defaultCommandRunner()
  });
  const readWakeUpConfig = (): WakeUpConfig =>
    vscode.workspace.getConfiguration('schegent') as unknown as WakeUpConfig;
  const getWorkspaceRoots = (): readonly string[] =>
    (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const saveWakeUpHandler = createSaveWakeUpSettingsHandler({
    readConfig: readWakeUpConfig,
    daemonManager: wakeUpDaemonManager,
    workspaceRoots: getWorkspaceRoots,
    sourceRunnerPath: wakeUpRunnerPath,
    homeDir: wakeUpHomeDir,
    audit: auditWriter as unknown as Parameters<typeof createSaveWakeUpSettingsHandler>[0]['audit'],
    sanitize: (msg) => logger.sanitize(msg)
  });
  const wakeUpNow = createManualWakeUpTrigger({
    readConfig: readWakeUpConfig,
    workspaceRoots: getWorkspaceRoots,
    sourceRunnerPath: wakeUpRunnerPath,
    homeDir: wakeUpHomeDir,
    sanitize: (msg) => logger.sanitize(msg)
  });

  const projector = new StateProjector({
    store,
    audit: auditWriter,
    ownerId,
    initialTailReader: new FileInitialTailReader(),
    logger,
    monitor,
    history: historyStore,
    getCatalog: () => activeCatalog,
    // Feature 011 — re-read scalar `schegent.*` settings on every
    // projection. The onDidChangeConfiguration listener below calls
    // `projector.kick()` for any schegent.* key so the Settings surface
    // is fresh within FR-017's 1s budget.
    getGeneralSettings: () =>
      readGeneralSettings(
        vscode.workspace.getConfiguration('schegent', vscode.Uri.file(workspaceRoot)) as unknown as GeneralSettingsConfig
      ),
    // Feature 014 (BUG-001 / BUG-002) — read the four `schegent.wakeUp.*`
    // settings from Global scope on every projection. The
    // `onDidChangeConfiguration` listener below already calls
    // `projector.kick()` for any `schegent.*` change, so wake-up edits
    // also surface within FR-017's 1s budget (mirrored by FR-025 /
    // SC-010).
    getWakeUpSettings: () =>
      readWakeUpSettings(
        vscode.workspace.getConfiguration('schegent') as unknown as WakeUpConfig
      ),
    getWakeUpLog: () => wakeUpInvocationLog.projectRecent((msg) => logger.sanitize(msg), 5),
    // Feature 031 — surface the wake-up `model` selection + the
    // host-composed session-log path on every snapshot. Both are
    // DISPLAY-ONLY; the webview never echoes the path back to the host
    // (the CMD_READ_WAKEUP_SESSION_LOG payload carries `correlationId`
    // only). Re-reading on every projection keeps the model dropdown in
    // sync with workspace edits within FR-017's 1s budget.
    getWakeupModel: () =>
      readWakeUpSettings(
        vscode.workspace.getConfiguration('schegent') as unknown as WakeUpConfig
      ).model,
    getWakeupSessionLogPath: () => path.join(wakeUpHomeDir, 'session.log'),
    // Feature 026 — UI-only per-phase precedence projection. Re-read on
    // every snapshot so a catalog reload triggered by
    // `onDidChangeConfiguration('schegent.phases')` reaches the webview
    // within the FR-017 1s budget. Never persisted; never logged.
    getPhasePrecedence: () => activePhasePrecedence
  });
  projector.start();
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
          event.affectsConfiguration('schegent.phases') ||
          event.affectsConfiguration('schegent.pipelines') ||
          event.affectsConfiguration('schegent.defaultPipelineId')
        ) {
          const reload = loadAndReportCatalog(catalogReader, logger);
          activeCatalog = reload.catalog;
          activePhasePrecedence = reload.phasePrecedence;
          controller.setCatalog(activeCatalog);
        }
        // Feature 011 — any schegent.* change triggers a re-projection
        // so the Settings surface reflects the new value within FR-017.
        if (event.affectsConfiguration('schegent')) {
          projector.kick();
        }
      })
    );
  }

  // Feature 020 — phase-log tail wiring (T049).
  //
  // The PhaseLogTailRegistry owns the cap-of-1 invariant per host and the
  // watcher mechanism (fs.watch vs polling) chosen at start time. Three
  // dispose paths converge here:
  //   1. webview-stop      — explicit CMD_STOP_PHASE_LOG_TAIL (handled in router)
  //   2. webview-dispose   — extension teardown via `disposables` below
  //   3. phase-complete    — the in-flight task transitioned out
  //
  // Path (3) is derived from a projector subscription that watches
  // `queue.inFlight.id` transitions and fires every registered
  // listener exactly once with the leaving runId.
  let previousInFlightTaskId: string | null =
    projector.getCurrentSnapshot().queue.inFlight?.id ?? null;
  const taskLeaveListeners = new Set<(runId: string) => void>();
  const taskLeaveProjectorSub = projector.subscribe((snapshot) => {
    const nextId = snapshot.queue.inFlight?.id ?? null;
    if (previousInFlightTaskId !== null && previousInFlightTaskId !== nextId) {
      const leavingId = previousInFlightTaskId;
      for (const listener of taskLeaveListeners) {
        try {
          listener(leavingId);
        } catch (err) {
          logger.debug(
            `phase-log-tail: task-leave listener threw: ${(err as Error).message}`
          );
        }
      }
    }
    previousInFlightTaskId = nextId;
  });
  disposables.push({ dispose: () => taskLeaveProjectorSub.dispose() });

  // Forward reference: the registry pushes through `dashboardBridge`,
  // which is constructed AFTER the router. The thunk resolves the
  // bridge at call time; pushes before the bridge exists are silently
  // dropped (the dashboard cannot be open yet).
  let dashboardBridgeRef: DashboardBridge | null = null;
  const phaseLogTailRegistry = new PhaseLogTailRegistry({
    pushToWebview: (envelope) => {
      const bridge = dashboardBridgeRef;
      if (bridge === null) return;
      bridge.postPhaseLogEntry(envelope as PhaseLogEntryPushMessage);
    },
    sanitize: (s) => logger.sanitize(s),
    appendAudit: async (event: PhaseLogTailRegistryAuditEvent) => {
      const p = event.payload;
      const auditPayload: Record<string, unknown> = {
        sessionId: p.sessionId,
        queueId: p.queueId,
        taskId: p.taskId,
        pipelineId: p.pipelineId,
        phaseId: p.phaseId,
        iterationN: p.iterationN,
        outcome: p.outcome
      };
      if (p.mechanism !== undefined) auditPayload.mechanism = p.mechanism;
      if (p.reason !== undefined) auditPayload.reason = p.reason;
      try {
        await auditWriter.append({
          runId: p.taskId,
          phase: p.phaseId,
          iteration: typeof p.iterationN === 'number' ? p.iterationN : 0,
          eventType: event.type,
          payload: auditPayload,
          outcome: p.outcome === 'success' ? 'success' : 'failure'
        });
      } catch (err) {
        logger.warn(
          `phase-log-tail: audit append failed: ${(err as Error).message}`
        );
      }
    },
    onTaskNoLongerInFlight: (cb): PhaseLogTailSubscriptionToken => {
      taskLeaveListeners.add(cb);
      return {
        dispose: () => {
          taskLeaveListeners.delete(cb);
        }
      };
    },
    caps: { perFieldBytes: 4096 }
  });
  disposables.push({
    dispose: () => {
      void phaseLogTailRegistry.disposeAll('webview-dispose');
    }
  });

  // Adapter: validate the selection against the current snapshot before
  // delegating to the registry. The "not-in-flight" failure surfaces a
  // typed wire-format reason so the webview can show the right empty
  // state instead of a generic internal-error.
  const phaseLogTailService = {
    start: async (
      req: StartPhaseLogTailRequest
    ): Promise<StartPhaseLogTailResponse> => {
      const snap = projector.getCurrentSnapshot();
      const inFlight = snap.queue.inFlight;
      if (inFlight === null || inFlight.id !== req.selection.taskId) {
        return { outcome: 'failure', reason: 'not-in-flight' };
      }
      if (inFlight.currentPhase !== req.selection.phaseId) {
        return { outcome: 'failure', reason: 'not-in-flight' };
      }
      return phaseLogTailRegistry.start({
        workspaceRoot,
        selection: {
          queueId: req.selection.queueId,
          // Feature 020 BUG-001 — same runId resolution as the read
          // path. The tail registry resolves filesystem paths from
          // taskId, so we substitute the actual session directory UUID.
          taskId: queue.findById(req.selection.taskId)?.runId ?? req.selection.taskId,
          pipelineId: req.selection.pipelineId,
          phaseId: req.selection.phaseId,
          iterationN: req.selection.iterationN
        }
      });
    },
    stop: async (
      req: StopPhaseLogTailRequest
    ): Promise<StopPhaseLogTailResponse> =>
      phaseLogTailRegistry.stop(req.sessionId, 'webview-stop')
  };

  const sidebarRouter = new MessageRouter({
    executeCommand: (id, ...args) => vscode.commands.executeCommand(id, ...args),
    queueRemover: queue,
    queueOps: queue,
    phaseOps: controller,
    isPrimary: () => !lock.isForeignLockHeld(),
    // Workspace-trust gate (defense-in-depth alongside the primary-host
    // gate). Mutating IPC is rejected when VS Code reports the workspace
    // is not trusted, blocking malicious workspaces from triggering
    // `CMD_SAVE_*` even if the operator clicks through the sidebar.
    isTrusted: () => vscode.workspace.isTrusted,
    notifyWarning: (message) => notifier.warn(`Schegent: ${message}.`),
    logger,
    audit: auditWriter,
    updateConfig: async (key, value) => {
      const config = vscode.workspace.getConfiguration('schegent', vscode.Uri.file(workspaceRoot));
      await config.update(key, value, vscode.ConfigurationTarget.Workspace);
    },
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
    // Feature 014 — Wake up save protocol (primary-only; transactional).
    saveWakeUpSettings: async (payload) => saveWakeUpHandler(payload),
    wakeUpNow,
    onWakeUpNowComplete: () => projector.kick(),
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
    phaseLogTailService,
    // Feature 031 T036 — wake-up session-log read adapter. The
    // session-log path is host-owned (composed from
    // `<globalStorageUri>/wakeup/session.log`); operators NEVER supply
    // a path on the IPC wire. The adapter delegates to the pure reader
    // in `src/wakeup/session-log-reader.ts` with the host's
    // `SanitizedLogger.sanitize` callback so `SECRET_PATTERNS` remains
    // the SINGLE redaction source at the IPC boundary.
    wakeupSessionLogService: {
      read: async (req): Promise<ReadWakeupSessionLogResponse> => {
        const sessionLogPath = path.join(wakeUpHomeDir, 'session.log');
        const result = await readSessionBlock(
          req.correlationId,
          sessionLogPath,
          (s) => logger.sanitize(s)
        );
        if (result.outcome === 'success') {
          return {
            status: 'success',
            correlationId: req.correlationId,
            capturedAtMs: result.header.capturedAtMs,
            trigger: result.header.trigger,
            model: result.header.model,
            outcome: result.header.outcome,
            body: result.body,
            bodyTruncated: result.bodyTruncated,
            fullBlockBytesOnDisk: result.fullBlockBytesOnDisk
          };
        }
        return { status: 'rejected', reason: result.outcome };
      }
    },
    // Feature 031 T050 — wake-up session-log reveal adapter. Path
    // composition mirrors `wakeupSessionLogService.read` (single source
    // of truth — same `<globalStorageUri>/wakeup/session.log`
    // convention). Webview supplies NO path. The handler stat-checks
    // the file (absent → 'session-log-unavailable') then delegates to
    // VS Code's `revealFileInOS` command. All other failures collapse
    // to `'reveal-failed'`.
    revealWakeupSessionLog: async () => {
      const sessionLogPath = path.join(wakeUpHomeDir, 'session.log');
      try {
        await fsPromises.stat(sessionLogPath);
      } catch {
        return { status: 'rejected' as const, reason: 'session-log-unavailable' as const };
      }
      try {
        await vscode.commands.executeCommand(
          'revealFileInOS',
          vscode.Uri.file(sessionLogPath)
        );
        return { status: 'success' as const };
      } catch (err) {
        logger.warn(
          `extension: wakeup session-log reveal failed: ${logger.sanitize(
            (err as Error).message ?? 'unknown error'
          )}`
        );
        return { status: 'rejected' as const, reason: 'reveal-failed' as const };
      }
    }
  });

  // Feature 014 — fire-and-forget reconcile + workspace-roots mirror on
  // activation. Errors are swallowed inside `activateWakeUp`; the
  // failure path emits a sanitized log line but does NOT block the
  // rest of Stage 2 (FR-024). The deps reference is hoisted to module
  // scope so the top-level `deactivate()` can call `deactivateWakeUp`.
  const wakeUpActivationDeps: WakeUpActivationDeps = {
    readConfig: readWakeUpConfig,
    daemonManager: wakeUpDaemonManager,
    workspaceRoots: getWorkspaceRoots,
    homeDir: wakeUpHomeDir,
    sourceRunnerPath: wakeUpRunnerPath,
    audit: auditWriter as unknown as WakeUpActivationDeps['audit'],
    logger
  };
  activeWakeUpDeps = wakeUpActivationDeps;
  void activateWakeUp(wakeUpActivationDeps);

  const queueOpsCtx = { queue, lock, notifier, logger };

  const dashboardBridge = new DashboardBridge({
    extensionRoot: context.extensionUri.fsPath,
    projector,
    dispatch: (cmd, ack) => sidebarRouter.dispatch(cmd, ack),
    logger
  });
  // Feature 020 — late-bind the registry's push thunk to the bridge.
  dashboardBridgeRef = dashboardBridge;

  disposables.push(
    vscode.commands.registerCommand('schegent.auto', (args) =>
      runAuto(args, {
        guardedRunService,
        store,
        audit: auditWriter,
        notifier,
        logger
      })
    ),
    // Feature 017 — BUG-003. Pure-enqueue host command. Dashboard
    // (`CMD_START`) dispatches here so a submission while the
    // controller is mid-pipeline lands as pending instead of being
    // rejected with `controller-already-running`.
    // BUG-002 (FR-012a) — fire-and-forget drain after successful
    // enqueue so the first submitted task starts automatically when
    // the queue is idle. The coordinator's capacity check
    // short-circuits safely when a run is already in-flight.
    vscode.commands.registerCommand('schegent.enqueue', async (args) => {
      const result = await runEnqueue(args, {
        guardedRunService,
        store,
        audit: auditWriter,
        logger,
        via: 'dashboard-submit',
        promptForInput: false
      });
      if (result?.result.outcome === 'enqueued') {
        void controller.drainQueuedWork().catch((err) =>
          logger.warn(`enqueue: auto-drain failed: ${(err as Error).message}`)
        );
      }
      return result;
    }),
    vscode.commands.registerCommand('schegent.schedule', (args) =>
      runSchedule(args, {
        guardedRunService,
        getCatalog: () => activeCatalog,
        notifier,
        logger
      })
    ),
    vscode.commands.registerCommand('schegent.resume', () =>
      runResume({ store, controller, lock, notifier, logger })
    ),
    // BUG-002 (FR-012a) — queue-start trigger. The webview
    // `CMD_START_QUEUE` handler delegates here. Promotes the oldest
    // pending task to in-flight when the queue is idle and no run is
    // active. Safe to call redundantly — the coordinator's internal
    // capacity checks short-circuit when a run is already in-flight.
    vscode.commands.registerCommand('schegent.startQueue', async () => {
      try {
        await controller.drainQueuedWork();
      } catch (err) {
        logger.warn(`startQueue: ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('schegent.cancel', (arg?: { taskId?: string }) =>
      runCancel({
        controller,
        store,
        queue,
        audit: auditWriter,
        lock,
        notifier,
        logger,
        taskId: typeof arg?.taskId === 'string' ? arg.taskId : undefined
      })
    ),
    vscode.commands.registerCommand(
      'schegent.restartCanceledTask',
      (arg?: { taskId?: string }) =>
        runRestartCanceledTask({
          store,
          queue,
          audit: auditWriter,
          notifier,
          logger,
          taskId: typeof arg?.taskId === 'string' ? arg.taskId : ''
        })
    ),
    vscode.commands.registerCommand('schegent.reset', () =>
      runReset({ store, notifier, logger })
    ),
    vscode.commands.registerCommand('schegent.showAuditLog', () =>
      runShowAuditLog({ workspaceRoot, notifier })
    ),
    vscode.commands.registerCommand('schegent.retryQueuedItem', (arg) =>
      runRetryQueuedItem(arg, queueOpsCtx)
    ),
    vscode.commands.registerCommand('schegent.moveQueuedItemUp', (arg) =>
      runMoveQueuedItemUp(arg, queueOpsCtx)
    ),
    vscode.commands.registerCommand('schegent.moveQueuedItemDown', (arg) =>
      runMoveQueuedItemDown(arg, queueOpsCtx)
    ),
    vscode.commands.registerCommand('schegent.clearCompleted', () =>
      runClearCompleted(queueOpsCtx)
    ),
    vscode.commands.registerCommand('schegent.clearFailed', () =>
      runClearFailed(queueOpsCtx)
    ),
    vscode.commands.registerCommand('schegent.pauseQueue', (arg) =>
      runPauseQueue(arg, queueOpsCtx)
    ),
    vscode.commands.registerCommand('schegent.resumeQueue', () =>
      runResumeQueue(queueOpsCtx)
    ),
    vscode.commands.registerCommand('schegent.rerunFromHistory', (arg) =>
      runRerunFromHistory(arg, {
        guarded: guardedRunService,
        history: historyStore,
        lock,
        notifier,
        logger
      })
    ),
    vscode.commands.registerCommand('schegent.showActiveRun', (arg) =>
      runShowActiveRun(arg, { notifier, logger })
    ),
    vscode.commands.registerCommand('schegent.openDashboard', (arg) =>
      runOpenDashboard(arg, {
        bridge: dashboardBridge,
        notifier,
        logger,
        getWorkspaceFolders: () => vscode.workspace.workspaceFolders
      })
    ),
    vscode.commands.registerCommand('schegent.retryActiveRun', (arg) =>
      runRetryActiveRun(arg, {
        store,
        controller,
        queue,
        history: historyStore,
        lock,
        guarded: guardedRunService,
        notifier,
        logger
      })
    ),
    vscode.commands.registerCommand('schegent.retryPhaseNow', (arg) =>
      runRetryPhaseNow(arg, { controller, lock, notifier, logger })
    ),
    vscode.commands.registerCommand('schegent.pausePhase', async () => {
      const result = await controller.pauseActivePhase();
      if (!result.ok) notifier.warn(`Schegent: pause phase rejected (${result.reason}).`);
    }),
    vscode.commands.registerCommand('schegent.resumePhase', async () => {
      const result = await controller.resumeActivePhase();
      if (!result.ok) notifier.warn(`Schegent: resume phase rejected (${result.reason}).`);
    }),
    vscode.commands.registerCommand('schegent.restartPhase', async () => {
      const result = await controller.restartActivePhase();
      if (!result.ok) notifier.warn(`Schegent: restart phase rejected (${result.reason}).`);
    }),
    // Feature 054 — operator escape hatch when the cached prompt
    // transport diverges from CLI reality (e.g. upgraded Claude CLI
    // mid-session). Read-only — does not mutate workspace state, so
    // not gated by MUTATING_COMMANDS.
    vscode.commands.registerCommand('schegent.redetectClaudeTransport', () => {
      resetPromptTransportCache();
      notifier.info(
        'Schegent: Claude CLI prompt transport will be re-detected on the next phase run.'
      );
    })
  );

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
  const persistedRun = store.getRun();
  if (persistedRun && persistedRun.status === 'running' && lockResult.acquired) {
    logger.info(`activation: resuming run ${persistedRun.id} at ${persistedRun.currentPhase}`);
    void controller.resumeExisting();
  }

  const dispose = async (): Promise<void> => {
    dashboardBridge.dispose();
    projector.dispose();
    watchdog.dispose();
    queueScheduleWatchdog.dispose();
    statusBar.dispose();
    await lock.release();
    if (activeWakeUpDeps === wakeUpActivationDeps) {
      activeWakeUpDeps = null;
    }
    for (const d of disposables) {
      try {
        d.dispose();
      } catch {
        // ignore disposal errors
      }
    }
  };

  return {
    stage2: { disposables, dispose },
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
      return scope === 'workspace' ? inspect.workspaceValue : inspect.globalValue;
    }
  };
}

function loadAndReportCatalog(
  reader: CatalogConfigReader,
  logger: SanitizedLogger
): {
  catalog: PipelineCatalog;
  phasePrecedence: import('./config/phase-precedence').PhasePrecedenceProjection;
} {
  const result = loadCatalog(reader);
  if (result.errors.length > 0) {
    logger.debug(
      `pipeline-config: ${result.errors.length} error(s) found in schegent.phases/pipelines; falling back to built-in catalog`
    );
    for (const err of result.errors.slice(0, 3)) {
      logger.debug(
        `pipeline-config: ${err.source}${err.id ? `[${err.id}]` : ''}${err.field ? `.${err.field}` : ''}: ${err.message}`
      );
    }
    if (result.errors.length > 3) {
      logger.debug(`pipeline-config: ${result.errors.length - 3} additional error(s) suppressed`);
    }
  }
  for (const w of result.warnings) {
    logger.debug(
      `pipeline-config: ${w.source}${w.id ? `[${w.id}]` : ''}: ${w.message}`
    );
  }
  // Feature 026 — surface the per-phase precedence projection alongside
  // the merged catalog. Computed once per catalog reload; the projector
  // reads it on every snapshot.
  const phasePrecedence = projectPhasePrecedence(
    result.builtInPhases,
    result.userPhases,
    result.workspacePhases
  );
  return { catalog: result.catalog, phasePrecedence };
}

export function deactivate(): void {
  // disposables registered to context.subscriptions will run automatically.
  // Feature 014 — FR-023: attempt to uninstall the OS daemon and swallow
  // failures with a single audit event. `deactivateWakeUp` is a no-op
  // when the user-scope `schegent.wakeUp.enabled` is false; when true,
  // it dispatches `daemon-manager.uninstall()` and records the result.
  // Errors here MUST NOT prevent VS Code from shutting down.
  if (activeWakeUpDeps) {
    const deps = activeWakeUpDeps;
    activeWakeUpDeps = null;
    void deactivateWakeUp(deps);
  }
  // Feature 058 — release the workspace-folder-picker subscription and clear
  // its memoized canonical folder so a fresh activation rebuilds from a clean
  // state. Idempotent and never throws.
  disposeWorkspaceFolderPicker();
}
