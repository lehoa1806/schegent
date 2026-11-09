/**
 * FR-R6-F02 — Shared contract entry-point boundary, 4-view consumer projector,
 * untrusted-workspace read-only inspection guard, and canonical cross-feature
 * acceptance fixtures (F02-AC-01 through F02-AC-10).
 *
 * Zero `vscode` imports (SC-009, docs/hard-rules.md rule 13).
 */

import type { ExecutionFence } from '../../contracts/control-ledger';
import {
  SHARED_STORAGE_CONTRACT_VERSION,
  acceptUsageObservation,
  applyUsageCorrection,
  buildSharedContractRefusal,
  createObservationLedgerState,
  readCompatibleRecord,
  rejectUnknownInputFields,
  validateSharedIdentifier,
  type AcceptedUsageObservation,
  type AcpEventEnvelope,
  type ArtifactDescriptor,
  type CompatibleRecordView,
  type MeasureCompleteness,
  type ObservationLedgerState,
  type ObservationProvenance,
  type ReportHandoffManifest,
  type SharedExecutionIdentity,
  type StorageBoundaryOutcome,
  type UnavailableReasonCode
} from '../../contracts';

export type SharedContractConsumerViewKind = 'metrics' | 'live-log' | 'report' | 'handoff';

export type RenderedQualityDisplayState =
  | 'zero-output-success'
  | 'absent'
  | 'capture-disabled'
  | 'expired'
  | 'partial'
  | 'estimated'
  | 'conflicting'
  | 'corrected';

export interface ConsumerAttemptViewProjection {
  readonly viewKind: SharedContractConsumerViewKind;
  readonly schemaVersion: typeof SHARED_STORAGE_CONTRACT_VERSION;
  readonly workspaceId: string;
  readonly queueId: string;
  readonly rootExecutionId: string;
  readonly invocationId: string;
  readonly occurrenceNodePath: string;
  readonly occurrenceIndex: number;
  readonly attemptId: string;
  readonly attemptOrdinal: number;
  readonly displayState: RenderedQualityDisplayState;
  readonly provenance: ObservationProvenance;
  readonly completeness: MeasureCompleteness;
  readonly unavailableReason?: UnavailableReasonCode | undefined;
  readonly expiryCutoffUtc?: string | undefined;
  readonly accountedInputTokens: bigint | null;
  readonly accountedOutputTokens: bigint | null;
  readonly aggregateSummaryRetained: boolean;
  readonly appliedCorrectionIds: readonly string[];
  readonly providerSpecificBranchUsed: false;
}

export interface ProjectAttemptViewInput {
  readonly identity: SharedExecutionIdentity;
  readonly ledger: ObservationLedgerState;
  readonly forceDisplayScenario?: {
    readonly kind:
      | 'zero-output-success'
      | 'absent'
      | 'capture-disabled'
      | 'expired'
      | 'partial'
      | 'estimated'
      | 'conflicting'
      | 'corrected';
    readonly expiryCutoffUtc?: string | undefined;
  } | undefined;
}

