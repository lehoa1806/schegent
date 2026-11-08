/**
 * FR-R5-F29 (SPEC-07, D1, D4, D7; WF-12, WF-17, WF-18; AC-26, AC-28, AC-33, AC-34) —
 * Fair all-or-none shared-quota permit arbiter.
 *
 * Responsibilities:
 * - Validate closed `QuotaWaiter` and `QuotaPermit` shapes at the ledger boundary.
 * - Allocate monotonic `sequence` once per attempt selection in `ControlLedgerStore`,
 *   preserve `sequence` across polling updates and pause/resume, and allocate a new
 *   waiter with a new `sequence` when reselected to a different quota set.
 * - Build the eligible-head view ordered by ascending durable `sequence`, skipping
 *   paused, untrusted, stale-fence, stale-generation, not-due, unready, or
 *   queue-head-blocked waiters without deleting their place, while preventing
 *   later items on the same `queueId` from overtaking their queue head.
 * - Compute fair all-or-none quota permit proposals (`preparePermitGrant`) in sorted
 *   UTF-8 byte order without partial reservations or durable side effects (`D4` /
 *   `ControlAttemptAdmissionService` owns the atomic ledger commit).
 * - Enforce conservative `unknown-local-quota` capacity 1 while preserving
 *   occurrence-scoped readiness (`unknown/<candidateOccurrenceId>`).
 * - Fence permit release and retain `uncertain` permits across restart and virtual
 *   time advances until process evidence resolves them.
 *
 * Zero `vscode` imports.
 */

import {
  MAX_QUOTA_CAPACITY,
  MAX_QUOTA_IDS_PER_CANDIDATE,
  MIN_QUOTA_CAPACITY,
  UNKNOWN_LOCAL_QUOTA_ID,
  isQuotaObservationFreshReady,
  isValidObservationId,
  isValidQuotaId
} from '../../contracts/backend-availability';
import {
  MAX_QUOTA_WAITERS,
  executionFencesEqual,
  isValidExecutionFence,
  type ControlClockPort,
  type ControlLedger,
  type ExecutionFence,
  type ExecutionPermitRecord,
  type QuotaObservationRecord,
  type QuotaWaiterRecord
} from '../../contracts/control-ledger';
import { fromObservationRecord } from '../backend-availability-service';
import { ControlLedgerStore, lookupRecord } from './control-ledger-store';

export interface QuotaWaiter {
  readonly waiterId: string;
  readonly rootRunId: string;
  readonly queueId: string;
  readonly invocationId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly quotaIds: readonly string[];
  readonly registeredAt: number;
  readonly frameKey?: string | undefined;
  readonly nodeId?: string | undefined;
  readonly candidateId?: string | undefined;
  readonly candidateOccurrenceId?: string | undefined;
  readonly observationIds?: readonly string[] | undefined;
  readonly paused?: boolean | undefined;
}

export interface QuotaPermit {
  readonly permitId: string;
  readonly attemptId: string;
  readonly rootRunId: string;
  readonly queueId: string;
  readonly quotaIds: readonly string[];
  readonly executionFence: ExecutionFence;
  readonly grantedAt: number;
  readonly state: 'held' | 'uncertain';
}

export type QuotaWaiterValidationResult =
  | { readonly ok: true; readonly value: QuotaWaiter }
  | { readonly ok: false; readonly code: string; readonly message: string };

export type QuotaPermitValidationResult =
  | { readonly ok: true; readonly value: QuotaPermit }
  | { readonly ok: false; readonly code: string; readonly message: string };

const ALLOWED_WAITER_KEYS = new Set<string>([
  'waiterId',
  'rootRunId',
  'queueId',
  'invocationId',
  'generation',
  'sequence',
  'quotaIds',
  'registeredAt',
  'frameKey',
  'nodeId',
  'candidateId',
  'candidateOccurrenceId',
  'observationIds',
  'paused'
]);

const ALLOWED_PERMIT_KEYS = new Set<string>([
  'permitId',
  'attemptId',
  'rootRunId',
  'queueId',
  'quotaIds',
  'executionFence',
  'grantedAt',
  'state'
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUnknownKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>
): string | undefined {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      return key;
    }
  }
  return undefined;
}

export function compareUtf8Bytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function sortQuotaIds(quotaIds: readonly string[]): readonly string[] {
  return Object.freeze([...quotaIds].sort(compareUtf8Bytes));
}

export function quotaIdSetsEqual(
  a: readonly string[],
  b: readonly string[]
): boolean {
  const sortedA = sortQuotaIds(a);
  const sortedB = sortQuotaIds(b);
  if (sortedA.length !== sortedB.length) return false;
  for (let i = 0; i < sortedA.length; i += 1) {
    if (sortedA[i] !== sortedB[i]) return false;
  }
  return true;
}

