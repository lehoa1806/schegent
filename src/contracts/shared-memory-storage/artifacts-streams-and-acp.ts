/**
 * FR-R6-F02 — Shared memory and storage contracts: C4 artifacts & retention,
 * C5 stream cursors & report/handoff provenance, C8 storage outcomes &
 * forward-only compatibility, and FR-017/FR-018 ACP event normalization into
 * logical SQLite fixtures.
 *
 * Zero `vscode` imports (SC-009, docs/hard-rules.md rule 13).
 */

import type { SnapshotSyncMeta } from '../snapshot-bounds';
import {
  SHARED_STORAGE_CONTRACT_VERSION,
  buildSharedContractRefusal,
  sanitizeOperatorExplanation,
  validateSharedIdentifier,
  type StorageBoundaryOutcome
} from './inventories';
import type { RetentionClassId } from './consumer-and-retention-inventories';
import {
  acceptUsageObservation,
  type AcceptedUsageObservation,
  type ArtifactAvailabilityState,
  type MeasureCompleteness,
  type MissingAttributionReason,
  type ObservationLedgerState,
  type UnavailableReasonCode
} from './identity-and-observations';

export type ArtifactPinPurpose =
  | 'active-recovery'
  | 'paused-recovery'
  | 'uncertain-recovery'
  | 'pending-handoff'
  | 'report-lease'
  | 'export-operation';

export interface ArtifactPinRecord {
  readonly pinId: string;
  readonly ownerId: string;
  readonly purpose: ArtifactPinPurpose;
}

export interface ArtifactDescriptor {
  readonly schemaVersion: typeof SHARED_STORAGE_CONTRACT_VERSION;
  readonly artifactId: string;
  readonly originAttemptId: string;
  readonly originAttemptTerminalStatus: 'completed' | 'failed' | 'canceled' | 'in-flight';
  readonly kind:
    | 'transcript'
    | 'diagnostic'
    | 'checkpoint'
    | 'report'
    | 'handoff-context'
    | 'review-report'
    | 'live-log-segment';
  readonly immutableVersion: number;
  readonly digestAlgorithm: 'sha256';
  readonly digestHex: string | null;
  readonly byteSize: number;
  readonly createdAtUtc: string;
  readonly sensitivity: 'metadata-only' | 'redacted-content' | 'sensitive-raw';
  readonly validationState: 'verified' | 'unverified-live-prefix' | 'invalid-digest';
  readonly availability: ArtifactAvailabilityState;
  readonly retentionClass: RetentionClassId;
  readonly displayName: string;
  readonly hostPrivateFilePath?: string | undefined;
  readonly growingLog?: {
    readonly generation: number;
    readonly extentBytes: number;
    readonly finalized: boolean;
  } | undefined;
  readonly pins: readonly ArtifactPinRecord[];
}

export interface PublicArtifactProjection {
  readonly artifactId: string;
  readonly originAttemptId: string;
  readonly immutableVersion: number;
  readonly digestHex: string | null;
  readonly byteSize: number;
  readonly validationState: ArtifactDescriptor['validationState'];
  readonly availability: ArtifactAvailabilityState;
  readonly displayName: string;
  readonly growingLog?: ArtifactDescriptor['growingLog'] | undefined;
}