export function projectAttemptAcrossConsumerViews(
  input: ProjectAttemptViewInput
): Readonly<Record<SharedContractConsumerViewKind, ConsumerAttemptViewProjection>> {
  const attemptId = input.identity.attemptId ?? 'unassigned-attempt';
  const invocationId = input.identity.invocationId ?? 'unassigned-invocation';
  const occurrenceNodePath = input.identity.occurrenceNodePath ?? 'root';
  const occurrenceIndex = input.identity.occurrenceIndex ?? 1;
  const attemptOrdinal = input.identity.attemptOrdinal ?? 1;

  const attemptObservations = [...input.ledger.observationsById.values()].filter(
    (obs) => obs.attemptId === attemptId && obs.attributionScope === 'attempt'
  );
  const attemptCorrections = [...input.ledger.appliedCorrectionsByKey.values()].filter(
    (corr) => corr.attemptId === attemptId && corr.status === 'applied'
  );

  let totalIn: bigint | null = null;
  let totalOut: bigint | null = null;
  for (const obs of attemptObservations) {
    if (obs.billableInputTokens !== null) {
      totalIn = (totalIn ?? 0n) + obs.billableInputTokens;
    }
    if (obs.billableOutputTokens !== null) {
      totalOut = (totalOut ?? 0n) + obs.billableOutputTokens;
    }
  }
  for (const corr of attemptCorrections) {
    totalIn = (totalIn ?? 0n) + corr.deltaInputTokens;
    totalOut = (totalOut ?? 0n) + corr.deltaOutputTokens;
  }

  const firstObs = attemptObservations.at(0);
  let provenance: ObservationProvenance = firstObs?.quality.provenance ?? 'observed';
  let completeness: MeasureCompleteness = firstObs?.quality.completeness ?? 'known';
  let unavailableReason: UnavailableReasonCode | undefined = firstObs?.quality.unavailableReason;
  let expiryCutoffUtc: string | undefined = firstObs?.quality.expiryCutoffUtc;
  let displayState: RenderedQualityDisplayState = 'zero-output-success';

  if (input.forceDisplayScenario !== undefined) {
    const scenario = input.forceDisplayScenario;
    displayState = scenario.kind;
    if (scenario.kind === 'zero-output-success') {
      totalIn = 0n;
      totalOut = 0n;
      provenance = 'observed';
      completeness = 'known';
    } else if (scenario.kind === 'absent') {
      totalIn = null;
      totalOut = null;
      provenance = 'observed';
      completeness = 'unknown';
      unavailableReason = 'missing-attribution';
    } else if (scenario.kind === 'capture-disabled') {
      totalIn = null;
      totalOut = null;
      provenance = 'observed';
      completeness = 'unknown';
      unavailableReason = 'capture-disabled';
    } else if (scenario.kind === 'expired') {
      totalIn = null;
      totalOut = null;
      provenance = 'derived';
      completeness = 'partial';
      unavailableReason = 'expired';
      expiryCutoffUtc = scenario.expiryCutoffUtc ?? '2026-11-01T00:00:00Z';
    } else if (scenario.kind === 'partial') {
      provenance = 'observed';
      completeness = 'partial';
    } else if (scenario.kind === 'estimated') {
      provenance = 'estimated';
      completeness = 'partial';
    } else if (scenario.kind === 'conflicting') {
      totalIn = null;
      totalOut = null;
      provenance = 'observed';
      completeness = 'conflicting';
    } else {
      // 'corrected'
      provenance = 'derived';
      completeness = 'known';
    }
  } else if (attemptCorrections.length > 0) {
    displayState = 'corrected';
  } else if (firstObs === undefined) {
    displayState = 'absent';
    totalIn = null;
    totalOut = null;
    completeness = 'unknown';
  } else if (firstObs.quality.unavailableReason === 'capture-disabled') {
    displayState = 'capture-disabled';
    totalIn = null;
    totalOut = null;
  } else if (firstObs.quality.unavailableReason === 'expired') {
    displayState = 'expired';
    totalIn = null;
    totalOut = null;
  } else if (firstObs.quality.completeness === 'conflicting') {
    displayState = 'conflicting';
  } else if (firstObs.quality.provenance === 'estimated') {
    displayState = 'estimated';
  } else if (firstObs.quality.completeness === 'partial') {
    displayState = 'partial';
  } else if (totalIn === 0n && totalOut === 0n) {
    displayState = 'zero-output-success';
  }

  const buildForView = (
    viewKind: SharedContractConsumerViewKind
  ): ConsumerAttemptViewProjection => ({
    viewKind,
    schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
    workspaceId: input.identity.workspaceId,
    queueId: input.identity.queueId,
    rootExecutionId: input.identity.rootExecutionId,
    invocationId,
    occurrenceNodePath,
    occurrenceIndex,
    attemptId,
    attemptOrdinal,
    displayState,
    provenance,
    completeness,
    ...(unavailableReason !== undefined ? { unavailableReason } : {}),
    ...(expiryCutoffUtc !== undefined ? { expiryCutoffUtc } : {}),
    accountedInputTokens: totalIn,
    accountedOutputTokens: totalOut,
    aggregateSummaryRetained: true,
    appliedCorrectionIds: attemptCorrections.map((c) => c.correctionId),
    providerSpecificBranchUsed: false
  });

  return {
    metrics: buildForView('metrics'),
    'live-log': buildForView('live-log'),
    report: buildForView('report'),
    handoff: buildForView('handoff')
  };
}