export function validateQuotaWaiter(raw: unknown): QuotaWaiterValidationResult {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      code: 'invalid-quota-waiter',
      message: 'QuotaWaiter must be a plain object.'
    };
  }
  const unknownKey = hasUnknownKeys(raw, ALLOWED_WAITER_KEYS);
  if (unknownKey !== undefined) {
    return {
      ok: false,
      code: 'invalid-quota-waiter',
      message: `Unknown field '${unknownKey}' in QuotaWaiter.`
    };
  }
  if (typeof raw.waiterId !== 'string' || raw.waiterId.trim().length === 0) {
    return {
      ok: false,
      code: 'invalid-quota-waiter',
      message: 'QuotaWaiter.waiterId must be a non-empty string.'
    };
  }
  if (typeof raw.rootRunId !== 'string' || raw.rootRunId.trim().length === 0) {
    return {
      ok: false,
      code: 'invalid-quota-waiter',
      message: 'QuotaWaiter.rootRunId must be a non-empty string.'
    };
  }
  if (typeof raw.queueId !== 'string' || raw.queueId.trim().length === 0) {
    return {
      ok: false,
      code: 'invalid-quota-waiter',
      message: 'QuotaWaiter.queueId must be a non-empty string.'
    };
  }
  if (
    typeof raw.invocationId !== 'string' ||
    raw.invocationId.trim().length === 0
  ) {
    return {
      ok: false,
      code: 'invalid-quota-waiter',
      message: 'QuotaWaiter.invocationId must be a non-empty string.'
    };
  }
  if (
    typeof raw.generation !== 'number' ||
    !Number.isSafeInteger(raw.generation) ||
    raw.generation < 0
  ) {
    return {
      ok: false,
      code: 'invalid-quota-waiter',
      message: 'QuotaWaiter.generation must be a nonnegative safe integer.'
    };
  }
  if (
    typeof raw.sequence !== 'number' ||
    !Number.isSafeInteger(raw.sequence) ||
    raw.sequence < 1
  ) {
    return {
      ok: false,
      code: 'invalid-quota-waiter',
      message: 'QuotaWaiter.sequence must be a positive safe integer.'
    };
  }
  if (
    typeof raw.registeredAt !== 'number' ||
    !Number.isSafeInteger(raw.registeredAt) ||
    raw.registeredAt < 0
  ) {
    return {
      ok: false,
      code: 'invalid-quota-waiter',
      message: 'QuotaWaiter.registeredAt must be a nonnegative safe integer.'
    };
  }
  if (
    !Array.isArray(raw.quotaIds) ||
    raw.quotaIds.length < 1 ||
    raw.quotaIds.length > MAX_QUOTA_IDS_PER_CANDIDATE
  ) {
    return {
      ok: false,
      code: 'invalid-quota-waiter',
      message: `QuotaWaiter.quotaIds must contain 1..${MAX_QUOTA_IDS_PER_CANDIDATE} quota IDs.`
    };
  }
  const seenQuotaIds = new Set<string>();
  for (const item of raw.quotaIds) {
    if (!isValidQuotaId(item)) {
      return {
        ok: false,
        code: 'invalid-quota-waiter',
        message: 'Every QuotaWaiter.quotaIds entry must be a valid non-secret ASCII quota token.'
      };
    }
    if (seenQuotaIds.has(item)) {
      return {
        ok: false,
        code: 'invalid-quota-waiter',
        message: `Duplicate quotaId '${item}' in QuotaWaiter.quotaIds.`
      };
    }
    seenQuotaIds.add(item);
  }

  let observationIds: readonly string[] | undefined;
  if (raw.observationIds !== undefined) {
    if (
      !Array.isArray(raw.observationIds) ||
      raw.observationIds.length !== raw.quotaIds.length
    ) {
      return {
        ok: false,
        code: 'invalid-quota-waiter',
        message: 'QuotaWaiter.observationIds must match quotaIds length when provided.'
      };
    }
    for (const obsId of raw.observationIds) {
      if (!isValidObservationId(obsId)) {
        return {
          ok: false,
          code: 'invalid-quota-waiter',
          message: 'Every QuotaWaiter.observationIds entry must be a valid token.'
        };
      }
    }
    observationIds = Object.freeze([...(raw.observationIds as string[])]);
  }

  const sortedQuotaIds = sortQuotaIds(raw.quotaIds as string[]);
  return {
    ok: true,
    value: Object.freeze({
      waiterId: raw.waiterId,
      rootRunId: raw.rootRunId,
      queueId: raw.queueId,
      invocationId: raw.invocationId,
      generation: raw.generation,
      sequence: raw.sequence,
      quotaIds: sortedQuotaIds,
      registeredAt: raw.registeredAt,
      ...(typeof raw.frameKey === 'string' ? { frameKey: raw.frameKey } : {}),
      ...(typeof raw.nodeId === 'string' ? { nodeId: raw.nodeId } : {}),
      ...(typeof raw.candidateId === 'string'
        ? { candidateId: raw.candidateId }
        : {}),
      ...(typeof raw.candidateOccurrenceId === 'string'
        ? { candidateOccurrenceId: raw.candidateOccurrenceId }
        : {}),
      ...(observationIds !== undefined ? { observationIds } : {}),
      ...(typeof raw.paused === 'boolean' ? { paused: raw.paused } : {})
    })
  };
}

export function validateQuotaPermit(raw: unknown): QuotaPermitValidationResult {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      code: 'invalid-quota-permit',
      message: 'QuotaPermit must be a plain object.'
    };
  }
  const unknownKey = hasUnknownKeys(raw, ALLOWED_PERMIT_KEYS);
  if (unknownKey !== undefined) {
    return {
      ok: false,
      code: 'invalid-quota-permit',
      message: `Unknown field '${unknownKey}' in QuotaPermit.`
    };
  }
  if (typeof raw.permitId !== 'string' || raw.permitId.trim().length === 0) {
    return {
      ok: false,
      code: 'invalid-quota-permit',
      message: 'QuotaPermit.permitId must be a non-empty string.'
    };
  }
  if (typeof raw.attemptId !== 'string' || raw.attemptId.trim().length === 0) {
    return {
      ok: false,
      code: 'invalid-quota-permit',
      message: 'QuotaPermit.attemptId must be a non-empty string.'
    };
  }
  if (typeof raw.rootRunId !== 'string' || raw.rootRunId.trim().length === 0) {
    return {
      ok: false,
      code: 'invalid-quota-permit',
      message: 'QuotaPermit.rootRunId must be a non-empty string.'
    };
  }
  if (typeof raw.queueId !== 'string' || raw.queueId.trim().length === 0) {
    return {
      ok: false,
      code: 'invalid-quota-permit',
      message: 'QuotaPermit.queueId must be a non-empty string.'
    };
  }
  if (!isValidExecutionFence(raw.executionFence)) {
    return {
      ok: false,
      code: 'invalid-quota-permit',
      message: 'QuotaPermit.executionFence must be a valid ExecutionFence.'
    };
  }
  if (
    typeof raw.grantedAt !== 'number' ||
    !Number.isSafeInteger(raw.grantedAt) ||
    raw.grantedAt < 0
  ) {
    return {
      ok: false,
      code: 'invalid-quota-permit',
      message: 'QuotaPermit.grantedAt must be a nonnegative safe integer.'
    };
  }
  if (raw.state !== 'held' && raw.state !== 'uncertain') {
    return {
      ok: false,
      code: 'invalid-quota-permit',
      message: "QuotaPermit.state must be 'held' or 'uncertain'."
    };
  }
  if (
    !Array.isArray(raw.quotaIds) ||
    raw.quotaIds.length < 1 ||
    raw.quotaIds.length > MAX_QUOTA_IDS_PER_CANDIDATE
  ) {
    return {
      ok: false,
      code: 'invalid-quota-permit',
      message: `QuotaPermit.quotaIds must contain 1..${MAX_QUOTA_IDS_PER_CANDIDATE} quota IDs.`
    };
  }
  const seenQuotaIds = new Set<string>();
  for (const item of raw.quotaIds) {
    if (!isValidQuotaId(item) || seenQuotaIds.has(item)) {
      return {
        ok: false,
        code: 'invalid-quota-permit',
        message: 'Every QuotaPermit.quotaIds entry must be a unique valid quota token.'
      };
    }
    seenQuotaIds.add(item);
  }

  return {
    ok: true,
    value: Object.freeze({
      permitId: raw.permitId,
      attemptId: raw.attemptId,
      rootRunId: raw.rootRunId,
      queueId: raw.queueId,
      quotaIds: sortQuotaIds(raw.quotaIds as string[]),
      executionFence: Object.freeze({ ...raw.executionFence }),
      grantedAt: raw.grantedAt,
      state: raw.state
    })
  };
}

export function fromWaiterRecord(record: QuotaWaiterRecord): QuotaWaiter {
  const quotaIds = sortQuotaIds(record.quotaIds ?? record.quotaKeys);
  return Object.freeze({
    waiterId: record.waiterId,
    rootRunId: record.rootRunId ?? record.ledgerRunId,
    queueId: record.queueId,
    invocationId: record.invocationId,
    generation: record.generation ?? 1,
    sequence: record.sequence ?? record.waitSequence,
    quotaIds,
    registeredAt: record.registeredAt ?? record.enqueuedAt,
    frameKey: record.frameKey,
    nodeId: record.nodeId,
    ...(record.candidateId !== undefined
      ? { candidateId: record.candidateId }
      : {}),
    ...(record.candidateOccurrenceId !== undefined
      ? { candidateOccurrenceId: record.candidateOccurrenceId }
      : {}),
    ...(record.observationIds !== undefined
      ? { observationIds: Object.freeze([...record.observationIds]) }
      : {}),
    paused: record.status === 'paused'
  });
}