export function resolveArtifactReference(
  descriptor: ArtifactDescriptor,
  expectedVersion: number,
  observedCurrentDigestHex: string | null
): StorageBoundaryOutcome<{
  readonly projection: PublicArtifactProjection;
  readonly substitutedBytes: null;
}> {
  if (descriptor.growingLog !== undefined && !descriptor.growingLog.finalized) {
    return {
      status: 'accepted',
      value: {
        projection: {
          artifactId: descriptor.artifactId,
          originAttemptId: descriptor.originAttemptId,
          immutableVersion: descriptor.immutableVersion,
          digestHex: null,
          byteSize: descriptor.growingLog.extentBytes,
          validationState: 'unverified-live-prefix',
          availability: descriptor.availability,
          displayName: sanitizeOperatorExplanation(descriptor.displayName),
          growingLog: descriptor.growingLog
        },
        substitutedBytes: null
      }
    };
  }

  if (
    descriptor.immutableVersion !== expectedVersion ||
    descriptor.digestHex === null ||
    observedCurrentDigestHex !== descriptor.digestHex
  ) {
    return buildSharedContractRefusal(
      'missing-artifact',
      'artifact-version-or-digest-mismatch',
      `Artifact '${descriptor.artifactId}' failed version or digest verification; substitute bytes are never served.`,
      'digestHex'
    );
  }

  return {
    status: 'accepted',
    value: {
      projection: {
        artifactId: descriptor.artifactId,
        originAttemptId: descriptor.originAttemptId,
        immutableVersion: descriptor.immutableVersion,
        digestHex: descriptor.digestHex,
        byteSize: descriptor.byteSize,
        validationState: 'verified',
        availability: descriptor.availability,
        displayName: sanitizeOperatorExplanation(descriptor.displayName)
      },
      substitutedBytes: null
    }
  };
}

export function checkPinQuotaAdmission(input: {
  readonly currentPinnedCount: number;
  readonly maxPinQuota: number;
  readonly settlementReservePins: number;
  readonly isSettlementWork: boolean;
}): StorageBoundaryOutcome<{ readonly admitted: true }> {
  const ceiling = input.isSettlementWork
    ? input.maxPinQuota
    : input.maxPinQuota - input.settlementReservePins;
  if (input.currentPinnedCount >= ceiling) {
    return buildSharedContractRefusal(
      'capacity-refusal',
      'pin-quota-settlement-reserve-reached',
      'New admission is refused because artifact pin capacity is reserved to settle existing active work.',
      'currentPinnedCount'
    );
  }
  return { status: 'accepted', value: { admitted: true } };
}

export interface RetentionSweepCandidate {
  readonly artifact: ArtifactDescriptor;
  readonly eligibleByAgeOrSize: boolean;
  readonly explicitlyAuthorizedDeletion?: boolean | undefined;
}

export interface RetentionSweepOutcomeItem {
  readonly artifactId: string;
  readonly action:
    | 'preserved-pinned'
    | 'preserved-ineligible'
    | 'collected'
    | 'authorized-deleted-recovery-dependency';
  readonly aggregateContributionCommitted: boolean;
  readonly deletionWatermarkCommitted: boolean;
  readonly consequenceReported: boolean;
  readonly resultingAvailability: ArtifactAvailabilityState;
  readonly missingEvidenceStatePersisted: boolean;
}

const RECOVERY_OR_HANDOFF_PIN_PURPOSES = new Set<ArtifactPinPurpose>([
  'active-recovery',
  'paused-recovery',
  'uncertain-recovery',
  'pending-handoff'
]);

export function evaluateRetentionSweep(
  candidates: readonly RetentionSweepCandidate[]
): readonly RetentionSweepOutcomeItem[] {
  return candidates.map((item) => {
    const hasProtectedPin = item.artifact.pins.some((p) =>
      RECOVERY_OR_HANDOFF_PIN_PURPOSES.has(p.purpose)
    );
    if (item.explicitlyAuthorizedDeletion === true && hasProtectedPin) {
      return {
        artifactId: item.artifact.artifactId,
        action: 'authorized-deleted-recovery-dependency',
        aggregateContributionCommitted: true,
        deletionWatermarkCommitted: true,
        consequenceReported: true,
        resultingAvailability: 'deleted',
        missingEvidenceStatePersisted: true
      };
    }
    if (hasProtectedPin) {
      return {
        artifactId: item.artifact.artifactId,
        action: 'preserved-pinned',
        aggregateContributionCommitted: false,
        deletionWatermarkCommitted: false,
        consequenceReported: false,
        resultingAvailability: item.artifact.availability,
        missingEvidenceStatePersisted: false
      };
    }
    if (!item.eligibleByAgeOrSize) {
      return {
        artifactId: item.artifact.artifactId,
        action: 'preserved-ineligible',
        aggregateContributionCommitted: false,
        deletionWatermarkCommitted: false,
        consequenceReported: false,
        resultingAvailability: item.artifact.availability,
        missingEvidenceStatePersisted: false
      };
    }
    return {
      artifactId: item.artifact.artifactId,
      action: 'collected',
      aggregateContributionCommitted: true,
      deletionWatermarkCommitted: true,
      consequenceReported: false,
      resultingAvailability: 'expired',
      missingEvidenceStatePersisted: false
    };
  });
}

