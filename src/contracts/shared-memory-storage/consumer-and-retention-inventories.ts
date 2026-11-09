/**
 * FR-R6-F02 — Shared memory and storage contracts: 15-feature consumer mapping,
 * C4 retention policy inventory, and authority/retention verification helpers
 * (FR-002, FR-003, FR-008, FR-015, FR-018, SC-001, SC-008).
 *
 * Zero `vscode` imports (SC-009, docs/hard-rules.md rule 13).
 */

import {
  DATA_CLASS_AUTHORITY_INVENTORY,
  DATA_CLASS_IDS,
  NEW_METADATA_RETENTION_MAX_AGE_DAYS,
  NEW_METADATA_RETENTION_RECLAIM_TARGET_BYTES,
  NON_AUTHORITATIVE_EXECUTION_SOURCES,
  ROUND6_FEATURE_IDS,
  SHARED_FIELD_DICTIONARY,
  buildSharedContractRefusal,
  type DataClassId,
  type NonAuthoritativeExecutionSource,
  type ProtectedExecutionEffect,
  type Round6FeatureId,
  type StorageBoundaryOutcome
} from './inventories';
import {
  OUTSTANDING_ACCOUNTING_INTENTS_MAX_BYTES,
  OUTSTANDING_ACCOUNTING_INTENTS_MAX_ITEMS,
  PENDING_ACCOUNTING_PROJECTION_MAX_BYTES,
  PENDING_ACCOUNTING_PROJECTION_MAX_ITEMS,
  RESOURCE_COLLECTOR_MAX_BYTES,
  RESOURCE_COLLECTOR_MAX_SAMPLES
} from '../runtime-resource-budgets/common-bounds';

export interface FeatureOwnedLimit {
  readonly limitName: string;
  readonly maxBytes?: number | undefined;
  readonly maxItems?: number | undefined;
}

export interface Round6FeatureConsumerEntry {
  readonly featureId: Round6FeatureId;
  readonly title: string;
  readonly consumerDomain: string;
  readonly inputAuthorities: readonly DataClassId[];
  readonly outputAuthorities: readonly DataClassId[];
  readonly sharedFieldsConsumed: readonly string[];
  readonly ownedLimits: readonly FeatureOwnedLimit[];
  readonly targetArchitecture: {
    readonly storeBoundary: 'F04-sqlite-domain-service';
    readonly runtimeBoundary: 'F13-acp-canonical-ingress' | 'host-internal';
    readonly excludesWholeMapStorage: true;
    readonly excludesCliFirstHandoff: true;
    readonly excludesRawWireDomainTables: true;
    readonly forbidsDirectAgentOrUiSql: true;
  };
}

const TARGET_ARCHITECTURE_BOUNDARY = Object.freeze({
  storeBoundary: 'F04-sqlite-domain-service' as const,
  runtimeBoundary: 'F13-acp-canonical-ingress' as const,
  excludesWholeMapStorage: true as const,
  excludesCliFirstHandoff: true as const,
  excludesRawWireDomainTables: true as const,
  forbidsDirectAgentOrUiSql: true as const
});

