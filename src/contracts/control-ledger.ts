/**
 * FR-R5-F26 (SPEC-04, D4, D1) — Durable control admission ledger contracts.
 *
 * Persisted under workspace state key `schegent.controlLedger` (`KEYS.controlLedger`)
 * and linked from `ConnectedWorkflowRun.controlState` (`{ version: 1, ledgerRunId }`)
 * without bumping `STATE_SCHEMA_VERSION_V15`.
 *
 * Zero `vscode` imports.
 */

import type { BackendRunnerKind } from './backend-kinds';
import type { DecisionFieldValue } from './decision-results';
import type { RootControlBudget } from './workflow-controls';

export const CONTROL_LEDGER_VERSION = 1 as const;

export const MAX_LIVE_CONTROL_ROOTS = 20 as const;
export const MAX_QUOTA_OBSERVATIONS = 256 as const;
export const MAX_QUOTA_WAITERS = 160 as const;
export const MAX_ACTIVE_AVAILABILITY_CHECKS = 3 as const;
export const MAX_FRAMES_PER_ROOT = 1024 as const;
export const MAX_ROOT_LEDGER_BYTES = 2_097_152 as const;
export const ROOT_SETTLEMENT_RESERVE_BYTES = 16_384 as const;
export const MAX_CONTROL_COMMAND_RECEIPTS_PER_ROOT = 256 as const;

/**
 * Execution fence triple required on every control-ledger write and child spawn:
 * - `primacyClaim`: window primacy claim id
 * - `queueClaim`: bound queue lease claim id
 * - `rootGeneration`: monotonic generation counter for the root workflow run
 */
export interface ExecutionFence {
  readonly primacyClaim: string;
  readonly queueClaim: string;
  readonly rootGeneration: number;
}

export type RootLinkState = 'prepared' | 'active' | 'terminal';

export type ControlRootStatus =
  | 'in-flight'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled';

export type ControlFrameKind =
  | 'root-workflow'
  | 'child-workflow'
  | 'candidate-block'
  | 'repeat'
  | 'for-each';

export type ControlFrameStatus =
  | 'in-flight'
  | 'selecting'
  | 'dispatch-pending'
  | 'executing'
  | 'retry-delayed'
  | 'waiting-availability'
  | 'waiting-permit'
  | 'waiting-handoff'
  | 'monitoring-expired'
  | 'intervention-required'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled';

export type ControlAttemptStage =
  | 'pending-dispatch'
  | 'spawn-intent'
  | 'started'
  | 'settled';

export type ControlAttemptTerminalStatus = 'completed' | 'failed' | 'canceled';

export type ControlProcessEvidenceState =
  | 'running'
  | 'exited-clean'
  | 'exited-failed'
  | 'not-found';

export interface CandidateRuntimeSlot {
  readonly candidateId: string;
  readonly nodeId: string;
  readonly backend: BackendRunnerKind;
  readonly priority: number;
  readonly authoredOrder?: number | undefined;
  readonly candidateOccurrenceId?: string | undefined;
  readonly maxAttempts: number;
  readonly dispatchedAttempts: number;
  readonly status:
    | 'eligible'
    | 'in-flight'
    | 'waiting-backoff'
    | 'waiting-availability'
    | 'exhausted'
    | 'succeeded'
    | 'failed'
    | 'disabled';
  readonly retirementReason?:
    | 'attempts-exhausted'
    | 'permanent-failure'
    | 'disabled'
    | undefined;
  readonly nextEligibleAt?: number | undefined;
  readonly lastAttemptId?: string | undefined;
  readonly lastFailureCode?: string | undefined;
  readonly quotaIds?: readonly string[] | undefined;
  readonly observationIds?: readonly string[] | undefined;
  readonly allowUnverifiedTrial?: boolean | undefined;
}

export type RepeatConditionResult = 'true' | 'false' | 'unresolved' | 'not-evaluated';

export interface RepeatCompletedPassEntry {
  readonly iteration: number;
  readonly invocationId: string;
  readonly status: 'completed' | 'failed' | 'canceled';
  readonly resultRef?: string | undefined;
}

