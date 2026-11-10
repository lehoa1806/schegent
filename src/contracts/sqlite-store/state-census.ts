/**
 * FR-R6-F04 (F04-C) — Complete structured-state census registry, catalog
 * definitions (`Phase`, `Pipeline`, `Workflow`), model catalog versions,
 * policy versions, frozen execution closures, canonical YAML exchange, and
 * dependency-ordered per-layer package partial-success contracts.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export const STRUCTURED_STATE_CLASSIFICATIONS = [
  'sqlite-authoritative',
  'external-immutable-blob',
  'append-only-evidence-log',
  'host-ui-preference'
] as const;

export type StructuredStateClassification = (typeof STRUCTURED_STATE_CLASSIFICATIONS)[number];

export interface StructuredStateCensusEntry {
  readonly surfaceId: string;
  readonly legacyLocation: string;
  readonly scope: 'workspace' | 'global' | 'both';
  readonly classification: StructuredStateClassification;
  readonly targetTables: readonly string[];
  readonly owningFeature: string;
  readonly executionAffecting: boolean;
  readonly migrationStage: 'F04-A' | 'F04-B' | 'F04-C' | 'external-retained';
  readonly rationale: string;
}

export const STRUCTURED_STATE_CENSUS: readonly StructuredStateCensusEntry[] = Object.freeze([
  {
    surfaceId: 'workflow-runs-and-queue',
    legacyLocation: 'workspaceState:schegent.runs / schegent.queue',
    scope: 'workspace',
    classification: 'sqlite-authoritative',
    targetTables: ['runs', 'run_inputs', 'queue_entries', 'steps', 'attempts', 'gates'],
    owningFeature: 'F01/F04-A',
    executionAffecting: true,
    migrationStage: 'F04-A',
    rationale: 'Replaces whole-map Memento cloning with atomic BEGIN IMMEDIATE run/step/queue commits.'
  },
  {
    surfaceId: 'window-primacy-and-locks',
    legacyLocation: '.schegent/locks/*.json',
    scope: 'workspace',
    classification: 'sqlite-authoritative',
    targetTables: ['lease_fences', 'operation_receipts', 'state_change_outbox'],
    owningFeature: 'F01/F04-A',
    executionAffecting: true,
    migrationStage: 'F04-A',
    rationale: 'Fences mutating commits by owner_id and monotonic epoch inside SQLite.'
  },
  {
    surfaceId: 'artifact-metadata-and-pins',
    legacyLocation: '.schegent/artifacts/index.json',
    scope: 'workspace',
    classification: 'sqlite-authoritative',
    targetTables: [
      'artifacts',
      'artifact_locations',
      'artifact_availability',
      'artifact_publications',
      'artifact_consumptions',
      'artifact_derivations',
      'artifact_pins'
    ],
    owningFeature: 'F05/F04-B',
    executionAffecting: true,
    migrationStage: 'F04-B',
    rationale: 'Relational lineage and single-owner pin CHECK enforcement for garbage collection.'
  },
  {
    surfaceId: 'artifact-cas-blobs',
    legacyLocation: '.schegent/artifacts/blobs/*',
    scope: 'workspace',
    classification: 'external-immutable-blob',
    targetTables: ['artifact_locations'],
    owningFeature: 'F05',
    executionAffecting: true,
    migrationStage: 'external-retained',
    rationale: 'Large content-addressed binary/text payloads remain external files verified via BackupDependencyManifest.'
  },
  {
    surfaceId: 'usage-and-cost-ledger',
    legacyLocation: 'workspaceState:schegent.usageLedger',
    scope: 'both',
    classification: 'sqlite-authoritative',
    targetTables: [
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
    ],
    owningFeature: 'F06',
    executionAffecting: false,
    migrationStage: 'F04-B',
    rationale:
      'FR-R6-F06 (research R14): append-only usage observations, revisioned contributions and corrections, and the imported legacy rollup epoch. The F04 usage_* tables are commit-unit placeholders production does not write.'
  },
  {
    surfaceId: 'log-segment-index',
    legacyLocation: '.schegent/logs/index.json',
    scope: 'workspace',
    classification: 'sqlite-authoritative',
    targetTables: ['live_log_streams', 'live_log_segments', 'live_log_coverage'],
    owningFeature: 'F07',
    executionAffecting: false,
    migrationStage: 'F04-B',
    rationale:
      'FR-R6-F07 (research R9): source generations, segment byte ranges with a durable flag, and coverage ranges over the live phase-log files; no column holds log content. The F04 log_* tables are commit-unit placeholders production does not write.'
  },
  {
    surfaceId: 'log-segment-bytes',
    legacyLocation: '.schegent/logs/segments/*.log',
    scope: 'workspace',
    classification: 'external-immutable-blob',
    targetTables: ['log_segments'],
    owningFeature: 'F07',
    executionAffecting: false,
    migrationStage: 'external-retained',
    rationale: 'High-volume streaming stdout/stderr bytes stay in bounded segment files tracked by BackupDependencyManifest.'
  },
  {
    surfaceId: 'crash-recovery-manifests',
    legacyLocation: '.schegent/recovery/*.json',
    scope: 'workspace',
    classification: 'sqlite-authoritative',
    targetTables: ['recovery_manifests', 'recovery_sources'],
    owningFeature: 'F08/F04-B',
    executionAffecting: true,
    migrationStage: 'F04-B',
    rationale: 'Deterministic crash recovery classification and source digest verification.'
  },
  {
    surfaceId: 'execution-workspaces-and-snapshots',
    legacyLocation: '.schegent/worktrees/manifest.json',
    scope: 'workspace',
    classification: 'sqlite-authoritative',
    targetTables: ['execution_workspaces', 'candidate_snapshots', 'integration_receipts'],
    owningFeature: 'F10/F04-B',
    executionAffecting: true,
    migrationStage: 'F04-B',
    rationale: 'Tracks isolated worktrees, candidate git tree snapshots, and merge receipts.'
  },
  {
    surfaceId: 'reporting-summaries-and-leases',
    legacyLocation: 'workspaceState:schegent.historySummaries',
    scope: 'both',
    classification: 'sqlite-authoritative',
    targetTables: [
      'execution_summary_revisions',
      'aggregate_revisions',
      'report_manifests',
      'report_leases',
      'export_operations'
    ],
    owningFeature: 'F11/F04-B',
    executionAffecting: false,
    migrationStage: 'F04-B',
    rationale: 'Keyset-paginated read projections at stable cutoff revision S and bounded export leases.'
  },
  {
    surfaceId: 'agent-runtime-sessions-and-effects',
    legacyLocation: '.schegent/sessions/*/runtime.json',
    scope: 'workspace',
    classification: 'sqlite-authoritative',
    targetTables: [
      'agent_profiles',
      'agent_profile_versions',
      'agent_sessions',
      'provider_sessions',
      'agent_session_provider_links',
      'agent_connections',
      'agent_session_connections',
      'agent_turns',
      'protocol_receipts',
      'effect_intents',
      'effect_observations',
      'projection_intents'
    ],
    owningFeature: 'F13/F04-B',
    executionAffecting: true,
    migrationStage: 'F04-B',
    rationale: 'Authoritative session/turn/effect ledger with strictly downstream projection_intents.'
  },
  {
    surfaceId: 'telemetry-export-outbox-and-cardinality',
    legacyLocation: '.schegent/telemetry/spool.json',
    scope: 'both',
    classification: 'sqlite-authoritative',
    targetTables: [
      'telemetry_destinations',
      'telemetry_export_copies',
      'telemetry_delivery_receipts',
      'telemetry_cardinality_sets'
    ],
    owningFeature: 'F14/F04-B',
    executionAffecting: false,
    migrationStage: 'F04-B',
    rationale: 'Bounded telemetry export copies, delivery receipts, and attribute cardinality guard.'
  },
  {
    surfaceId: 'structured-outputs-handoffs-and-reviews',
    legacyLocation: '.schegent/sessions/*/diagnostics/**/*.json',
    scope: 'workspace',
    classification: 'sqlite-authoritative',
    targetTables: [
      'accepted_results',
      'result_values',
      'handoffs',
      'handoff_sources',
      'input_envelopes',
      'input_bindings',
      'handoff_approvals',
      'handoff_delivery_observations',
      'review_loops',
      'review_reports',
      'findings',
      'finding_dispositions',
      'fix_claims'
    ],
    owningFeature: 'F15/F04-B',
    executionAffecting: true,
    migrationStage: 'F04-B',
    rationale: 'Replaces phase-message.env and review JSON sidecars with relational handoffs and findings.'
  },
  {
    surfaceId: 'catalog-definitions-and-heads',
    legacyLocation: '.schegent/catalog/{phases,pipelines,workflows}/*.yaml',
    scope: 'both',
    classification: 'sqlite-authoritative',
    targetTables: [
      'definitions',
      'definition_versions',
      'catalog_heads',
      'catalog_revisions',
      'definition_dependencies'
    ],
    owningFeature: 'F04-C',
    executionAffecting: true,
    migrationStage: 'F04-C',
    rationale: 'Atomic version+pointer publication with lossless YAML import/export equivalence.'
  },
  {
    surfaceId: 'policy-and-model-catalogs',
    legacyLocation: '.schegent/policy/*.yaml & globalStorage/models.json',
    scope: 'both',
    classification: 'sqlite-authoritative',
    targetTables: [
      'policy_versions',
      'policy_heads',
      'model_catalog_versions',
      'model_catalog_heads',
      'frozen_closures',
      'frozen_closure_members'
    ],
    owningFeature: 'F04-C',
    executionAffecting: true,
    migrationStage: 'F04-C',
    rationale: 'Versioned execution policies, model catalogs, and immutable per-run frozen closures.'
  },
  {
    surfaceId: 'tamper-evident-audit-log',
    legacyLocation: '.schegent/audit.log',
    scope: 'workspace',
    classification: 'append-only-evidence-log',
    targetTables: [],
    owningFeature: 'AuditLogger',
    executionAffecting: false,
    migrationStage: 'external-retained',
    rationale: 'Hash-chained JSONL evidence sink remains independent of SQLite (Rule 1, Rule 35).'
  },
  {
    surfaceId: 'vscode-ui-layout-preferences',
    legacyLocation: 'workspaceState:schegent.uiLayout',
    scope: 'both',
    classification: 'host-ui-preference',
    targetTables: [],
    owningFeature: 'WebviewUI',
    executionAffecting: false,
    migrationStage: 'external-retained',
    rationale: 'Non-authoritative UI pane collapse/filter preferences with zero execution authority.'
  }
]);

