/**
 * FR-R6-F05 (NFR-006) — DDL of SQLite migration 2, `002_f05_artifact_lifecycle`.
 *
 * Additive and forward-only: it creates eleven `STRICT` tables and their
 * indexes, and alters no F04 table, column, CHECK or stored value. Every
 * foreign key that points at `artifacts` is `ON DELETE RESTRICT`; owner ids are
 * plain text with no foreign key, so no cascade can remove protection.
 *
 * The CHECK value lists are spelled out, not built from the contract
 * constants: the migration checksum covers this text, so it must never change
 * once shipped. `schema-migration.test.ts` asserts the lists still equal the
 * constants.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export const F05_LIFECYCLE_MIGRATION_VERSION = 2 as const;
export const F05_LIFECYCLE_MIGRATION_NAME = '002_f05_artifact_lifecycle' as const;

export const F05_LIFECYCLE_TABLE_NAMES = [
  'artifact_lifecycle',
  'artifact_references',
  'retention_policy_revisions',
  'retention_previews',
  'deletion_operations',
  'deletion_targets',
  'sweep_leases',
  'preservation_operations',
  'preservation_targets',
  'archived_task_summaries',
  'storage_scan_checkpoints'
] as const;

export const F05_LIFECYCLE_DDL: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS artifact_lifecycle (
    artifact_id TEXT PRIMARY KEY REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
    lifecycle_revision INTEGER NOT NULL CHECK (lifecycle_revision >= 1),
    owner_run_id TEXT,
    owner_attempt_id TEXT,
    sensitivity TEXT NOT NULL CHECK (sensitivity IN ('metadata', 'content', 'secret-adjacent')),
    retention_class TEXT NOT NULL CHECK (retention_class IN (
      'new-terminal-execution-usage-detail',
      'active-and-recovery-required-metadata',
      'aggregate-history',
      'transcripts-diagnostics-checkpoints-audit-catalog',
      'generated-reports-handoff-exports',
      'provider-owned-session-stores'
    )),
    store_kind TEXT NOT NULL CHECK (store_kind IN (
      'transcript', 'diagnostic', 'checkpoint', 'audit', 'catalog', 'report', 'handoff-context',
      'review-report', 'live-log-segment', 'export-copy', 'quarantine', 'provider-session', 'unclassified'
    )),
    immutability TEXT NOT NULL CHECK (immutability IN ('immutable', 'growing')),
    digest_algorithm TEXT CHECK (digest_algorithm IS NULL OR digest_algorithm = 'sha256'),
    digest_value TEXT CHECK (
      digest_value IS NULL OR (length(digest_value) = 64 AND digest_value NOT GLOB '*[^0-9a-f]*')
    ),
    generation INTEGER CHECK (generation IS NULL OR generation >= 0),
    extent_bytes INTEGER CHECK (extent_bytes IS NULL OR extent_bytes >= 0),
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    availability TEXT NOT NULL CHECK (availability IN (
      'present', 'pending', 'missing', 'expired', 'deleted', 'corrupt', 'unverified'
    )),
    producer_identity TEXT NOT NULL,
    display_name TEXT NOT NULL CHECK (length(CAST(display_name AS BLOB)) <= 256),
    created_at_ms INTEGER NOT NULL,
    terminal_settled_at_ms INTEGER,
    expires_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL,
    CHECK (
      (immutability = 'immutable' AND digest_algorithm IS NOT NULL AND digest_value IS NOT NULL
        AND generation IS NULL AND extent_bytes IS NULL)
      OR (immutability = 'growing' AND digest_algorithm IS NULL AND digest_value IS NULL
        AND generation IS NOT NULL AND extent_bytes IS NOT NULL)
    )
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_artifact_lifecycle_class_keyset ON artifact_lifecycle(retention_class, artifact_id)`,
  `CREATE INDEX IF NOT EXISTS idx_artifact_lifecycle_owner_run ON artifact_lifecycle(owner_run_id)`,
  `CREATE TABLE IF NOT EXISTS artifact_references (
    reference_id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
    owner_type TEXT NOT NULL CHECK (owner_type IN ('run', 'attempt', 'handoff', 'export', 'phase-context', 'operator')),
    owner_id TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN (
      'active-recovery', 'paused-recovery', 'uncertain-recovery', 'pending-handoff',
      'report-lease', 'export-operation', 'phase-context', 'operator-hold'
    )),
    protective INTEGER NOT NULL CHECK (protective IN (0, 1)),
    created_revision INTEGER NOT NULL CHECK (created_revision >= 0),
    released_revision INTEGER,
    release_reason TEXT CHECK (
      release_reason IS NULL OR release_reason IN ('owner-durable', 'operator-early-release', 'expired')
    ),
    created_at_ms INTEGER NOT NULL,
    released_at_ms INTEGER,
    UNIQUE (artifact_id, owner_type, owner_id, purpose),
    CHECK ((released_revision IS NULL) = (release_reason IS NULL))
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_artifact_references_owner ON artifact_references(owner_type, owner_id)`,
  `CREATE INDEX IF NOT EXISTS idx_artifact_references_active ON artifact_references(artifact_id) WHERE released_revision IS NULL`,
  `CREATE TABLE IF NOT EXISTS retention_policy_revisions (
    policy_revision INTEGER PRIMARY KEY CHECK (policy_revision >= 1),
    state TEXT NOT NULL CHECK (state IN ('proposed', 'adopted', 'superseded')),
    policy_json TEXT NOT NULL,
    preview_id TEXT,
    created_at_ms INTEGER NOT NULL,
    adopted_at_ms INTEGER
  ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_retention_policy_single_adopted ON retention_policy_revisions(state) WHERE state = 'adopted'`,
  `CREATE TABLE IF NOT EXISTS retention_previews (
    preview_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('policy-adoption', 'deletion', 'early-release', 'archival', 'legacy-quarantine')),
    basis_revision TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS deletion_operations (
    operation_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    preview_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('planned', 'executing', 'completed', 'partial', 'refused', 'cancelled')),
    fence_token TEXT NOT NULL,
    planned_count INTEGER NOT NULL CHECK (planned_count >= 0),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS deletion_targets (
    operation_id TEXT NOT NULL REFERENCES deletion_operations(operation_id) ON DELETE RESTRICT,
    target_ordinal INTEGER NOT NULL CHECK (target_ordinal >= 0),
    artifact_id TEXT REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
    target_key TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN (
      'planned', 'executing', 'deleted', 'already-absent', 'retained', 'unknown', 'refused'
    )),
    reason_code TEXT,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (operation_id, target_ordinal)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS sweep_leases (
    workspace_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    holder_id TEXT NOT NULL,
    acquired_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS preservation_operations (
    operation_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    preview_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('planned', 'copying', 'verifying', 'completed', 'ambiguous', 'refused')),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS preservation_targets (
    operation_id TEXT NOT NULL REFERENCES preservation_operations(operation_id) ON DELETE RESTRICT,
    target_ordinal INTEGER NOT NULL CHECK (target_ordinal >= 0),
    source_key TEXT NOT NULL,
    destination_key TEXT,
    source_digest TEXT,
    destination_digest TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('preserved-in-place', 'quarantined', 'ambiguous', 'refused')),
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (operation_id, target_ordinal)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS archived_task_summaries (
    queue_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    terminal_resolved_at_ms INTEGER NOT NULL,
    archived_at_ms INTEGER NOT NULL,
    summary_json TEXT NOT NULL,
    retained_reference_ids_json TEXT NOT NULL,
    detail_expires_at_ms INTEGER NOT NULL,
    detail_state TEXT NOT NULL CHECK (detail_state IN ('retained', 'expired')),
    PRIMARY KEY (queue_id, task_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS storage_scan_checkpoints (
    scan_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    policy_revision INTEGER NOT NULL CHECK (policy_revision >= 0),
    started_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER,
    coverage TEXT NOT NULL CHECK (coverage IN ('complete', 'partial')),
    cursor_json TEXT NOT NULL,
    totals_json TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_storage_scan_checkpoints_workspace ON storage_scan_checkpoints(workspace_id, started_at_ms DESC)`
]);
