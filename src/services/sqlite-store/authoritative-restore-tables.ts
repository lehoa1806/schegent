/**
 * FR-R7-03 (FR-001) — Canonical schema-adjacent table registry for SQLite backup and restore.
 *
 * Every table created across `SchemaBootstrapService` (Migrations 1–9) MUST appear in
 * exactly one of `AUTHORITATIVE_RESTORE_TABLES` or `SCHEMA_CONTROL_TABLES`.
 * `repo/tests/lint/sqlite-authoritative-restore-census.test.ts` enforces parity against
 * both all static `CREATE TABLE` definitions in `repo/src/` and runtime `sqlite_master`
 * after `SchemaBootstrapService.bootstrapAndMigrate(...)`, so a newly added table cannot
 * be silently omitted from restore.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

/**
 * DDL-owned schema control tables managed exclusively by `SchemaBootstrapService`.
 * Preserved during online row restore so the live file's DDL version and applied
 * migration ledger always match its physical schema (including when restoring an
 * older compatible schema-8 backup onto a schema-9 database with backfill).
 */
export const SCHEMA_CONTROL_TABLES = Object.freeze([
  'schema_meta',
  'schema_migrations'
] as const);

export type SchemaControlTableName = (typeof SCHEMA_CONTROL_TABLES)[number];

/**
 * Complete sorted list of every authoritative SQLite table replaced atomically during
 * full-authority restore (128 `STRICT` tables across Migrations 1–9).
 */
export const AUTHORITATIVE_RESTORE_TABLES = Object.freeze([
  'accepted_results',
  'accounting_attempts',
  'accounting_contributions',
  'accounting_corrections',
  'accounting_gaps',
  'accounting_legacy_epoch',
  'accounting_legacy_runs',
  'accounting_observation_measures',
  'accounting_observations',
  'accounting_projection_intents',
  'accounting_revisions',
  'accounting_root_outcomes',
  'acp_authorization_receipts',
  'acp_observation_ledger',
  'agent_connections',
  'agent_profile_versions',
  'agent_profiles',
  'agent_session_connections',
  'agent_session_provider_links',
  'agent_sessions',
  'agent_turns',
  'aggregate_revisions',
  'archived_task_summaries',
  'artifact_availability',
  'artifact_consumptions',
  'artifact_derivations',
  'artifact_lifecycle',
  'artifact_locations',
  'artifact_pins',
  'artifact_publications',
  'artifact_references',
  'artifacts',
  'attempt_usage_revisions',
  'attempts',
  'candidate_snapshots',
  'catalog_heads',
  'catalog_revisions',
  'containment_acceptance_bindings',
  'containment_qualifications',
  'cutover_sentinel',
  'definition_dependencies',
  'definition_versions',
  'definitions',
  'deletion_operations',
  'deletion_targets',
  'effect_intents',
  'effect_observations',
  'execution_lanes',
  'execution_summary_revisions',
  'execution_workspaces',
  'export_operations',
  'finding_dispositions',
  'findings',
  'fix_claims',
  'frozen_closure_members',
  'frozen_closures',
  'gates',
  'handoff_approvals',
  'handoff_delivery_observations',
  'handoff_sources',
  'handoffs',
  'input_bindings',
  'input_envelopes',
  'integration_receipts',
  'lane_candidates',
  'lane_host_generations',
  'lane_integration_journal',
  'lane_integration_requests',
  'lane_operations',
  'lane_review_receipts',
  'lane_verification_results',
  'lease_fences',
  'live_log_coverage',
  'live_log_segments',
  'live_log_streams',
  'log_gaps',
  'log_segments',
  'log_streams',
  'migration_ledger',
  'migration_quarantine',
  'model_catalog_heads',
  'model_catalog_versions',
  'operation_receipts',
  'operational_kv_documents',
  'operational_queue_meta',
  'operational_runs',
  'operational_tasks',
  'phase_handoff_records',
  'phase_review_loop_ledgers',
  'policy_heads',
  'policy_versions',
  'preservation_operations',
  'preservation_targets',
  'projection_intents',
  'protocol_receipts',
  'provider_sessions',
  'queue_entries',
  'recovery_handoff_decisions',
  'recovery_handoff_deliveries',
  'recovery_handoff_references',
  'recovery_handoff_revisions',
  'recovery_handoffs',
  'recovery_manifests',
  'recovery_sources',
  'report_exports',
  'report_leases',
  'report_manifests',
  'report_saved',
  'result_values',
  'retention_policy_revisions',
  'retention_previews',
  'review_loops',
  'review_reports',
  'run_inputs',
  'runs',
  'state_change_outbox',
  'steps',
  'storage_scan_checkpoints',
  'sweep_leases',
  'telemetry_cardinality_sets',
  'telemetry_delivery_receipts',
  'telemetry_destinations',
  'telemetry_export_copies',
  'telemetry_export_ledger',
  'telemetry_spool_batches',
  'usage_accounting_applications',
  'usage_corrections',
  'usage_observations'
] as const);

export type AuthoritativeRestoreTableName = (typeof AUTHORITATIVE_RESTORE_TABLES)[number];

export const ALL_CLASSIFIED_SQLITE_TABLES: readonly string[] = Object.freeze(
  [...AUTHORITATIVE_RESTORE_TABLES, ...SCHEMA_CONTROL_TABLES].sort()
);
