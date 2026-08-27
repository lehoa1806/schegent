import * as vscode from 'vscode';

import { AuditLogWriter } from '../audit/audit-log-writer';
import { readGeneralSettings } from '../config/general-settings';
import type { SanitizedLogger } from '../lib/logger';
import type { QueueManager } from '../queue/queue-manager';
import { SessionArtifactRetentionService } from '../services/session-retention/session-artifact-retention-service';
import type { EvidenceHealthMonitor } from '../services/evidence-health/evidence-health-monitor';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { Notifier } from '../ui/notifications';
import { createWorkflowPipelineRefReader } from '../ui/sidebar/workflow-pipeline-ref-source';
import type { CatalogSession } from './catalog-loading';
import type { GeneralSettingsConfig } from '../config/general-settings';
import { forwardMigrationAuditEvents } from '../state/migration-audit-forwarder';

/** The five event bundles `store.initialize()` reports, typed by their consumer. */
type MigrationEvents = Parameters<typeof forwardMigrationAuditEvents>[0];
import { recordCompletedInterruptedReset } from '../commands/reset-wiring';
import { maybeShowMultiRootWarning } from '../state/multi-root-warning';
import { getCanonicalWorkspaceRoot } from '../state/workspace-folder-picker';

/**
 * FR-R3-119 — the evidence surface: the audit writer, the session-artifact
 * retention sweep, and the two readers that tell them what is still live.
 *
 * The sixth extraction out of `wireStage2()`. 91 lines, sixteen bindings in,
 * four out.
 *
 * WHY THE MIGRATION EVENTS ARE PARAMETERS. `v6`/`v7`/`v11`/`v12` and the run-repair
 * events are produced by `store.initialize()` at the very top of activation and
 * consumed here, because the audit writer is the first thing that exists which can
 * record them. They are passed rather than re-derived: the store reports them once,
 * and asking twice would either return nothing the second time or re-run a
 * migration.
 *
 * WHY THE TWO READERS ARE THUNKS, unchanged from the original. Both re-read on
 * every call so a catalog reload — which reassigns `catalogSession.workflowCatalog`
 * — reaches the next decision, and so `protectedSessionRunIds` sees runs that
 * started after this wiring ran. Freezing either into a value at construction is
 * the bug they are written to avoid.
 */
export interface EvidenceWiringDeps {
  readonly workspaceRoot: string;
  readonly logger: SanitizedLogger;
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly notifier: Notifier;
  readonly evidenceHealth: EvidenceHealthMonitor;
  readonly catalogSession: CatalogSession;
  readonly rotationSizeMB: number;
  readonly rotationMaxAgeDays: number;
  readonly completedResetGeneration: number | null;
  readonly v6MigrationEvents: MigrationEvents['v6MigrationEvents'];
  readonly v7MigrationEvents: MigrationEvents['v7MigrationEvents'];
  readonly v11MigrationEvents: MigrationEvents['v11MigrationEvents'];
  readonly v12MigrationEvents: MigrationEvents['v12MigrationEvents'];
  readonly runRepairEvents: MigrationEvents['runRepairEvents'];
}

export interface EvidenceWiring {
  readonly auditWriter: AuditLogWriter;
  readonly sessionRetention: SessionArtifactRetentionService;
  readonly collectAllWorkflowPipelineRefs: ReturnType<typeof createWorkflowPipelineRefReader>;
  readonly protectedSessionRunIds: () => ReadonlySet<string>;
}

export async function wireEvidence(deps: EvidenceWiringDeps): Promise<EvidenceWiring> {
  const {
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
  } = deps;

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
  return { auditWriter, sessionRetention, collectAllWorkflowPipelineRefs, protectedSessionRunIds };
}