export function toWaiterRecord(
  waiter: QuotaWaiter,
  connectedRunId: string,
  updatedAt: number,
  status: QuotaWaiterRecord['status'] = waiter.paused ? 'paused' : 'waiting'
): QuotaWaiterRecord {
  const sortedQuotaIds = sortQuotaIds(waiter.quotaIds);
  return Object.freeze({
    waiterId: waiter.waiterId,
    waitSequence: waiter.sequence,
    sequence: waiter.sequence,
    ledgerRunId: waiter.rootRunId,
    rootRunId: waiter.rootRunId,
    connectedRunId,
    queueId: waiter.queueId,
    frameKey: waiter.frameKey ?? waiter.invocationId,
    invocationId: waiter.invocationId,
    generation: waiter.generation,
    nodeId: waiter.nodeId ?? waiter.candidateId ?? 'node',
    ...(waiter.candidateId !== undefined
      ? { candidateId: waiter.candidateId }
      : {}),
    ...(waiter.candidateOccurrenceId !== undefined
      ? { candidateOccurrenceId: waiter.candidateOccurrenceId }
      : {}),
    quotaKeys: sortedQuotaIds,
    quotaIds: sortedQuotaIds,
    ...(waiter.observationIds !== undefined
      ? { observationIds: Object.freeze([...waiter.observationIds]) }
      : {}),
    status,
    enqueuedAt: waiter.registeredAt,
    registeredAt: waiter.registeredAt,
    updatedAt
  });
}

export function fromPermitRecord(
  record: ExecutionPermitRecord,
  fallbackFence?: ExecutionFence
): QuotaPermit | undefined {
  if (record.status === 'released' || record.state === 'released') {
    return undefined;
  }
  const fence = record.executionFence ?? fallbackFence;
  if (fence === undefined) {
    return undefined;
  }
  const state: 'held' | 'uncertain' =
    record.state === 'uncertain' || record.status === 'held-uncertain'
      ? 'uncertain'
      : 'held';
  return Object.freeze({
    permitId: record.permitId,
    attemptId: record.attemptId,
    rootRunId: record.rootRunId ?? record.ledgerRunId,
    queueId: record.queueId,
    quotaIds: sortQuotaIds(record.quotaIds ?? record.quotaKeys),
    executionFence: fence,
    grantedAt: record.grantedAt,
    state
  });
}

export interface RegisterWaiterInput {
  readonly waiterId?: string | undefined;
  readonly rootRunId: string;
  readonly queueId: string;
  readonly invocationId: string;
  readonly frameKey?: string | undefined;
  readonly nodeId?: string | undefined;
  readonly candidateId?: string | undefined;
  readonly candidateOccurrenceId?: string | undefined;
  readonly generation: number;
  readonly quotaIds: readonly string[];
  readonly observationIds?: readonly string[] | undefined;
  readonly paused?: boolean | undefined;
}

export type RegisterWaiterOutcome =
  | {
      readonly ok: true;
      readonly waiter: QuotaWaiter;
      readonly preservedSequence: boolean;
      readonly ledger: ControlLedger;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid-quota-waiter'
        | 'sequence-overflow'
        | 'control-root-not-found'
        | 'control-waiter-limit-exceeded'
        | 'ledger-error';
      readonly message: string;
    };

export type WaiterSkipReason =
  | 'paused'
  | 'untrusted'
  | 'stale-fence'
  | 'stale-generation'
  | 'not-due'
  | 'budget-exhausted'
  | 'not-ready'
  | 'queue-head-blocked';

export interface EligibleHeadEntry {
  readonly waiter: QuotaWaiter;
  readonly admissible: boolean;
  readonly skipReason?: WaiterSkipReason | undefined;
  readonly skipDetail?: string | undefined;
}

export interface EligibleHeadView {
  readonly evaluatedAtWallMs: number;
  readonly entries: readonly EligibleHeadEntry[];
  readonly admissibleWaiters: readonly QuotaWaiter[];
}

export interface PermitGrantProposal {
  readonly waiter: QuotaWaiter;
  readonly permit: QuotaPermit;
  readonly sortedQuotaIds: readonly string[];
  readonly observationIds: readonly string[];
  readonly requireFreshReady: boolean;
  readonly hostEpoch: string;
  readonly capacitiesByQuotaId: Readonly<Record<string, number>>;
  readonly expectedLedgerRevision: number;
}

export interface PreparePermitGrantInput {
  readonly waiterId?: string | undefined;
  readonly rootRunId?: string | undefined;
  readonly invocationId?: string | undefined;
  readonly attemptId: string;
  readonly executionFence?: ExecutionFence | undefined;
  readonly allowUnverifiedTrialByWaiterId?: Readonly<Record<string, boolean>> | undefined;
  readonly notBeforeByWaiterId?: Readonly<Record<string, number>> | undefined;
  readonly capacitiesOverrideByQuotaId?: Readonly<Record<string, number>> | undefined;
}

export type PreparePermitGrantOutcome =
  | {
      readonly ok: true;
      readonly proposal: PermitGrantProposal;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'waiter-not-found'
        | 'waiter-inadmissible'
        | 'quota-capacity-exhausted'
        | 'preempted-by-older-waiter'
        | 'process-capacity-exhausted'
        | 'duplicate-attempt-permit'
        | 'ledger-error';
      readonly skipReason?: WaiterSkipReason | undefined;
      readonly message: string;
    };

export interface ReleasePermitInput {
  readonly attemptId: string;
  readonly permitId?: string | undefined;
  readonly rootRunId: string;
  readonly fence: ExecutionFence;
  readonly holdUncertain?: boolean | undefined;
  readonly uncertainReason?: string | undefined;
}

export type ReleasePermitOutcome =
  | {
      readonly ok: true;
      readonly alreadyReleased: boolean;
      readonly state: 'released' | 'uncertain';
      readonly ledger: ControlLedger;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'permit-not-found'
        | 'attempt-mismatch'
        | 'stale-execution-fence'
        | 'ledger-error';
      readonly message: string;
    };

export interface QuotaHoldingSummary {
  readonly quotaId: string;
  readonly heldCount: number;
  readonly uncertainCount: number;
  readonly totalActiveCount: number;
  readonly capacity: number;
  readonly activePermitIds: readonly string[];
}

export interface QuotaPermitArbiterClock extends ControlClockPort {
  readonly hostEpoch?: string | undefined;
}

