/**
 * FR-R6-F05 (clarification 1) — census of every existing evidence sweeper.
 *
 * Only the run-checkpoint sweeper is wired to F05 recovery pins in this
 * feature. Every other sweeper keeps its own protection and is routed through
 * the lifecycle service at the F01-B live cutover. A unit test reads each
 * `source` file and requires the named `symbol` to appear in it.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export type SweeperProtection =
  | 'lifecycle-recovery-pins'
  | 'run-status-protected-set'
  | 'class-specific-policy'
  | 'none-needed';

export interface SweeperCensusEntry {
  readonly sweeper: string;
  /** Repo-relative source file. */
  readonly source: string;
  /** Identifier that must appear in `source`. */
  readonly symbol: string;
  readonly protection: SweeperProtection;
  readonly liveCutoverOwner: 'F05' | 'F01-B';
  readonly note: string;
}

export const SWEEPER_CENSUS: readonly SweeperCensusEntry[] = [
  {
    sweeper: 'RunCheckpointRetentionService.sweep',
    source: 'src/services/run-checkpoint-retention.ts',
    symbol: 'RunCheckpointRetentionService',
    protection: 'lifecycle-recovery-pins',
    liveCutoverOwner: 'F05',
    note: 'run checkpoints; production passes isPinnedRun from recoveryPinnedRunIds'
  },
  {
    sweeper: 'SessionArtifactRetentionService.sweep',
    source: 'src/services/session-retention/session-artifact-retention-service.ts',
    symbol: 'SessionArtifactRetentionService',
    protection: 'run-status-protected-set',
    liveCutoverOwner: 'F01-B',
    note: 'session artifacts; protectedSessionRunIds already spares non-terminal runs'
  },
  {
    sweeper: 'sweepFailureRecords',
    source: 'src/services/failure-record/failure-record-retention.ts',
    symbol: 'sweepFailureRecords',
    protection: 'class-specific-policy',
    liveCutoverOwner: 'F01-B',
    note: 'failure records; age and count bounds'
  },
  {
    sweeper: 'cleanupSessionArtifacts',
    source: 'src/services/session-cleanup/session-cleanup-service.ts',
    symbol: 'cleanupSessionArtifacts',
    protection: 'run-status-protected-set',
    liveCutoverOwner: 'F01-B',
    note: 'per-task session cleanup on Task removal'
  },
  {
    sweeper: 'createEvidenceMaintenancePass',
    source: 'src/services/evidence-maintenance/evidence-maintenance-pass.ts',
    symbol: 'createEvidenceMaintenancePass',
    protection: 'class-specific-policy',
    liveCutoverOwner: 'F01-B',
    note: 'hourly evidence maintenance on an idle owner window'
  },
  {
    sweeper: 'TransportRouter.enforceTotal',
    source: 'src/monitor/transport/transport-router.ts',
    symbol: 'enforceTotal',
    protection: 'class-specific-policy',
    liveCutoverOwner: 'F01-B',
    note: 'run transport files over the workspace total'
  },
  {
    sweeper: 'RunTransportStore.narrowLegacy',
    source: 'src/monitor/transport/run-transport-store.ts',
    symbol: 'narrowLegacy',
    protection: 'class-specific-policy',
    liveCutoverOwner: 'F01-B',
    note: 'CLI transport generations a pre-251 release left'
  },
  {
    sweeper: 'scavengeAbandonedSpools',
    source: 'src/audit/raw-transcript-writer.ts',
    symbol: 'scavengeAbandonedSpools',
    protection: 'class-specific-policy',
    liveCutoverOwner: 'F01-B',
    note: 'raw transcript spools of a dead writer, outside the workspace'
  },
  {
    sweeper: 'AuditLogWriter.pruneArchives',
    source: 'src/audit/audit-log-writer.ts',
    symbol: 'pruneArchives',
    protection: 'class-specific-policy',
    liveCutoverOwner: 'F01-B',
    note: 'audit archive generations; the live audit log is never eligible for F05'
  },
  {
    sweeper: 'sweepHistoryDescriptions',
    source: 'src/services/history/history-description-sweep.ts',
    symbol: 'sweepHistoryDescriptions',
    protection: 'class-specific-policy',
    liveCutoverOwner: 'F01-B',
    note: 'history description sweep'
  },
  {
    sweeper: 'HISTORY_CAP_PER_QUEUE',
    source: 'src/state/workspace-state.ts',
    symbol: 'HISTORY_CAP_PER_QUEUE',
    protection: 'class-specific-policy',
    liveCutoverOwner: 'F01-B',
    note: 'history entry cap per queue'
  },
  {
    sweeper: 'planRetention',
    source: 'src/catalog/catalog-retention.ts',
    symbol: 'planRetention',
    protection: 'class-specific-policy',
    liveCutoverOwner: 'F01-B',
    note: 'catalog version retention'
  },
  {
    sweeper: 'MetricsRollupWriter.trimIfOversized',
    source: 'src/metrics/metrics-rollup-writer.ts',
    symbol: 'trimIfOversized',
    protection: 'none-needed',
    liveCutoverOwner: 'F01-B',
    note: 'metrics rollup trim; aggregate rows only'
  },
  {
    sweeper: 'RuntimeLogSink.rotateGenerations',
    source: 'src/lib/runtime-log/runtime-log-sink.ts',
    symbol: 'rotateGenerations',
    protection: 'none-needed',
    liveCutoverOwner: 'F01-B',
    note: 'runtime log rotation'
  },
  {
    sweeper: 'enforceBoundedRootHistory',
    source: 'src/services/workflow-execution/control-notification-service.ts',
    symbol: 'enforceBoundedRootHistory',
    protection: 'class-specific-policy',
    liveCutoverOwner: 'F01-B',
    note: 'control-ledger root eviction'
  }
];
