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
  | 'waiting-availability'
  | 'waiting-permit'
  | 'waiting-handoff'
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
  readonly nextEligibleAt?: number;
  readonly lastAttemptId?: string;
  readonly lastFailureCode?: string;
}

export interface RepeatRuntimeState {
  readonly currentPass: number;
  readonly maxIterations: number;
  readonly carryValues?: Readonly<Record<string, DecisionFieldValue>>;
  readonly lastPassAccepted?: boolean;
  readonly exhaustionReason?: string;
}

export interface ForEachItemRuntimeSlot {
  readonly itemIndex: number;
  readonly itemKey: string;
  readonly status: 'pending' | 'in-flight' | 'completed' | 'failed' | 'skipped';
  readonly childInvocationId?: string;
  readonly attemptId?: string;
  readonly failureCode?: string;
  readonly decisionResults?: Readonly<Record<string, DecisionFieldValue>>;
}

export interface ForEachRuntimeState {
  readonly totalItems: number;
  readonly currentIndex: number;
  readonly hasErrors: boolean;
  readonly resultIndexArtifactPath?: string;
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
  readonly pauseCause?: string;
  readonly failureCode?: string;
  readonly candidateSlots?: readonly CandidateRuntimeSlot[];
  readonly repeatState?: RepeatRuntimeState;
  readonly forEachState?: ForEachRuntimeState;
  readonly decisionResults?: Readonly<Record<string, DecisionFieldValue>>;
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
  readonly backend: BackendRunnerKind;
  readonly accountId?: string;
  readonly status: 'ready' | 'rate-limited' | 'credit-exhausted' | 'unknown' | 'unsupported';
  readonly observedAt: number;
  readonly resetAt?: number;
  readonly nextCheckAt?: number;
  readonly checkAttempts: number;
  readonly detail?: string;
}

export interface AvailabilityCheckRecord {
  readonly checkId: string;
  readonly quotaKey: string;
  readonly backend: BackendRunnerKind;
  readonly sponsorLedgerRunId: string;
  readonly status: 'running' | 'completed' | 'failed' | 'aborted';
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly completedAt?: number;
  readonly costMicrousd?: number;
  readonly costUncertain?: boolean;
}

export interface QuotaWaiterRecord {
  readonly waiterId: string;
  readonly waitSequence: number;
  readonly ledgerRunId: string;
  readonly connectedRunId: string;
  readonly queueId: string;
  readonly frameKey: string;
  readonly invocationId: string;
  readonly nodeId: string;
  readonly candidateId?: string;
  readonly quotaKeys: readonly string[];
  readonly status: 'waiting' | 'paused' | 'granted' | 'canceled';
  readonly enqueuedAt: number;
  readonly updatedAt: number;
}

export interface ExecutionPermitRecord {
  readonly permitId: string;
  readonly attemptId: string;
  readonly ledgerRunId: string;
  readonly connectedRunId: string;
  readonly queueId: string;
  readonly quotaKeys: readonly string[];
  readonly status: 'active' | 'held-uncertain' | 'released';
  readonly grantedAt: number;
  readonly releasedAt?: number;
  readonly uncertainReason?: string;
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
  readonly candidateId?: string;
  readonly backend: BackendRunnerKind;
  readonly model?: string;
  readonly reservedMicrousd: number;
  readonly hasSideEffects: boolean;
  readonly fence: ExecutionFence;
  readonly quotaKeys: readonly string[];
  readonly satisfiedWaiterId?: string;
  readonly maxDispatches?: number;
  readonly candidateMaxAttempts?: number;
}

export interface PrepareControlAttemptInput {
  readonly ledgerRunId: string;
  readonly connectedRunId: string;
  readonly queueId: string;
  readonly frameKey: string;
  readonly frameKind?: ControlFrameKind;
  readonly workflowId: string;
  readonly invocationId: string;
  readonly nodeId: string;
  readonly attemptId?: string;
  readonly attemptIndex?: number;
  readonly candidateId?: string;
  readonly backend: BackendRunnerKind;
  readonly model?: string;
  readonly reservedMicrousd?: number;
  readonly hasSideEffects?: boolean;
  readonly fence: ExecutionFence;
  readonly quotaKeys?: readonly string[];
  readonly satisfiedWaiterId?: string;
  readonly maxDispatches?: number;
  readonly candidateMaxAttempts?: number;
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