export interface QuotaPermitArbiterDeps {
  readonly ledgerStore: ControlLedgerStore;
  readonly clock: QuotaPermitArbiterClock;
  readonly isWorkspaceTrusted?: (() => boolean) | undefined;
  readonly verifyLiveFence?: (
    fence: ExecutionFence,
    context: { readonly rootRunId: string; readonly queueId: string }
  ) => boolean;
  readonly isQueueHeadEligible?: (
    queueId: string,
    rootRunId: string
  ) => boolean;
  readonly hasProcessCapacity?: (() => boolean) | undefined;
  readonly resolveQuotaCapacity?: (
    quotaId: string,
    observation: QuotaObservationRecord | undefined
  ) => number;
  readonly onCapacityOrWaiterChanged?: ((queueId?: string) => void) | undefined;
}

function clampCapacity(quotaId: string, rawCapacity: number | undefined): number {
  if (quotaId === UNKNOWN_LOCAL_QUOTA_ID) {
    return 1;
  }
  if (
    rawCapacity === undefined ||
    !Number.isSafeInteger(rawCapacity) ||
    rawCapacity < MIN_QUOTA_CAPACITY
  ) {
    return 1;
  }
  return Math.min(MAX_QUOTA_CAPACITY, rawCapacity);
}

export class QuotaPermitArbiter {
  private readonly ledgerStore: ControlLedgerStore;
  private readonly clock: QuotaPermitArbiterClock;
  private readonly isWorkspaceTrusted: (() => boolean) | undefined;
  private readonly verifyLiveFence:
    | ((
        fence: ExecutionFence,
        context: { readonly rootRunId: string; readonly queueId: string }
      ) => boolean)
    | undefined;
  private readonly isQueueHeadEligible:
    | ((queueId: string, rootRunId: string) => boolean)
    | undefined;
  private readonly hasProcessCapacity: (() => boolean) | undefined;
  private readonly resolveQuotaCapacity:
    | ((
        quotaId: string,
        observation: QuotaObservationRecord | undefined
      ) => number)
    | undefined;
  private readonly onCapacityOrWaiterChanged:
    | ((queueId?: string) => void)
    | undefined;

  public constructor(deps: QuotaPermitArbiterDeps) {
    this.ledgerStore = deps.ledgerStore;
    this.clock = deps.clock;
    this.isWorkspaceTrusted = deps.isWorkspaceTrusted;
    this.verifyLiveFence = deps.verifyLiveFence;
    this.isQueueHeadEligible = deps.isQueueHeadEligible;
    this.hasProcessCapacity = deps.hasProcessCapacity;
    this.resolveQuotaCapacity = deps.resolveQuotaCapacity;
    this.onCapacityOrWaiterChanged = deps.onCapacityOrWaiterChanged;
  }

  /**
   * Register or update a `QuotaWaiter` in `ControlLedgerStore`.
   * - Sequence is allocated once per attempt selection from `ledger.nextWaitSequence`.
   * - Preserved across polling updates and pause when `(rootRunId, invocationId)` and
   *   sorted `quotaIds` are unchanged.
   * - Reselection to another quota set replaces the prior waiter and allocates a new sequence.
   * - Sequence overflow at `Number.MAX_SAFE_INTEGER` is rejected fail-closed.
   */
  public async registerWaiter(
    input: RegisterWaiterInput
  ): Promise<RegisterWaiterOutcome> {
    if (
      !Array.isArray(input.quotaIds) ||
      input.quotaIds.length < 1 ||
      input.quotaIds.length > MAX_QUOTA_IDS_PER_CANDIDATE
    ) {
      return {
        ok: false,
        reason: 'invalid-quota-waiter',
        message: `quotaIds must contain 1..${MAX_QUOTA_IDS_PER_CANDIDATE} quota tokens.`
      };
    }
    const seen = new Set<string>();
    for (const qId of input.quotaIds) {
      if (!isValidQuotaId(qId) || seen.has(qId)) {
        return {
          ok: false,
          reason: 'invalid-quota-waiter',
          message: 'Every quotaId must be a unique valid non-secret ASCII token.'
        };
      }
      seen.add(qId);
    }

    const sortedQuotaIds = sortQuotaIds(input.quotaIds);
    const nowWallMs = this.clock.nowWallMs();

    const mutated = await this.ledgerStore.mutate<{
      readonly waiter: QuotaWaiter;
      readonly preservedSequence: boolean;
    }>(
      { targetRootId: input.rootRunId },
      ({ ledger }) => {
        const root = lookupRecord(ledger.roots, input.rootRunId);
        if (root === undefined) {
          return {
            commit: false,
            code: 'control-root-not-found',
            message: `Control root '${input.rootRunId}' not found.`
          };
        }

        // Find any existing active (waiting or paused) waiter for this (rootRunId, invocationId)
        const existingIdx = ledger.waiters.findIndex(
          (w) =>
            (w.rootRunId ?? w.ledgerRunId) === input.rootRunId &&
            w.invocationId === input.invocationId &&
            (w.status === 'waiting' || w.status === 'paused')
        );
        const existingRecord =
          existingIdx >= 0 ? ledger.waiters[existingIdx] : undefined;

        const sameQuotaSet =
          existingRecord !== undefined &&
          quotaIdSetsEqual(
            existingRecord.quotaIds ?? existingRecord.quotaKeys,
            sortedQuotaIds
          );

        let sequence: number;
        let nextWaitSequence = ledger.nextWaitSequence;
        let registeredAt = nowWallMs;
        let waiterId =
          input.waiterId ??
          `waiter:${input.rootRunId}:${input.invocationId}:${nextWaitSequence}`;

        if (sameQuotaSet) {
          sequence = existingRecord.sequence ?? existingRecord.waitSequence;
          registeredAt = existingRecord.registeredAt ?? existingRecord.enqueuedAt;
          waiterId = input.waiterId ?? existingRecord.waiterId;
        } else {
          if (
            !Number.isSafeInteger(nextWaitSequence) ||
            nextWaitSequence >= Number.MAX_SAFE_INTEGER
          ) {
            return {
              commit: false,
              code: 'control-ledger-corrupt',
              message: 'Ledger nextWaitSequence reached MAX_SAFE_INTEGER overflow.'
            };
          }
          sequence = nextWaitSequence;
          nextWaitSequence = sequence + 1;
        }

        const candidateWaiter = {
          waiterId,
          rootRunId: input.rootRunId,
          queueId: input.queueId,
          invocationId: input.invocationId,
          generation: input.generation,
          sequence,
          quotaIds: sortedQuotaIds,
          registeredAt,
          ...(input.frameKey !== undefined ? { frameKey: input.frameKey } : {}),
          ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
          ...(input.candidateId !== undefined
            ? { candidateId: input.candidateId }
            : {}),
          ...(input.candidateOccurrenceId !== undefined
            ? { candidateOccurrenceId: input.candidateOccurrenceId }
            : {}),
          ...(input.observationIds !== undefined
            ? { observationIds: input.observationIds }
            : {}),
          ...(input.paused !== undefined
            ? { paused: input.paused }
            : sameQuotaSet
              ? { paused: existingRecord.status === 'paused' }
              : {})
        };

        const validated = validateQuotaWaiter(candidateWaiter);
        if (!validated.ok) {
          return {
            commit: false,
            code: 'control-ledger-corrupt',
            message: validated.message
          };
        }

        const nextRecord = toWaiterRecord(
          validated.value,
          root.connectedRunId,
          nowWallMs
        );

        const nextWaiters: QuotaWaiterRecord[] = [];
        let replaced = false;
        for (let i = 0; i < ledger.waiters.length; i += 1) {
          const w = ledger.waiters[i]!;
          if (i === existingIdx) {
            nextWaiters.push(nextRecord);
            replaced = true;
          } else {
            nextWaiters.push(w);
          }
        }
        if (!replaced) {
          const activeCount = nextWaiters.filter(
            (w) => w.status === 'waiting' || w.status === 'paused'
          ).length;
          if (activeCount + 1 > MAX_QUOTA_WAITERS) {
            return {
              commit: false,
              code: 'control-waiter-limit-exceeded',
              message: `Active quota waiters cannot exceed MAX_QUOTA_WAITERS (${MAX_QUOTA_WAITERS}).`
            };
          }
          nextWaiters.push(nextRecord);
        }

        return {
          commit: true,
          plan: {
            nextLedger: {
              ...ledger,
              nextWaitSequence,
              waiters: nextWaiters
            },
            targetRootId: input.rootRunId,
            result: {
              waiter: validated.value,
              preservedSequence: sameQuotaSet
            }
          }
        };
      }
    );

    if (!mutated.ok) {
      if (mutated.message.includes('MAX_SAFE_INTEGER overflow')) {
        return {
          ok: false,
          reason: 'sequence-overflow',
          message: mutated.message
        };
      }
      if (mutated.code === 'control-root-not-found') {
        return {
          ok: false,
          reason: 'control-root-not-found',
          message: mutated.message
        };
      }
      if (mutated.code === 'control-waiter-limit-exceeded') {
        return {
          ok: false,
          reason: 'control-waiter-limit-exceeded',
          message: mutated.message
        };
      }
      return {
        ok: false,
        reason: 'invalid-quota-waiter',
        message: mutated.message
      };
    }

    this.onCapacityOrWaiterChanged?.(input.queueId);
    return {
      ok: true,
      waiter: mutated.result.waiter,
      preservedSequence: mutated.result.preservedSequence,
      ledger: mutated.ledger
    };
  }