export interface CensusValidationResult {
  readonly valid: boolean;
  readonly totalSurfaces: number;
  readonly unclassifiedExecutionAffectingSurfaces: readonly string[];
  readonly duplicateSurfaceIds: readonly string[];
}

export function validateStructuredStateCensus(
  entries: readonly StructuredStateCensusEntry[] = STRUCTURED_STATE_CENSUS
): CensusValidationResult {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const unclassifiedExecutionAffecting: string[] = [];

  for (const entry of entries) {
    if (seen.has(entry.surfaceId)) {
      duplicates.push(entry.surfaceId);
    }
    seen.add(entry.surfaceId);

    if (
      entry.executionAffecting &&
      entry.classification !== 'sqlite-authoritative' &&
      entry.classification !== 'external-immutable-blob'
    ) {
      unclassifiedExecutionAffecting.push(entry.surfaceId);
    }
    if (entry.classification === 'sqlite-authoritative' && entry.targetTables.length === 0) {
      unclassifiedExecutionAffecting.push(entry.surfaceId);
    }
  }

  return {
    valid: duplicates.length === 0 && unclassifiedExecutionAffecting.length === 0,
    totalSurfaces: entries.length,
    unclassifiedExecutionAffectingSurfaces: unclassifiedExecutionAffecting,
    duplicateSurfaceIds: duplicates
  };
}