// ---------------------------------------------------------------------------
// Cross-Surface Entry-Point Boundary (UI, Host, Headless) & Untrusted Guard
// (FR-013, FR-016, FR-019, FR-021, SC-009, F02-AC-09)
// ---------------------------------------------------------------------------

export type SharedContractEntrySurface = 'ui' | 'host' | 'headless';

export interface WriteSideEffectsAudit {
  readonly repairTriggered: false;
  readonly retentionTriggered: false;
  readonly migrationTriggered: false;
  readonly backendProbingTriggered: false;
}

export type SharedContractBoundaryRequest =
  | {
      readonly operation: 'inspect-record';
      readonly workspaceTrusted: boolean;
      readonly record: Readonly<Record<string, unknown>>;
    }
  | {
      readonly operation: 'accept-observation';
      readonly workspaceTrusted: boolean;
      readonly activeFence: ExecutionFence;
      readonly suppliedFence: ExecutionFence;
      readonly ledger: ObservationLedgerState;
      readonly payload: Readonly<Record<string, unknown>>;
    }
  | {
      readonly operation: 'rebind-workspace';
      readonly workspaceTrusted: boolean;
      readonly previousWorkspaceId: string;
      readonly newWorkspaceId: string;
      readonly hostControlledDecisionConfirmed: boolean;
    };

export type SharedContractBoundaryResult =
  | {
      readonly kind: 'inspected-record';
      readonly surface: SharedContractEntrySurface;
      readonly view: CompatibleRecordView;
      readonly writeSideEffects: WriteSideEffectsAudit;
    }
  | {
      readonly kind: 'accepted-observation';
      readonly surface: SharedContractEntrySurface;
      readonly observation: AcceptedUsageObservation;
    }
  | {
      readonly kind: 'workspace-rebound';
      readonly surface: SharedContractEntrySurface;
      readonly newWorkspaceId: string;
      readonly foreignPermitsAttached: false;
      readonly foreignEvidenceAttached: false;
    };

const ALLOWED_KEYS_BY_OPERATION: Readonly<Record<string, ReadonlySet<string>>> = {
  'inspect-record': new Set(['operation', 'workspaceTrusted', 'record']),
  'accept-observation': new Set([
    'operation',
    'workspaceTrusted',
    'activeFence',
    'suppliedFence',
    'ledger',
    'payload'
  ]),
  'rebind-workspace': new Set([
    'operation',
    'workspaceTrusted',
    'previousWorkspaceId',
    'newWorkspaceId',
    'hostControlledDecisionConfirmed'
  ])
};

function isExecutionFence(value: unknown): value is ExecutionFence {
  const f = value as Partial<ExecutionFence> | null;
  return (
    typeof f === 'object' &&
    f !== null &&
    typeof f.primacyClaim === 'string' &&
    typeof f.queueClaim === 'string' &&
    typeof f.rootGeneration === 'number'
  );
}

function isObservationLedger(value: unknown): value is ObservationLedgerState {
  const l = value as Partial<ObservationLedgerState> | null;
  return (
    typeof l === 'object' &&
    l !== null &&
    typeof l.nextAcceptedSeq === 'number' &&
    l.observationsById instanceof Map
  );
}

function fencesMatch(a: ExecutionFence, b: ExecutionFence): boolean {
  return (
    a.primacyClaim === b.primacyClaim &&
    a.queueClaim === b.queueClaim &&
    a.rootGeneration === b.rootGeneration
  );
}

