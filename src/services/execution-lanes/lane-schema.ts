/**
 * FR-R6-F10 (data-model.md) — DDL of SQLite migration 6, `006_f10_execution_lanes`.
 *
 * Additive and forward-only: eight `STRICT` tables and five indexes; no table of migrations 1 to 5
 * is altered. The F04 skeleton tables `execution_workspaces`, `candidate_snapshots` and
 * `integration_receipts` stay as they are: they need `runs`, `steps` and `attempts` rows
 * production does not write before F01-B (research R11).
 *
 * No table has a foreign key. Rows outlive a lane's removal (FR-005), and the store layer joins
 * by identifier. No column holds an absolute path, an environment value, Git stderr or a check's
 * output (SC-006): `root_ref` is relative to the caller's storage directory.
 *
 * The CHECK value lists are spelled out, not built from the contract constants: the migration
 * checksum covers this text, so it must never change once shipped. `lane-schema.test.ts` asserts
 * the lists still equal the constants.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export const F10_LANES_MIGRATION_VERSION = 6 as const;
export const F10_LANES_MIGRATION_NAME = '006_f10_execution_lanes' as const;

export const F10_LANES_TABLE_NAMES = Object.freeze([
  'execution_lanes',
  'lane_operations',
  'lane_candidates',
  'lane_integration_requests',
  'lane_verification_results',
  'lane_review_receipts',
  'lane_integration_journal',
  'lane_host_generations'
] as const);

export const F10_LANES_DDL: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS execution_lanes (
    lane_id TEXT PRIMARY KEY CHECK (length(lane_id) = 32 AND lane_id NOT GLOB '*[^0-9a-f]*'),
    workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
    repository_id TEXT NOT NULL CHECK (length(repository_id) = 64 AND repository_id NOT GLOB '*[^0-9a-f]*'),
    root_execution_id TEXT NOT NULL CHECK (length(root_execution_id) BETWEEN 1 AND 128),
    source_commit TEXT NOT NULL CHECK (length(source_commit) IN (40, 64) AND source_commit NOT GLOB '*[^0-9a-f]*'),
    base_ref TEXT NOT NULL CHECK (length(CAST(base_ref AS BLOB)) BETWEEN 1 AND 128),
    candidate_ref TEXT NOT NULL CHECK (length(CAST(candidate_ref AS BLOB)) BETWEEN 1 AND 128),
    root_ref TEXT NOT NULL CHECK (length(CAST(root_ref AS BLOB)) BETWEEN 1 AND 200 AND root_ref NOT LIKE '/%'),
    dependency_recipe TEXT NOT NULL CHECK (dependency_recipe IN ('none')),
    state TEXT NOT NULL CHECK (state IN ('preparing', 'active', 'paused', 'completed', 'retained', 'cleanup-eligible', 'removed', 'preparation-failed')),
    state_reason TEXT CHECK (state_reason IS NULL OR length(state_reason) BETWEEN 1 AND 64),
    pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
    owner_generation INTEGER NOT NULL CHECK (owner_generation >= 1),
    created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 32),
    updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 32)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS execution_lanes_by_workspace ON execution_lanes (workspace_id, created_at, lane_id)`,
  `CREATE TABLE IF NOT EXISTS lane_operations (
    operation_id TEXT PRIMARY KEY CHECK (length(operation_id) = 32 AND operation_id NOT GLOB '*[^0-9a-f]*'),
    lane_id TEXT NOT NULL CHECK (length(lane_id) = 32 AND lane_id NOT GLOB '*[^0-9a-f]*'),
    workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
    kind TEXT NOT NULL CHECK (kind IN ('provision', 'cleanup', 'reconcile')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'refused', 'kept')),
    reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 64),
    owner_generation INTEGER NOT NULL CHECK (owner_generation >= 1),
    started_at TEXT NOT NULL CHECK (length(started_at) BETWEEN 20 AND 32),
    ended_at TEXT CHECK (ended_at IS NULL OR length(ended_at) BETWEEN 20 AND 32)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS lane_operations_by_lane ON lane_operations (lane_id, started_at)`,
  `CREATE TABLE IF NOT EXISTS lane_candidates (
    candidate_id TEXT PRIMARY KEY CHECK (length(candidate_id) = 32 AND candidate_id NOT GLOB '*[^0-9a-f]*'),
    lane_id TEXT NOT NULL CHECK (length(lane_id) = 32 AND lane_id NOT GLOB '*[^0-9a-f]*'),
    candidate_seq INTEGER NOT NULL CHECK (candidate_seq >= 1),
    commit_sha TEXT NOT NULL CHECK (length(commit_sha) IN (40, 64) AND commit_sha NOT GLOB '*[^0-9a-f]*'),
    tree_sha TEXT NOT NULL CHECK (length(tree_sha) IN (40, 64) AND tree_sha NOT GLOB '*[^0-9a-f]*'),
    parent_sha TEXT NOT NULL CHECK (length(parent_sha) IN (40, 64) AND parent_sha NOT GLOB '*[^0-9a-f]*'),
    owner_generation INTEGER NOT NULL CHECK (owner_generation >= 1),
    frozen_at TEXT NOT NULL CHECK (length(frozen_at) BETWEEN 20 AND 32),
    UNIQUE (lane_id, candidate_seq)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS lane_integration_requests (
    request_id TEXT PRIMARY KEY CHECK (length(request_id) = 32 AND request_id NOT GLOB '*[^0-9a-f]*'),
    lane_id TEXT NOT NULL CHECK (length(lane_id) = 32 AND lane_id NOT GLOB '*[^0-9a-f]*'),
    workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
    repository_id TEXT NOT NULL CHECK (length(repository_id) = 64 AND repository_id NOT GLOB '*[^0-9a-f]*'),
    candidate_id TEXT NOT NULL CHECK (length(candidate_id) = 32 AND candidate_id NOT GLOB '*[^0-9a-f]*'),
    candidate_commit TEXT NOT NULL CHECK (length(candidate_commit) IN (40, 64) AND candidate_commit NOT GLOB '*[^0-9a-f]*'),
    target_ref TEXT NOT NULL CHECK (length(CAST(target_ref AS BLOB)) <= 255 AND target_ref LIKE 'refs/heads/%'),
    expected_target_commit TEXT NOT NULL CHECK (length(expected_target_commit) IN (40, 64) AND expected_target_commit NOT GLOB '*[^0-9a-f]*'),
    profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 128),
    profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
    profile_digest TEXT NOT NULL CHECK (length(profile_digest) = 64 AND profile_digest NOT GLOB '*[^0-9a-f]*'),
    profile_json TEXT NOT NULL CHECK (length(CAST(profile_json AS BLOB)) <= 8192),
    state TEXT NOT NULL CHECK (state IN ('queued', 'verifying', 'awaiting-review', 'landing', 'landed', 'blocked', 'canceled', 'uncertain')),
    reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 64),
    verification_attempt INTEGER NOT NULL CHECK (verification_attempt >= 0),
    owner_generation INTEGER NOT NULL CHECK (owner_generation >= 1),
    created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 32),
    updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 32)
  ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS lane_integration_active_per_repository ON lane_integration_requests (repository_id) WHERE state IN ('verifying', 'landing')`,
  `CREATE INDEX IF NOT EXISTS lane_integration_requests_by_workspace ON lane_integration_requests (workspace_id, created_at, request_id)`,
  `CREATE INDEX IF NOT EXISTS lane_integration_requests_by_lane ON lane_integration_requests (lane_id, state)`,
  `CREATE TABLE IF NOT EXISTS lane_verification_results (
    result_id TEXT PRIMARY KEY CHECK (length(result_id) = 32 AND result_id NOT GLOB '*[^0-9a-f]*'),
    request_id TEXT NOT NULL CHECK (length(request_id) = 32 AND request_id NOT GLOB '*[^0-9a-f]*'),
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    check_index INTEGER NOT NULL CHECK (check_index BETWEEN 0 AND 7),
    check_name TEXT NOT NULL CHECK (length(check_name) BETWEEN 1 AND 64),
    candidate_commit TEXT NOT NULL CHECK (length(candidate_commit) IN (40, 64) AND candidate_commit NOT GLOB '*[^0-9a-f]*'),
    exit_code INTEGER,
    signal TEXT CHECK (signal IS NULL OR length(signal) BETWEEN 1 AND 16),
    timed_out INTEGER NOT NULL CHECK (timed_out IN (0, 1)),
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    output_bytes INTEGER NOT NULL CHECK (output_bytes >= 0),
    output_sha256 TEXT NOT NULL CHECK (length(output_sha256) = 64 AND output_sha256 NOT GLOB '*[^0-9a-f]*'),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 20 AND 32),
    UNIQUE (request_id, attempt, check_index)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS lane_review_receipts (
    receipt_id TEXT PRIMARY KEY CHECK (length(receipt_id) = 32 AND receipt_id NOT GLOB '*[^0-9a-f]*'),
    request_id TEXT NOT NULL UNIQUE CHECK (length(request_id) = 32 AND request_id NOT GLOB '*[^0-9a-f]*'),
    lane_id TEXT NOT NULL CHECK (length(lane_id) = 32 AND lane_id NOT GLOB '*[^0-9a-f]*'),
    candidate_commit TEXT NOT NULL CHECK (length(candidate_commit) IN (40, 64) AND candidate_commit NOT GLOB '*[^0-9a-f]*'),
    target_ref TEXT NOT NULL CHECK (length(CAST(target_ref AS BLOB)) <= 255 AND target_ref LIKE 'refs/heads/%'),
    target_commit TEXT NOT NULL CHECK (length(target_commit) IN (40, 64) AND target_commit NOT GLOB '*[^0-9a-f]*'),
    profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
    profile_digest TEXT NOT NULL CHECK (length(profile_digest) = 64 AND profile_digest NOT GLOB '*[^0-9a-f]*'),
    approved_at TEXT NOT NULL CHECK (length(approved_at) BETWEEN 20 AND 32),
    outcome TEXT CHECK (outcome IN ('landed', 'blocked', 'uncertain')),
    outcome_reason TEXT CHECK (outcome_reason IS NULL OR length(outcome_reason) BETWEEN 1 AND 64),
    owner_generation INTEGER NOT NULL CHECK (owner_generation >= 1)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS lane_integration_journal (
    entry_id TEXT PRIMARY KEY CHECK (length(entry_id) = 32 AND entry_id NOT GLOB '*[^0-9a-f]*'),
    request_id TEXT NOT NULL CHECK (length(request_id) = 32 AND request_id NOT GLOB '*[^0-9a-f]*'),
    entry_seq INTEGER NOT NULL CHECK (entry_seq >= 1),
    kind TEXT NOT NULL CHECK (kind IN ('landing-intent', 'landing-observed', 'cancel', 'reconcile')),
    method TEXT CHECK (method IN ('ff-merge', 'update-ref')),
    candidate_commit TEXT NOT NULL CHECK (length(candidate_commit) IN (40, 64) AND candidate_commit NOT GLOB '*[^0-9a-f]*'),
    expected_commit TEXT NOT NULL CHECK (length(expected_commit) IN (40, 64) AND expected_commit NOT GLOB '*[^0-9a-f]*'),
    observed_tip TEXT CHECK (observed_tip IS NULL OR (length(observed_tip) IN (40, 64) AND observed_tip NOT GLOB '*[^0-9a-f]*')),
    outcome TEXT CHECK (outcome IN ('landed', 'blocked', 'uncertain', 'canceled')),
    reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 64),
    owner_generation INTEGER NOT NULL CHECK (owner_generation >= 1),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 20 AND 32),
    UNIQUE (request_id, entry_seq)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS lane_host_generations (
    workspace_id TEXT PRIMARY KEY CHECK (length(workspace_id) BETWEEN 1 AND 128),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    claimed_at TEXT NOT NULL CHECK (length(claimed_at) BETWEEN 20 AND 32)
  ) STRICT`
]);
