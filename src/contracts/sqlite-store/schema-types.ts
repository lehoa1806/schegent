/**
 * FR-R6-F04 (F04-A) — Core SQLite operational schema, pragma profile,
 * qualification report, trusted storage location, migration stages, backup
 * dependency manifest, and 7 atomic transaction unit contracts.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export const SQLITE_STORE_CONTRACT_VERSION = 1 as const;
export const SQLITE_SCHEMA_CURRENT_VERSION = 4 as const;
/** STRICT tables created by migration 1 (F04); later migrations add to this. */
export const F04_INITIAL_STRICT_TABLE_COUNT = 78 as const;
export const SQLITE_MIN_SUPPORTED_ENGINE_VERSION = '3.51.3' as const;

/** F03 / F04 bounded writer queue and WAL checkpoint constants. */
export const SQLITE_WRITER_MAX_QUEUE_REQUESTS = 64 as const;
export const SQLITE_WRITER_MAX_QUEUE_BYTES = 16_777_216 as const; // 16 MiB
export const SQLITE_WRITER_RESERVED_SETTLEMENT_SLOTS = 16 as const;
export const SQLITE_WRITER_RESERVED_SETTLEMENT_BYTES = 4_194_304 as const; // 4 MiB
export const SQLITE_WRITER_NORMAL_MAX_REQUESTS = 48 as const; // 64 - 16
export const SQLITE_WRITER_NORMAL_MAX_BYTES = 12_582_912 as const; // 12 MiB
export const SQLITE_BUSY_TIMEOUT_MS = 250 as const;
export const SQLITE_MAX_READ_CONNECTIONS = 2 as const;
export const SQLITE_WAL_PASSIVE_CHECKPOINT_PAGES = 1_000 as const;
export const SQLITE_WAL_PASSIVE_CHECKPOINT_INTERVAL_MS = 30_000 as const;
export const SQLITE_WAL_ESCALATION_BYTES = 67_108_864 as const; // 64 MiB
export const SQLITE_WAL_PAUSE_BACKGROUND_BYTES = 134_217_728 as const; // 128 MiB
export const SQLITE_BENCHMARK_WARMUP_SAMPLES = 20 as const;
export const SQLITE_BENCHMARK_MEASURED_SAMPLES = 200 as const;

export const ATOMIC_TRANSACTION_UNITS = [
  'Admission',
  'Terminal acceptance',
  'Handoff acceptance',
  'Review acceptance',
  'Usage/correction',
  'Catalog publication',
  'Retention'
] as const;

export type AtomicTransactionUnitName = (typeof ATOMIC_TRANSACTION_UNITS)[number];

export const WRITER_PRIORITY_LANES = ['settlement', 'standard', 'background'] as const;
export type WriterPriorityLane = (typeof WRITER_PRIORITY_LANES)[number];

export const MIGRATION_STAGES = [
  'prepare-copy',
  'import',
  'quiesce/reconcile',
  'validate',
  'publish-authority',
  'retain-source',
  'retire-source'
] as const;

export type MigrationStageName = (typeof MIGRATION_STAGES)[number];

export const STORAGE_AUTHORITIES = ['legacy', 'migrating', 'sqlite', 'retired_legacy'] as const;
export type StorageAuthority = (typeof STORAGE_AUTHORITIES)[number];

export const NETWORK_FILESYSTEM_TYPES = [
  'nfs',
  'smb',
  'cifs',
  'afp',
  'webdav',
  'fuse.sshfs',
  'smbfs',
  'ncpfs'
] as const;

export type NetworkFilesystemType = (typeof NETWORK_FILESYSTEM_TYPES)[number];

export type StorageLocationSourceKind =
  | 'host_storage_uri'
  | 'host_global_storage_uri'
  | 'cli_state_dir'
  | 'webview_untrusted'
  | 'workspace_setting_untrusted'
  | 'env_untrusted';

export interface StorageLocationRequest {
  readonly trustedRootDir: string;
  readonly relativeSegments: readonly string[];
  readonly databaseFileName?: string | undefined;
  readonly sourceKind: StorageLocationSourceKind;
  readonly filesystemType?: string | undefined;
  readonly requestedJournalMode?: 'wal' | 'delete' | 'memory' | undefined;
}

