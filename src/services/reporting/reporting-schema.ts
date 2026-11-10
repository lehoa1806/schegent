/**
 * FR-R6-F11 (data-model.md, research R4) — DDL of SQLite migration 7, `007_f11_reporting`.
 *
 * Additive and forward-only:
 *   - two read indexes, so the capture's range scan and per-root attempt read are indexed
 *     (FR-023): `runs` had only an index on the mutable `updated_at_ms`, and `attempts` had none
 *     on `run_id`;
 *   - `report_saved`, the saved reports, with a self-reference that becomes NULL on delete;
 *   - `report_exports`, one row per export, with a partial unique index that admits one
 *     `pending` export per workspace even across windows (NFR-003).
 *
 * The F04 skeleton tables `report_manifests`, `report_leases` and `export_operations` stay unused
 * (research R4). No column holds a prompt, a transcript or a free-text reason. `staging_dir` is
 * the resolved export directory, read only by reconciliation and never returned.
 *
 * The CHECK value lists are spelled out, not built from the contract constants: the migration
 * checksum covers this text, so it must never change once shipped. `reporting-schema.test.ts`
 * asserts the lists still equal the constants.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export const F11_REPORTING_MIGRATION_VERSION = 7 as const;
export const F11_REPORTING_MIGRATION_NAME = '007_f11_reporting' as const;

export const F11_REPORTING_TABLE_NAMES = Object.freeze(['report_saved', 'report_exports'] as const);

export const F11_REPORTING_INDEX_NAMES = Object.freeze([
  'idx_runs_workspace_created',
  'idx_attempts_run',
  'idx_report_saved_workspace',
  'idx_report_exports_one_pending'
] as const);

export const F11_REPORTING_DDL: readonly string[] = Object.freeze([
  `CREATE INDEX IF NOT EXISTS idx_runs_workspace_created ON runs (workspace_id, created_at_ms, run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_run ON attempts (run_id, attempt_number, attempt_id)`,
  `CREATE TABLE IF NOT EXISTS report_saved (
    report_id TEXT PRIMARY KEY CHECK (length(report_id) = 32),
    workspace_id TEXT NOT NULL,
    rerun_of TEXT REFERENCES report_saved (report_id) ON DELETE SET NULL,
    view TEXT NOT NULL CHECK (view IN ('execution-summary', 'attempt-detail', 'failure-cause', 'workflow-revision', 'time-series', 'usage')),
    query_json TEXT NOT NULL CHECK (length(query_json) <= 16384),
    manifest_json TEXT NOT NULL CHECK (length(manifest_json) <= 65536),
    manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
    calculation_version INTEGER NOT NULL CHECK (calculation_version >= 1),
    accounting_revision INTEGER CHECK (accounting_revision IS NULL OR accounting_revision >= 0),
    source_cutoff_ms INTEGER NOT NULL,
    population_digest TEXT NOT NULL CHECK (length(population_digest) = 64),
    created_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_report_saved_workspace ON report_saved (workspace_id, created_at_ms, report_id)`,
  `CREATE TABLE IF NOT EXISTS report_exports (
    export_id TEXT PRIMARY KEY CHECK (length(export_id) = 32),
    workspace_id TEXT NOT NULL,
    report_id TEXT NOT NULL CHECK (length(report_id) = 32),
    format TEXT NOT NULL CHECK (format IN ('json', 'csv')),
    state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'failed', 'cancelled', 'limited')),
    staging_dir TEXT NOT NULL,
    final_name TEXT NOT NULL,
    data_partial_name TEXT NOT NULL,
    manifest_partial_name TEXT NOT NULL,
    overwrite INTEGER NOT NULL CHECK (overwrite IN (0, 1)),
    outcome_reason TEXT,
    row_count INTEGER CHECK (row_count IS NULL OR row_count >= 0),
    byte_length INTEGER CHECK (byte_length IS NULL OR byte_length >= 0),
    content_sha256 TEXT CHECK (content_sha256 IS NULL OR length(content_sha256) = 64),
    created_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER
  ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_report_exports_one_pending ON report_exports (workspace_id) WHERE state = 'pending'`
]);