export interface StreamCursor {
  readonly streamId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly snapshotMeta?: SnapshotSyncMeta | undefined;
}

export interface StreamDeliveryInput {
  readonly cursor: StreamCursor;
  readonly activeGeneration: number;
  readonly earliestRetainedSequence: number;
  readonly latestSequence: number;
  readonly incomingGeneration: number;
  readonly incomingSequence: number;
  readonly snapshotRevision: number;
}

export type StreamDeliveryClassification =
  | { readonly disposition: 'new-item'; readonly nextCursor: StreamCursor }
  | { readonly disposition: 'duplicate'; readonly nextCursor: StreamCursor }
  | {
      readonly disposition: 'gap';
      readonly missingFromSequence: number;
      readonly missingToSequence: number;
      readonly nextCursor: StreamCursor;
    }
  | { readonly disposition: 'stale-generation'; readonly nextCursor: StreamCursor }
  | {
      readonly disposition: 'expired-cursor';
      readonly errorCategory: 'expired-cursor';
      readonly gapFromSequence: number;
      readonly gapToSequence: number;
      readonly freshTailCursor: StreamCursor;
      readonly freshSnapshotMeta: SnapshotSyncMeta;
    };

export function evaluateStreamCursorDelivery(
  input: StreamDeliveryInput
): StreamDeliveryClassification {
  const cursorFromOlderGeneration = input.cursor.generation < input.activeGeneration;
  if (
    cursorFromOlderGeneration ||
    (input.cursor.generation === input.activeGeneration &&
      input.cursor.sequence + 1 < input.earliestRetainedSequence)
  ) {
    // A cursor from a superseded generation cannot be compared by sequence; the
    // whole active generation up to the retained floor is reported as the gap.
    return {
      disposition: 'expired-cursor',
      errorCategory: 'expired-cursor',
      gapFromSequence: cursorFromOlderGeneration ? 1 : input.cursor.sequence + 1,
      gapToSequence: Math.max(0, input.earliestRetainedSequence - 1),
      freshTailCursor: {
        streamId: input.cursor.streamId,
        generation: input.activeGeneration,
        sequence: input.latestSequence
      },
      freshSnapshotMeta: {
        mode: 'full',
        revision: input.snapshotRevision
      }
    };
  }
  if (input.incomingGeneration < input.activeGeneration) {
    return {
      disposition: 'stale-generation',
      nextCursor: input.cursor
    };
  }
  if (input.incomingSequence <= input.cursor.sequence) {
    return {
      disposition: 'duplicate',
      nextCursor: input.cursor
    };
  }
  if (input.incomingSequence > input.cursor.sequence + 1) {
    return {
      disposition: 'gap',
      missingFromSequence: input.cursor.sequence + 1,
      missingToSequence: input.incomingSequence - 1,
      nextCursor: {
        streamId: input.cursor.streamId,
        generation: input.activeGeneration,
        sequence: input.incomingSequence
      }
    };
  }
  return {
    disposition: 'new-item',
    nextCursor: {
      streamId: input.cursor.streamId,
      generation: input.activeGeneration,
      sequence: input.incomingSequence
    }
  };
}

export interface QueryCutoff {
  readonly maxAcceptedSeq: number;
  readonly snapshotRevision: number;
  readonly capturedAtUtc: string;
}