export const ROUND6_FEATURE_CONSUMER_MAPPING: readonly Round6FeatureConsumerEntry[] = Object.freeze([
  {
    featureId: 'F01',
    title: 'Production workflow integration and recovery',
    consumerDomain: 'execution-control-and-recovery',
    inputAuthorities: [
      'current-execution-admission-permits',
      'window-queue-ownership',
      'catalog-definitions-version-pointers',
      'review-findings-fix-claims'
    ],
    outputAuthorities: ['current-execution-admission-permits', 'window-queue-ownership'],
    sharedFieldsConsumed: ['schemaVersion', 'workspaceId', 'rootExecutionId', 'queueId', 'invocationId', 'attemptId'],
    ownedLimits: [
      { limitName: 'refusalMessageBytes', maxBytes: 240 },
      { limitName: 'maxForEachItems', maxItems: 256 }
    ],
    targetArchitecture: TARGET_ARCHITECTURE_BOUNDARY
  },
  {
    featureId: 'F02',
    title: 'Shared memory and storage contracts',
    consumerDomain: 'cross-consumer-logical-contracts',
    inputAuthorities: ['audit-evidence', 'ui-state-caches'],
    outputAuthorities: ['audit-evidence', 'ui-state-caches'],
    sharedFieldsConsumed: [
      'schemaVersion',
      'workspaceId',
      'rootExecutionId',
      'queueId',
      'invocationId',
      'attemptId',
      'providerSessionId',
      'acpSessionId',
      'observationId',
      'artifactId',
      'handoffId',
      'acceptedSeq',
      'quality.provenance',
      'quality.completeness',
      'streamCursor',
      'sourceCutoff',
      'omissions'
    ],
    ownedLimits: [
      { limitName: 'sharedIdentifierUtf8Bytes', maxBytes: 256 },
      { limitName: 'operatorExplanationUtf8Bytes', maxBytes: 240 },
      { limitName: 'omissionsCollectionItems', maxItems: 256 }
    ],
    targetArchitecture: TARGET_ARCHITECTURE_BOUNDARY
  },
  {
    featureId: 'F03',
    title: 'Runtime resource budgets',
    consumerDomain: 'resource-budgets-and-admission',
    inputAuthorities: [
      'current-execution-admission-permits',
      'accepted-usage-observations-adjustments',
      'artifact-availability-references-pins'
    ],
    outputAuthorities: ['current-execution-admission-permits'],
    sharedFieldsConsumed: ['schemaVersion', 'rootExecutionId', 'queueId', 'attemptId', 'streamCursor'],
    ownedLimits: [
      {
        limitName: 'resourceCollectorWindow',
        maxItems: RESOURCE_COLLECTOR_MAX_SAMPLES,
        maxBytes: RESOURCE_COLLECTOR_MAX_BYTES
      },
      {
        limitName: 'pendingAccountingProjectionWork',
        maxItems: PENDING_ACCOUNTING_PROJECTION_MAX_ITEMS,
        maxBytes: PENDING_ACCOUNTING_PROJECTION_MAX_BYTES
      },
      {
        limitName: 'outstandingAccountingIntents',
        maxItems: OUTSTANDING_ACCOUNTING_INTENTS_MAX_ITEMS,
        maxBytes: OUTSTANDING_ACCOUNTING_INTENTS_MAX_BYTES
      }
    ],
    targetArchitecture: TARGET_ARCHITECTURE_BOUNDARY
  },
  {
    featureId: 'F04',
    title: 'Transactional storage evaluation and SQLite foundation',
    consumerDomain: 'relational-storage-and-transactions',
    inputAuthorities: [
      'current-execution-admission-permits',
      'window-queue-ownership',
      'catalog-definitions-version-pointers'
    ],
    outputAuthorities: ['historical-execution-facts', 'catalog-definitions-version-pointers'],
    sharedFieldsConsumed: [
      'schemaVersion',
      'workspaceId',
      'rootExecutionId',
      'queueId',
      'invocationId',
      'attemptId',
      'acpSessionId',
      'observationId',
      'artifactId',
      'handoffId',
      'acceptedSeq',
      'sourceCutoff'
    ],
    ownedLimits: [
      { limitName: 'writerAdmissionQueueRequests', maxItems: 64 },
      { limitName: 'writerAdmissionQueueBytes', maxBytes: 16_777_216 }
    ],
    targetArchitecture: TARGET_ARCHITECTURE_BOUNDARY
  },
  {
    featureId: 'F05',
    title: 'Artifact lifecycle, storage, and recovery',
    consumerDomain: 'artifacts-pins-and-retention',
    inputAuthorities: ['audit-evidence', 'artifact-bytes', 'artifact-availability-references-pins'],
    outputAuthorities: ['artifact-bytes', 'artifact-availability-references-pins'],
    sharedFieldsConsumed: ['schemaVersion', 'workspaceId', 'rootExecutionId', 'attemptId', 'artifactId', 'acceptedSeq', 'omissions'],
    ownedLimits: [
      { limitName: 'artifactDisplayNameBytes', maxBytes: 256 },
      { limitName: 'artifactPinsPerOwner', maxItems: 64 }
    ],
    targetArchitecture: TARGET_ARCHITECTURE_BOUNDARY
  },
  {
    featureId: 'F06',
    title: 'Usage metrics and accounting',
    consumerDomain: 'metrics-and-spend-accounting',
    inputAuthorities: ['acp-interaction-metadata', 'accepted-usage-observations-adjustments'],
    outputAuthorities: ['accepted-usage-observations-adjustments', 'ui-state-caches'],
    sharedFieldsConsumed: [
      'schemaVersion',
      'rootExecutionId',
      'queueId',
      'invocationId',
      'attemptId',
      'providerSessionId',
      'acpSessionId',
      'observationId',
      'acceptedSeq',
      'quality.provenance',
      'quality.completeness',
      'omissions'
    ],
    ownedLimits: [
      { limitName: 'usageCorrectionsPerAttempt', maxItems: 64 },
      { limitName: 'decimalMonetaryTextBytes', maxBytes: 64 }
    ],
    targetArchitecture: TARGET_ARCHITECTURE_BOUNDARY
  },
  {
    featureId: 'F07',
    title: 'Recoverable live logs',
    consumerDomain: 'live-logs-and-streaming',
    inputAuthorities: ['acp-interaction-metadata', 'artifact-bytes', 'artifact-availability-references-pins'],
    outputAuthorities: ['artifact-bytes', 'artifact-availability-references-pins', 'ui-state-caches'],
    sharedFieldsConsumed: [
      'schemaVersion',
      'rootExecutionId',
      'invocationId',
      'attemptId',
      'acpSessionId',
      'artifactId',
      'acceptedSeq',
      'quality.provenance',
      'quality.completeness',
      'streamCursor'
    ],
    ownedLimits: [
      { limitName: 'liveLogSegmentsPerStream', maxItems: 256 },
      { limitName: 'liveLogSegmentBytes', maxBytes: 1_048_576 }
    ],
    targetArchitecture: TARGET_ARCHITECTURE_BOUNDARY
  },
  {
    featureId: 'F08',
    title: 'Durable handoff and resume',
    consumerDomain: 'recovery-handoff-and-resume',
    inputAuthorities: [
      'current-execution-admission-permits',
      'window-queue-ownership',
      'historical-execution-facts',
      'audit-evidence',
      'artifact-bytes',
      'artifact-availability-references-pins',
      'accepted-phase-context-input-selection',
      'catalog-definitions-version-pointers',
      'acp-interaction-metadata',
      'provider-conversation-history'
    ],
    outputAuthorities: ['current-execution-admission-permits', 'artifact-availability-references-pins'],
    sharedFieldsConsumed: [
      'schemaVersion',
      'workspaceId',
      'rootExecutionId',
      'queueId',
      'invocationId',
      'attemptId',
      'providerSessionId',
      'acpSessionId',
      'artifactId',
      'handoffId',
      'acceptedSeq',
      'quality.provenance',
      'quality.completeness',
      'sourceCutoff',
      'omissions'
    ],
    ownedLimits: [
      { limitName: 'recoveryEnvelopeBytes', maxBytes: 16_384 },
      { limitName: 'recoveryRefsPerArray', maxItems: 32 }
    ],
    targetArchitecture: TARGET_ARCHITECTURE_BOUNDARY
  },
  {
    featureId: 'F09',
    title: 'Backend containment qualification',
    consumerDomain: 'backend-containment',
    inputAuthorities: ['current-execution-admission-permits'],
    outputAuthorities: ['current-execution-admission-permits'],
    sharedFieldsConsumed: ['schemaVersion', 'attemptId'],
    ownedLimits: [{ limitName: 'containmentDiagnosticBytes', maxBytes: 240 }],
    targetArchitecture: TARGET_ARCHITECTURE_BOUNDARY
  },
  {
    featureId: 'F10',
    title: 'Isolated workspaces and Git integration',
    consumerDomain: 'worktree-isolation-and-integration',
    inputAuthorities: [
      'current-execution-admission-permits',
      'window-queue-ownership',
      'review-findings-fix-claims'
    ],
    outputAuthorities: ['current-execution-admission-permits', 'historical-execution-facts'],
    sharedFieldsConsumed: ['schemaVersion', 'workspaceId', 'rootExecutionId', 'queueId', 'attemptId'],
    ownedLimits: [{ limitName: 'candidateSnapshotEntries', maxItems: 256 }],
    targetArchitecture: TARGET_ARCHITECTURE_BOUNDARY
  },
  {
    featureId: 'F11',
    title: 'Historical reporting and exports',
    consumerDomain: 'reporting-and-exports',
    inputAuthorities: [
      'accepted-usage-observations-adjustments',
      'historical-execution-facts',
      'audit-evidence',
      'artifact-bytes',
      'artifact-availability-references-pins',
      'catalog-definitions-version-pointers'
    ],
    outputAuthorities: ['artifact-bytes', 'artifact-availability-references-pins', 'ui-state-caches'],
    sharedFieldsConsumed: [
      'schemaVersion',
      'workspaceId',
      'rootExecutionId',
      'queueId',
      'invocationId',
      'attemptId',
      'providerSessionId',
      'observationId',
      'artifactId',
      'acceptedSeq',
      'quality.provenance',
      'quality.completeness',
      'streamCursor',
      'sourceCutoff',
      'omissions'
    ],
    ownedLimits: [
      { limitName: 'reportPageSizeMax', maxItems: 100 },
      { limitName: 'reportFilterKeysMax', maxItems: 16 }
    ],
    targetArchitecture: TARGET_ARCHITECTURE_BOUNDARY
  },
  {
    featureId: 'F12',
    title: 'Change review and execution visibility',
    consumerDomain: 'review-and-execution-visibility',
    inputAuthorities: [
      'current-execution-admission-permits',
      'historical-execution-facts',
      'audit-evidence',
      'artifact-bytes',
      'review-findings-fix-claims',
      'ui-state-caches'
    ],
    outputAuthorities: ['ui-state-caches'],
    sharedFieldsConsumed: [
      'schemaVersion',
      'rootExecutionId',
      'queueId',
      'invocationId',
      'attemptId',
      'artifactId',
      'handoffId',
      'acceptedSeq',
      'quality.provenance',
      'quality.completeness',
      'streamCursor',
      'sourceCutoff',
      'omissions'
    ],
    ownedLimits: [{ limitName: 'reviewVisibilityFindingsPageMax', maxItems: 100 }],
    targetArchitecture: TARGET_ARCHITECTURE_BOUNDARY
  },
  {
    featureId: 'F13',
    title: 'ACP integration pilot and canonical agent runtime',
    consumerDomain: 'agent-runtime-acp',
    inputAuthorities: [
      'accepted-phase-context-input-selection',
      'acp-interaction-metadata',
      'provider-conversation-history'
    ],
    outputAuthorities: ['acp-interaction-metadata', 'provider-conversation-history'],
    sharedFieldsConsumed: ['schemaVersion', 'rootExecutionId', 'attemptId', 'providerSessionId', 'acpSessionId', 'observationId', 'handoffId'],
    ownedLimits: [
      { limitName: 'acpReceiptReasonBytes', maxBytes: 240 },
      { limitName: 'acpActiveSessionsPerConnection', maxItems: 16 }
    ],
    targetArchitecture: TARGET_ARCHITECTURE_BOUNDARY
  },
  {
    featureId: 'F14',
    title: 'Optional OpenTelemetry export',
    consumerDomain: 'telemetry-export',
    inputAuthorities: [
      'accepted-usage-observations-adjustments',
      'historical-execution-facts',
      'acp-interaction-metadata'
    ],
    outputAuthorities: [],
    sharedFieldsConsumed: [
      'schemaVersion',
      'rootExecutionId',
      'attemptId',
      'acpSessionId',
      'observationId',
      'acceptedSeq',
      'quality.provenance',
      'quality.completeness'
    ],
    ownedLimits: [
      { limitName: 'telemetryExportBatchSpansMax', maxItems: 256 },
      { limitName: 'telemetryDimensionSetMax', maxItems: 64 }
    ],
    targetArchitecture: TARGET_ARCHITECTURE_BOUNDARY
  },
  {
    featureId: 'F15',
    title: 'Phase-to-phase context handoff and review/fix loops',
    consumerDomain: 'phase-context-handoff-and-review-loops',
    inputAuthorities: [
      'historical-execution-facts',
      'artifact-bytes',
      'artifact-availability-references-pins',
      'catalog-definitions-version-pointers',
      'acp-interaction-metadata'
    ],
    outputAuthorities: ['accepted-phase-context-input-selection', 'review-findings-fix-claims'],
    sharedFieldsConsumed: [
      'schemaVersion',
      'rootExecutionId',
      'invocationId',
      'attemptId',
      'acpSessionId',
      'observationId',
      'artifactId',
      'handoffId',
      'acceptedSeq',
      'quality.completeness',
      'sourceCutoff',
      'omissions'
    ],
    ownedLimits: [
      { limitName: 'handoffSourcesMax', maxItems: 32 },
      { limitName: 'findingsPerReportMax', maxItems: 256 }
    ],
    targetArchitecture: TARGET_ARCHITECTURE_BOUNDARY
  }
]);

