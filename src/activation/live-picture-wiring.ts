// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: GATED HERE, plus one deferral.
// Three acts were found in this module and all three are named at their sites:
// the wiring-time backend probe (deferred to `stage2-producers.ts`), the
// configuration-change retention sweep, and the configuration-change backend
// probe (both gated in place, because a settings edit is a third way in beside
// commands and IPC and there is nothing to hand over).
//
// `projector.start()` STAYS, and it is the reason T1523a's "arms a timer" clause
// needs a reading rather than a match. The tick it arms calls
// `scheduleProjection()` and nothing else: it recomputes a snapshot from state
// already in memory and posts it to the webview. That is a read on a timer, not a
// timer that acts, and suppressing it would freeze the state, history, audit and
// log views the manifest's `limited` claim promises keep working. The clause is
// about timers whose callback writes, spawns, or resumes.

import * as vscode from 'vscode';

import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import type { SchegentWorkflowController } from '../controller/workflow-controller';
import type { SanitizedLogger } from '../lib/logger';
import type { ClaudeCliMonitor } from '../monitor/claude-cli-monitor';
import type { QueueManager } from '../queue/queue-manager';
import type { EvidenceHealthMonitor } from '../services/evidence-health/evidence-health-monitor';
import type { SessionArtifactRetentionService } from '../services/session-retention/session-artifact-retention-service';
import type { HistoryStore } from '../state/history-store';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { SchegentStatusBar } from '../ui/status-bar';
import { StateProjector } from '../ui/sidebar/state-projector';
import type { CatalogSession } from './catalog-loading';
import { createConnectedRunService } from './ui-wiring';
import { createPhaseLogTailWiring } from './phase-log-tail-wiring';
import type { BackendExecutionWiring } from './backend-execution-wiring';
import type { EvidenceWiring } from './evidence-wiring';
import type { CreditWatchdog } from '../watchdog/credit-watchdog';
import type { WebviewLogSink } from '../lib/webview-log-sink';
import { readGeneralSettings, type GeneralSettingsConfig } from '../config/general-settings';
import { buildBuilderLifecycleByKind } from '../ui/sidebar/builder-lifecycle';
import { isConfirmationsEnabled } from '../state/confirmations-config';
import { resolveRunOrigin } from '../services/run-origin-resolver';
import { initCapabilityTrustResolver } from '../state/capability-trust-resolver';

/**
 * FR-R3-119 — the live picture: the state projector, the connected-run service it
 * reads, and the phase-log tail that feeds it.
 *
 * The seventh extraction out of `wireStage2()`, and the first taken from the
 * coupled core rather than the edges. **Twenty-three bindings in, three out** —
 * every earlier region ran nine to eighteen, and the jump is the signal that the
 * boundary is now inside what genuinely composes rather than around it.
 *
 * WHY THE TWO BIND CALLS ARE FUNCTIONS, not the wiring bundle they belong to.
 * `backend-execution-wiring.ts` returns `bindCapabilityProjector` and
 * `bindTelemetryProjector` so its closures can reach a projector built later; the
 * projector is built HERE, so those calls belong here too. Passing the whole
 * `backend` object to reach two setters would make this module depend on
 * everything that bundle holds. Two function parameters say exactly what is used.
 *
 * That is the counterweight to the binding count: three of the twenty-three are
 * narrowings rather than dependencies, and the extraction is what forced them to
 * be named.
 */
export interface LivePictureWiringDeps {
  readonly context: vscode.ExtensionContext;
  readonly workspaceRoot: string;
  readonly ownerId: string;
  readonly logger: SanitizedLogger;
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly controller: SchegentWorkflowController;
  readonly historyStore: HistoryStore;
  readonly auditWriter: AuditLogWriter;
  readonly statusBar: SchegentStatusBar;
  readonly monitor: ClaudeCliMonitor;
  readonly watchdog: CreditWatchdog;
  readonly catalogSession: CatalogSession;
  readonly evidenceHealth: EvidenceHealthMonitor;
  readonly sessionRetention: SessionArtifactRetentionService;
  readonly webviewLogSink: WebviewLogSink;
  readonly disposables: vscode.Disposable[];
  readonly backendKind: BackendRunnerKind;
  readonly backendCapabilities: BackendExecutionWiring['backendCapabilities'];
  readonly backendPing: BackendExecutionWiring['backendPing'];
  readonly protectedSessionRunIds: EvidenceWiring['protectedSessionRunIds'];
  readonly collectAllWorkflowPipelineRefs: EvidenceWiring['collectAllWorkflowPipelineRefs'];
  /**
   * FR-R3-136 (FR-005, FR-011) — read on every configuration change, never
   * captured. The retention arm below deletes under `.schegent/sessions`, and a
   * settings edit is a way to reach a workspace write in an untrusted window
   * that has nothing to do with a command or an IPC message. Phase D restricts
   * the workspace-scoped half of these keys; this closes the user-scope half,
   * which no manifest declaration can.
   */
  readonly isWorkspaceTrusted: () => boolean;
  /** See the docblock: two setters, not the bundle that owns them. */
  readonly bindCapabilityProjector: BackendExecutionWiring['bindCapabilityProjector'];
  readonly bindTelemetryProjector: BackendExecutionWiring['bindTelemetryProjector'];
}