export interface ReportHandoffManifest {
  readonly schemaVersion: typeof SHARED_STORAGE_CONTRACT_VERSION;
  readonly manifestId: string;
  readonly kind: 'report' | 'handoff';
  readonly sourceCutoff: QueryCutoff;
  readonly calculationVersion: string;
  readonly filters: Readonly<Record<string, string | number | boolean>>;
  readonly ordering: readonly string[];
  readonly timezone: string;
  readonly coverage: {
    readonly completeness: MeasureCompleteness;
    readonly detailCutoffUtc?: string | undefined;
    readonly retainedRowCount: number;
    readonly omittedRowCount: number;
  };
  readonly omissions: readonly {
    readonly code: UnavailableReasonCode;
    readonly count: number;
    readonly explanation: string;
  }[];
  readonly grantsExecutionAuthority: false;
}

/** F11-owned `reportPageSizeMax` limit published in the consumer mapping. */
const MAX_REPORT_PAGE_SIZE = 100;

export interface ReportRowFact {
  readonly attemptId: string;
  readonly rootExecutionId: string;
  readonly queueId: string;
  readonly acceptedSeq: number;
  readonly summary: string;
}

export function pageReportAtCutoff(input: {
  readonly allFacts: readonly ReportRowFact[];
  readonly manifest: ReportHandoffManifest;
  readonly pageSize: number;
  readonly afterAcceptedSeq?: number | undefined;
  readonly canceled?: boolean | undefined;
}): StorageBoundaryOutcome<{
  readonly rows: readonly ReportRowFact[];
  readonly nextAfterAcceptedSeq: number | null;
  readonly sourceCutoff: QueryCutoff;
  readonly isComplete: boolean;
}> {
  if (input.canceled === true) {
    return buildSharedContractRefusal(
      'stale-revision',
      'report-generation-canceled',
      'Report generation was canceled mid-run; partial report output is never presented as complete.'
    );
  }
  if (
    !Number.isInteger(input.pageSize) ||
    input.pageSize < 1 ||
    input.pageSize > MAX_REPORT_PAGE_SIZE
  ) {
    return buildSharedContractRefusal(
      'capacity-refusal',
      'report-page-size-out-of-range',
      `Report page size must be an integer between 1 and ${MAX_REPORT_PAGE_SIZE}.`,
      'pageSize'
    );
  }
  const eligible = input.allFacts
    .filter((f) => f.acceptedSeq <= input.manifest.sourceCutoff.maxAcceptedSeq)
    .sort((a, b) => a.acceptedSeq - b.acceptedSeq || a.attemptId.localeCompare(b.attemptId));
  const afterSeq = input.afterAcceptedSeq ?? 0;
  const windowRows = eligible.filter((f) => f.acceptedSeq > afterSeq).slice(0, input.pageSize);
  const lastRow = windowRows.at(-1);
  const nextAfterAcceptedSeq =
    lastRow !== undefined && eligible.some((f) => f.acceptedSeq > lastRow.acceptedSeq)
      ? lastRow.acceptedSeq
      : null;
  return {
    status: 'accepted',
    value: {
      rows: windowRows,
      nextAfterAcceptedSeq,
      sourceCutoff: input.manifest.sourceCutoff,
      isComplete: true
    }
  };
}

export function renderHandoffProseProjection(
  manifest: ReportHandoffManifest,
  editedProseOverride?: string
): { readonly prose: string; readonly authoritativeManifest: ReportHandoffManifest } {
  const frozenManifest: ReportHandoffManifest = structuredClone(manifest);
  const defaultProse = `Handoff ${manifest.manifestId} at seq=${manifest.sourceCutoff.maxAcceptedSeq} (${manifest.calculationVersion})`;
  return {
    prose: editedProseOverride ?? defaultProse,
    authoritativeManifest: frozenManifest
  };
}

export interface StorageOperationReceiptStore {
  readonly committedByOperationId: Map<
    string,
    { readonly factId: string; readonly payloadDigest: string }
  >;
  readonly uncertainByOperationId: Map<
    string,
    { readonly factId: string; readonly payloadDigest: string }
  >;
}