export const RETENTION_CLASS_IDS = [
  'new-terminal-execution-usage-detail',
  'active-and-recovery-required-metadata',
  'aggregate-history',
  'transcripts-diagnostics-checkpoints-audit-catalog',
  'generated-reports-handoff-exports',
  'provider-owned-session-stores'
] as const;

export type RetentionClassId = (typeof RETENTION_CLASS_IDS)[number];

export interface RetentionPolicyInventoryEntry {
  readonly retentionClass: RetentionClassId;
  readonly governingPolicy:
    | 'new-metadata-90d-or-256mib'
    | 'existing-admission-ledger-limits'
    | 'explicit-reporting-horizon-aggregate'
    | 'existing-class-specific-policy'
    | 'independent-export-or-artifact-class'
    | 'external-provider-boundary';
  readonly maxAgeDays?: number | undefined;
  readonly reclaimTargetBytes?: number | undefined;
  readonly ageStartsAt?: 'terminal-settlement' | undefined;
  readonly appliesOnlyAfterActivation: boolean;
  readonly upgradeDeletesLegacyHistory: false;
  readonly reportingHorizonDisclosure: string;
}

export const RETENTION_POLICY_INVENTORY: readonly RetentionPolicyInventoryEntry[] = Object.freeze([
  {
    retentionClass: 'new-terminal-execution-usage-detail',
    governingPolicy: 'new-metadata-90d-or-256mib',
    maxAgeDays: NEW_METADATA_RETENTION_MAX_AGE_DAYS,
    reclaimTargetBytes: NEW_METADATA_RETENTION_RECLAIM_TARGET_BYTES,
    ageStartsAt: 'terminal-settlement',
    appliesOnlyAfterActivation: true,
    upgradeDeletesLegacyHistory: false,
    reportingHorizonDisclosure:
      'Unpinned terminal detail is collectible at 90 days from terminal settlement or 256 MiB reclaim target after policy activation; aggregate contribution and deletion watermark are committed first.'
  },
  {
    retentionClass: 'active-and-recovery-required-metadata',
    governingPolicy: 'existing-admission-ledger-limits',
    appliesOnlyAfterActivation: false,
    upgradeDeletesLegacyHistory: false,
    reportingHorizonDisclosure:
      'Preserved across active, paused, and uncertain runs within admission/ledger limits; settlement reserve space is protected before new admission.'
  },
  {
    retentionClass: 'aggregate-history',
    governingPolicy: 'explicit-reporting-horizon-aggregate',
    appliesOnlyAfterActivation: false,
    upgradeDeletesLegacyHistory: false,
    reportingHorizonDisclosure:
      'Preserves supported cumulative totals and coverage horizon; arbitrary backend/model/date cohorts are not promised after underlying detail expires.'
  },
  {
    retentionClass: 'transcripts-diagnostics-checkpoints-audit-catalog',
    governingPolicy: 'existing-class-specific-policy',
    appliesOnlyAfterActivation: false,
    upgradeDeletesLegacyHistory: false,
    reportingHorizonDisclosure:
      'Governed by existing class-specific rotation, retention, and append-only audit integrity policies until an explicit policy change.'
  },
  {
    retentionClass: 'generated-reports-handoff-exports',
    governingPolicy: 'independent-export-or-artifact-class',
    appliesOnlyAfterActivation: false,
    upgradeDeletesLegacyHistory: false,
    reportingHorizonDisclosure:
      'User-owned exported copies have independent lifetimes; managed internal copies follow their artifact class without creating a permanent pin.'
  },
  {
    retentionClass: 'provider-owned-session-stores',
    governingPolicy: 'external-provider-boundary',
    appliesOnlyAfterActivation: false,
    upgradeDeletesLegacyHistory: false,
    reportingHorizonDisclosure:
      'Managed outside Schegent retention and deletion; operator views disclose provider-store independence.'
  }
]);

