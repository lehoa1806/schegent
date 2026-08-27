import * as vscode from 'vscode';

import { storedLayerReaders } from './catalog-loading';
import { createHostCatalogStore, createHostCatalogLifecycle } from './catalog-store-wiring';
import { createCatalogSettingsWriter } from './catalog-settings-wiring';
import { createConnectedRunService } from './ui-wiring';
import { createPhaseLogTailWiring } from './phase-log-tail-wiring';
import { createBackendDiagnosticsWiring } from './backend-wiring';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import { DEFAULT_QUEUE_ID } from '../contracts/queue-identity';
import type { CatalogConfigReader } from '../config/pipeline-config-loader';
import { coerceModels } from '../config/pipeline-config-loader';
import { writeGeneralSettings, type GeneralSettingsConfig } from '../config/general-settings';
import type { SchegentWorkflowController } from '../controller/workflow-controller';
import type { SanitizedLogger } from '../lib/logger';
import type { QueueManager } from '../queue/queue-manager';
import type { GuardedRunService } from '../services/guarded-run-service';
import type { HistoryStore } from '../state/history-store';
import type { WorkspaceLockManager } from '../state/lock';
import type { WorkspaceStateStore } from '../state/workspace-state';
import { MessageRouter } from '../ui/sidebar/message-router';
import type { StateProjector } from '../ui/sidebar/state-projector';
import type { Notifier } from '../ui/notifications';
import { CatalogSession } from './catalog-loading';
import type { EvidenceHealthMonitor } from '../services/evidence-health/evidence-health-monitor';
import type { RuntimeLogSink } from '../lib/runtime-log/runtime-log-sink';
import { createRuntimeLogAccessor } from '../lib/runtime-log';
import * as path from 'node:path';
import { createPhaseLogService } from '../services/phase-log';
import { readMetrics } from '../metrics/metrics-service';
import { HistoryEvidenceService } from '../services/history/history-evidence-service';
import { AuditPointerResolver } from '../services/history/audit-pointer-resolver';
import { HistoryDescriptionStore } from '../services/history/history-description-store';
import { resolveHistoryDescription } from '../services/history/history-description-resolver';

/**
 * FR-R3-119 — the sidebar message router, wired.
 *
 * Extracted from `wireStage2()` in `src/extension.ts`. That function was 1,221
 * lines and roughly 245 top-level statements, inside a 1,489-line file sitting one
 * line under a ceiling nobody had to justify — while `ARCHITECTURE.md` stated that
 * `src/activation/` is the composition root and that domain modules do not
 * construct VS Code adapters themselves. The directory expressed a boundary that
 * one function in the entry file substantially bypassed.
 *
 * This was the largest single independent span in it: one `new MessageRouter({…})`
 * and nothing else.
 *
 * MECHANICAL, BY CONSTRUCTION (FR-059 forbids anything else). The span moved
 * verbatim. The only edits are the de-indent, `const sidebarRouter =` becoming
 * `return`, and the outer-scope bindings it closed over becoming named parameters.
 * Every handler runs in the same order, under the same conditions, against the
 * same collaborators as before; `tests/unit/extension/activate.test.ts` and the
 * full host suite are what hold that.
 */
/**
 * `context`, `output` and `config` are deliberately ABSENT. The span closed over
 * them in `wireStage2` only because everything in that function was in scope;
 * measured against what the router actually reads, it needs none of the three.
 * Passing them anyway would manufacture a dependency the extraction exists to
 * disprove.
 */
export interface SidebarRouterWiringDeps {

  readonly logger: SanitizedLogger;

  readonly ownerId: string;
  readonly workspaceRoot: string;
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly controller: SchegentWorkflowController;
  readonly lock: WorkspaceLockManager;
  readonly notifier: Notifier;
  readonly auditWriter: AuditLogWriter;
  readonly historyStore: HistoryStore;
  readonly guardedRunService: GuardedRunService;
  readonly backendKind: BackendRunnerKind;
  readonly metricsViewOpenedState: { emitted: boolean };