export interface RepeatRuntimeState {
  readonly iteration?: number | undefined;
  readonly currentPass: number;
  readonly maxIterations: number;
  readonly currentChildInvocationId?: string | null | undefined;
  readonly completedPasses?: readonly RepeatCompletedPassEntry[] | undefined;
  readonly conditionResult?: RepeatConditionResult | undefined;
  readonly carryEnvelopeRef?: string | undefined;
  readonly onExhausted?: 'pause' | 'fail' | undefined;
  readonly carryValues?: Readonly<Record<string, DecisionFieldValue>> | undefined;
  readonly lastPassAccepted?: boolean | undefined;
  readonly exhaustionReason?: string | undefined;
}

export type ForEachSlotErrorCode =
  | 'child-failed'
  | 'invalid-child-result'
  | 'dispatch-budget-exhausted';

export interface ForEachSlotError {
  readonly code: ForEachSlotErrorCode;
  readonly message: string;
}

export interface ForEachItemRuntimeSlot {
  readonly index?: number | undefined;
  readonly itemIndex: number;
  readonly itemKey: string;
  readonly state?: 'pending' | 'executing' | 'completed' | 'failed' | undefined;
  readonly status: 'in-flight' | 'pending' | 'completed' | 'failed' | 'skipped';
  readonly invocationId?: string | undefined;
  readonly childInvocationId?: string;
  readonly attemptId?: string;
  readonly resultRef?: string | undefined;
  readonly error?: ForEachSlotError | undefined;
  readonly failureCode?: string;
  readonly decisionResults?: Readonly<Record<string, DecisionFieldValue>>;
}

export interface ForEachRuntimeState {
  readonly collectionRef?: string | undefined;
  readonly collectionSha256?: string | undefined;
  readonly itemCount?: number | undefined;
  readonly totalItems: number;
  readonly currentIndex: number;
  readonly hasErrors: boolean;
  readonly errorCount?: number | undefined;
  readonly onItemError?: 'stop' | 'continue' | undefined;
  readonly refusalCode?: string | undefined;
  readonly resultIndexRef?: string | undefined;
  readonly resultIndexJson?: string | undefined;
  readonly resultIndexArtifactPath?: string;
  readonly frozenItemsJson?: readonly string[] | undefined;
  readonly slots: readonly ForEachItemRuntimeSlot[];
}

export interface ControlFrame {
  readonly frameKey: string;
  readonly parentFrameKey: string | null;
  readonly invocationId: string;
  readonly workflowId: string;
  readonly nodeId?: string;
  readonly kind: ControlFrameKind;
  readonly status: ControlFrameStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number | undefined;
  readonly activeAttemptId?: string | undefined;
  readonly selectedCandidateId?: string | undefined;
  readonly dispatchedCount: number;
  readonly maxDispatches?: number;
  readonly pauseCause?: string | undefined;
  readonly failureCode?: string | undefined;
  readonly frameGeneration?: number | undefined;
  readonly monitoringStartedAt?: number | undefined;
  readonly monitoringExpiresAt?: number | undefined;
  readonly monitoringRenewals?: number | undefined;
  readonly lastClockWallMs?: number | undefined;
  readonly lastClockMonotonicMs?: number | undefined;
  readonly lastClockHostEpoch?: string | undefined;
  readonly selectionPolicy?:
    | 'first-ready'
    | 'wait-for-selected'
    | 'stop-on-unavailability'
    | undefined;
  readonly manualSelectionCandidateId?: string | undefined;
  readonly allowedCandidateIds?: readonly string[] | undefined;
  readonly policyOverrides?: readonly ControlPolicyOverrideRecord[] | undefined;
  readonly returnCommitId?: string | undefined;
  readonly winningCandidateId?: string | undefined;
  readonly winningAttemptId?: string | undefined;
  readonly winningOutputs?: Readonly<Record<string, string>> | undefined;
  readonly waitStateReleasedSlot?: boolean | undefined;
  readonly candidateSlots?: readonly CandidateRuntimeSlot[] | undefined;
  readonly repeatState?: RepeatRuntimeState | undefined;
  readonly forEachState?: ForEachRuntimeState | undefined;
  readonly decisionResults?: Readonly<Record<string, DecisionFieldValue>> | undefined;
}