export interface LivePictureWiring {
  readonly projector: StateProjector;
  /**
   * Returned because the sidebar router calls it too. It is declared inside this
   * module because the catalog-settings save path here invokes it directly; the
   * router needs the same function, not a second one that re-resolves differently.
   */
  readonly refreshCatalog: () => Promise<void>;
  readonly connectedRuns: ReturnType<typeof createConnectedRunService>;
  readonly phaseLogTail: ReturnType<typeof createPhaseLogTailWiring>;
}

export function wireLivePicture(deps: LivePictureWiringDeps): LivePictureWiring {
  const {
    context,
    workspaceRoot,
    ownerId,
    logger,
    store,
    queue,
    controller,
    historyStore,
    auditWriter,
    isWorkspaceTrusted,
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
    collectAllWorkflowPipelineRefs,
    bindCapabilityProjector,
    bindTelemetryProjector
  } = deps;

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
bindCapabilityProjector(projector);
// FR-R3-136 (T1525a) — `start()` subscribes and arms the re-projection tick, and
// the tick only re-renders. See this module's classification banner for why a
// read-side timer is not the timer T1523a's criterion means.
projector.start();
// FR-R3-136 (FR-011) — the backend probe is NOT started here any more, and this
// was the second find of T1525a's pass. `scan()` spawns `<cliPath> --help` for
// each supported backend with `cwd` set to the workspace root, which is a child
// process at wiring time — the least arguable half of T1523a's criterion, and
// the one thing an untrusted window must not do on the workspace's behalf.
//
// The three path keys are `scope: application`, so the BINARY is the operator's
// and not the folder's; that is why this is a deferral and not a vulnerability
// report. What the folder does supply is the cwd, and a CLI that reads
// project-level configuration on startup makes `--help` less inert than it
// looks. Deferring costs an untrusted window a backend list it cannot act on
// anyway: no Run can start, and the grant re-runs the producers.
disposables.push(evidenceHealth.subscribe((health) => {
  statusBar.setEvidenceHealth(health.overall);
  projector.kick();
}));
webviewLogSink.setOnAppend(() => projector.kick());
// Feature 033 — bind the deferred telemetry projector reference now that
// the projector exists. The sampler's `onSample` closure consults this
// pointer on every emission (and is a no-op until binding).
bindTelemetryProjector(projector);

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
        // FR-R3-136 (FR-011) — a settings change is a third way in, beside
        // commands and webview IPC, and this arm writes to `.schegent/sessions`.
        // Re-read here rather than captured, per FR-005.
        if (isWorkspaceTrusted()) {
          void sessionRetention.sweep(protectedSessionRunIds()).then(() => projector.kick());
        } else {
          logger.info('session retention sweep skipped on config change: workspace is not trusted');
        }
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
        // FR-R3-136 (FR-011) — same act, same gate as the deferral above: a
        // settings edit must not be the way a spawn happens in an untrusted
        // window. Re-read here rather than captured, per FR-005.
        if (isWorkspaceTrusted()) {
          void backendCapabilities.scan();
        } else {
          logger.info('backend capability scan skipped on config change: workspace is not trusted');
        }
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
  // FR-R3-136 (FR-011) — the tail's audit append is a workspace write on a
  // message the IPC gate does not cover; the gate is in the wiring module.
  isWorkspaceTrusted,
  logger
});
disposables.push(phaseLogTail);
  return { projector, connectedRuns, phaseLogTail, refreshCatalog };
}
