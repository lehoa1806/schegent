/**
 * FR-R6-F04 (F04-A, F04-B, F04-C) — Authoritative `STRICT` SQLite schema
 * bootstrap and forward-only migration service.
 *
 * Migration 1 defines the 78 F04 `STRICT` tables across:
 * 1. Schema control, cutover sentinel, migration ledger/quarantine, lease fences,
 *    operation receipts, and state change outbox (`F04-A`)
 * 2. Core operational execution tables (`runs`, `run_inputs`, `queue_entries`,
 *    `steps`, `attempts`, `gates`) (`F04-A` / `F01`)
 * 3. Round 6 consumer domain tables (`F05`, `F06`, `F07`, `F08`, `F10`, `F11`,
 *    `F13`, `F14`, `F15`) (`F04-B`)
 * 4. Catalog definitions, versions, heads, revisions, dependencies, policies,
 *    model catalogs, and frozen execution closures (`F04-C`)
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { createHash } from 'node:crypto';
import { SQLITE_SCHEMA_CURRENT_VERSION } from '../../contracts/sqlite-store/schema-types';
import type { NodeSqliteConnection } from './sqlite-driver';
import {
  F05_LIFECYCLE_DDL,
  F05_LIFECYCLE_MIGRATION_NAME,
  F05_LIFECYCLE_MIGRATION_VERSION
} from '../artifact-lifecycle/lifecycle-schema';
import {
  F06_ACCOUNTING_DDL,
  F06_ACCOUNTING_MIGRATION_NAME,
  F06_ACCOUNTING_MIGRATION_VERSION
} from '../usage-accounting/accounting-schema';

export interface SchemaMigrationDefinition {
  readonly version: number;
  readonly name: string;
  readonly ddlStatements: readonly string[];
}

export const INITIAL_STRICT_SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
  // 1. Schema control, cutover, migration, fencing, receipts, outbox (8 tables)
  `CREATE TABLE IF NOT EXISTS schema_meta (
    meta_key TEXT PRIMARY KEY,
    meta_value TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum_sha256 TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS cutover_sentinel (
    scope_id TEXT PRIMARY KEY,
    authority TEXT NOT NULL CHECK (authority IN ('legacy', 'migrating', 'sqlite', 'retired_legacy')),
    stage TEXT NOT NULL,
    cutover_epoch INTEGER NOT NULL CHECK (cutover_epoch >= 0),
    legacy_digest_sha256 TEXT NOT NULL,
    sqlite_digest_sha256 TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS migration_ledger (
    migration_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'blocked')),
    records_processed INTEGER NOT NULL CHECK (records_processed >= 0),
    quarantined_count INTEGER NOT NULL CHECK (quarantined_count >= 0),
    checksum_sha256 TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (migration_id, stage)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS migration_quarantine (
    quarantine_id TEXT PRIMARY KEY,
    migration_id TEXT NOT NULL,
    source_surface TEXT NOT NULL,
    source_record_key TEXT NOT NULL,
    reason_code TEXT NOT NULL CHECK (reason_code IN ('corrupt_json', 'unknown_future_version', 'schema_violation', 'digest_mismatch')),
    detected_schema_version INTEGER,
    raw_payload TEXT NOT NULL,
    diagnostic_json TEXT NOT NULL,
    resolved INTEGER NOT NULL CHECK (resolved IN (0, 1)),
    created_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS lease_fences (
    fence_scope TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    epoch INTEGER NOT NULL CHECK (epoch >= 1),
    acquired_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    PRIMARY KEY (fence_scope, resource_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS operation_receipts (
    scope_kind TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    commit_unit TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    resulting_revision INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    committed_at_ms INTEGER NOT NULL,
    PRIMARY KEY (scope_kind, scope_id, idempotency_key)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS state_change_outbox (
    outbox_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    commit_unit TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    delivered_at_ms INTEGER
  ) STRICT`,

  // 2. Core operational execution tables (6 tables)
  `CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    frozen_closure_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled', 'aborted')),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    current_step_id TEXT,
    started_at_ms INTEGER,
    completed_at_ms INTEGER,
    terminal_reason TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS run_inputs (
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    input_key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    redacted_digest_sha256 TEXT NOT NULL,
    PRIMARY KEY (run_id, input_key)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS queue_entries (
    queue_entry_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE CASCADE,
    priority INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'released', 'completed', 'cancelled')),
    claimed_by TEXT,
    claim_epoch INTEGER NOT NULL DEFAULT 0,
    enqueued_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS steps (
    step_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    step_index INTEGER NOT NULL CHECK (step_index >= 0),
    phase_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting_gate', 'succeeded', 'failed', 'skipped', 'cancelled')),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    current_attempt_id TEXT,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (run_id, step_index)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS attempts (
    attempt_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'timed_out')),
    exit_code INTEGER,
    started_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER,
    UNIQUE (step_id, attempt_number)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS gates (
    gate_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
    gate_type TEXT NOT NULL CHECK (gate_type IN ('approval', 'quality', 'security', 'review', 'manual')),
    status TEXT NOT NULL CHECK (status IN ('open', 'approved', 'rejected', 'expired')),
    decided_by TEXT,
    decided_at_ms INTEGER,
    notes TEXT
  ) STRICT`,

  // 3. F05 — Artifacts, Locations, Availability, Lineage Relations & Pins (7 tables)
  `CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id TEXT PRIMARY KEY,
    content_sha256 TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    media_type TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_by_run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
    created_by_attempt_id TEXT REFERENCES attempts(attempt_id) ON DELETE SET NULL,
    created_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS artifact_locations (
    location_id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    storage_tier TEXT NOT NULL CHECK (storage_tier IN ('inline_db', 'cas_blob', 'workspace_file')),
    uri_or_relpath TEXT NOT NULL,
    inline_bytes BLOB,
    verified_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS artifact_availability (
    artifact_id TEXT PRIMARY KEY REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('available', 'quarantined', 'evicted', 'missing')),
    last_verified_at_ms INTEGER NOT NULL,
    detail_json TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS artifact_publications (
    publication_id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    published_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS artifact_consumptions (
    consumption_id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
    input_name TEXT NOT NULL,
    consumed_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS artifact_derivations (
    derivation_id TEXT PRIMARY KEY,
    parent_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    child_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    transform_kind TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    UNIQUE (parent_artifact_id, child_artifact_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS artifact_pins (
    pin_id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    owner_run_id TEXT REFERENCES runs(run_id) ON DELETE CASCADE,
    owner_attempt_id TEXT REFERENCES attempts(attempt_id) ON DELETE CASCADE,
    owner_handoff_id TEXT,
    owner_export_id TEXT,
    reason TEXT NOT NULL,
    pinned_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER,
    CHECK (
      (owner_run_id IS NOT NULL) +
      (owner_attempt_id IS NOT NULL) +
      (owner_handoff_id IS NOT NULL) +
      (owner_export_id IS NOT NULL) = 1
    )
  ) STRICT`,

  // 4. F06 — Usage & Cost Accounting (4 tables)
  `CREATE TABLE IF NOT EXISTS usage_observations (
    observation_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    cached_tokens INTEGER NOT NULL CHECK (cached_tokens >= 0),
    cost_microdollars INTEGER NOT NULL CHECK (cost_microdollars >= 0),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('provider_exact', 'parsed_footer', 'estimated')),
    observed_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS usage_corrections (
    correction_id TEXT PRIMARY KEY,
    observation_id TEXT NOT NULL REFERENCES usage_observations(observation_id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    delta_input_tokens INTEGER NOT NULL,
    delta_output_tokens INTEGER NOT NULL,
    delta_cost_microdollars INTEGER NOT NULL,
    pricing_version TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS usage_accounting_applications (
    application_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
    observation_id TEXT REFERENCES usage_observations(observation_id) ON DELETE CASCADE,
    correction_id TEXT REFERENCES usage_corrections(correction_id) ON DELETE CASCADE,
    applied_revision INTEGER NOT NULL CHECK (applied_revision >= 1),
    applied_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS attempt_usage_revisions (
    attempt_id TEXT PRIMARY KEY REFERENCES attempts(attempt_id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    total_input_tokens INTEGER NOT NULL,
    total_output_tokens INTEGER NOT NULL,
    total_cached_tokens INTEGER NOT NULL,
    total_cost_microdollars INTEGER NOT NULL,
    completeness TEXT NOT NULL CHECK (completeness IN ('exact', 'partial', 'estimated')),
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,

  // 5. F07 — Bounded Log Stream, Segment Index & Gaps (3 tables)
  `CREATE TABLE IF NOT EXISTS log_streams (
    stream_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK (channel IN ('stdout', 'stderr', 'protocol', 'diagnostic')),
    total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
    segment_count INTEGER NOT NULL CHECK (segment_count >= 0),
    closed INTEGER NOT NULL CHECK (closed IN (0, 1)),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS log_segments (
    segment_id TEXT PRIMARY KEY,
    stream_id TEXT NOT NULL REFERENCES log_streams(stream_id) ON DELETE CASCADE,
    segment_seq INTEGER NOT NULL CHECK (segment_seq >= 0),
    start_byte_offset INTEGER NOT NULL CHECK (start_byte_offset >= 0),
    end_byte_offset INTEGER NOT NULL CHECK (end_byte_offset >= start_byte_offset),
    line_count INTEGER NOT NULL CHECK (line_count >= 0),
    content_sha256 TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    UNIQUE (stream_id, segment_seq)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS log_gaps (
    gap_id TEXT PRIMARY KEY,
    stream_id TEXT NOT NULL REFERENCES log_streams(stream_id) ON DELETE CASCADE,
    after_segment_seq INTEGER NOT NULL,
    dropped_bytes INTEGER NOT NULL CHECK (dropped_bytes > 0),
    reason TEXT NOT NULL CHECK (reason IN ('backpressure', 'truncation', 'crash_recovery')),
    recorded_at_ms INTEGER NOT NULL
  ) STRICT`,

  // 6. F08 — Crash Recovery Manifests & Sources (2 tables)
  `CREATE TABLE IF NOT EXISTS recovery_manifests (
    manifest_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    step_id TEXT REFERENCES steps(step_id) ON DELETE SET NULL,
    attempt_id TEXT REFERENCES attempts(attempt_id) ON DELETE SET NULL,
    frozen_closure_id TEXT,
    classification TEXT NOT NULL CHECK (classification IN ('resumable', 'reconcilable', 'stranded', 'terminal_verified')),
    action_taken TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS recovery_sources (
    source_id TEXT PRIMARY KEY,
    manifest_id TEXT NOT NULL REFERENCES recovery_manifests(manifest_id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('sqlite_row', 'log_segment', 'artifact_blob', 'workspace_tree', 'process_probe')),
    source_ref TEXT NOT NULL,
    digest_sha256 TEXT NOT NULL,
    verified INTEGER NOT NULL CHECK (verified IN (0, 1))
  ) STRICT`,

  // 7. F10 — Execution Workspaces, Candidate Snapshots & Integration Receipts (3 tables)
  `CREATE TABLE IF NOT EXISTS execution_workspaces (
    execution_workspace_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
    strategy TEXT NOT NULL CHECK (strategy IN ('worktree', 'clone', 'in_place')),
    root_relpath TEXT NOT NULL,
    base_commit_sha TEXT NOT NULL,
    head_commit_sha TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'snapshot_ready', 'integrated', 'abandoned', 'cleaned')),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (run_id, step_id, attempt_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS candidate_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    execution_workspace_id TEXT NOT NULL REFERENCES execution_workspaces(execution_workspace_id) ON DELETE CASCADE,
    tree_sha TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    dirty_file_count INTEGER NOT NULL CHECK (dirty_file_count >= 0),
    diff_artifact_id TEXT REFERENCES artifacts(artifact_id) ON DELETE SET NULL,
    created_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS integration_receipts (
    receipt_id TEXT PRIMARY KEY,
    execution_workspace_id TEXT NOT NULL REFERENCES execution_workspaces(execution_workspace_id) ON DELETE CASCADE,
    snapshot_id TEXT NOT NULL REFERENCES candidate_snapshots(snapshot_id) ON DELETE CASCADE,
    target_branch TEXT NOT NULL,
    integrated_commit_sha TEXT,
    status TEXT NOT NULL CHECK (status IN ('merged', 'fast_forwarded', 'conflict', 'rejected')),
    recorded_at_ms INTEGER NOT NULL
  ) STRICT`,

  // 8. F11 — Reporting Projections, Keyset Pagination & Export Leases (5 tables)
  `CREATE TABLE IF NOT EXISTS execution_summary_revisions (
    run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    status TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    step_count INTEGER NOT NULL CHECK (step_count >= 0),
    completed_step_count INTEGER NOT NULL CHECK (completed_step_count >= 0),
    attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
    open_finding_count INTEGER NOT NULL CHECK (open_finding_count >= 0),
    total_tokens INTEGER NOT NULL DEFAULT 0,
    total_cost_microdollars INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    started_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS aggregate_revisions (
    scope_key TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    run_count INTEGER NOT NULL CHECK (run_count >= 0),
    succeeded_count INTEGER NOT NULL CHECK (succeeded_count >= 0),
    failed_count INTEGER NOT NULL CHECK (failed_count >= 0),
    total_tokens INTEGER NOT NULL DEFAULT 0,
    total_cost_microdollars INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS report_manifests (
    report_id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    cutoff_revision INTEGER NOT NULL CHECK (cutoff_revision >= 0),
    format TEXT NOT NULL CHECK (format IN ('json', 'markdown', 'csv', 'bundle')),
    artifact_id TEXT REFERENCES artifacts(artifact_id) ON DELETE SET NULL,
    created_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS report_leases (
    lease_id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL REFERENCES report_manifests(report_id) ON DELETE CASCADE,
    holder_id TEXT NOT NULL,
    cutoff_revision INTEGER NOT NULL,
    acquired_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired'))
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS export_operations (
    export_id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL REFERENCES report_manifests(report_id) ON DELETE CASCADE,
    destination_relpath TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    content_sha256 TEXT,
    completed_at_ms INTEGER
  ) STRICT`,

  // 9. F13 — Agent Runtime Profiles, Sessions, Turns, Receipts, Effects & Projections (12 tables)
  `CREATE TABLE IF NOT EXISTS agent_profiles (
    profile_id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    adapter_kind TEXT NOT NULL CHECK (adapter_kind IN ('cli', 'acp', 'sdk', 'cloud')),
    active_version_id TEXT,
    created_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS agent_profile_versions (
    profile_version_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES agent_profiles(profile_id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL CHECK (version_number >= 1),
    config_json TEXT NOT NULL,
    config_sha256 TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    UNIQUE (profile_id, version_number)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS agent_sessions (
    agent_session_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
    profile_version_id TEXT NOT NULL REFERENCES agent_profile_versions(profile_version_id),
    state TEXT NOT NULL CHECK (state IN ('initializing', 'active', 'suspended', 'completed', 'failed', 'terminated')),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS provider_sessions (
    provider_session_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    external_session_ref TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS agent_session_provider_links (
    link_id TEXT PRIMARY KEY,
    agent_session_id TEXT NOT NULL REFERENCES agent_sessions(agent_session_id) ON DELETE CASCADE,
    provider_session_id TEXT NOT NULL REFERENCES provider_sessions(provider_session_id) ON DELETE CASCADE,
    linked_at_ms INTEGER NOT NULL,
    UNIQUE (agent_session_id, provider_session_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS agent_connections (
    connection_id TEXT PRIMARY KEY,
    transport_kind TEXT NOT NULL CHECK (transport_kind IN ('stdio', 'socket', 'http', 'in_proc')),
    state TEXT NOT NULL CHECK (state IN ('connected', 'disconnected', 'draining', 'failed')),
    pid INTEGER,
    connected_at_ms INTEGER NOT NULL,
    disconnected_at_ms INTEGER
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS agent_session_connections (
    binding_id TEXT PRIMARY KEY,
    agent_session_id TEXT NOT NULL REFERENCES agent_sessions(agent_session_id) ON DELETE CASCADE,
    connection_id TEXT NOT NULL REFERENCES agent_connections(connection_id) ON DELETE CASCADE,
    bound_epoch INTEGER NOT NULL CHECK (bound_epoch >= 1),
    bound_at_ms INTEGER NOT NULL,
    unbound_at_ms INTEGER
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS agent_turns (
    turn_id TEXT PRIMARY KEY,
    agent_session_id TEXT NOT NULL REFERENCES agent_sessions(agent_session_id) ON DELETE CASCADE,
    turn_index INTEGER NOT NULL CHECK (turn_index >= 0),
    state TEXT NOT NULL CHECK (state IN ('queued', 'streaming', 'completed', 'failed', 'cancelled')),
    prompt_artifact_id TEXT REFERENCES artifacts(artifact_id) ON DELETE SET NULL,
    response_artifact_id TEXT REFERENCES artifacts(artifact_id) ON DELETE SET NULL,
    started_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER,
    UNIQUE (agent_session_id, turn_index)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS protocol_receipts (
    receipt_id TEXT PRIMARY KEY,
    agent_session_id TEXT NOT NULL REFERENCES agent_sessions(agent_session_id) ON DELETE CASCADE,
    turn_id TEXT REFERENCES agent_turns(turn_id) ON DELETE SET NULL,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    message_type TEXT NOT NULL,
    sequence_no INTEGER NOT NULL CHECK (sequence_no >= 0),
    payload_sha256 TEXT NOT NULL,
    recorded_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS effect_intents (
    effect_intent_id TEXT PRIMARY KEY,
    agent_session_id TEXT NOT NULL REFERENCES agent_sessions(agent_session_id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL REFERENCES agent_turns(turn_id) ON DELETE CASCADE,
    effect_kind TEXT NOT NULL CHECK (effect_kind IN ('file_write', 'command_exec', 'git_op', 'network_call', 'tool_call')),
    idempotency_key TEXT NOT NULL UNIQUE,
    target_summary TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('declared', 'approved', 'denied', 'executed', 'failed')),
    created_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS effect_observations (
    observation_id TEXT PRIMARY KEY,
    effect_intent_id TEXT NOT NULL REFERENCES effect_intents(effect_intent_id) ON DELETE CASCADE,
    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'aborted')),
    exit_code INTEGER,
    artifact_id TEXT REFERENCES artifacts(artifact_id) ON DELETE SET NULL,
    observed_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS projection_intents (
    projection_id TEXT PRIMARY KEY,
    agent_session_id TEXT NOT NULL REFERENCES agent_sessions(agent_session_id) ON DELETE CASCADE,
    source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
    target_surface TEXT NOT NULL CHECK (target_surface IN ('webview', 'status_bar', 'notification', 'log_view')),
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'superseded', 'dropped')),
    created_at_ms INTEGER NOT NULL
  ) STRICT`,

  // 10. F14 — Telemetry Destinations, Export Copies, Receipts & Cardinality Sets (4 tables)
  `CREATE TABLE IF NOT EXISTS telemetry_destinations (
    destination_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('otlp_http', 'jsonl_file', 'memory_ring')),
    endpoint_or_path TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    created_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS telemetry_export_copies (
    copy_id TEXT PRIMARY KEY,
    destination_id TEXT NOT NULL REFERENCES telemetry_destinations(destination_id) ON DELETE CASCADE,
    source_commit_unit TEXT NOT NULL,
    source_revision INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
    status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'dead_letter')),
    retry_count INTEGER NOT NULL CHECK (retry_count >= 0),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS telemetry_delivery_receipts (
    delivery_id TEXT PRIMARY KEY,
    copy_id TEXT NOT NULL REFERENCES telemetry_export_copies(copy_id) ON DELETE CASCADE,
    destination_id TEXT NOT NULL REFERENCES telemetry_destinations(destination_id) ON DELETE CASCADE,
    status_code INTEGER NOT NULL,
    delivered_at_ms INTEGER NOT NULL,
    diagnostic_text TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS telemetry_cardinality_sets (
    metric_family TEXT NOT NULL,
    attribute_key TEXT NOT NULL,
    attribute_value TEXT NOT NULL,
    first_seen_at_ms INTEGER NOT NULL,
    PRIMARY KEY (metric_family, attribute_key, attribute_value)
  ) STRICT`,

  // 11. F15 — Structured Results, Handoffs, Envelopes & Review Loops (13 tables)
  `CREATE TABLE IF NOT EXISTS accepted_results (
    result_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
    schema_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    status TEXT NOT NULL CHECK (status IN ('accepted', 'superseded', 'invalidated')),
    accepted_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS result_values (
    result_id TEXT NOT NULL REFERENCES accepted_results(result_id) ON DELETE CASCADE,
    field_path TEXT NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN ('string', 'number', 'boolean', 'json', 'artifact_ref')),
    value_text TEXT NOT NULL,
    artifact_id TEXT REFERENCES artifacts(artifact_id) ON DELETE SET NULL,
    PRIMARY KEY (result_id, field_path)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS handoffs (
    handoff_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    from_step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
    to_step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    status TEXT NOT NULL CHECK (status IN ('prepared', 'approved', 'delivered', 'consumed', 'rejected', 'expired')),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS handoff_sources (
    handoff_id TEXT NOT NULL REFERENCES handoffs(handoff_id) ON DELETE CASCADE,
    source_result_id TEXT REFERENCES accepted_results(result_id) ON DELETE CASCADE,
    source_artifact_id TEXT REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    PRIMARY KEY (handoff_id, role)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS input_envelopes (
    envelope_id TEXT PRIMARY KEY,
    handoff_id TEXT NOT NULL REFERENCES handoffs(handoff_id) ON DELETE CASCADE,
    target_run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    target_step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
    schema_version INTEGER NOT NULL,
    digest_sha256 TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS input_bindings (
    envelope_id TEXT NOT NULL REFERENCES input_envelopes(envelope_id) ON DELETE CASCADE,
    param_name TEXT NOT NULL,
    bound_value_json TEXT NOT NULL,
    source_field_path TEXT NOT NULL,
    PRIMARY KEY (envelope_id, param_name)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS handoff_approvals (
    approval_id TEXT PRIMARY KEY,
    handoff_id TEXT NOT NULL REFERENCES handoffs(handoff_id) ON DELETE CASCADE,
    approver_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
    notes TEXT NOT NULL,
    decided_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS handoff_delivery_observations (
    observation_id TEXT PRIMARY KEY,
    handoff_id TEXT NOT NULL REFERENCES handoffs(handoff_id) ON DELETE CASCADE,
    consumer_attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
    delivery_status TEXT NOT NULL CHECK (delivery_status IN ('delivered', 'acknowledged', 'failed')),
    observed_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS review_loops (
    review_loop_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
    iteration INTEGER NOT NULL CHECK (iteration >= 1),
    max_iterations INTEGER NOT NULL CHECK (max_iterations >= 1),
    status TEXT NOT NULL CHECK (status IN ('open', 'converged', 'escalated', 'aborted')),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS review_reports (
    report_id TEXT PRIMARY KEY,
    review_loop_id TEXT NOT NULL REFERENCES review_loops(review_loop_id) ON DELETE CASCADE,
    iteration INTEGER NOT NULL CHECK (iteration >= 1),
    reviewer_role TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'changes_requested', 'blocked')),
    created_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS findings (
    finding_id TEXT PRIMARY KEY,
    review_loop_id TEXT NOT NULL REFERENCES review_loops(review_loop_id) ON DELETE CASCADE,
    report_id TEXT NOT NULL REFERENCES review_reports(report_id) ON DELETE CASCADE,
    severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
    category TEXT NOT NULL,
    file_path TEXT NOT NULL,
    line_number INTEGER NOT NULL CHECK (line_number >= 0),
    summary TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'fixed', 'waived', 'false_positive')),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS finding_dispositions (
    disposition_id TEXT PRIMARY KEY,
    finding_id TEXT NOT NULL REFERENCES findings(finding_id) ON DELETE CASCADE,
    disposition TEXT NOT NULL CHECK (disposition IN ('fixed', 'waived', 'false_positive', 'deferred')),
    actor_id TEXT NOT NULL,
    rationale TEXT NOT NULL,
    recorded_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS fix_claims (
    claim_id TEXT PRIMARY KEY,
    finding_id TEXT NOT NULL REFERENCES findings(finding_id) ON DELETE CASCADE,
    claimant_attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
    commit_sha TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending_verification', 'verified', 'rejected')),
    claimed_at_ms INTEGER NOT NULL
  ) STRICT`,

  // 12. F04-C — Catalog, Model Catalog, Policy & Frozen Execution Closures (11 tables)
  `CREATE TABLE IF NOT EXISTS policy_versions (
    policy_version_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('workspace', 'global')),
    policy_name TEXT NOT NULL,
    version_number INTEGER NOT NULL CHECK (version_number >= 1),
    canonical_yaml TEXT NOT NULL,
    digest_sha256 TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    UNIQUE (scope, policy_name, version_number)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS policy_heads (
    scope TEXT NOT NULL CHECK (scope IN ('workspace', 'global')),
    policy_name TEXT NOT NULL,
    active_policy_version_id TEXT NOT NULL REFERENCES policy_versions(policy_version_id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (scope, policy_name)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS definitions (
    definition_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('workspace', 'global', 'builtin')),
    layer TEXT NOT NULL CHECK (layer IN ('phase', 'pipeline', 'workflow')),
    slug TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    UNIQUE (scope, layer, slug)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS definition_versions (
    definition_version_id TEXT PRIMARY KEY,
    definition_id TEXT NOT NULL REFERENCES definitions(definition_id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL CHECK (version_number >= 1),
    status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
    canonical_yaml TEXT NOT NULL,
    digest_sha256 TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    UNIQUE (definition_id, version_number)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS catalog_heads (
    definition_id TEXT PRIMARY KEY REFERENCES definitions(definition_id) ON DELETE CASCADE,
    published_version_id TEXT REFERENCES definition_versions(definition_version_id),
    draft_version_id TEXT REFERENCES definition_versions(definition_version_id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS catalog_revisions (
    scope TEXT PRIMARY KEY CHECK (scope IN ('workspace', 'global', 'combined')),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS definition_dependencies (
    from_version_id TEXT NOT NULL REFERENCES definition_versions(definition_version_id) ON DELETE CASCADE,
    to_definition_id TEXT NOT NULL REFERENCES definitions(definition_id),
    dep_layer TEXT NOT NULL CHECK (dep_layer IN ('phase', 'pipeline')),
    dep_order INTEGER NOT NULL CHECK (dep_order >= 0),
    PRIMARY KEY (from_version_id, to_definition_id, dep_order)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS model_catalog_versions (
    model_catalog_version_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('workspace', 'global', 'builtin')),
    version_number INTEGER NOT NULL CHECK (version_number >= 1),
    models_json TEXT NOT NULL,
    digest_sha256 TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    UNIQUE (scope, version_number)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS model_catalog_heads (
    scope TEXT PRIMARY KEY CHECK (scope IN ('workspace', 'global', 'builtin')),
    active_model_catalog_version_id TEXT NOT NULL REFERENCES model_catalog_versions(model_catalog_version_id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS frozen_closures (
    frozen_closure_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE CASCADE,
    root_definition_version_id TEXT NOT NULL REFERENCES definition_versions(definition_version_id),
    policy_version_id TEXT REFERENCES policy_versions(policy_version_id),
    model_catalog_version_id TEXT REFERENCES model_catalog_versions(model_catalog_version_id),
    closure_digest_sha256 TEXT NOT NULL,
    frozen_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS frozen_closure_members (
    frozen_closure_id TEXT NOT NULL REFERENCES frozen_closures(frozen_closure_id) ON DELETE CASCADE,
    member_role TEXT NOT NULL,
    definition_version_id TEXT NOT NULL REFERENCES definition_versions(definition_version_id),
    PRIMARY KEY (frozen_closure_id, member_role, definition_version_id)
  ) STRICT`
]);

export const BUILTIN_SCHEMA_MIGRATIONS: readonly SchemaMigrationDefinition[] = Object.freeze([
  {
    version: 1,
    name: '001_initial_round6_strict_schema',
    ddlStatements: [
      ...INITIAL_STRICT_SCHEMA_STATEMENTS,
      `CREATE INDEX IF NOT EXISTS idx_runs_workspace_updated ON runs(workspace_id, updated_at_ms DESC, run_id DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_summary_keyset ON execution_summary_revisions(workspace_id, updated_at_ms DESC, run_id DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_pins_artifact ON artifact_pins(artifact_id)`,
      `CREATE INDEX IF NOT EXISTS idx_findings_loop_status ON findings(review_loop_id, status)`
    ]
  },
  {
    // FR-R6-F05: additive and forward-only; never edit migration 1.
    version: F05_LIFECYCLE_MIGRATION_VERSION,
    name: F05_LIFECYCLE_MIGRATION_NAME,
    ddlStatements: F05_LIFECYCLE_DDL
  },
  {
    // FR-R6-F06: additive and forward-only; never edit migrations 1 or 2.
    version: F06_ACCOUNTING_MIGRATION_VERSION,
    name: F06_ACCOUNTING_MIGRATION_NAME,
    ddlStatements: F06_ACCOUNTING_DDL
  }
]);

export class SchemaBootstrapService {
  public static computeMigrationChecksum(migration: SchemaMigrationDefinition): string {
    return createHash('sha256')
      .update(`${migration.version}:${migration.name}:${migration.ddlStatements.join(';\n')}`)
      .digest('hex');
  }

  public static bootstrapAndMigrate(
    conn: NodeSqliteConnection,
    nowMs: () => number = () => Date.now(),
    migrations: readonly SchemaMigrationDefinition[] = BUILTIN_SCHEMA_MIGRATIONS
  ): {
    readonly schemaVersion: number;
    readonly strictTableCount: number;
    readonly appliedMigrations: readonly number[];
  } {
    conn.exec('BEGIN IMMEDIATE');
    try {
      // Ensure schema_meta and schema_migrations exist first so we can check existing version
      conn.exec(INITIAL_STRICT_SCHEMA_STATEMENTS[0]!);
      conn.exec(INITIAL_STRICT_SCHEMA_STATEMENTS[1]!);

      const currentVersionRow = conn.get<{ meta_value: string }>(
        `SELECT meta_value FROM schema_meta WHERE meta_key = 'schema_version'`
      );
      const maxSupportedVersion = migrations.reduce<number>(
        (max, m) => (m.version > max ? m.version : max),
        SQLITE_SCHEMA_CURRENT_VERSION
      );
      if (currentVersionRow) {
        const existingVersion = Number(currentVersionRow.meta_value);
        if (existingVersion > maxSupportedVersion) {
          throw new Error(
            `UNSUPPORTED_FUTURE_SCHEMA_VERSION: database schema_version=${existingVersion} exceeds supported max=${maxSupportedVersion}`
          );
        }
      }

      const appliedRows = conn.all<{ version: number; checksum_sha256: string }>(
        `SELECT version, checksum_sha256 FROM schema_migrations ORDER BY version ASC`
      );
      const appliedMap = new Map<number, string>(
        appliedRows.map((r) => [r.version, r.checksum_sha256])
      );

      const newlyApplied: number[] = [];
      const sorted = [...migrations].sort((a, b) => a.version - b.version);

      for (const migration of sorted) {
        const expectedChecksum = SchemaBootstrapService.computeMigrationChecksum(migration);
        const existingChecksum = appliedMap.get(migration.version);
        if (existingChecksum !== undefined) {
          if (existingChecksum !== expectedChecksum) {
            throw new Error(
              `SCHEMA_MIGRATION_CHECKSUM_MISMATCH: version ${migration.version} (${migration.name})`
            );
          }
          continue;
        }

        for (const stmt of migration.ddlStatements) {
          conn.exec(stmt);
        }

        const ts = nowMs();
        conn.run(
          `INSERT INTO schema_migrations (version, name, checksum_sha256, applied_at_ms) VALUES (?, ?, ?, ?)`,
          migration.version,
          migration.name,
          expectedChecksum,
          ts
        );
        newlyApplied.push(migration.version);
      }

      const fkViolations = conn.runForeignKeyCheck();
      if (fkViolations.length > 0) {
        throw new Error(`FOREIGN_KEY_CHECK_FAILED: ${fkViolations.length} violations after schema migration`);
      }

      const runtimeMeta = conn.inspectRuntimeMetadata();
      const latestVersion = sorted.length > 0 ? sorted[sorted.length - 1]!.version : SQLITE_SCHEMA_CURRENT_VERSION;
      const ts = nowMs();

      const upsertMeta = (key: string, value: string): void => {
        conn.run(
          `INSERT INTO schema_meta (meta_key, meta_value, updated_at_ms)
           VALUES (?, ?, ?)
           ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at_ms = excluded.updated_at_ms`,
          key,
          value,
          ts
        );
      };

      upsertMeta('schema_version', String(latestVersion));
      upsertMeta('min_reader_version', '1');
      upsertMeta('sqlite_version', runtimeMeta.sqliteVersion);
      upsertMeta('sqlite_source_id', runtimeMeta.sqliteSourceId);

      // Initialize default catalog_revisions rows if absent
      for (const scope of ['workspace', 'global', 'combined'] as const) {
        conn.run(
          `INSERT OR IGNORE INTO catalog_revisions (scope, revision, updated_at_ms) VALUES (?, 0, ?)`,
          scope,
          ts
        );
      }

      conn.exec('COMMIT');

      const strictTableCount = SchemaBootstrapService.verifyAllTablesStrict(conn);
      return {
        schemaVersion: latestVersion,
        strictTableCount,
        appliedMigrations: newlyApplied
      };
    } catch (error) {
      try {
        conn.exec('ROLLBACK');
      } catch {
        // Ignore rollback error if transaction already rolled back
      }
      throw error;
    }
  }

  public static verifyAllTablesStrict(conn: NodeSqliteConnection): number {
    const tables = conn.all<{ name: string; sql: string }>(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC`
    );
    for (const table of tables) {
      if (!/\bSTRICT\s*$/i.test(table.sql.trim())) {
        throw new Error(`NON_STRICT_TABLE_DETECTED: table '${table.name}' is not declared STRICT`);
      }
    }
    return tables.length;
  }
}