export interface ControlAttemptRecord {
  readonly attemptId: string;
  readonly ledgerRunId: string;
  readonly connectedRunId: string;
  readonly queueId: string;
  readonly frameKey: string;
  readonly invocationId: string;
  readonly nodeId: string;
  readonly attemptIndex: number;
  readonly candidateId?: string;
  readonly backend: BackendRunnerKind;
  readonly model?: string;
  readonly stage: ControlAttemptStage;
  readonly terminalStatus?: ControlAttemptTerminalStatus;
  readonly failureCode?: string;
  readonly failureMessage?: string;
  readonly reservedMicrousd: number;
  readonly settledMicrousd?: number;
  readonly permitId?: string;
  readonly waiterId?: string;
  readonly queueItemId?: string;
  readonly pid?: number;
  readonly hasSideEffects?: boolean;
  readonly committedAt: number;
  readonly spawnIntentAt?: number;
  readonly startedAt?: number;
  readonly settledAt?: number;
  readonly fence: ExecutionFence;
  readonly decisionResults?: Readonly<Record<string, DecisionFieldValue>>;
}

export interface QuotaObservationRecord {
  readonly quotaKey: string;
  readonly observationId?: string | undefined;
  readonly quotaId?: string | undefined;
  readonly generation?: number | undefined;
  readonly backend: BackendRunnerKind;
  readonly accountId?: string | undefined;
  readonly status:
    | 'ready'
    | 'cooldown-known'
    | 'cooldown-unknown'
    | 'unreachable'
    | 'top-up-required'
    | 'check-unsupported'
    | 'rate-limited'
    | 'credit-exhausted'
    | 'unknown'
    | 'unsupported';
  readonly source?:
    | 'qualified-status'
    | 'canonical-diagnostic'
    | 'counted-trial'
    | undefined;
  readonly observedAt: number;
  readonly observedMonotonicAt?: number | undefined;
  readonly hostEpoch?: string | undefined;
  readonly resetAt?: number | undefined;
  readonly notBefore?: number | undefined;
  readonly nextCheckAt?: number | undefined;
  readonly pollIndex?: number | undefined;
  readonly capacity?: number | undefined;
  readonly checkAttempts: number;
  readonly lastCheckStartedAt?: number | undefined;
  readonly detail?: string | undefined;
}

export interface AvailabilityCheckRecord {
  readonly checkId: string;
  readonly quotaKey: string;
  readonly observationId?: string | undefined;
  readonly backend: BackendRunnerKind;
  readonly sponsorLedgerRunId: string;
  readonly sponsorRootRunId?: string | undefined;
  readonly generation?: number | undefined;
  readonly status: 'running' | 'completed' | 'failed' | 'aborted';
  readonly stage?: 'pending' | 'started' | 'settled' | 'uncertain' | undefined;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly completedAt?: number | undefined;
  readonly reservedMicrousd?: number | undefined;
  readonly costMicrousd?: number | undefined;
  readonly costUncertain?: boolean | undefined;
  readonly usageRef?: string | undefined;
}

export interface QuotaWaiterRecord {
  readonly waiterId: string;
  readonly waitSequence: number;
  readonly sequence?: number | undefined;
  readonly ledgerRunId: string;
  readonly rootRunId?: string | undefined;
  readonly connectedRunId: string;
  readonly queueId: string;
  readonly frameKey: string;
  readonly invocationId: string;
  readonly generation?: number | undefined;
  readonly nodeId: string;
  readonly candidateId?: string | undefined;
  readonly candidateOccurrenceId?: string | undefined;
  readonly quotaKeys: readonly string[];
  readonly quotaIds?: readonly string[] | undefined;
  readonly observationIds?: readonly string[] | undefined;
  readonly status: 'waiting' | 'paused' | 'granted' | 'canceled';
  readonly enqueuedAt: number;
  readonly registeredAt?: number | undefined;
  readonly updatedAt: number;
}

export interface ExecutionPermitRecord {
  readonly permitId: string;
  readonly attemptId: string;
  readonly ledgerRunId: string;
  readonly rootRunId?: string | undefined;
  readonly connectedRunId: string;
  readonly queueId: string;
  readonly quotaKeys: readonly string[];
  readonly quotaIds?: readonly string[] | undefined;
  readonly executionFence?: ExecutionFence | undefined;
  readonly status: 'active' | 'held-uncertain' | 'released';
  readonly state?: 'held' | 'uncertain' | 'released' | undefined;
  readonly grantedAt: number;
  readonly releasedAt?: number | undefined;
  readonly uncertainReason?: string | undefined;
}