export function createStorageOperationReceiptStore(): StorageOperationReceiptStore {
  return {
    committedByOperationId: new Map(),
    uncertainByOperationId: new Map()
  };
}

export function executeIdempotentStorageAcceptance(
  store: StorageOperationReceiptStore,
  input: {
    readonly operationId: string;
    readonly factId: string;
    readonly payloadDigest: string;
    readonly simulateInterruptedAcknowledgement?: boolean | undefined;
  }
): StorageBoundaryOutcome<{ readonly factId: string; readonly replayed: boolean }> {
  const existingCommitted = store.committedByOperationId.get(input.operationId);
  if (existingCommitted !== undefined) {
    if (existingCommitted.payloadDigest !== input.payloadDigest) {
      return buildSharedContractRefusal(
        'identity-mismatch',
        'operation-id-payload-conflict',
        `Operation '${input.operationId}' was already accepted with different content.`,
        'operationId',
        input.operationId
      );
    }
    return {
      status: 'accepted',
      operationId: input.operationId,
      value: { factId: existingCommitted.factId, replayed: true }
    };
  }

  const existingUncertain = store.uncertainByOperationId.get(input.operationId);
  if (existingUncertain !== undefined) {
    if (existingUncertain.payloadDigest !== input.payloadDigest) {
      return buildSharedContractRefusal(
        'identity-mismatch',
        'operation-id-payload-conflict',
        `Operation '${input.operationId}' is pending reconciliation with different content.`,
        'operationId',
        input.operationId
      );
    }
    if (input.simulateInterruptedAcknowledgement === true) {
      return {
        status: 'uncertain',
        operationId: input.operationId,
        recoveryObligation: 'reconcile-receipt-before-retry-or-effect',
        error: {
          category: 'uncertain-persistence',
          reasonCode: 'write-acknowledgement-interrupted',
          operatorExplanation: sanitizeOperatorExplanation(
            `Outcome for operation '${input.operationId}' is uncertain after an interrupted acknowledgement; reconciliation preserves original identity '${existingUncertain.factId}'.`
          )
        }
      };
    }
    store.uncertainByOperationId.delete(input.operationId);
    store.committedByOperationId.set(input.operationId, existingUncertain);
    return {
      status: 'accepted',
      operationId: input.operationId,
      value: { factId: existingUncertain.factId, replayed: true }
    };
  }

  if (input.simulateInterruptedAcknowledgement === true) {
    store.uncertainByOperationId.set(input.operationId, {
      factId: input.factId,
      payloadDigest: input.payloadDigest
    });
    return {
      status: 'uncertain',
      operationId: input.operationId,
      recoveryObligation: 'reconcile-receipt-before-retry-or-effect',
      error: {
        category: 'uncertain-persistence',
        reasonCode: 'write-acknowledgement-interrupted',
        operatorExplanation: sanitizeOperatorExplanation(
          `Outcome for operation '${input.operationId}' is uncertain after an interrupted acknowledgement; replay will reuse identity '${input.factId}'.`
        )
      }
    };
  }

  store.committedByOperationId.set(input.operationId, {
    factId: input.factId,
    payloadDigest: input.payloadDigest
  });
  return {
    status: 'accepted',
    operationId: input.operationId,
    value: { factId: input.factId, replayed: false }
  };
}

export interface CompatibleRecordView {
  readonly schemaVersion: typeof SHARED_STORAGE_CONTRACT_VERSION;
  readonly recordId: string;
  readonly rootExecutionId: string;
  readonly queueId: string;
  readonly availableValues: Readonly<Record<string, unknown>>;
  readonly missingAttributionReasons: Readonly<Record<string, MissingAttributionReason>>;
  readonly upgradedFromLegacyInMemory: boolean;
  readonly startupRewritePerformed: false;
}