// ---------------------------------------------------------------------------
// F04-C — Catalog, Policy, Model Catalog & Frozen Closure Contracts
// ---------------------------------------------------------------------------

export type CatalogLayer = 'phase' | 'pipeline' | 'workflow';
export type CatalogScope = 'workspace' | 'global' | 'builtin';

export interface DefinitionRow {
  readonly definitionId: string;
  readonly scope: CatalogScope;
  readonly layer: CatalogLayer;
  readonly slug: string;
  readonly displayName: string;
  readonly createdAtMs: number;
}

export interface DefinitionVersionRow {
  readonly definitionVersionId: string;
  readonly definitionId: string;
  readonly versionNumber: number;
  readonly status: 'draft' | 'published' | 'archived';
  readonly canonicalYaml: string;
  readonly digestSha256: string;
  readonly schemaVersion: number;
  readonly createdAtMs: number;
}

export interface CatalogHeadRow {
  readonly definitionId: string;
  readonly publishedVersionId: string | null;
  readonly draftVersionId: string | null;
  readonly revision: number;
  readonly updatedAtMs: number;
}

export interface PolicyVersionRow {
  readonly policyVersionId: string;
  readonly scope: 'workspace' | 'global';
  readonly policyName: string;
  readonly versionNumber: number;
  readonly canonicalYaml: string;
  readonly digestSha256: string;
  readonly createdAtMs: number;
}

export interface ModelCatalogVersionRow {
  readonly modelCatalogVersionId: string;
  readonly scope: CatalogScope;
  readonly versionNumber: number;
  readonly modelsJson: string;
  readonly digestSha256: string;
  readonly createdAtMs: number;
}

export interface FrozenClosureRow {
  readonly frozenClosureId: string;
  readonly runId: string;
  readonly rootDefinitionVersionId: string;
  readonly policyVersionId: string | null;
  readonly modelCatalogVersionId: string | null;
  readonly closureDigestSha256: string;
  readonly frozenAtMs: number;
}

export interface FrozenClosureMemberRow {
  readonly frozenClosureId: string;
  readonly memberRole: string;
  readonly definitionVersionId: string;
}

export interface CatalogPackageImportItem {
  readonly definitionId: string;
  readonly scope: CatalogScope;
  readonly layer: CatalogLayer;
  readonly slug: string;
  readonly displayName: string;
  readonly versionNumber: number;
  readonly schemaVersion: number;
  readonly yamlText: string;
  readonly promoteAsPublished: boolean;
  readonly dependencies?: ReadonlyArray<{
    readonly toDefinitionId: string;
    readonly depLayer: 'phase' | 'pipeline';
    readonly depOrder: number;
  }> | undefined;
}

export interface CatalogPackageImportResult {
  readonly committedDefinitionIds: readonly string[];
  readonly failedItems: ReadonlyArray<{
    readonly definitionId: string;
    readonly layer: CatalogLayer;
    readonly reason: string;
  }>;
  readonly finalCatalogRevision: number;
}