export interface AuthorityInventoryVerificationResult {
  readonly ok: boolean;
  readonly dataClassesCovered: number;
  readonly featuresCovered: number;
  readonly orphanSharedFields: readonly string[];
  readonly competingAuthorities: readonly string[];
}

export function validateAuthorityInventoryCompleteness(): AuthorityInventoryVerificationResult {
  const seenClasses = new Set<string>();
  const competingAuthorities: string[] = [];
  for (const row of DATA_CLASS_AUTHORITY_INVENTORY) {
    if (seenClasses.has(row.dataClass)) {
      competingAuthorities.push(row.dataClass);
    }
    seenClasses.add(row.dataClass);
    if (row.derivedConsumers.length === 0) {
      competingAuthorities.push(`${row.dataClass}:missing-owner-or-consumer`);
    }
  }
  const featureIds = new Set(ROUND6_FEATURE_CONSUMER_MAPPING.map((f) => f.featureId));
  const orphanSharedFields = SHARED_FIELD_DICTIONARY.filter(
    (field) => field.namedConsumers.length === 0
  ).map((field) => field.fieldName);

  return {
    ok:
      seenClasses.size === DATA_CLASS_IDS.length &&
      featureIds.size === ROUND6_FEATURE_IDS.length &&
      orphanSharedFields.length === 0 &&
      competingAuthorities.length === 0,
    dataClassesCovered: seenClasses.size,
    featuresCovered: featureIds.size,
    orphanSharedFields,
    competingAuthorities
  };
}