export function readCompatibleRecord(input: unknown): StorageBoundaryOutcome<CompatibleRecordView> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return buildSharedContractRefusal(
      'invalid-observation',
      'record-not-an-object',
      'Compatible record input must be a JSON object.'
    );
  }
  const rawRecord = input as Readonly<Record<string, unknown>>;
  if (rawRecord.kind === 'RetiredPipelineV0' || rawRecord.retiredFormat === true) {
    return buildSharedContractRefusal(
      'unsupported-version',
      'retired-format-refused',
      'Record uses a retired format; automatic conversion of retired formats is not supported.',
      'kind'
    );
  }

  const version = rawRecord.schemaVersion ?? rawRecord.version;
  if (typeof version === 'number' && version > SHARED_STORAGE_CONTRACT_VERSION) {
    return buildSharedContractRefusal(
      'unsupported-version',
      'unknown-future-schema-version',
      `Record carries unknown future schema version '${version}'; read is refused and stored bytes are preserved unchanged.`,
      'schemaVersion'
    );
  }
  if (version !== undefined && version !== 1 && version !== '1.0.0') {
    return buildSharedContractRefusal(
      'unsupported-version',
      'invalid-schema-version-discriminator',
      'Record is missing a supported schema version discriminator.',
      'schemaVersion'
    );
  }

  const recordId = typeof rawRecord.recordId === 'string' ? rawRecord.recordId : 'legacy-record';
  const rootExecutionId =
    typeof rawRecord.rootExecutionId === 'string'
      ? rawRecord.rootExecutionId
      : typeof rawRecord.runId === 'string'
        ? rawRecord.runId
        : '';
  const queueId = typeof rawRecord.queueId === 'string' ? rawRecord.queueId : 'default';

  const idCheck = validateSharedIdentifier(rootExecutionId, 'rootExecutionId');
  if (idCheck.status !== 'accepted') return idCheck;

  const missing: Record<string, MissingAttributionReason> = {};
  if (typeof rawRecord.modelId !== 'string') {
    missing.modelId = 'not-recorded-in-legacy-schema';
  }
  if (typeof rawRecord.providerSessionId !== 'string') {
    missing.providerSessionId = 'not-recorded-in-legacy-schema';
  }
  if (typeof rawRecord.attemptId !== 'string') {
    missing.attemptId = 'not-recorded-in-legacy-schema';
  }

  return {
    status: 'accepted',
    value: {
      schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
      recordId,
      rootExecutionId: idCheck.value.id,
      queueId,
      availableValues: { ...rawRecord },
      missingAttributionReasons: missing,
      upgradedFromLegacyInMemory: rawRecord.schemaVersion === undefined,
      startupRewritePerformed: false
    }
  };
}

export interface AcpEventEnvelope {
  readonly profileId: string;
  readonly profileRevision: number;
  readonly connectionGeneration: number;
  readonly acpSessionId: string;
  readonly turnId?: string | undefined;
  readonly jsonRpcRequestId?: string | undefined;
  readonly producerEventId?: string | undefined;
  readonly hostReceiveSeq: number;
  readonly observedAtUtc: string;
  readonly messageKind: 'turn-started' | 'turn-completed' | 'session-update' | 'usage-update';
  readonly stopReason?: 'end_turn' | 'max_tokens' | 'tool_use' | 'canceled' | undefined;
  readonly observedBridgeProviderSession?: {
    readonly providerSessionId: string;
    readonly backend: string;
    readonly accountAlias: string;
  } | undefined;
  readonly usageDelta?: {
    readonly counterScope: 'attempt-incremental' | 'session-cumulative' | 'acp-context-occupancy';
    readonly hasQualifiedSessionBaseline?: boolean | undefined;
    readonly inputTokens: bigint;
    readonly outputTokens: bigint;
  } | undefined;
}

export interface AcpNormalizationContext {
  readonly workspaceId: string;
  readonly queueId: string;
  readonly rootExecutionId: string;
  readonly invocationId: string;
  readonly attemptId: string;
  readonly activeConnectionGeneration: number;
  readonly hostResultValidated: boolean;
  readonly ledger: ObservationLedgerState;
}