  /**
   * Pause or resume a waiter while preserving its durable `sequence`.
   */
  public async setWaiterPaused(input: {
    readonly rootRunId: string;
    readonly invocationId: string;
    readonly paused: boolean;
    readonly generation?: number | undefined;
  }): Promise<QuotaWaiter | undefined> {
    const nowWallMs = this.clock.nowWallMs();
    const mutated = await this.ledgerStore.mutate<QuotaWaiter | undefined>(
      { targetRootId: input.rootRunId },
      ({ ledger }) => {
        let updatedWaiter: QuotaWaiter | undefined;
        const nextWaiters = ledger.waiters.map((w) => {
          if (
            (w.rootRunId ?? w.ledgerRunId) === input.rootRunId &&
            w.invocationId === input.invocationId &&
            (w.status === 'waiting' || w.status === 'paused')
          ) {
            const nextStatus: QuotaWaiterRecord['status'] = input.paused
              ? 'paused'
              : 'waiting';
            const nextGen = input.generation ?? w.generation ?? 1;
            const nextRec: QuotaWaiterRecord = Object.freeze({
              ...w,
              generation: nextGen,
              status: nextStatus,
              updatedAt: nowWallMs
            });
            updatedWaiter = fromWaiterRecord(nextRec);
            return nextRec;
          }
          return w;
        });

        return {
          commit: true,
          plan: {
            nextLedger: {
              ...ledger,
              waiters: nextWaiters
            },
            targetRootId: input.rootRunId,
            result: updatedWaiter
          }
        };
      }
    );

    if (mutated.ok && mutated.result !== undefined) {
      this.onCapacityOrWaiterChanged?.(mutated.result.queueId);
      return mutated.result;
    }
    return undefined;
  }