export function executeSharedContractOperation(
  surface: SharedContractEntrySurface,
  rawRequest: unknown
): StorageBoundaryOutcome<SharedContractBoundaryResult> {
  if (typeof rawRequest !== 'object' || rawRequest === null || Array.isArray(rawRequest)) {
    return buildSharedContractRefusal(
      'invalid-observation',
      'invalid-boundary-request-envelope',
      'Boundary request must be a JSON object.'
    );
  }
  const reqObj = rawRequest as Record<string, unknown>;
  const allowedKeys =
    typeof reqObj.operation === 'string' &&
    Object.prototype.hasOwnProperty.call(ALLOWED_KEYS_BY_OPERATION, reqObj.operation)
      ? ALLOWED_KEYS_BY_OPERATION[reqObj.operation]
      : undefined;
  if (allowedKeys === undefined) {
    return buildSharedContractRefusal(
      'invalid-observation',
      'unknown-boundary-operation',
      'Unsupported shared contract boundary operation.'
    );
  }
  const unknownEnvelopeCheck = rejectUnknownInputFields(
    reqObj,
    allowedKeys,
    'SharedContractBoundaryRequest'
  );
  if (unknownEnvelopeCheck.status !== 'accepted') return unknownEnvelopeCheck;
  if (typeof reqObj.workspaceTrusted !== 'boolean') {
    return buildSharedContractRefusal(
      'invalid-observation',
      'missing-workspace-trust-flag',
      'Boundary requests must carry a host-resolved boolean workspaceTrusted flag.',
      'workspaceTrusted'
    );
  }

  const request = rawRequest as SharedContractBoundaryRequest;

  if (request.operation === 'inspect-record') {
    const record: unknown = request.record;
    if (typeof record !== 'object' || record === null) {
      return buildSharedContractRefusal(
        'invalid-observation',
        'record-not-an-object',
        'inspect-record requires a record object.',
        'record'
      );
    }
    const readRes = readCompatibleRecord(request.record);
    if (readRes.status !== 'accepted') return readRes;
    return {
      status: 'accepted',
      value: {
        kind: 'inspected-record',
        surface,
        view: readRes.value,
        writeSideEffects: {
          repairTriggered: false,
          retentionTriggered: false,
          migrationTriggered: false,
          backendProbingTriggered: false
        }
      }
    };
  }

  if (request.operation === 'accept-observation') {
    if (!request.workspaceTrusted) {
      return buildSharedContractRefusal(
        'stale-revision',
        'untrusted-workspace-mutation-refused',
        'Mutating observation acceptance is refused in an untrusted workspace.'
      );
    }
    if (!isExecutionFence(request.activeFence) || !isExecutionFence(request.suppliedFence)) {
      return buildSharedContractRefusal(
        'stale-revision',
        'missing-or-malformed-ownership-fence',
        'Mutations require both the active and supplied ownership fences.',
        'suppliedFence'
      );
    }
    if (!fencesMatch(request.activeFence, request.suppliedFence)) {
      return buildSharedContractRefusal(
        'stale-revision',
        'stale-ownership-fence',
        'Supplied window primacy or queue execution lease fence is stale; re-read current state before mutating.',
        'suppliedFence'
      );
    }
    if (!isObservationLedger(request.ledger)) {
      return buildSharedContractRefusal(
        'invalid-observation',
        'missing-observation-ledger',
        'accept-observation requires the host observation ledger.',
        'ledger'
      );
    }
    const obsRes = acceptUsageObservation(request.ledger, request.payload);
    if (obsRes.status !== 'accepted') return obsRes;
    return {
      status: 'accepted',
      value: {
        kind: 'accepted-observation',
        surface,
        observation: obsRes.value
      }
    };
  }

  // rebind-workspace
  if (!request.workspaceTrusted || !request.hostControlledDecisionConfirmed) {
    return buildSharedContractRefusal(
      'identity-mismatch',
      'unauthorized-workspace-rebinding',
      'Moving or copying a workspace folder requires an explicit host-controlled rebinding decision in a trusted workspace.'
    );
  }
  const prevCheck = validateSharedIdentifier(request.previousWorkspaceId, 'previousWorkspaceId');
  if (prevCheck.status !== 'accepted') return prevCheck;
  const wsCheck = validateSharedIdentifier(request.newWorkspaceId, 'newWorkspaceId');
  if (wsCheck.status !== 'accepted') return wsCheck;
  return {
    status: 'accepted',
    value: {
      kind: 'workspace-rebound',
      surface,
      newWorkspaceId: wsCheck.value.id,
      foreignPermitsAttached: false,
      foreignEvidenceAttached: false
    }
  };
}

