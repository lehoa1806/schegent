/**
 * Round 6 Production Integration Schema — SQLite migration 8 (`008_round6_production_integration`).
 *
 * Additive and forward-only across Round 6 integration packages (`F04`, `F01-B`, `F09-FR-17`,
 * `F10`, `F11`, `F13-B/C`, `F14-B`, `F15-B`):
 *   - `containment_qualifications` and `containment_acceptance_bindings` (`F09-FR-01`, `F09-FR-13`, `F09-FR-17`);
 *   - `acp_authorization_receipts` (`F09-FR-17`, `F09-AC-08`, `F13-FR-09`, `F13-FR-10`);
 *   - `acp_observation_ledger` (`F13-FR-18` bounded generation + receive-sequence observation index);
 *   - `operational_kv_documents` (`F04` / `F01-B` / `F03` SQLite-authoritative operational state
 *     projections with terminal retention indexing);
 *   - `telemetry_export_ledger` and `telemetry_spool_batches` (`F14-FR-10`, `F14-FR-19`, `F14-NFR-01`);
 *   - `phase_handoff_records` and `phase_review_loop_ledgers` (`F15-FR-07`, `F15-FR-09`, `F15-FR-27`);
 *   - additive attribution/lane/invocation columns on `runs` and `attempts` (`F10-FR-08`, `F11-FR-01/02/07/23`).
 *
 * Every table is `STRICT`. Never edit migrations 1 to 7; checksum verification covers this text.
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export const R6_INTEGRATION_MIGRATION_VERSION = 8 as const;
export const R6_INTEGRATION_MIGRATION_NAME = '008_round6_production_integration' as const;

export const R6_INTEGRATION_TABLE_NAMES = Object.freeze([
  'containment_qualifications',
  'containment_acceptance_bindings',
  'acp_authorization_receipts',
  'acp_observation_ledger',
  'operational_kv_documents',
  'telemetry_export_ledger',
  'telemetry_spool_batches',
  'phase_handoff_records',
  'phase_review_loop_ledgers'
] as const);

export const R6_INTEGRATION_DDL: readonly string[] = Object.freeze([
  `ALTER TABLE runs ADD COLUMN queue_id TEXT`,
  `ALTER TABLE runs ADD COLUMN backend_kind TEXT`,
  `ALTER TABLE runs ADD COLUMN model_id TEXT`,
  `ALTER TABLE runs ADD COLUMN profile_id TEXT`,
  `ALTER TABLE runs ADD COLUMN lane_id TEXT`,
  `ALTER TABLE runs ADD COLUMN invocation_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE attempts ADD COLUMN backend_kind TEXT`,
  `ALTER TABLE attempts ADD COLUMN model_id TEXT`,
  `ALTER TABLE attempts ADD COLUMN profile_id TEXT`,
  `ALTER TABLE attempts ADD COLUMN lane_id TEXT`,
  `ALTER TABLE attempts ADD COLUMN failure_cause TEXT`,
  `ALTER TABLE attempts ADD COLUMN invocation_count INTEGER NOT NULL DEFAULT 1`,
  `CREATE TABLE IF NOT EXISTS containment_qualifications (
    qualification_key_id TEXT PRIMARY KEY,
    backend_kind TEXT NOT NULL CHECK (backend_kind IN ('claude', 'codex', 'agy')),
    version_minor TEXT NOT NULL,
    os TEXT NOT NULL,
    arch TEXT NOT NULL,
    mechanism TEXT NOT NULL,
    fingerprint_sha256 TEXT NOT NULL CHECK (length(fingerprint_sha256) = 64),
    acp_segment TEXT NOT NULL CHECK (acp_segment IN ('not-applicable', 'native-stdio-v1', 'bridge-stdio-v1', 'unqualified-acp')),
    qualified INTEGER NOT NULL CHECK (qualified IN (0, 1)),
    identity_state TEXT NOT NULL CHECK (identity_state IN ('observed', 'unverified', 'not-observed')),
    record_json TEXT NOT NULL CHECK (length(record_json) <= 32768),
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS containment_acceptance_bindings (
    backend_kind TEXT PRIMARY KEY CHECK (backend_kind IN ('claude', 'codex', 'agy')),
    fingerprint_sha256 TEXT NOT NULL CHECK (length(fingerprint_sha256) = 64),
    origin TEXT NOT NULL CHECK (origin IN ('consent', 'legacy-first-use')),
    fingerprint_json TEXT NOT NULL CHECK (length(fingerprint_json) <= 8192),
    bound_at_utc TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS acp_authorization_receipts (
    receipt_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    connection_generation INTEGER NOT NULL CHECK (connection_generation >= 1),
    session_id TEXT NOT NULL,
    attempt_id TEXT,
    request_kind TEXT NOT NULL CHECK (request_kind IN ('permission', 'fs', 'terminal', 'resource_link')),
    idempotency_key TEXT NOT NULL UNIQUE,
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'denied', 'cancelled', 'refused')),
    reason_code TEXT NOT NULL,
    fenced_epoch INTEGER NOT NULL CHECK (fenced_epoch >= 0),
    recorded_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_acp_auth_receipts_session ON acp_authorization_receipts (session_id, recorded_at_ms DESC)`,
  `CREATE TABLE IF NOT EXISTS acp_observation_ledger (
    observation_key TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    connection_generation INTEGER NOT NULL CHECK (connection_generation >= 1),
    host_receive_seq INTEGER NOT NULL CHECK (host_receive_seq >= 1),
    acp_session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    attempt_id TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('live', 'history')),
    kind TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
    observed_at_ms INTEGER NOT NULL,
    UNIQUE (profile_id, connection_generation, host_receive_seq)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_acp_observations_attempt ON acp_observation_ledger (attempt_id, observed_at_ms ASC)`,
  `CREATE TABLE IF NOT EXISTS operational_kv_documents (
    doc_namespace TEXT NOT NULL,
    doc_key TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
    payload_json TEXT NOT NULL,
    payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
    is_terminal INTEGER NOT NULL CHECK (is_terminal IN (0, 1)),
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (doc_namespace, doc_key)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_operational_kv_terminal ON operational_kv_documents (doc_namespace, is_terminal, updated_at_ms ASC)`,
  `CREATE TABLE IF NOT EXISTS telemetry_export_ledger (
    record_kind TEXT NOT NULL,
    record_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    profile_id TEXT NOT NULL,
    mapping_revision INTEGER NOT NULL CHECK (mapping_revision >= 1),
    state TEXT NOT NULL CHECK (state IN ('pending', 'exported', 'dropped')),
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (record_kind, record_id, revision, profile_id, mapping_revision)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS telemetry_spool_batches (
    batch_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    signal TEXT NOT NULL CHECK (signal IN ('traces', 'metrics', 'logs')),
    payload_json TEXT NOT NULL,
    payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
    attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
    next_attempt_at_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_telemetry_spool_due ON telemetry_spool_batches (profile_id, next_attempt_at_ms ASC, created_at_ms ASC)`,
  `CREATE TABLE IF NOT EXISTS phase_handoff_records (
    handoff_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    source_attempt_id TEXT NOT NULL,
    target_phase_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    status TEXT NOT NULL,
    record_json TEXT NOT NULL,
    record_bytes INTEGER NOT NULL CHECK (record_bytes >= 0),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_phase_handoff_run ON phase_handoff_records (run_id, updated_at_ms DESC)`,
  `CREATE TABLE IF NOT EXISTS phase_review_loop_ledgers (
    loop_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL CHECK (iteration >= 0),
    verdict TEXT NOT NULL,
    ledger_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_phase_review_loop_run ON phase_review_loop_ledgers (run_id, updated_at_ms DESC)`
]);