export type StorageLocationRefusalReason =
  | 'untrusted_source'
  | 'escapes_trusted_root'
  | 'invalid_database_filename'
  | 'network_share_wal_unsupported'
  | 'symlink_or_containment_refused'
  | 'permission_narrowing_failed';

export type StorageLocationResolution =
  | {
      readonly status: 'resolved';
      readonly anchorDirectory: string;
      readonly databasePath: string;
      readonly walPath: string;
      readonly shmPath: string;
      readonly journalMode: 'wal' | 'delete' | 'memory';
      readonly expectedDirMode: 0o700;
      readonly expectedFileMode: 0o600;
      readonly filesystemType: string;
    }
  | {
      readonly status: 'refused';
      readonly reason: StorageLocationRefusalReason;
      readonly operatorDiagnostic: string;
    };

export interface VerifiedPragmaState {
  readonly journalMode: 'wal' | 'memory' | 'delete';
  readonly synchronous: number;
  readonly foreignKeys: 1;
  readonly busyTimeoutMs: number;
  readonly trustedSchema: 0;
  readonly tempStore: number;
  readonly queryOnly: 0 | 1;
}

export interface IdempotencyEnvelope {
  readonly scopeKind: string;
  readonly scopeId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
}

export interface LeaseFenceToken {
  readonly fenceScope: string;
  readonly resourceId: string;
  readonly ownerId: string;
  readonly epoch: number;
}

export interface LeaseFenceRow {
  readonly fenceScope: string;
  readonly resourceId: string;
  readonly ownerId: string;
  readonly epoch: number;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;
}

export interface OperationReceiptRow {
  readonly scopeKind: string;
  readonly scopeId: string;
  readonly idempotencyKey: string;
  readonly commitUnit: AtomicTransactionUnitName;
  readonly requestSha256: string;
  readonly resultingRevision: number;
  readonly responseJson: string;
  readonly committedAtMs: number;
}

export interface StateChangeOutboxRow {
  readonly outboxSeq: number;
  readonly commitUnit: AtomicTransactionUnitName;
  readonly scopeKind: string;
  readonly scopeId: string;
  readonly revision: number;
  readonly payloadJson: string;
  readonly createdAtMs: number;
  readonly deliveredAtMs: number | null;
}

export type TransactionUnitErrorCode =
  | 'STALE_REVISION'
  | 'FENCE_MISMATCH'
  | 'FENCE_EXPIRED'
  | 'IDEMPOTENCY_PAYLOAD_MISMATCH'
  | 'QUEUE_SATURATED'
  | 'WAL_BACKGROUND_PAUSED'
  | 'FOREIGN_KEY_VIOLATION'
  | 'CONSTRAINT_VIOLATION'
  | 'FAILPOINT_INJECTED'
  | 'STORAGE_BUSY_OR_FULL';

export type TransactionUnitOutcome<T> =
  | {
      readonly status: 'committed';
      readonly commitUnit: AtomicTransactionUnitName;
      readonly revision: number;
      readonly replayed: boolean;
      readonly outboxSeq?: number | undefined;
      readonly value: T;
    }
  | {
      readonly status: 'rejected';
      readonly commitUnit: AtomicTransactionUnitName;
      readonly code: TransactionUnitErrorCode;
      readonly message: string;
      readonly currentRevision?: number | undefined;
    };

export type RunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'aborted';

export type StepStatus =
  | 'pending'
  | 'running'
  | 'waiting_gate'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export type AttemptStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';