export interface LogicalSqliteDomainFixtureBundle {
  readonly agentConnectionRow: {
    readonly connectionGeneration: number;
    readonly profileId: string;
    readonly profileRevision: number;
    readonly lifecycle: 'active' | 'stale-historical';
  };
  readonly agentSessionRow: {
    readonly internalSessionKey: string;
    readonly profileId: string;
    readonly profileRevision: number;
    readonly acpSessionId: string;
  };
  readonly providerSessionRow: {
    readonly providerSessionId: string;
    readonly backend: string;
    readonly accountAlias: string;
  } | null;
  readonly agentSessionProviderLinkRow: {
    readonly internalSessionKey: string;
    readonly providerSessionId: string;
    readonly linkProvenance: 'observed-bridge';
  } | null;
  readonly agentTurnRow: {
    readonly turnId: string;
    readonly attemptId: string;
    readonly internalSessionKey: string;
    readonly connectionGeneration: number;
    readonly connectionLocalRequestId: string | null;
  } | null;
  readonly protocolReceiptRow: {
    readonly receiptId: string;
    readonly connectionGeneration: number;
    readonly turnId: string | null;
    readonly messageKind: AcpEventEnvelope['messageKind'];
    readonly producerEventId: string | null;
    readonly replayQuality: 'durable-producer-id' | 'unavailable';
    readonly hostReceiveSeq: number;
    readonly disposition: 'accepted-domain-observation' | 'historical-unattributed';
    readonly phaseSettledByWireFrame: false;
    readonly permissionGrantedByWireFrame: false;
    readonly requiresHostResultValidation: true;
    readonly effectivePhaseSettled: boolean;
  };
  readonly usageObservationRow: AcceptedUsageObservation | null;
}