export interface ControlUsageRecord {
  readonly attemptId?: string | undefined;
  readonly checkId?: string | undefined;
  readonly backend: BackendRunnerKind;
  readonly modelId?: string | undefined;
  readonly denomination: 'usd' | 'tokens';
  readonly quality: 'verified' | 'estimated' | 'unavailable';
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly cachedTokens?: number | undefined;
  readonly costMicrousd?: number | undefined;
  readonly upperBoundMicrousd?: number | undefined;
  readonly sharedObservation?: boolean | undefined;
}

export interface ControlBackendTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
}

export interface ControlRootUsageRollup {
  readonly verifiedMicrousd: number;
  readonly estimatedMicrousd: number;
  readonly unpricedAttemptCount: number;
  readonly reservedMicrousd: number;
  readonly uncertainReservationCount: number;
  readonly sharedCheckMicrousd: number;
  readonly tokensByBackend: Readonly<Record<string, ControlBackendTokenUsage>>;
  readonly usageRecordsByRef: Readonly<Record<string, ControlUsageRecord>>;
}

export type ControlNotificationReason =
  | 'candidate-switched'
  | 'waiting-availability'
  | 'monitoring-expired'
  | 'spend-limit-reached'
  | 'spend-unverifiable'
  | 'spend-bound-exceeded'
  | 'intervention-required'
  | 'repeat-exhausted'
  | 'foreach-item-failed';

export interface ControlNotificationRecord {
  readonly notificationId: string;
  readonly rootRunId: string;
  readonly invocationId: string;
  readonly generation: number;
  readonly reason: ControlNotificationReason;
  readonly createdAt: number;
  readonly delivery: 'pending' | 'claimed';
  readonly summary?: string | undefined;
}

export interface ControlDecisionSummaryRecord {
  readonly summaryId: string;
  readonly rootRunId: string;
  readonly invocationId: string;
  readonly frameKey: string;
  readonly generation: number;
  readonly eventKind:
    | 'candidate-selected'
    | 'candidate-switched'
    | 'candidate-retired'
    | 'candidate-waiting'
    | 'candidate-returned'
    | 'notice-created'
    | 'control-paused';
  readonly candidateId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly reason?: string | undefined;
  readonly createdAt: number;
}

export interface ControlSettledCheckSummaryRecord {
  readonly checkId: string;
  readonly observationId: string;
  readonly backend: BackendRunnerKind;
  readonly sponsorRootRunId: string;
  readonly sharedObservation: boolean;
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly costMicrousd: number;
  readonly settledAt: number;
}

export interface ControlPolicyOverrideRecord {
  readonly commandId: string;
  readonly generation: number;
  readonly appliedAt: number;
  readonly availabilityPolicy?:
    | 'first-ready'
    | 'wait-for-selected'
    | 'stop-on-unavailability'
    | undefined;
  readonly allowedCandidateIds?: readonly string[] | undefined;
  readonly manualSelectionCandidateId?: string | undefined;
  readonly monitoringDurationMs?: number | undefined;
}

export interface ControlCommandReceiptRecord {
  readonly commandId: string;
  readonly payloadDigest: string;
  readonly invocationId: string;
  readonly generation: number;
  readonly acceptedAt: number;
  readonly acknowledgement: {
    readonly version: 1;
    readonly commandId: string;
    readonly outcome: 'accepted' | 'refused';
    readonly generation: number;
    readonly reason?: string | undefined;
  };
}

export interface RootControlState {
  readonly version: typeof CONTROL_LEDGER_VERSION;
  readonly ledgerRunId: string;
  readonly connectedRunId: string;
  readonly rootWorkflowId: string;
  readonly queueId: string;
  readonly linkState: RootLinkState;
  readonly status: ControlRootStatus;
  readonly fence: ExecutionFence;
  readonly rootBudget: RootControlBudget;
  readonly dispatchedAttempts: number;
  readonly settledMicrousd: number;
  readonly reservedMicrousd: number;
  readonly sharedCheckMicrousd?: number;
  readonly uncertainSpendCount?: number;
  readonly usageRollup?: ControlRootUsageRollup | undefined;
  readonly notificationsById?: Readonly<Record<string, ControlNotificationRecord>> | undefined;
  readonly decisionSummaries?: readonly ControlDecisionSummaryRecord[] | undefined;
  readonly settledCheckSummaries?: readonly ControlSettledCheckSummaryRecord[] | undefined;
  readonly commandReceipts?: readonly ControlCommandReceiptRecord[] | undefined;
  readonly receiptHighWaterGeneration?: number | undefined;
  readonly archivedHistoryCursor?: string | undefined;
  readonly archivedSummaryCount?: number | undefined;
  readonly framesByKey: Readonly<Record<string, ControlFrame>>;
  readonly attemptsById: Readonly<Record<string, ControlAttemptRecord>>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
  readonly pauseCause?: string;
  readonly failureCode?: string;
}

