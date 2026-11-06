// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: DEFERRED.
// The migration audit appends and the `.schegent/sessions` retention sweep ran at
// construction. They are returned as `replayEvidenceBacklog` and run inside the
// trust gate; nothing here writes into the workspace any more. The one write left creates the
// owner-only head-checkpoint root in global storage, outside every workspace (FR-R4-F03, W9).

import * as vscode from 'vscode';

import { AuditLogWriter } from '../audit/audit-log-writer';
import { lockWriteAuthority } from '../audit/audit-write-authority';
import { realpath } from 'fs/promises';
import { randomBytes } from 'node:crypto';
import { checkpointKey, type AuditCheckpointPort } from '../audit/audit-checkpoint';
import { ensureCheckpointRoot } from '../audit/audit-checkpoint-root';
import { createAuditCheckpointStore } from '../audit/audit-checkpoint-store';
import { readGeneralSettings } from '../config/general-settings';
import type { SanitizedLogger } from '../lib/logger';
import type { QueueManager } from '../queue/queue-manager';
import { SessionArtifactRetentionService } from '../services/session-retention/session-artifact-retention-service';
import { sweepFailureRecords } from '../services/failure-record/failure-record-retention';
import { sweepHistoryDescriptions } from '../services/history/history-description-sweep';
import type { EvidenceHealthMonitor } from '../services/evidence-health/evidence-health-monitor';
import type { VerdictBasisMigrationEvent } from '../state/host-verification-migrator';
import type { WorkspaceLockManager } from '../state/lock';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { Notifier } from '../ui/notifications';
import { createWorkflowPipelineRefReader } from '../ui/sidebar/workflow-pipeline-ref-source';
import type { CatalogSession } from './catalog-loading';
import type { GeneralSettingsConfig } from '../config/general-settings';
import { forwardMigrationAuditEvents } from '../state/migration-audit-forwarder';
import {
  createOperatorAttribution,
  installOperatorAttribution,
  type OperatorAttribution
} from '../lib/operator-attribution';

/** The six event bundles `store.initialize()` reports, typed by their consumer. */
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
 * WHY THE MIGRATION EVENTS ARE PARAMETERS. `v6`/`v7`/`v11`/`v12`, the orphaned-run
 * cancellations and the run-repair events are produced by `store.initialize()` at
 * the very top of activation and consumed here, because the audit writer is the
 * first thing that exists which can record them. They are passed rather than
 * re-derived: the store reports them once, and asking twice would either return
 * nothing the second time or re-run a migration.
 *
 * WHY THE TWO READERS ARE THUNKS, unchanged from the original. Both re-read on
 * every call so a catalog reload — which reassigns `catalogSession.workflowCatalog`
 * — reaches the next decision, and so `protectedSessionRunIds` sees runs that
 * started after this wiring ran. Freezing either into a value at construction is
 * the bug they are written to avoid.
 */
export interface EvidenceWiringDeps {
  readonly workspaceRoot: string;
  /**
   * FR-R4-F03 (FR-010; W9) — the workspace lock, which the audit writer asks before every step that
   * writes. The lock exists here and the election runs later in `stage2-producers.ts`, so until it
   * is won the adapter answers "not the owner" and the writer writes nothing.
   */
  readonly lock: Pick<WorkspaceLockManager, 'hasPrimacy' | 'fenceOfRecord'>;
  /**
   * FR-R4-F03 (FR-015; W9) — the extension's per-user storage root (`context.globalStorageUri.fsPath`),
   * where the audit head checkpoint is kept OUTSIDE the workspace so removing `.schegent/` cannot remove it.
   */
  readonly globalStorageRoot: string;
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
  readonly v10MigrationEvents?: MigrationEvents['v10MigrationEvents'];
  readonly v11MigrationEvents: MigrationEvents['v11MigrationEvents'];
  readonly v12MigrationEvents: MigrationEvents['v12MigrationEvents'];
  readonly v13MigrationEvents?: MigrationEvents['v13MigrationEvents'];
  // `NonNullable` because the forwarder declares this one optional — older
  // callers that build a `MigrationAuditEvents` literal predate it — while
  // `initialize()` always reports it. Inheriting the optionality here would put
  // an `| undefined` in this contract that no caller can produce, and passing it
  // on fails `exactOptionalPropertyTypes` at the forwarding call below.
  readonly orphanedRunEvents: NonNullable<MigrationEvents['orphanedRunEvents']>;
  readonly runRepairEvents: MigrationEvents['runRepairEvents'];
  /**
   * FR-R4-F01 (US4, contract V3) — what the verdict-basis step reported. Not an audit event
   * (`forwardMigrationAuditEvents` is not given it): it is disclosed through the notifier and the
   * runtime log, once, and the Run is not blocked.
   */
  readonly v14MigrationEvents: readonly VerdictBasisMigrationEvent[];
}