  /**
   * Build the eligible-head view ordered by ascending durable `sequence`.
   * Skips paused, untrusted, stale-fence, stale-generation, not-due, unready,
   * or queue-head-blocked waiters without deleting their place in the ledger.
   */
  public buildEligibleHeadView(options?: {
    readonly allowUnverifiedTrialByWaiterId?: Readonly<Record<string, boolean>> | undefined;
    readonly notBeforeByWaiterId?: Readonly<Record<string, number>> | undefined;
  }): EligibleHeadView {
    const nowWallMs = this.clock.nowWallMs();
    const hostEpoch = this.clock.hostEpoch ?? 'default-epoch';
    const readResult = this.ledgerStore.read();
    if (!readResult.ok) {
      return Object.freeze({
        evaluatedAtWallMs: nowWallMs,
        entries: Object.freeze([]),
        admissibleWaiters: Object.freeze([])
      });
    }
    const { ledger } = readResult;

    const activeWaiterRecords = ledger.waiters
      .filter((w) => w.status === 'waiting' || w.status === 'paused')
      .sort((a, b) => {
        const seqA = a.sequence ?? a.waitSequence;
        const seqB = b.sequence ?? b.waitSequence;
        return seqA - seqB;
      });

    // Determine which queues already have an active (non-settled) attempt or held/uncertain permit
    const activeRootByQueueId = new Map<string, string>();
    for (const root of Object.values(ledger.roots)) {
      for (const attempt of Object.values(root.attemptsById)) {
        if (attempt.stage !== 'settled') {
          activeRootByQueueId.set(attempt.queueId, root.ledgerRunId);
        }
      }
    }
    for (const permit of Object.values(ledger.permits)) {
      if (permit.status === 'active' || permit.status === 'held-uncertain') {
        activeRootByQueueId.set(
          permit.queueId,
          permit.rootRunId ?? permit.ledgerRunId
        );
      }
    }

    // Track the earliest sequence active waiter per queueId so later waiters on the same queue cannot overtake their head
    const headWaiterIdByQueueId = new Map<string, string>();
    for (const rec of activeWaiterRecords) {
      if (!headWaiterIdByQueueId.has(rec.queueId)) {
        headWaiterIdByQueueId.set(rec.queueId, rec.waiterId);
      }
    }

    const entries: EligibleHeadEntry[] = [];
    const admissibleWaiters: QuotaWaiter[] = [];

    for (const rec of activeWaiterRecords) {
      const waiter = fromWaiterRecord(rec);
      const root = lookupRecord(ledger.roots, waiter.rootRunId);

      // 1. Check root existence and active status / pause
      if (root === undefined) {
        entries.push(
          Object.freeze({
            waiter,
            admissible: false,
            skipReason: 'stale-fence',
            skipDetail: `Root '${waiter.rootRunId}' not found.`
          })
        );
        continue;
      }

      const frame = lookupRecord(
        root.framesByKey,
        waiter.frameKey ?? waiter.invocationId
      );

      if (
        waiter.paused === true ||
        root.linkState !== 'active' ||
        root.status !== 'in-flight' ||
        frame?.status === 'paused' ||
        frame?.status === 'intervention-required' ||
        frame?.status === 'monitoring-expired' ||
        frame?.status === 'completed' ||
        frame?.status === 'failed' ||
        frame?.status === 'canceled'
      ) {
        entries.push(
          Object.freeze({
            waiter,
            admissible: false,
            skipReason: 'paused',
            skipDetail: 'Waiter, frame, or root is paused or inactive.'
          })
        );
        continue;
      }

      // 2. Same-queue serial integrity check: cannot overtake queue head or active work on same queue
      const queueHeadWaiterId = headWaiterIdByQueueId.get(waiter.queueId);
      const activeRootOnQueue = activeRootByQueueId.get(waiter.queueId);
      if (
        (queueHeadWaiterId !== undefined &&
          queueHeadWaiterId !== waiter.waiterId) ||
        activeRootOnQueue !== undefined ||
        (this.isQueueHeadEligible !== undefined &&
          !this.isQueueHeadEligible(waiter.queueId, waiter.rootRunId))
      ) {
        entries.push(
          Object.freeze({
            waiter,
            admissible: false,
            skipReason: 'queue-head-blocked',
            skipDetail: `Queue '${waiter.queueId}' has an earlier active head or in-flight attempt.`
          })
        );
        continue;
      }

      // 3. Workspace trust check
      if (
        this.isWorkspaceTrusted !== undefined &&
        !this.isWorkspaceTrusted()
      ) {
        entries.push(
          Object.freeze({
            waiter,
            admissible: false,
            skipReason: 'untrusted',
            skipDetail: 'Workspace is not trusted.'
          })
        );
        continue;
      }

      // 4. Live ownership / fence check
      if (
        this.verifyLiveFence !== undefined &&
        !this.verifyLiveFence(root.fence, {
          rootRunId: waiter.rootRunId,
          queueId: waiter.queueId
        })
      ) {
        entries.push(
          Object.freeze({
            waiter,
            admissible: false,
            skipReason: 'stale-fence',
            skipDetail: 'Live ownership fence verification failed.'
          })
        );
        continue;
      }

      // 5. Generation check
      const effectiveGen =
        frame?.frameGeneration ?? root.fence.rootGeneration;
      if (waiter.generation !== effectiveGen) {
        entries.push(
          Object.freeze({
            waiter,
            admissible: false,
            skipReason: 'stale-generation',
            skipDetail: `Waiter generation (${waiter.generation}) does not match current generation (${effectiveGen}).`
          })
        );
        continue;
      }

      // 6. Remaining budgets check (root, frame, candidate)
      if (root.dispatchedAttempts >= root.rootBudget.maxPhaseAttempts) {
        entries.push(
          Object.freeze({
            waiter,
            admissible: false,
            skipReason: 'budget-exhausted',
            skipDetail: 'Root phase attempt budget exhausted.'
          })
        );
        continue;
      }
      if (
        frame?.maxDispatches !== undefined &&
        frame.dispatchedCount >= frame.maxDispatches
      ) {
        entries.push(
          Object.freeze({
            waiter,
            admissible: false,
            skipReason: 'budget-exhausted',
            skipDetail: 'Frame dispatch budget exhausted.'
          })
        );
        continue;
      }
      const candidateSlot =
        waiter.candidateId !== undefined
          ? frame?.candidateSlots?.find(
              (s) => s.candidateId === waiter.candidateId
            )
          : undefined;
      if (
        candidateSlot !== undefined &&
        (candidateSlot.dispatchedAttempts >= candidateSlot.maxAttempts ||
          candidateSlot.status === 'exhausted' ||
          candidateSlot.status === 'disabled')
      ) {
        entries.push(
          Object.freeze({
            waiter,
            admissible: false,
            skipReason: 'budget-exhausted',
            skipDetail: 'Candidate attempt budget exhausted or candidate retired.'
          })
        );
        continue;
      }

      // 7. Not-before deadlines check (candidate slot + explicit override + observations)
      const explicitNotBefore =
        options?.notBeforeByWaiterId?.[waiter.waiterId] ??
        candidateSlot?.nextEligibleAt;
      if (explicitNotBefore !== undefined && explicitNotBefore > nowWallMs) {
        entries.push(
          Object.freeze({
            waiter,
            admissible: false,
            skipReason: 'not-due',
            skipDetail: `Waiter notBefore deadline (${explicitNotBefore}) has not elapsed.`
          })
        );
        continue;
      }

      const obsIds =
        waiter.observationIds ??
        waiter.quotaIds.map((qId) =>
          qId === UNKNOWN_LOCAL_QUOTA_ID &&
          waiter.candidateOccurrenceId !== undefined
            ? `unknown/${waiter.candidateOccurrenceId}`
            : qId
        );

      const allowTrial =
        options?.allowUnverifiedTrialByWaiterId?.[waiter.waiterId] === true;

      let notDueObs = false;
      let notReadyObs = false;

      for (const obsId of obsIds) {
        const obsRec = lookupRecord(ledger.quotaObservations, obsId);
        const obs = obsRec !== undefined ? fromObservationRecord(obsRec) : undefined;
        if (obs?.notBefore !== undefined && obs.notBefore > nowWallMs) {
          notDueObs = true;
          break;
        }
        if (!isQuotaObservationFreshReady(obs, nowWallMs, hostEpoch)) {
          if (!allowTrial || obs?.status === 'top-up-required') {
            notReadyObs = true;
          }
        }
      }

      if (notDueObs) {
        entries.push(
          Object.freeze({
            waiter,
            admissible: false,
            skipReason: 'not-due',
            skipDetail: 'Quota observation notBefore floor has not elapsed.'
          })
        );
        continue;
      }

      if (notReadyObs) {
        entries.push(
          Object.freeze({
            waiter,
            admissible: false,
            skipReason: 'not-ready',
            skipDetail: 'Required quota observation is not fresh-ready.'
          })
        );
        continue;
      }

      entries.push(
        Object.freeze({
          waiter,
          admissible: true
        })
      );
      admissibleWaiters.push(waiter);
    }

    return Object.freeze({
      evaluatedAtWallMs: nowWallMs,
      entries: Object.freeze(entries),
      admissibleWaiters: Object.freeze(admissibleWaiters)
    });
  }

  /**
   * Compute current quota holdings across all active (`held` and `uncertain`) permits.
   */
  public getQuotaHoldingsSummary(
    capacitiesOverrideByQuotaId?: Readonly<Record<string, number>>
  ): Readonly<Record<string, QuotaHoldingSummary>> {
    const readResult = this.ledgerStore.read();
    if (!readResult.ok) return Object.freeze({});
    const { ledger } = readResult;
    return this.computeQuotaHoldingsFromLedger(
      ledger,
      capacitiesOverrideByQuotaId
    );
  }