export interface ControlLedger {
  readonly version: typeof CONTROL_LEDGER_VERSION;
  readonly revision: number;
  readonly nextWaitSequence: number;
  readonly roots: Readonly<Record<string, RootControlState>>;
  readonly quotaObservations: Readonly<Record<string, QuotaObservationRecord>>;
  readonly checks: Readonly<Record<string, AvailabilityCheckRecord>>;
  readonly waiters: readonly QuotaWaiterRecord[];
  readonly permits: Readonly<Record<string, ExecutionPermitRecord>>;
}

export interface ConnectedRunControlLink {
  readonly version: typeof CONTROL_LEDGER_VERSION;
  readonly ledgerRunId: string;
}

/**
 * Typed clock port for deterministic control-ledger timestamps and deadlines.
 */
export interface ControlClockPort {
  nowWallMs(): number;
  nowMonotonicMs(): number;
  readonly hostEpoch?: string | undefined;
}

/**
 * Typed policy preflight port evaluated during `prepareAttempt`.
 */
export interface ControlPolicyPreflightInput {
  readonly ledgerRunId: string;
  readonly connectedRunId: string;
  readonly queueId: string;
  readonly invocationId: string;
  readonly nodeId: string;
  readonly candidateId?: string;
  readonly backend: BackendRunnerKind;
  readonly model?: string;
  readonly estimatedMicrousd?: number;
}

export type ControlPolicyPreflightResult =
  | { readonly allowed: true; readonly reservedMicrousd?: number }
  | { readonly allowed: false; readonly refusalCode: string; readonly detail?: string };

export interface ControlPolicySnapshotPort {
  evaluatePreflight(
    input: ControlPolicyPreflightInput
  ): Promise<ControlPolicyPreflightResult> | ControlPolicyPreflightResult;
}

/**
 * Typed process/attempt evidence port consulted during crash reconciliation.
 */
export interface ProcessEvidenceProbeInput {
  readonly ledgerRunId: string;
  readonly connectedRunId: string;
  readonly invocationId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly queueItemId?: string;
  readonly pid?: number;
}

export interface ProcessEvidenceSnapshot {
  readonly processState: ControlProcessEvidenceState;
  readonly durableTerminalStatus?: ControlAttemptTerminalStatus;
  readonly durableFailureCode?: string;
  readonly settledMicrousd?: number;
  readonly queueItemPresent?: boolean;
  readonly decisionResults?: Readonly<Record<string, DecisionFieldValue>>;
}

export interface ProcessEvidencePort {
  inspectAttempt(
    input: ProcessEvidenceProbeInput
  ): Promise<ProcessEvidenceSnapshot> | ProcessEvidenceSnapshot;
}

export type ControlLedgerErrorCode =
  | 'unsupported-control-ledger-version'
  | 'control-ledger-corrupt'
  | 'stale-ledger-revision'
  | 'stale-execution-fence'
  | 'control-root-not-found'
  | 'control-root-limit-exceeded'
  | 'control-frame-limit-exceeded'
  | 'control-ledger-size-exceeded'
  | 'control-waiter-limit-exceeded'
  | 'control-check-limit-exceeded'
  | 'control-root-not-active'
  | 'root-attempt-budget-exhausted'
  | 'candidate-dispatch-budget-exhausted'
  | 'candidate-attempt-budget-exhausted'
  | 'strict-usd-budget-exceeded'
  | 'prepare-token-consumed'
  | 'prepare-token-stale'
  | 'attempt-not-found'
  | 'invalid-attempt-stage'
  | 'policy-preflight-refused'
  | 'quota-capacity-unavailable';