/**
 * FR-R4-F01 (FR-019, contract V3 G9 and G10, constitution principle I) — tell the operator what the
 * verdict-basis migration did, and never wait for an answer.
 *
 * A Run frozen with a verdict basis this version cannot date keeps the policy the runtime already
 * applies, and the operator hears of it once: one warning per such Run, with no button, and a
 * metadata-only log line (the queue, 8 characters of the Run id, a count: no path, no Phase body).
 * `Notifier.warn` resolves when the notice is dismissed, so it is not awaited. A Run found only in
 * the terminal-transition journal has no queue and is finishing, so it is logged and not announced.
 * A migrated Run is one information line. Synchronous on purpose: nothing here can block activation.
 */
export function discloseVerdictBasisMigration(
  events: readonly VerdictBasisMigrationEvent[],
  deps: { readonly notifier: Pick<Notifier, 'warn'>; readonly logger: Pick<SanitizedLogger, 'warn' | 'info'> }
): void {
  for (const event of events) {
    const runId = event.runId.slice(0, 8);
    if (event.type === 'verdict-basis-migrated') {
      deps.logger.info('verdict basis migrated', {
        queueId: event.queueId,
        runId,
        legacyAuthored: event.legacyAuthored,
        legacyDefault: event.legacyDefault
      });
      continue;
    }
    deps.logger.warn('verdict basis provenance unknown', {
      queueId: event.queueId,
      runId,
      phaseCount: event.phaseCount
    });
    if (event.queueId === null) continue;
    void deps.notifier.warn(
      `Schegent: the Run on queue ${event.queueId} (${runId}) was frozen with a verdict basis ` +
        'this version cannot date. It keeps the current policy: Phases with side effects are ' +
        'judged on their exit status. To run it under a plan frozen now, cancel it and start it again.'
    );
  }
}

export interface EvidenceWiring {
  readonly auditWriter: AuditLogWriter;
  readonly sessionRetention: SessionArtifactRetentionService;
  readonly collectAllWorkflowPipelineRefs: ReturnType<typeof createWorkflowPipelineRefReader>;
  readonly protectedSessionRunIds: () => ReadonlySet<string>;
  /**
   * FR-R3-136 (FR-011) — the four things this module used to DO at construction,
   * returned as a thunk instead: forward the migration audit events, record a
   * finished interrupted reset, sweep `.schegent/sessions`, and warn about a
   * multi-root workspace.
   *
   * All four write inside the workspace folder — three append to `audit.log` and
   * one deletes session directories — so none may run before Workspace Trust is
   * established. Constructing the writer and the retention service still happens
   * eagerly, because construction writes nothing and the sidebar's audit and
   * evidence views need both objects to render in an untrusted window.
   *
   * The caller runs this from `stage2-producers.ts`, which is the one place that
   * decides when producing is allowed. Returning a thunk rather than taking an
   * `isWorkspaceTrusted` dependency keeps that decision in one module: two
   * modules each reading trust is how a gate ends up half-applied.
   */
  readonly replayEvidenceBacklog: () => Promise<void>;
  /**
   * FR-R4-F04 (P1, TA7) — the operator attribution, already installed read-only: `getOperatorActor()`
   * answers the stored pseudonym, or `unknown-operator` when none is stored. Creating one is
   * `ensureStored()`, a memento write that the trust-gated producer preamble runs (`stage2-producers.ts`),
   * and the reset command replaces it.
   */
  readonly operatorAttribution: OperatorAttribution;
}