export interface AuthorityProposalReviewInput {
  readonly featureId: Round6FeatureId;
  readonly dataClass: DataClassId;
  readonly claimsWriteAuthority: boolean;
  readonly introducesParallelIdentity?:
    | 'rootExecutionId'
    | 'attemptId'
    | 'executionFence'
    | undefined;
}

export function reviewAuthorityProposal(
  proposal: AuthorityProposalReviewInput
): StorageBoundaryOutcome<{ readonly approved: true; readonly authoritativeOwner: Round6FeatureId }> {
  if (proposal.introducesParallelIdentity !== undefined) {
    return buildSharedContractRefusal(
      'identity-mismatch',
      'competing-identity-allocation-rejected',
      `Proposal from ${proposal.featureId} introduces a parallel '${proposal.introducesParallelIdentity}' where an existing authority already supplies one.`,
      proposal.introducesParallelIdentity
    );
  }
  const entry = DATA_CLASS_AUTHORITY_INVENTORY.find((row) => row.dataClass === proposal.dataClass);
  if (!entry) {
    return buildSharedContractRefusal(
      'invalid-observation',
      'unknown-data-class',
      `Data class '${proposal.dataClass}' is not in the C2 authority inventory.`,
      'dataClass'
    );
  }
  if (
    proposal.claimsWriteAuthority &&
    proposal.featureId !== entry.singleAuthorityOwner &&
    !(
      proposal.featureId === 'F04' &&
      (proposal.dataClass === 'current-execution-admission-permits' ||
        proposal.dataClass === 'window-queue-ownership')
    )
  ) {
    return buildSharedContractRefusal(
      'identity-mismatch',
      'competing-data-class-authority-rejected',
      `Feature ${proposal.featureId} cannot claim write authority over '${proposal.dataClass}'; single authority belongs to ${entry.singleAuthorityOwner}.`,
      'dataClass'
    );
  }
  return {
    status: 'accepted',
    value: { approved: true, authoritativeOwner: entry.singleAuthorityOwner }
  };
}