// ---------------------------------------------------------------------------
// Delivery Package 3 — Canonical Cross-Feature Acceptance Fixtures
// (F02-AC-01 through F02-AC-10, FR-023, SC-013)
// ---------------------------------------------------------------------------

export interface SharedContractAcceptanceFixtureSet {
  readonly acceptanceIds: readonly [
    'F02-AC-01',
    'F02-AC-02',
    'F02-AC-03',
    'F02-AC-04',
    'F02-AC-05',
    'F02-AC-06',
    'F02-AC-07',
    'F02-AC-08',
    'F02-AC-09',
    'F02-AC-10'
  ];
  readonly defaultFence: ExecutionFence;
  readonly repeatTwiceAndRetryIdentities: {
    readonly occurrence1Attempt1: SharedExecutionIdentity;
    readonly occurrence2Attempt1: SharedExecutionIdentity;
    readonly occurrence2Attempt2Retry: SharedExecutionIdentity;
  };
  readonly legacyRecordMissingModelAndSession: Readonly<Record<string, unknown>>;
  readonly unknownFutureVersionRecord: Readonly<Record<string, unknown>>;
  readonly retiredFormatRecord: Readonly<Record<string, unknown>>;
  readonly pinnedArtifactDescriptor: ArtifactDescriptor;
  readonly unpinnedExpiredArtifactDescriptor: ArtifactDescriptor;
  readonly growingLiveLogDescriptor: ArtifactDescriptor;
  readonly initialReportManifest: ReportHandoffManifest;
  readonly regeneratedHandoffManifest: ReportHandoffManifest;
  readonly acpEvents: {
    readonly liveTurnCompletedWithStopReason: AcpEventEnvelope;
    readonly eventWithoutProducerId: AcpEventEnvelope;
    readonly staleGenerationEvent: AcpEventEnvelope;
  };
}

const DEFAULT_FENCE: ExecutionFence = Object.freeze({
  primacyClaim: 'primacy-win-1',
  queueClaim: 'lease-q-main-1',
  rootGeneration: 1
});

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