export async function wireEvidence(deps: EvidenceWiringDeps): Promise<EvidenceWiring> {
  const {
    workspaceRoot,
    lock,
    globalStorageRoot,
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
    v10MigrationEvents,
    v11MigrationEvents,
    v12MigrationEvents,
    v13MigrationEvents,
    orphanedRunEvents,
    runRepairEvents,
    v14MigrationEvents
  } = deps;

// Feature 083 (US6, FR-041) — the single source of "which Workflows consume a
// Pipeline?" for both the Library list (FR-002) and gate 13 (FR-022a). The
// callbacks re-read on every call so a Workflow catalog reload, which
// reassigns `catalogSession.workflowCatalog`, reaches the next gate decision.
const collectAllWorkflowPipelineRefs = createWorkflowPipelineRefReader({
  listRequests: () => queue.list(),
  listWorkflowRecords: () => catalogSession.workflowCatalog.records
});
// FR-R4-F03 (W9) — the head checkpoint store: the root is created first, and a failure there leaves the
// writer with no port (no loss tracking for this window) and says so once. It never blocks activation.
let checkpoint: AuditCheckpointPort | undefined;
try {
  await ensureCheckpointRoot(globalStorageRoot);
  checkpoint = createAuditCheckpointStore({
    root: globalStorageRoot,
    key: checkpointKey(await realpath(workspaceRoot))
  });
} catch {
  logger.warn(
    'audit-checkpoint-unavailable: the head checkpoint store could not be prepared; loss detection is ' +
      'not tracking history for this window'
  );
}
const auditWriter = new AuditLogWriter(
  {
    workspaceRoot,
    rotationSizeBytes: rotationSizeMB * 1024 * 1024,
    rotationMaxAgeMs: rotationMaxAgeDays * 24 * 60 * 60 * 1000,
    authority: lockWriteAuthority(lock),
    ...(checkpoint === undefined ? {} : { checkpoint })
  },
  logger,
  evidenceHealth
);

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
  },
  // FR-R4-F15 (K2) — the failure records are aged and counted by the same sweep, inside its chain, so
  // the triggers (activation, a terminal Run, a changed setting) are the ones that already exist.
  failureRecords: {
    sweep: (maxAgeMs, now) => sweepFailureRecords({ workspaceRoot, logger }, maxAgeMs, now)
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
// FR-R3-136 (FR-011) — the four writes, deferred. Every line below ran at this
// point in the function before this requirement; only the WHEN changed, so the
// bodies and their comments are unedited.
const replayEvidenceBacklog = async (): Promise<void> => {
  // Forward all state-migration audit events (v5→v6, v6→v7, v10→v11, v11→v12,
  // workflow-run repair) through the sanitized audit writer. Helper preserves
  // the append-error best-effort semantics — never blocks activation.
  await forwardMigrationAuditEvents(
    {
      v6MigrationEvents,
      v7MigrationEvents,
      ...(v10MigrationEvents === undefined ? {} : { v10MigrationEvents }),
      v11MigrationEvents,
      v12MigrationEvents,
      ...(v13MigrationEvents === undefined ? {} : { v13MigrationEvents }),
      orphanedRunEvents,
      runRepairEvents,
      // FR-R3-111 — drained where the writer exists; `initialize()` buffers it before that.
      quarantineEvents: store.drainRunQuarantineEvents()
    },
    auditWriter,
    logger
  );

  // FR-R4-F01 (US4) — disclose the verdict-basis migration. After the audit forward, and inside
  // the trust gate like every other write here, though it writes nothing: the notice is about a
  // workspace the operator has trusted.
  discloseVerdictBasisMigration(v14MigrationEvents, { notifier, logger });

  // Feature FR-R3-006 (T346, T348) — record the interrupted reset this
  // activation finished, now that there is a writer to record it with.
  if (completedResetGeneration !== null) {
    await recordCompletedInterruptedReset(auditWriter, logger, completedResetGeneration);
  }

  // Sweep once at activation. The service is fail-soft and restricts deletion
  // to exact inactive run groups below `.schegent/sessions`; `audit.log` lives
  // outside that root and is never a candidate.
  await sessionRetention.sweep(protectedSessionRunIds());

  // FR-R4-F04 (G1) — the history descriptions are swept at the same moment, which is what the retention
  // inventory has always said. Owner only: this deletes operator-authored text, and FR-031's principle is
  // that only the owner sweeps, so two windows over one workspace do not remove each other's files. The
  // election has already run, so `hasPrimacy()` answers for this window. The referenced set comes from the
  // raw rows, not the history list (`history-description-sweep.ts`).
  if (await lock.hasPrimacy()) {
    await sweepHistoryDescriptions({
      workspaceRoot,
      logger,
      historyMap: () => store.getHistoryMap(),
      nowMs: Date.now()
    });
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
};
  // FR-R4-F04 (P1) — read-only here: reading a memento writes nothing, so an untrusted window attributes
  // to the stored pseudonym (or `unknown-operator`) and creates none.
  const operatorAttribution = createOperatorAttribution(store, randomBytes);
  installOperatorAttribution(operatorAttribution);
  return {
    auditWriter,
    sessionRetention,
    collectAllWorkflowPipelineRefs,
    protectedSessionRunIds,
    replayEvidenceBacklog,
    operatorAttribution
  };
}