export function normalizeAcpEventToDomainFixtures(
  event: AcpEventEnvelope,
  context: AcpNormalizationContext
): StorageBoundaryOutcome<LogicalSqliteDomainFixtureBundle> {
  for (const [field, val] of [
    ['profileId', event.profileId],
    ['acpSessionId', event.acpSessionId]
  ] as const) {
    const idCheck = validateSharedIdentifier(val, field);
    if (idCheck.status !== 'accepted') return idCheck;
  }
  for (const [field, val] of [
    ['turnId', event.turnId],
    ['jsonRpcRequestId', event.jsonRpcRequestId],
    ['producerEventId', event.producerEventId]
  ] as const) {
    if (val === undefined) continue;
    const idCheck = validateSharedIdentifier(val, field);
    if (idCheck.status !== 'accepted') return idCheck;
  }
  if (
    !Number.isSafeInteger(event.connectionGeneration) ||
    event.connectionGeneration < 0 ||
    !Number.isSafeInteger(event.hostReceiveSeq) ||
    event.hostReceiveSeq < 0
  ) {
    return buildSharedContractRefusal(
      'invalid-observation',
      'invalid-acp-sequence-metadata',
      'connectionGeneration and hostReceiveSeq must be non-negative safe integers.',
      'connectionGeneration'
    );
  }
  if (event.connectionGeneration > context.activeConnectionGeneration) {
    return buildSharedContractRefusal(
      'stale-revision',
      'acp-connection-generation-ahead-of-host',
      'ACP event names a connection generation the host has not admitted.',
      'connectionGeneration'
    );
  }
  if (
    event.jsonRpcRequestId !== undefined &&
    (event.jsonRpcRequestId === context.rootExecutionId ||
      event.jsonRpcRequestId === context.attemptId)
  ) {
    return buildSharedContractRefusal(
      'identity-mismatch',
      'connection-local-request-id-used-as-global-id',
      'JSON-RPC requestId is connection-local and cannot be used as a global execution or attempt identity.',
      'jsonRpcRequestId'
    );
  }
  if (
    event.observedBridgeProviderSession !== undefined &&
    event.observedBridgeProviderSession.providerSessionId === event.acpSessionId
  ) {
    return buildSharedContractRefusal(
      'identity-mismatch',
      'acp-session-equated-with-provider-session',
      'ACP session identity and providerSessionId are distinct namespaces and cannot be conflated.',
      'providerSessionId'
    );
  }

  const isStaleGeneration = event.connectionGeneration < context.activeConnectionGeneration;
  const internalSessionKey = `${event.profileId}@${event.profileRevision}:${event.acpSessionId}`;
  const hasDurableProducerId =
    typeof event.producerEventId === 'string' && event.producerEventId.length > 0;

  let usageRow: AcceptedUsageObservation | null = null;
  if (!isStaleGeneration && event.usageDelta !== undefined) {
    const obsRes = acceptUsageObservation(context.ledger, {
      schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
      workspaceId: context.workspaceId,
      queueId: context.queueId,
      rootExecutionId: context.rootExecutionId,
      invocationId: context.invocationId,
      attemptId: context.attemptId,
      producerNamespace: `acp:${event.profileId}`,
      ...(hasDurableProducerId ? { producerObservationId: event.producerEventId } : {}),
      source: 'acp-runtime',
      observationTimeUtc: event.observedAtUtc,
      counterScope: event.usageDelta.counterScope,
      ...(event.usageDelta.hasQualifiedSessionBaseline !== undefined
        ? { hasQualifiedSessionBaseline: event.usageDelta.hasQualifiedSessionBaseline }
        : {}),
      inputTokens: event.usageDelta.inputTokens,
      outputTokens: event.usageDelta.outputTokens,
      ...(event.observedBridgeProviderSession !== undefined
        ? { providerSessionId: event.observedBridgeProviderSession.providerSessionId }
        : {}),
      quality: {
        provenance: 'observed',
        completeness: 'known'
      }
    });
    if (obsRes.status !== 'accepted') return obsRes;
    usageRow = obsRes.value;
  }

  return {
    status: 'accepted',
    value: {
      agentConnectionRow: {
        connectionGeneration: event.connectionGeneration,
        profileId: event.profileId,
        profileRevision: event.profileRevision,
        lifecycle: isStaleGeneration ? 'stale-historical' : 'active'
      },
      agentSessionRow: {
        internalSessionKey,
        profileId: event.profileId,
        profileRevision: event.profileRevision,
        acpSessionId: event.acpSessionId
      },
      providerSessionRow:
        event.observedBridgeProviderSession !== undefined
          ? {
              providerSessionId: event.observedBridgeProviderSession.providerSessionId,
              backend: event.observedBridgeProviderSession.backend,
              accountAlias: event.observedBridgeProviderSession.accountAlias
            }
          : null,
      agentSessionProviderLinkRow:
        event.observedBridgeProviderSession !== undefined
          ? {
              internalSessionKey,
              providerSessionId: event.observedBridgeProviderSession.providerSessionId,
              linkProvenance: 'observed-bridge'
            }
          : null,
      agentTurnRow:
        event.turnId !== undefined && !isStaleGeneration
          ? {
              turnId: event.turnId,
              attemptId: context.attemptId,
              internalSessionKey,
              connectionGeneration: event.connectionGeneration,
              connectionLocalRequestId: event.jsonRpcRequestId ?? null
            }
          : null,
      protocolReceiptRow: {
        receiptId: hasDurableProducerId
          ? `acp-receipt:${event.connectionGeneration}:${event.producerEventId}`
          : `acp-receipt:${event.connectionGeneration}:seq-${event.hostReceiveSeq}`,
        connectionGeneration: event.connectionGeneration,
        turnId: event.turnId ?? null,
        messageKind: event.messageKind,
        producerEventId: event.producerEventId ?? null,
        replayQuality: hasDurableProducerId ? 'durable-producer-id' : 'unavailable',
        hostReceiveSeq: event.hostReceiveSeq,
        disposition: isStaleGeneration
          ? 'historical-unattributed'
          : 'accepted-domain-observation',
        phaseSettledByWireFrame: false,
        permissionGrantedByWireFrame: false,
        requiresHostResultValidation: true,
        effectivePhaseSettled: !isStaleGeneration && context.hostResultValidated === true
      },
      usageObservationRow: usageRow
    }
  };
}