export const SHARED_CONTRACT_ACCEPTANCE_FIXTURES: SharedContractAcceptanceFixtureSet =
  deepFreeze<SharedContractAcceptanceFixtureSet>({
    acceptanceIds: [
      'F02-AC-01',
      'F02-AC-02',
      'F02-AC-03',
      'F02-AC-04',
      'F02-AC-05',
      'F02-AC-06',
      'F02-AC-07',
      'F02-AC-08',
      'F02-AC-09',
      'F02-AC-10'
    ],
    defaultFence: DEFAULT_FENCE,
    repeatTwiceAndRetryIdentities: {
      occurrence1Attempt1: {
        schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
        workspaceId: 'ws-canonical-01',
        queueId: 'queue-main',
        rootExecutionId: 'run-root-100',
        invocationId: 'frame-repeat-pass-1',
        occurrenceNodePath: 'workflow/repeat-body/implement',
        occurrenceIndex: 1,
        attemptId: 'att-occ1-try1',
        attemptOrdinal: 1,
        executionFence: DEFAULT_FENCE,
        knownIdentities: [
          'workspaceId',
          'queueId',
          'rootExecutionId',
          'invocationId',
          'occurrenceNodePath',
          'attemptId'
        ],
        missingIdentityReasons: { providerSessionId: 'provider-session-unreported' },
        identifierAliases: {}
      },
      occurrence2Attempt1: {
        schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
        workspaceId: 'ws-canonical-01',
        queueId: 'queue-main',
        rootExecutionId: 'run-root-100',
        invocationId: 'frame-repeat-pass-2',
        occurrenceNodePath: 'workflow/repeat-body/implement',
        occurrenceIndex: 2,
        attemptId: 'att-occ2-try1',
        attemptOrdinal: 1,
        executionFence: DEFAULT_FENCE,
        knownIdentities: [
          'workspaceId',
          'queueId',
          'rootExecutionId',
          'invocationId',
          'occurrenceNodePath',
          'attemptId'
        ],
        missingIdentityReasons: { providerSessionId: 'provider-session-unreported' },
        identifierAliases: {}
      },
      occurrence2Attempt2Retry: {
        schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
        workspaceId: 'ws-canonical-01',
        queueId: 'queue-main',
        rootExecutionId: 'run-root-100',
        invocationId: 'frame-repeat-pass-2',
        occurrenceNodePath: 'workflow/repeat-body/implement',
        occurrenceIndex: 2,
        attemptId: 'att-occ2-try2',
        attemptOrdinal: 2,
        executionFence: DEFAULT_FENCE,
        knownIdentities: [
          'workspaceId',
          'queueId',
          'rootExecutionId',
          'invocationId',
          'occurrenceNodePath',
          'attemptId'
        ],
        missingIdentityReasons: { providerSessionId: 'provider-session-unreported' },
        identifierAliases: {}
      }
    },
    legacyRecordMissingModelAndSession: {
      version: 1,
      recordId: 'legacy-phase-rec-01',
      runId: 'run-legacy-01',
      queueId: 'queue-main',
      phaseType: 'implement',
      iteration: 1,
      durationMs: 4200,
      costUsd: 0.125
    },
    unknownFutureVersionRecord: {
      schemaVersion: 99,
      recordId: 'future-rec-99',
      rootExecutionId: 'run-future-99',
      queueId: 'queue-main',
      newFutureField: { preserved: true }
    },
    retiredFormatRecord: {
      kind: 'RetiredPipelineV0',
      recordId: 'retired-pipeline-01',
      steps: ['specify', 'implement']
    },
    pinnedArtifactDescriptor: {
      schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
      artifactId: 'art-pinned-01',
      originAttemptId: 'att-occ2-try2',
      originAttemptTerminalStatus: 'failed',
      kind: 'checkpoint',
      immutableVersion: 1,
      digestAlgorithm: 'sha256',
      digestHex: 'a'.repeat(64),
      byteSize: 4096,
      createdAtUtc: '2026-11-09T08:00:00Z',
      sensitivity: 'redacted-content',
      validationState: 'verified',
      availability: 'present',
      retentionClass: 'active-and-recovery-required-metadata',
      displayName: 'recovery-checkpoint-attempt-2.patch',
      hostPrivateFilePath: '/Users/operator/.schegent/artifacts/art-pinned-01.patch',
      pins: [
        {
          pinId: 'pin-recovery-01',
          ownerId: 'recovery-manifest-01',
          purpose: 'paused-recovery'
        }
      ]
    },
    unpinnedExpiredArtifactDescriptor: {
      schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
      artifactId: 'art-expired-02',
      originAttemptId: 'att-occ1-try1',
      originAttemptTerminalStatus: 'completed',
      kind: 'diagnostic',
      immutableVersion: 1,
      digestAlgorithm: 'sha256',
      digestHex: 'b'.repeat(64),
      byteSize: 2048,
      createdAtUtc: '2026-07-01T08:00:00Z',
      sensitivity: 'metadata-only',
      validationState: 'verified',
      availability: 'present',
      retentionClass: 'new-terminal-execution-usage-detail',
      displayName: 'diagnostic-summary.json',
      pins: []
    },
    growingLiveLogDescriptor: {
      schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
      artifactId: 'art-livelog-03',
      originAttemptId: 'att-occ2-try2',
      originAttemptTerminalStatus: 'in-flight',
      kind: 'live-log-segment',
      immutableVersion: 1,
      digestAlgorithm: 'sha256',
      digestHex: null,
      byteSize: 1024,
      createdAtUtc: '2026-11-09T09:00:00Z',
      sensitivity: 'redacted-content',
      validationState: 'unverified-live-prefix',
      availability: 'present',
      retentionClass: 'transcripts-diagnostics-checkpoints-audit-catalog',
      displayName: 'attempt-2-live.log',
      growingLog: {
        generation: 1,
        extentBytes: 1024,
        finalized: false
      },
      pins: []
    },
    initialReportManifest: {
      schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
      manifestId: 'report-manifest-cutoff-2',
      kind: 'report',
      sourceCutoff: {
        maxAcceptedSeq: 2,
        snapshotRevision: 10,
        capturedAtUtc: '2026-11-09T09:00:00Z'
      },
      calculationVersion: 'f06-v1',
      filters: { queueId: 'queue-main' },
      ordering: ['acceptedSeq ASC', 'attemptId ASC'],
      timezone: 'UTC',
      coverage: {
        completeness: 'known',
        retainedRowCount: 2,
        omittedRowCount: 0
      },
      omissions: [],
      grantsExecutionAuthority: false
    },
    regeneratedHandoffManifest: {
      schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
      manifestId: 'handoff-manifest-cutoff-4',
      kind: 'handoff',
      sourceCutoff: {
        maxAcceptedSeq: 4,
        snapshotRevision: 14,
        capturedAtUtc: '2026-11-09T09:05:00Z'
      },
      calculationVersion: 'f15-v1',
      filters: { rootExecutionId: 'run-root-100' },
      ordering: ['acceptedSeq ASC'],
      timezone: 'UTC',
      coverage: {
        completeness: 'partial',
        detailCutoffUtc: '2026-11-01T00:00:00Z',
        retainedRowCount: 4,
        omittedRowCount: 1
      },
      omissions: [
        {
          code: 'expired',
          count: 1,
          explanation: 'One older attempt detail expired under the 90-day retention policy; aggregate totals remain intact.'
        }
      ],
      grantsExecutionAuthority: false
    },
    acpEvents: {
      liveTurnCompletedWithStopReason: {
        profileId: 'claude-acp-default',
        profileRevision: 1,
        connectionGeneration: 3,
        acpSessionId: 'acp-sess-100',
        turnId: 'turn-200',
        jsonRpcRequestId: 'req-local-7',
        producerEventId: 'prod-evt-9001',
        hostReceiveSeq: 1,
        observedAtUtc: '2026-11-09T09:10:00Z',
        messageKind: 'turn-completed',
        stopReason: 'end_turn',
        observedBridgeProviderSession: {
          providerSessionId: 'prov-sess-claude-xyz',
          backend: 'claude',
          accountAlias: 'acct-alias-work'
        },
        usageDelta: {
          counterScope: 'attempt-incremental',
          inputTokens: 1200n,
          outputTokens: 350n
        }
      },
      eventWithoutProducerId: {
        profileId: 'claude-acp-default',
        profileRevision: 1,
        connectionGeneration: 3,
        acpSessionId: 'acp-sess-100',
        turnId: 'turn-200',
        hostReceiveSeq: 2,
        observedAtUtc: '2026-11-09T09:10:05Z',
        messageKind: 'session-update'
      },
      staleGenerationEvent: {
        profileId: 'claude-acp-default',
        profileRevision: 1,
        connectionGeneration: 2,
        acpSessionId: 'acp-sess-100',
        turnId: 'turn-199',
        producerEventId: 'prod-evt-8999',
        hostReceiveSeq: 3,
        observedAtUtc: '2026-11-09T09:10:06Z',
        messageKind: 'turn-completed',
        stopReason: 'end_turn'
      }
    }
  });

export { createObservationLedgerState, applyUsageCorrection };