  private computeQuotaHoldingsFromLedger(
    ledger: ControlLedger,
    capacitiesOverrideByQuotaId?: Readonly<Record<string, number>>
  ): Readonly<Record<string, QuotaHoldingSummary>> {
    const allQuotaIds = new Set<string>();
    for (const obs of Object.values(ledger.quotaObservations)) {
      allQuotaIds.add(obs.quotaId ?? obs.quotaKey);
    }
    for (const waiter of ledger.waiters) {
      for (const qId of waiter.quotaIds ?? waiter.quotaKeys) {
        allQuotaIds.add(qId);
      }
    }
    for (const permit of Object.values(ledger.permits)) {
      for (const qId of permit.quotaIds ?? permit.quotaKeys) {
        allQuotaIds.add(qId);
      }
    }
    if (capacitiesOverrideByQuotaId !== undefined) {
      for (const qId of Object.keys(capacitiesOverrideByQuotaId)) {
        allQuotaIds.add(qId);
      }
    }

    const summary: Record<string, QuotaHoldingSummary> = {};
    for (const quotaId of allQuotaIds) {
      let heldCount = 0;
      let uncertainCount = 0;
      const activePermitIds: string[] = [];

      for (const permit of Object.values(ledger.permits)) {
        if (permit.status === 'released' || permit.state === 'released') {
          continue;
        }
        const pQuotas = permit.quotaIds ?? permit.quotaKeys;
        if (pQuotas.includes(quotaId)) {
          activePermitIds.push(permit.permitId);
          if (
            permit.state === 'uncertain' ||
            permit.status === 'held-uncertain'
          ) {
            uncertainCount += 1;
          } else {
            heldCount += 1;
          }
        }
      }

      const obsRec = lookupRecord(ledger.quotaObservations, quotaId);
      const rawCap =
        capacitiesOverrideByQuotaId?.[quotaId] ??
        (this.resolveQuotaCapacity !== undefined
          ? this.resolveQuotaCapacity(quotaId, obsRec)
          : obsRec?.capacity);
      const capacity = clampCapacity(quotaId, rawCap);

      summary[quotaId] = Object.freeze({
        quotaId,
        heldCount,
        uncertainCount,
        totalActiveCount: heldCount + uncertainCount,
        capacity,
        activePermitIds: Object.freeze(activePermitIds)
      });
    }
    return Object.freeze(summary);
  }

  /**
   * Prepare an all-or-none `PermitGrantProposal` without mutating the ledger.
   *
   * Evaluates all currently admissible heads in ascending `sequence` order:
   * - An older admissible waiter whose full sorted quota set is available reserves
   *   its quotas first.
   * - An older waiter that is paused, untrusted, not due, not ready, or whose own
   *   multi-quota set cannot be satisfied in full holds NO partial reservation and
   *   never blocks a later admissible waiter whose required quotas are free.
   */
  public preparePermitGrant(
    input: PreparePermitGrantInput
  ): PreparePermitGrantOutcome {
    if (this.hasProcessCapacity !== undefined && !this.hasProcessCapacity()) {
      return {
        ok: false,
        reason: 'process-capacity-exhausted',
        message: 'Host process capacity is currently full.'
      };
    }

    const readResult = this.ledgerStore.read();
    if (!readResult.ok) {
      return {
        ok: false,
        reason: 'ledger-error',
        message: readResult.message
      };
    }
    const { ledger } = readResult;

    // Refuse duplicate active permit for the same attemptId
    for (const existingPermit of Object.values(ledger.permits)) {
      if (
        existingPermit.attemptId === input.attemptId &&
        existingPermit.status !== 'released' &&
        existingPermit.state !== 'released'
      ) {
        return {
          ok: false,
          reason: 'duplicate-attempt-permit',
          message: `Attempt '${input.attemptId}' already holds active permit '${existingPermit.permitId}'.`
        };
      }
    }

    const view = this.buildEligibleHeadView({
      allowUnverifiedTrialByWaiterId: input.allowUnverifiedTrialByWaiterId,
      notBeforeByWaiterId: input.notBeforeByWaiterId
    });

    const targetEntry =
      input.waiterId !== undefined
        ? view.entries.find((e) => e.waiter.waiterId === input.waiterId)
        : input.rootRunId !== undefined && input.invocationId !== undefined
          ? view.entries.find(
              (e) =>
                e.waiter.rootRunId === input.rootRunId &&
                e.waiter.invocationId === input.invocationId
            )
          : view.entries.find((e) => e.admissible);

    if (targetEntry === undefined) {
      return {
        ok: false,
        reason: 'waiter-not-found',
        message: 'No matching quota waiter found in ledger.'
      };
    }

    if (!targetEntry.admissible) {
      return {
        ok: false,
        reason: 'waiter-inadmissible',
        skipReason: targetEntry.skipReason,
        message:
          targetEntry.skipDetail ??
          `Waiter '${targetEntry.waiter.waiterId}' is not currently admissible.`
      };
    }

    const holdings = this.computeQuotaHoldingsFromLedger(
      ledger,
      input.capacitiesOverrideByQuotaId
    );
    const simulatedHeldCount = new Map<string, number>();
    const capacityByQuota = new Map<string, number>();

    for (const [qId, info] of Object.entries(holdings)) {
      simulatedHeldCount.set(qId, info.totalActiveCount);
      capacityByQuota.set(qId, info.capacity);
    }

    const getCapacity = (qId: string): number => {
      const existing = capacityByQuota.get(qId);
      if (existing !== undefined) return existing;
      const obsRec = lookupRecord(ledger.quotaObservations, qId);
      const cap = clampCapacity(
        qId,
        input.capacitiesOverrideByQuotaId?.[qId] ?? obsRec?.capacity
      );
      capacityByQuota.set(qId, cap);
      return cap;
    };

    const getHeld = (qId: string): number => simulatedHeldCount.get(qId) ?? 0;

    let preemptedByWaiterId: string | undefined;

    for (const candidateWaiter of view.admissibleWaiters) {
      const sortedQuotas = sortQuotaIds(candidateWaiter.quotaIds);
      const canAcquireAll = sortedQuotas.every(
        (qId) => getHeld(qId) < getCapacity(qId)
      );

      if (candidateWaiter.waiterId === targetEntry.waiter.waiterId) {
        if (!canAcquireAll) {
          return {
            ok: false,
            reason:
              preemptedByWaiterId !== undefined
                ? 'preempted-by-older-waiter'
                : 'quota-capacity-exhausted',
            message:
              preemptedByWaiterId !== undefined
                ? `Quota capacity claimed by older admissible waiter '${preemptedByWaiterId}'.`
                : `Required quota set [${sortedQuotas.join(', ')}] does not have all-or-none capacity available.`
          };
        }

        const root = lookupRecord(ledger.roots, candidateWaiter.rootRunId);
        if (root === undefined) {
          return {
            ok: false,
            reason: 'ledger-error',
            message: `Root '${candidateWaiter.rootRunId}' missing.`
          };
        }

        const fence = input.executionFence ?? root.fence;
        if (!executionFencesEqual(root.fence, fence)) {
          return {
            ok: false,
            reason: 'waiter-inadmissible',
            skipReason: 'stale-fence',
            message: 'Execution fence does not match root fence.'
          };
        }

        const nowWallMs = this.clock.nowWallMs();
        const permitCandidate: QuotaPermit = {
          permitId: `permit:${input.attemptId}`,
          attemptId: input.attemptId,
          rootRunId: candidateWaiter.rootRunId,
          queueId: candidateWaiter.queueId,
          quotaIds: sortedQuotas,
          executionFence: fence,
          grantedAt: nowWallMs,
          state: 'held'
        };
        const validatedPermit = validateQuotaPermit(permitCandidate);
        if (!validatedPermit.ok) {
          return {
            ok: false,
            reason: 'ledger-error',
            message: validatedPermit.message
          };
        }

        const capacitiesRecord: Record<string, number> = {};
        for (const qId of sortedQuotas) {
          capacitiesRecord[qId] = getCapacity(qId);
        }

        const obsIds =
          candidateWaiter.observationIds ??
          sortedQuotas.map((qId) =>
            qId === UNKNOWN_LOCAL_QUOTA_ID &&
            candidateWaiter.candidateOccurrenceId !== undefined
              ? `unknown/${candidateWaiter.candidateOccurrenceId}`
              : qId
          );

        const allowTrial =
          input.allowUnverifiedTrialByWaiterId?.[candidateWaiter.waiterId] ===
          true;

        return {
          ok: true,
          proposal: Object.freeze({
            waiter: candidateWaiter,
            permit: validatedPermit.value,
            sortedQuotaIds: sortedQuotas,
            observationIds: Object.freeze(obsIds),
            requireFreshReady: !allowTrial,
            hostEpoch: this.clock.hostEpoch ?? 'default-epoch',
            capacitiesByQuotaId: Object.freeze(capacitiesRecord),
            expectedLedgerRevision: ledger.revision
          })
        };
      }

      // Older admissible waiter: if its full quota set is available, it reserves all of them;
      // otherwise it reserves NONE (all-or-none, no hold-and-wait!).
      if (canAcquireAll) {
        const sharesQuotaWithTarget = sortedQuotas.some((qId) =>
          targetEntry.waiter.quotaIds.includes(qId)
        );
        if (sharesQuotaWithTarget && preemptedByWaiterId === undefined) {
          preemptedByWaiterId = candidateWaiter.waiterId;
        }
        for (const qId of sortedQuotas) {
          simulatedHeldCount.set(qId, getHeld(qId) + 1);
        }
      }
    }

    return {
      ok: false,
      reason: 'waiter-not-found',
      message: 'Target waiter was not reached in admissible evaluation.'
    };
  }