export interface RunRow {
  readonly runId: string;
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly frozenClosureId: string | null;
  readonly status: RunStatus;
  readonly revision: number;
  readonly currentStepId: string | null;
  readonly startedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly terminalReason: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface AdmissionCommitRequest {
  readonly idempotency: IdempotencyEnvelope;
  readonly fence: LeaseFenceToken;
  readonly expectedRevision: number;
  readonly failpointStep?: 'after_run_insert' | 'after_queue_insert' | 'before_receipt' | undefined;
  readonly run: {
    readonly runId: string;
    readonly workspaceId: string;
    readonly workflowId: string;
    readonly frozenClosureId?: string | null | undefined;
    readonly status?: 'queued' | 'running' | undefined;
    readonly priority: number;
    readonly claimedBy?: string | null | undefined;
    readonly claimEpoch?: number | undefined;
    readonly inputs?: Readonly<Record<string, unknown>> | undefined;
    readonly initialStep?: {
      readonly stepId: string;
      readonly stepIndex: number;
      readonly phaseId: string;
      readonly status?: StepStatus | undefined;
      readonly attemptId?: string | undefined;
    } | undefined;
  };
}

export interface TerminalAcceptanceCommitRequest {
  readonly idempotency: IdempotencyEnvelope;
  readonly fence: LeaseFenceToken;
  readonly expectedRevision: number;
  readonly failpointStep?: 'after_run_update' | 'after_queue_release' | 'before_receipt' | undefined;
  readonly settlement: {
    readonly runId: string;
    readonly terminalStatus: 'succeeded' | 'failed' | 'cancelled' | 'aborted';
    readonly terminalReason: string;
    readonly completedAtMs?: number | undefined;
    readonly stepSettlement?: {
      readonly stepId: string;
      readonly status: 'succeeded' | 'failed' | 'cancelled' | 'skipped';
      readonly attemptId?: string | undefined;
      readonly attemptStatus?: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | undefined;
      readonly exitCode?: number | null | undefined;
    } | undefined;
  };
}

export interface HandoffAcceptanceCommitRequest {
  readonly idempotency: IdempotencyEnvelope;
  readonly fence: LeaseFenceToken;
  readonly expectedRevision: number;
  readonly failpointStep?: 'after_result_insert' | 'after_handoff_insert' | 'before_receipt' | undefined;
  readonly handoff: {
    readonly runId: string;
    readonly resultId: string;
    readonly stepId: string;
    readonly attemptId: string;
    readonly schemaId: string;
    readonly values: ReadonlyArray<{
      readonly fieldPath: string;
      readonly valueType: 'string' | 'number' | 'boolean' | 'json' | 'artifact_ref';
      readonly valueText: string;
      readonly artifactId?: string | null | undefined;
    }>;
    readonly handoffId: string;
    readonly toStepId: string;
    readonly envelopeId: string;
    readonly envelopeDigestSha256: string;
    readonly bindings: ReadonlyArray<{
      readonly paramName: string;
      readonly boundValueJson: string;
      readonly sourceFieldPath: string;
    }>;
    readonly pinArtifactIds?: readonly string[] | undefined;
  };
}

export interface ReviewAcceptanceCommitRequest {
  readonly idempotency: IdempotencyEnvelope;
  readonly fence: LeaseFenceToken;
  readonly expectedRevision: number;
  readonly failpointStep?: 'after_loop_upsert' | 'after_findings_insert' | 'before_receipt' | undefined;
  readonly review: {
    readonly reviewLoopId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly iteration: number;
    readonly maxIterations: number;
    readonly loopStatus: 'open' | 'converged' | 'escalated' | 'aborted';
    readonly reportId: string;
    readonly reviewerRole: string;
    readonly verdict: 'pass' | 'changes_requested' | 'blocked';
    readonly findings: ReadonlyArray<{
      readonly findingId: string;
      readonly severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
      readonly category: string;
      readonly filePath: string;
      readonly lineNumber: number;
      readonly summary: string;
      readonly status: 'open' | 'claimed' | 'fixed' | 'waived' | 'false_positive';
      readonly disposition?: {
        readonly dispositionId: string;
        readonly disposition: 'fixed' | 'waived' | 'false_positive' | 'deferred';
        readonly actorId: string;
        readonly rationale: string;
      } | undefined;
      readonly fixClaim?: {
        readonly claimId: string;
        readonly claimantAttemptId: string;
        readonly commitSha: string;
        readonly status: 'pending_verification' | 'verified' | 'rejected';
      } | undefined;
    }>;
    readonly gateUpdate?: {
      readonly gateId: string;
      readonly gateType: 'approval' | 'quality' | 'security' | 'review' | 'manual';
      readonly status: 'open' | 'approved' | 'rejected' | 'expired';
      readonly decidedBy: string;
      readonly notes: string;
    } | undefined;
  };
}

export interface UsageCorrectionCommitRequest {
  readonly idempotency: IdempotencyEnvelope;
  readonly expectedRevision: number;
  readonly failpointStep?: 'after_observation' | 'after_application' | 'before_receipt' | undefined;
  readonly usage: {
    readonly runId: string;
    readonly stepId: string;
    readonly attemptId: string;
    readonly applicationId: string;
    readonly completeness: 'exact' | 'partial' | 'estimated';
    readonly observation?: {
      readonly observationId: string;
      readonly provider: string;
      readonly modelId: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cachedTokens: number;
      readonly costMicrodollars: number;
      readonly sourceKind: 'provider_exact' | 'parsed_footer' | 'estimated';
    } | undefined;
    readonly correction?: {
      readonly correctionId: string;
      readonly observationId: string;
      readonly reason: string;
      readonly deltaInputTokens: number;
      readonly deltaOutputTokens: number;
      readonly deltaCostMicrodollars: number;
      readonly pricingVersion: string;
    } | undefined;
  };
}

export interface CatalogPublicationCommitRequest {
  readonly idempotency: IdempotencyEnvelope;
  readonly expectedRevision: number;
  readonly failpointStep?: 'after_version_insert' | 'after_head_update' | 'before_receipt' | undefined;
  readonly publication: {
    readonly scope: 'workspace' | 'global' | 'builtin';
    readonly definitionId: string;
    readonly layer: 'phase' | 'pipeline' | 'workflow';
    readonly slug: string;
    readonly displayName: string;
    readonly definitionVersionId: string;
    readonly versionNumber: number;
    readonly status: 'draft' | 'published' | 'archived';
    readonly canonicalYaml: string;
    readonly digestSha256: string;
    readonly schemaVersion: number;
    readonly promoteAsPublished: boolean;
    readonly dependencies?: ReadonlyArray<{
      readonly toDefinitionId: string;
      readonly depLayer: 'phase' | 'pipeline';
      readonly depOrder: number;
    }> | undefined;
  };
}

export interface RetentionCommitRequest {
  readonly idempotency: IdempotencyEnvelope;
  readonly cutoffTimestampMs: number;
  readonly failpointStep?: 'after_receipt_sweep' | 'after_artifact_sweep' | 'before_receipt' | undefined;
}

export interface MigrationQuarantineRow {
  readonly quarantineId: string;
  readonly migrationId: string;
  readonly sourceSurface: string;
  readonly sourceRecordKey: string;
  readonly reasonCode: 'corrupt_json' | 'unknown_future_version' | 'schema_violation' | 'digest_mismatch';
  readonly detectedSchemaVersion: number | null;
  readonly rawPayload: string;
  readonly diagnosticJson: string;
  readonly resolved: 0 | 1;
  readonly createdAtMs: number;
}

export interface BackupExternalDependency {
  readonly dependencyKind: 'artifact_blob' | 'log_segment' | 'audit_log';
  readonly referenceId: string;
  readonly relativePath: string;
  readonly byteLength: number;
  readonly sha256Digest: string;
}

export interface BackupDependencyManifest {
  readonly backupId: string;
  readonly createdAtMs: number;
  readonly schemaVersion: number;
  readonly sqliteVersion: string;
  readonly databaseSha256: string;
  readonly databaseBytes: number;
  readonly cutoverAuthority: StorageAuthority;
  readonly externalDependencies: readonly BackupExternalDependency[];
}

export interface LatencyDistributionSummary {
  readonly operationName: string;
  readonly warmupSamples: number;
  readonly measuredSamples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly failureCount: number;
  readonly heapDeltaBytes: number;
}

export interface SqliteQualificationReport {
  readonly engineName: 'node:sqlite';
  readonly sqliteVersion: string;
  readonly sqliteSourceId: string;
  readonly meetsMinimumVersionFloor: boolean;
  readonly compileOptions: readonly string[];
  readonly verifiedPragmas: VerifiedPragmaState;
  readonly strictSchemaTableCount: number;
  readonly foreignKeyCheckViolations: number;
  readonly sqliteBenchmarks: readonly LatencyDistributionSummary[];
  readonly legacyMementoBenchmarks: readonly LatencyDistributionSummary[];
  readonly qualificationPassed: boolean;
}