export interface PreparedControlAttemptToken {
  readonly tokenId: string;
  readonly preparedAt: number;
  readonly expectedLedgerRevision: number;
  readonly ledgerRunId: string;
  readonly connectedRunId: string;
  readonly queueId: string;
  readonly frameKey: string;
  readonly frameKind: ControlFrameKind;
  readonly workflowId: string;
  readonly invocationId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly candidateId?: string | undefined;
  readonly backend: BackendRunnerKind;
  readonly model?: string | undefined;
  readonly reservedMicrousd: number;
  readonly hasSideEffects: boolean;
  readonly fence: ExecutionFence;
  readonly quotaKeys: readonly string[];
  readonly observationIds?: readonly string[] | undefined;
  readonly requireFreshReady?: boolean | undefined;
  readonly hostEpoch?: string | undefined;
  readonly capacitiesByQuotaId?: Readonly<Record<string, number>> | undefined;
  readonly satisfiedWaiterId?: string | undefined;
  readonly expectedWaiterSequence?: number | undefined;
  readonly expectedWaiterGeneration?: number | undefined;
  readonly maxDispatches?: number | undefined;
  readonly candidateMaxAttempts?: number | undefined;
}

export interface PrepareControlAttemptInput {
  readonly ledgerRunId: string;
  readonly connectedRunId: string;
  readonly queueId: string;
  readonly frameKey: string;
  readonly frameKind?: ControlFrameKind | undefined;
  readonly workflowId: string;
  readonly invocationId: string;
  readonly nodeId: string;
  readonly attemptId?: string | undefined;
  readonly attemptIndex?: number | undefined;
  readonly candidateId?: string | undefined;
  readonly backend: BackendRunnerKind;
  readonly model?: string | undefined;
  readonly reservedMicrousd?: number | undefined;
  readonly hasSideEffects?: boolean | undefined;
  readonly fence: ExecutionFence;
  readonly quotaKeys?: readonly string[] | undefined;
  readonly observationIds?: readonly string[] | undefined;
  readonly requireFreshReady?: boolean | undefined;
  readonly hostEpoch?: string | undefined;
  readonly capacitiesByQuotaId?: Readonly<Record<string, number>> | undefined;
  readonly satisfiedWaiterId?: string | undefined;
  readonly expectedWaiterSequence?: number | undefined;
  readonly expectedWaiterGeneration?: number | undefined;
  readonly maxDispatches?: number | undefined;
  readonly candidateMaxAttempts?: number | undefined;
}

export type PrepareControlAttemptOutcome =
  | {
      readonly ok: true;
      readonly token: PreparedControlAttemptToken;
      readonly ledgerRevision: number;
    }
  | {
      readonly ok: false;
      readonly code: ControlLedgerErrorCode;
      readonly message: string;
    };

export type CommitControlAttemptOutcome =
  | {
      readonly ok: true;
      readonly ledger: ControlLedger;
      readonly root: RootControlState;
      readonly frame: ControlFrame;
      readonly attempt: ControlAttemptRecord;
      readonly permit?: ExecutionPermitRecord;
    }
  | {
      readonly ok: false;
      readonly code: ControlLedgerErrorCode;
      readonly message: string;
    };

export interface ControlAdmissionPort {
  prepareAttempt(
    input: PrepareControlAttemptInput
  ): Promise<PrepareControlAttemptOutcome>;
  commitAttempt(
    token: PreparedControlAttemptToken
  ): Promise<CommitControlAttemptOutcome>;
}

export function createEmptyControlLedger(): ControlLedger {
  return Object.freeze({
    version: CONTROL_LEDGER_VERSION,
    revision: 0,
    nextWaitSequence: 1,
    roots: Object.freeze({}),
    quotaObservations: Object.freeze({}),
    checks: Object.freeze({}),
    waiters: Object.freeze([]),
    permits: Object.freeze({})
  });
}

export function executionFencesEqual(a: ExecutionFence, b: ExecutionFence): boolean {
  return (
    a.primacyClaim === b.primacyClaim &&
    a.queueClaim === b.queueClaim &&
    a.rootGeneration === b.rootGeneration
  );
}

export function isValidExecutionFence(value: unknown): value is ExecutionFence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.primacyClaim === 'string' &&
    rec.primacyClaim.trim().length > 0 &&
    typeof rec.queueClaim === 'string' &&
    rec.queueClaim.trim().length > 0 &&
    typeof rec.rootGeneration === 'number' &&
    Number.isSafeInteger(rec.rootGeneration) &&
    rec.rootGeneration >= 1
  );
}

export function isValidConnectedRunControlLink(
  value: unknown
): value is ConnectedRunControlLink {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  return (
    rec.version === CONTROL_LEDGER_VERSION &&
    typeof rec.ledgerRunId === 'string' &&
    rec.ledgerRunId.trim().length > 0
  );
}