  /**
   * Release or transition a permit to `uncertain` after fenced teardown/settlement.
   * - Matches release to the immutable `attemptId` and current ownership claims
   *   (`primacyClaim` and `queueClaim`).
   * - Allows current-owner teardown after pause/cancel generation advances while
   *   rejecting releases from a lost primacy/queue claim or for another attempt.
   */
  public async releasePermit(
    input: ReleasePermitInput
  ): Promise<ReleasePermitOutcome> {
    if (!isValidExecutionFence(input.fence)) {
      return {
        ok: false,
        reason: 'stale-execution-fence',
        message: 'Invalid execution fence on releasePermit.'
      };
    }

    const nowWallMs = this.clock.nowWallMs();
    const mutated = await this.ledgerStore.mutate<{
      readonly alreadyReleased: boolean;
      readonly state: 'released' | 'uncertain';
      readonly queueId: string;
    }>(
      {
        targetRootId: input.rootRunId,
        allowSettlementReserve: true
      },
      ({ ledger }) => {
        const root = lookupRecord(ledger.roots, input.rootRunId);
        if (root === undefined) {
          return {
            commit: false,
            code: 'control-root-not-found',
            message: `Control root '${input.rootRunId}' not found.`
          };
        }

        // Verify current ownership claims (primacyClaim + queueClaim).
        // Note: rootGeneration may have incremented on pause/cancel while the same
        // owner finishes tearing down the active child process (F29-T06).
        if (
          root.fence.primacyClaim !== input.fence.primacyClaim ||
          root.fence.queueClaim !== input.fence.queueClaim ||
          (this.verifyLiveFence !== undefined &&
            !this.verifyLiveFence(root.fence, {
              rootRunId: input.rootRunId,
              queueId: root.queueId
            }))
        ) {
          return {
            commit: false,
            code: 'stale-execution-fence',
            message: 'Cannot release permit under stale primacy or queue ownership claim.'
          };
        }

        const permitId = input.permitId ?? `permit:${input.attemptId}`;
        const existingPermit = lookupRecord(ledger.permits, permitId);
        if (existingPermit === undefined) {
          return {
            commit: false,
            code: 'attempt-not-found',
            message: `Permit '${permitId}' not found.`
          };
        }

        if (
          existingPermit.attemptId !== input.attemptId ||
          (existingPermit.rootRunId ?? existingPermit.ledgerRunId) !==
            input.rootRunId
        ) {
          return {
            commit: false,
            code: 'invalid-attempt-stage',
            message: `Permit '${permitId}' belongs to attempt '${existingPermit.attemptId}', not '${input.attemptId}'.`
          };
        }

        if (
          existingPermit.status === 'released' ||
          existingPermit.state === 'released'
        ) {
          return {
            commit: true,
            plan: {
              nextLedger: ledger,
              targetRootId: input.rootRunId,
              allowSettlementReserve: true,
              result: {
                alreadyReleased: true,
                state: 'released',
                queueId: existingPermit.queueId
              }
            }
          };
        }

        const nextState: 'released' | 'uncertain' = input.holdUncertain
          ? 'uncertain'
          : 'released';
        const nextStatus: ExecutionPermitRecord['status'] = input.holdUncertain
          ? 'held-uncertain'
          : 'released';

        const updatedPermit: ExecutionPermitRecord = Object.freeze({
          ...existingPermit,
          status: nextStatus,
          state: nextState,
          ...(input.holdUncertain
            ? {
                uncertainReason:
                  input.uncertainReason ?? 'recovery-uncertain-effect'
              }
            : { releasedAt: nowWallMs })
        });

        return {
          commit: true,
          plan: {
            nextLedger: {
              ...ledger,
              permits: {
                ...ledger.permits,
                [permitId]: updatedPermit
              }
            },
            targetRootId: input.rootRunId,
            allowSettlementReserve: true,
            result: {
              alreadyReleased: false,
              state: nextState,
              queueId: existingPermit.queueId
            }
          }
        };
      }
    );

    if (!mutated.ok) {
      if (mutated.code === 'stale-execution-fence') {
        return {
          ok: false,
          reason: 'stale-execution-fence',
          message: mutated.message
        };
      }
      if (mutated.code === 'invalid-attempt-stage') {
        return {
          ok: false,
          reason: 'attempt-mismatch',
          message: mutated.message
        };
      }
      if (mutated.code === 'attempt-not-found') {
        return {
          ok: false,
          reason: 'permit-not-found',
          message: mutated.message
        };
      }
      return {
        ok: false,
        reason: 'ledger-error',
        message: mutated.message
      };
    }

    if (mutated.result.state === 'released' && !mutated.result.alreadyReleased) {
      this.onCapacityOrWaiterChanged?.(mutated.result.queueId);
    }

    return {
      ok: true,
      alreadyReleased: mutated.result.alreadyReleased,
      state: mutated.result.state,
      ledger: mutated.ledger
    };
  }
}