export function assertExecutionEffectAuthority(
  sourceKind: DataClassId | NonAuthoritativeExecutionSource,
  effect: ProtectedExecutionEffect
): StorageBoundaryOutcome<{ readonly authorized: true }> {
  if ((NON_AUTHORITATIVE_EXECUTION_SOURCES as readonly string[]).includes(sourceKind)) {
    return buildSharedContractRefusal(
      'identity-mismatch',
      'non-authoritative-source-for-execution-effect',
      `Derived source '${sourceKind}' cannot authorize '${effect}'. Only the host execution state machine and ownership fences hold execution authority.`,
      'sourceKind'
    );
  }
  const row = DATA_CLASS_AUTHORITY_INVENTORY.find((entry) => entry.dataClass === sourceKind);
  if (!row || !row.canAuthorizeExecutionEffects) {
    return buildSharedContractRefusal(
      'identity-mismatch',
      'data-class-not-execution-authority',
      `Data class '${sourceKind}' is not an execution authority for '${effect}'.`,
      'sourceKind'
    );
  }
  return { status: 'accepted', value: { authorized: true } };
}

export function lookupRetentionPolicy(
  retentionClass: RetentionClassId
): RetentionPolicyInventoryEntry {
  const found = RETENTION_POLICY_INVENTORY.find((entry) => entry.retentionClass === retentionClass);
  if (!found) {
    throw new Error(`Unknown retention class: ${retentionClass}`);
  }
  return found;
}