  readonly projector: StateProjector;
  readonly catalogStore: ReturnType<typeof createHostCatalogStore>;
  readonly catalogReader: CatalogConfigReader;
  readonly catalogSession: CatalogSession;
  readonly catalogLifecycle: ReturnType<typeof createHostCatalogLifecycle>;
  readonly connectedRuns: ReturnType<typeof createConnectedRunService>;
  readonly backendPing: ReturnType<typeof createBackendDiagnosticsWiring>['ping'];
  readonly evidenceHealth: EvidenceHealthMonitor;
  readonly phaseLogTail: ReturnType<typeof createPhaseLogTailWiring>;
  readonly runtimeLogSink: RuntimeLogSink;
  readonly runtimeLogAccessor: ReturnType<typeof createRuntimeLogAccessor>;
  /** Declared in `wireStage2` and referenced by the catalog handlers. */
  readonly refreshCatalog: () => Promise<void>;
}

export function createSidebarRouter(deps: SidebarRouterWiringDeps): MessageRouter {
  const {
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
  } = deps;
return new MessageRouter({
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
  notifyWarning: (message) => void notifier.warn(`Schegent: ${message}.`), // advisory
  logger,
  audit: auditWriter,
  // Feature 099 (T494, FR-056) — the Model Catalog is the only
  // configuration-backed catalog left; `createCatalogSettingsWriter` carries
  // why the scope argument this port used to take is gone.
  updateConfig: createCatalogSettingsWriter(workspaceRoot),
  // Feature 099 (T493d, FR-042a, FR-051) — the write side of the store, or
  // `null` in an untrusted workspace, where a save has nowhere legitimate to
  // land and is refused by name rather than silently doing nothing.
  catalogStore,
  // Feature 100 (T509c, FR-047) — the lifecycle service, `null` on exactly the
  // condition the store is. Separate from `catalogStore` because building it
  // needs a configuration read the handlers must not perform themselves.
  catalogLifecycle,
  // Feature 099 (T493b, T493d, FR-042a, FR-044) — served from the snapshot this
  // window last read, not from a fresh read per call: the store's own
  // compare-and-swap is the authoritative gate (FR-030a), so these three feed the
  // early-out that spares an operator a pointless write, and a save that races
  // past them is still refused `stale` by the store itself. Same snapshot the
  // catalogs resolved from, so a gate and the Library it defends cannot disagree.
  ...storedLayerReaders(catalogSession),
  // Feature 099 (T493b, FR-054) — the one signal that a definition changed. No
  // configuration event announces a store write, so the window that wrote is the
  // window that says so.
  refreshCatalog,
  // Feature 096 — Model Catalog's one writable layer is 'workspace' (research.md
  // Decision 6), so this reads that scope only, fresh per call, same reason as
  // readWorkflowConfig above — not catalogSession.catalog.models, which is the merged
  // user+workspace view and would let the revision gate react to a layer this
  // command never writes.
  readModelsConfig: () => coerceModels(catalogReader.getModels('workspace')),
  getCatalog: () => catalogSession.catalog,
  // Feature 102 (T038, FR-022) — the version behind the line above, read
  // through the same session so a freeze cannot pair one window's body with
  // another read's version. `'pipeline'` is named here and only here: this
  // seam starts Pipelines, and a Workflow's own version is a question it has
  // no way to ask (FR-026).
  resolveCatalogVersion: (pipelineId) => catalogSession.activeVersion('pipeline', pipelineId),
  guardedRun: guardedRunService,
  defaultRunnerKind: backendKind,
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
    }), DEFAULT_QUEUE_ID,
      store.runCommitClaim(DEFAULT_QUEUE_ID)
    );
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
  // FR-R3-071 — the sidebar replay panel's description read, through the one
  // resolver the host commands use. Same closure shape and the same reason:
  // the workspace root reaches the sidecar store here and nowhere else.
  historyDescriptionService: {
    resolve: async (runId) => {
      const entry = historyStore.list().find((row) => row.runId === runId);
      if (!entry) return null;
      return resolveHistoryDescription(entry, {
        descriptions: new HistoryDescriptionStore({ workspaceRoot, logger }),
        logger
      });
    }
  },
  // Feature 073 — existing session-scoped correlation id, reused (not
  // newly minted) for the metrics-view-opened audit payload
  // (contracts/metrics-view-opened-event.md).
  sessionId: ownerId,
  metricsViewOpenedState,
  backendPingService: backendPing
});
}
