/**
 * FR-R6-F06 (FR-014, NFR-004) — DDL of SQLite migration 3, `003_f06_usage_accounting`.
 *
 * Additive and forward-only: it creates eleven `STRICT` tables and their indexes, and alters
 * no F04 or F05 table. No foreign key points into an F04 run table (research R14): attempt
 * and root ids are plain text, so accounting never blocks or cascades a run-table change.
 *
 * The CHECK value lists are spelled out, not built from the contract constants: the
 * migration checksum covers this text, so it must never change once shipped.
 * `accounting-schema.test.ts` asserts the lists still equal the constants.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export const F06_ACCOUNTING_MIGRATION_VERSION = 3 as const;
export const F06_ACCOUNTING_MIGRATION_NAME = '003_f06_usage_accounting' as const;

export const F06_ACCOUNTING_TABLE_NAMES = [
  'accounting_observations',
  'accounting_observation_measures',
  'accounting_contributions',
  'accounting_corrections',
  'accounting_revisions',
  'accounting_projection_intents',
  'accounting_attempts',
  'accounting_root_outcomes',
  'accounting_gaps',
  'accounting_legacy_epoch',
  'accounting_legacy_runs'
] as const;

export const F06_ACCOUNTING_DDL: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS accounting_observations (
    observation_id TEXT PRIMARY KEY,
    ingest_seq INTEGER NOT NULL UNIQUE CHECK (ingest_seq >= 1),
    dedup_key TEXT UNIQUE,
    content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
    producer_namespace TEXT NOT NULL CHECK (length(producer_namespace) BETWEEN 1 AND 64),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('phase-end', 'acp-usage-update', 'correction', 'fixture')),
    source_identity TEXT CHECK (source_identity IS NULL OR length(CAST(source_identity AS BLOB)) <= 256),
    observation_revision INTEGER NOT NULL CHECK (observation_revision >= 1),
    workspace_id TEXT NOT NULL,
    root_id TEXT,
    attempt_id TEXT,
    invocation_ordinal INTEGER CHECK (invocation_ordinal IS NULL OR invocation_ordinal >= 0),
    counter_scope TEXT NOT NULL CHECK (counter_scope IN ('invocation-delta', 'session-cumulative', 'acp-context-occupancy', 'legacy-run-total')),
    adapter_version TEXT NOT NULL,
    normalization_version INTEGER NOT NULL CHECK (normalization_version = 1),
    backend TEXT,
    model_requested TEXT,
    model_reported TEXT,
    provider_session_ref TEXT CHECK (provider_session_ref IS NULL OR length(provider_session_ref) = 32),
    workflow_revision TEXT,
    phase_id TEXT,
    event_utc TEXT NOT NULL,
    observed_utc TEXT NOT NULL,
    ingested_utc TEXT NOT NULL,
    ingested_monotonic_ms INTEGER NOT NULL,
    clock_anomaly INTEGER NOT NULL CHECK (clock_anomaly IN (0, 1)),
    disposition TEXT NOT NULL CHECK (disposition IN ('accepted', 'corroborating', 'conflicting', 'superseded', 'unattributed', 'historical', 'correction')),
    uncertainty_reason TEXT CHECK (uncertainty_reason IS NULL OR uncertainty_reason IN ('invalid-counter', 'dimension-excluded', 'unattributed-limit', 'admission-overflow', 'ingest-failed', 'projection-failed', 'expired-source', 'telemetry-echo', 'cumulative-reset', 'unattributed-session-baseline', 'observation-too-large', 'correction-refused')),
    CHECK ((root_id IS NOT NULL AND attempt_id IS NOT NULL) OR disposition IN ('unattributed', 'historical'))
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_accounting_observations_attempt ON accounting_observations(attempt_id, invocation_ordinal)`,
  `CREATE INDEX IF NOT EXISTS idx_accounting_observations_disposition ON accounting_observations(disposition, ingest_seq)`,
  `CREATE INDEX IF NOT EXISTS idx_accounting_observations_event ON accounting_observations(event_utc)`,
  `CREATE TABLE IF NOT EXISTS accounting_observation_measures (
    observation_id TEXT NOT NULL REFERENCES accounting_observations(observation_id) ON DELETE CASCADE,
    measure TEXT NOT NULL CHECK (measure IN ('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cost', 'credits', 'context_used', 'context_size')),
    quantity INTEGER CHECK (quantity IS NULL OR quantity >= 0),
    unit TEXT NOT NULL,
    reported_scale INTEGER CHECK (reported_scale IS NULL OR reported_scale BETWEEN 0 AND 6),
    completeness TEXT NOT NULL CHECK (completeness IN ('known', 'partial', 'unknown')),
    provenance TEXT NOT NULL CHECK (provenance IN ('provider-reported', 'derived', 'estimated')),
    cache_relation TEXT CHECK (cache_relation IS NULL OR cache_relation IN ('subset-of-input', 'disjoint', 'unknown')),
    pricing_version TEXT,
    unknown_reason TEXT,
    PRIMARY KEY (observation_id, measure),
    CHECK ((quantity IS NULL) = (completeness = 'unknown')),
    CHECK ((unknown_reason IS NOT NULL) = (completeness = 'unknown')),
    CHECK ((cache_relation IS NOT NULL) = (measure IN ('cache_read_tokens', 'cache_creation_tokens'))),
    CHECK (pricing_version IS NOT NULL OR provenance <> 'estimated' OR measure <> 'cost'),
    CHECK (
      (measure IN ('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'context_used', 'context_size') AND unit = 'count' AND reported_scale IS NULL)
      OR (measure = 'cost' AND length(unit) = 3 AND unit GLOB '[A-Z][A-Z][A-Z]')
      OR (measure = 'credits' AND length(unit) BETWEEN 1 AND 32 AND unit GLOB '[a-z]*' AND unit NOT GLOB '*[^a-z0-9._-]*')
    )
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS accounting_attempts (
    attempt_id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    backend TEXT,
    model TEXT,
    workflow_revision TEXT,
    phase_id TEXT,
    outcome TEXT NOT NULL DEFAULT 'unknown' CHECK (outcome IN ('succeeded', 'failed', 'cancelled', 'interrupted', 'superseded', 'unknown')),
    first_event_utc TEXT NOT NULL,
    last_event_utc TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_accounting_attempts_root ON accounting_attempts(root_id)`,
  `CREATE TABLE IF NOT EXISTS accounting_revisions (
    revision INTEGER PRIMARY KEY CHECK (revision >= 1),
    committed_utc TEXT NOT NULL,
    cause TEXT NOT NULL CHECK (cause IN ('ingest', 'correction', 'outcome', 'rebuild', 'policy', 'legacy-import')),
    cutoff_ingest_seq INTEGER NOT NULL CHECK (cutoff_ingest_seq >= 0),
    policy_version INTEGER NOT NULL CHECK (policy_version = 1),
    calculation_version INTEGER NOT NULL CHECK (calculation_version = 1)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS accounting_corrections (
    correction_id INTEGER PRIMARY KEY,
    target_observation_id TEXT NOT NULL,
    measure TEXT NOT NULL CHECK (measure IN ('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cost', 'credits', 'context_used', 'context_size')),
    replacement_quantity INTEGER CHECK (replacement_quantity IS NULL OR replacement_quantity >= 0),
    unit TEXT NOT NULL,
    reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 64 AND reason_code GLOB '[a-z]*' AND reason_code NOT GLOB '*[^a-z0-9-]*'),
    actor TEXT NOT NULL CHECK (actor IN ('operator', 'provider')),
    recorded_utc TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_accounting_corrections_target ON accounting_corrections(target_observation_id, measure)`,
  `CREATE TABLE IF NOT EXISTS accounting_contributions (
    contribution_id INTEGER PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES accounting_attempts(attempt_id),
    invocation_ordinal INTEGER CHECK (invocation_ordinal IS NULL OR invocation_ordinal >= 0),
    measure TEXT NOT NULL CHECK (measure IN ('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cost', 'credits', 'context_used', 'context_size')),
    unit TEXT NOT NULL,
    quantity INTEGER CHECK (quantity IS NULL OR quantity >= 0),
    completeness TEXT NOT NULL CHECK (completeness IN ('known', 'partial', 'unknown', 'conflicting')),
    provenance TEXT NOT NULL CHECK (provenance IN ('provider-reported', 'derived', 'estimated')),
    cost_origin TEXT CHECK (cost_origin IS NULL OR cost_origin IN ('reported', 'estimated')),
    selected_observation_id TEXT REFERENCES accounting_observations(observation_id),
    correction_id INTEGER REFERENCES accounting_corrections(correction_id),
    from_revision INTEGER NOT NULL CHECK (from_revision >= 1),
    to_revision INTEGER CHECK (to_revision IS NULL OR to_revision > from_revision),
    CHECK ((quantity IS NULL) = (completeness = 'unknown'))
  ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_contributions_open ON accounting_contributions(attempt_id, IFNULL(invocation_ordinal, -1), measure, unit) WHERE to_revision IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_accounting_contributions_attempt ON accounting_contributions(attempt_id, from_revision)`,
  `CREATE INDEX IF NOT EXISTS idx_accounting_contributions_from ON accounting_contributions(from_revision)`,
  `CREATE INDEX IF NOT EXISTS idx_accounting_contributions_to ON accounting_contributions(to_revision)`,
  `CREATE INDEX IF NOT EXISTS idx_accounting_contributions_selected ON accounting_contributions(selected_observation_id)`,
  `CREATE TABLE IF NOT EXISTS accounting_projection_intents (
    intent_id INTEGER PRIMARY KEY,
    observation_id TEXT NOT NULL REFERENCES accounting_observations(observation_id),
    state TEXT NOT NULL CHECK (state IN ('pending', 'applied')),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    created_utc TEXT NOT NULL,
    applied_revision INTEGER,
    CHECK ((applied_revision IS NOT NULL) = (state = 'applied'))
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_accounting_intents_state ON accounting_projection_intents(state, intent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_accounting_intents_observation ON accounting_projection_intents(observation_id)`,
  `CREATE TABLE IF NOT EXISTS accounting_root_outcomes (
    root_id TEXT NOT NULL,
    transition_seq INTEGER NOT NULL CHECK (transition_seq >= 1),
    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'cancelled', 'interrupted')),
    terminal_utc TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    PRIMARY KEY (root_id, transition_seq)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS accounting_gaps (
    gap_kind TEXT NOT NULL CHECK (gap_kind IN ('invalid-counter', 'dimension-excluded', 'unattributed-limit', 'admission-overflow', 'ingest-failed', 'projection-failed', 'expired-source', 'telemetry-echo', 'cumulative-reset', 'unattributed-session-baseline', 'observation-too-large', 'correction-refused')),
    scope_key TEXT NOT NULL,
    count INTEGER NOT NULL CHECK (count >= 1),
    first_seen_utc TEXT NOT NULL,
    last_seen_utc TEXT NOT NULL,
    PRIMARY KEY (gap_kind, scope_key)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS accounting_legacy_epoch (
    epoch_id INTEGER PRIMARY KEY CHECK (epoch_id = 1),
    state TEXT NOT NULL CHECK (state IN ('importing', 'complete')),
    boundary_run_id TEXT,
    boundary_terminal_utc TEXT,
    imported_runs INTEGER NOT NULL CHECK (imported_runs >= 0),
    legacy_cost_micros INTEGER NOT NULL CHECK (legacy_cost_micros >= 0),
    carry_forward_header TEXT CHECK (carry_forward_header IS NULL OR length(CAST(carry_forward_header AS BLOB)) <= 4096),
    reconciliation TEXT CHECK (reconciliation IS NULL OR reconciliation IN ('matched', 'mismatch', 'empty')),
    reconciliation_detail TEXT CHECK (reconciliation_detail IS NULL OR length(CAST(reconciliation_detail AS BLOB)) <= 1024),
    started_utc TEXT NOT NULL,
    completed_utc TEXT
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS accounting_legacy_runs (
    run_id TEXT PRIMARY KEY,
    terminal_utc TEXT NOT NULL,
    outcome TEXT NOT NULL,
    cost_micros INTEGER CHECK (cost_micros IS NULL OR cost_micros >= 0),
    cost_origin TEXT NOT NULL CHECK (cost_origin = 'legacy-float'),
    input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0)
  ) STRICT`
]);
