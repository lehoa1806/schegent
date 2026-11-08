/**
 * FR-R5-F30 (SPEC-08, D6; WF-04, WF-05, WF-11, WF-12, WF-14, WF-15; AC-08..10, AC-25, AC-35) —
 * Root control usage accounting, strict-USD admission, and shared-check sponsorship.
 *
 * Responsibilities:
 * - Validate closed `UsageRecord` shapes (`attemptId` XOR `checkId`).
 * - Maintain cumulative root usage rollups (`verifiedMicrousd`, `estimatedMicrousd`,
 *   `unpricedAttemptCount`, `reservedMicrousd`, `uncertainReservationCount`,
 *   `sharedCheckMicrousd`, `tokensByBackend`) across candidate switches, Repeat
 *   passes, ForEach items, and host restarts.
 * - Derive the frozen root budget (`strict-usd` minimum `limitMicrousd` across
 *   reachable blocks or `count-only`) and allow live host caps to tighten only.
 * - Enforce `strict-usd` pre-dispatch admission (`spend-unverifiable`,
 *   `spend-limit-reached`) and post-settlement reconciliation (`spend-bound-exceeded`),
 *   retaining reservations on `uncertain` attempts and never coercing unpriced or
 *   token-only usage to `0` verified USD.
 * - Sponsor deduplicated availability checks once on the lowest-sequence eligible
 *   subscribed root and mark other subscribers `sharedObservation: true`.
 *
 * Zero `vscode` imports.
 */

import type { BackendRunnerKind } from '../../contracts/backend-kinds';
import {
  type ControlBackendTokenUsage,
  type ControlClockPort,
  type ControlLedger,
  type ControlRootUsageRollup,
  type ControlSettledCheckSummaryRecord,
  type ControlUsageRecord,
  type ExecutionFence,
  type RootControlState
} from '../../contracts/control-ledger';
import {
  DEFAULT_ROOT_MAX_PHASE_ATTEMPTS,
  WORKFLOW_CONTROL_SCHEMA_VERSION,
  type ControlBudgetMode,
  type RootControlBudget
} from '../../contracts/workflow-controls';
import { ControlLedgerStore, lookupRecord } from './control-ledger-store';

export type UsageRecordValidationResult =
  | { readonly ok: true; readonly value: ControlUsageRecord }
  | { readonly ok: false; readonly code: 'invalid-usage-record'; readonly message: string };

const ALLOWED_USAGE_RECORD_KEYS = new Set<string>([
  'attemptId',
  'checkId',
  'backend',
  'modelId',
  'denomination',
  'quality',
  'inputTokens',
  'outputTokens',
  'cachedTokens',
  'costMicrousd',
  'upperBoundMicrousd',
  'sharedObservation'
]);

const VALID_BACKENDS = new Set<string>(['claude', 'codex', 'agy']);
const VALID_DENOMINATIONS = new Set<string>(['usd', 'tokens']);
const VALID_QUALITIES = new Set<string>(['verified', 'estimated', 'unavailable']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function createEmptyRootUsageRollup(): ControlRootUsageRollup {
  return Object.freeze({
    verifiedMicrousd: 0,
    estimatedMicrousd: 0,
    unpricedAttemptCount: 0,
    reservedMicrousd: 0,
    uncertainReservationCount: 0,
    sharedCheckMicrousd: 0,
    tokensByBackend: Object.freeze({}),
    usageRecordsByRef: Object.freeze({})
  });
}

/**
 * Validate the closed `D6` `UsageRecord` shape (`attemptId` XOR `checkId`).
 */
export function validateUsageRecord(raw: unknown): UsageRecordValidationResult {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      code: 'invalid-usage-record',
      message: 'UsageRecord must be a plain object.'
    };
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_USAGE_RECORD_KEYS.has(key)) {
      return {
        ok: false,
        code: 'invalid-usage-record',
        message: `Unknown field '${key}' in UsageRecord.`
      };
    }
  }

  const hasAttemptId =
    typeof raw.attemptId === 'string' && raw.attemptId.trim().length > 0;
  const hasCheckId =
    typeof raw.checkId === 'string' && raw.checkId.trim().length > 0;

  if (
    (raw.attemptId !== undefined && !hasAttemptId) ||
    (raw.checkId !== undefined && !hasCheckId) ||
    hasAttemptId === hasCheckId
  ) {
    return {
      ok: false,
      code: 'invalid-usage-record',
      message:
        'UsageRecord must carry exactly one non-empty attemptId or checkId (attemptId XOR checkId).'
    };
  }

  if (typeof raw.backend !== 'string' || !VALID_BACKENDS.has(raw.backend)) {
    return {
      ok: false,
      code: 'invalid-usage-record',
      message: `UsageRecord.backend must be one of claude, codex, or agy.`
    };
  }

  if (
    raw.modelId !== undefined &&
    (typeof raw.modelId !== 'string' || raw.modelId.trim().length === 0)
  ) {
    return {
      ok: false,
      code: 'invalid-usage-record',
      message: 'UsageRecord.modelId must be a non-empty string when provided.'
    };
  }

  if (
    typeof raw.denomination !== 'string' ||
    !VALID_DENOMINATIONS.has(raw.denomination)
  ) {
    return {
      ok: false,
      code: 'invalid-usage-record',
      message: `UsageRecord.denomination must be 'usd' or 'tokens'.`
    };
  }

  if (typeof raw.quality !== 'string' || !VALID_QUALITIES.has(raw.quality)) {
    return {
      ok: false,
      code: 'invalid-usage-record',
      message: `UsageRecord.quality must be 'verified', 'estimated', or 'unavailable'.`
    };
  }

  for (const field of [
    'inputTokens',
    'outputTokens',
    'cachedTokens',
    'costMicrousd',
    'upperBoundMicrousd'
  ] as const) {
    const val = raw[field];
    if (val !== undefined && !isNonNegativeSafeInt(val)) {
      return {
        ok: false,
        code: 'invalid-usage-record',
        message: `UsageRecord.${field} must be a nonnegative safe integer when provided.`
      };
    }
  }

  if (
    raw.sharedObservation !== undefined &&
    typeof raw.sharedObservation !== 'boolean'
  ) {
    return {
      ok: false,
      code: 'invalid-usage-record',
      message: 'UsageRecord.sharedObservation must be a boolean when provided.'
    };
  }

  if (raw.quality === 'unavailable' && raw.costMicrousd !== undefined) {
    return {
      ok: false,
      code: 'invalid-usage-record',
      message:
        'UsageRecord with quality "unavailable" cannot claim a verified or estimated costMicrousd.'
    };
  }

  return {
    ok: true,
    value: Object.freeze({
      ...(hasAttemptId ? { attemptId: raw.attemptId as string } : {}),
      ...(hasCheckId ? { checkId: raw.checkId as string } : {}),
      backend: raw.backend as BackendRunnerKind,
      ...(typeof raw.modelId === 'string' ? { modelId: raw.modelId } : {}),
      denomination: raw.denomination as 'usd' | 'tokens',
      quality: raw.quality as 'verified' | 'estimated' | 'unavailable',
      ...(typeof raw.inputTokens === 'number'
        ? { inputTokens: raw.inputTokens }
        : {}),
      ...(typeof raw.outputTokens === 'number'
        ? { outputTokens: raw.outputTokens }
        : {}),
      ...(typeof raw.cachedTokens === 'number'
        ? { cachedTokens: raw.cachedTokens }
        : {}),
      ...(typeof raw.costMicrousd === 'number'
        ? { costMicrousd: raw.costMicrousd }
        : {}),
      ...(typeof raw.upperBoundMicrousd === 'number'
        ? { upperBoundMicrousd: raw.upperBoundMicrousd }
        : {}),
      ...(typeof raw.sharedObservation === 'boolean'
        ? { sharedObservation: raw.sharedObservation }
        : {})
    })
  };
}

export interface ReachableControlBlockBudget {
  readonly budgetMode?: ControlBudgetMode | undefined;
  readonly maxMicrousd?: number | undefined;
  readonly limitMicrousd?: number | undefined;
}

export interface DerivedRootBudgetSpec {
  readonly rootBudget: RootControlBudget;
  readonly budgetMode: ControlBudgetMode;
  readonly frozenLimitMicrousd?: number | undefined;
  readonly effectiveLimitMicrousd?: number | undefined;
}

/**
 * Derive the frozen root budget from reachable control blocks and optional live host cap.
 * - Uses `strict-usd` with the minimum `limitMicrousd` if any reachable block declares `strict-usd`.
 * - Otherwise uses `count-only`.
 * - A live host/workspace cap can tighten `effectiveLimitMicrousd` further at admission time,
 *   and never increases the frozen cap.
 */
export function deriveFrozenRootBudget(
  reachableBlocks: readonly ReachableControlBlockBudget[],
  options?: {
    readonly maxPhaseAttempts?: number | undefined;
    readonly rootStrictUsdMicrousd?: number | undefined;
    readonly liveHostCapMicrousd?: number | undefined;
  }
): DerivedRootBudgetSpec {
  const strictLimits: number[] = [];

  if (
    options?.rootStrictUsdMicrousd !== undefined &&
    isNonNegativeSafeInt(options.rootStrictUsdMicrousd) &&
    options.rootStrictUsdMicrousd > 0
  ) {
    strictLimits.push(options.rootStrictUsdMicrousd);
  }

  for (const block of reachableBlocks) {
    const rawLimit = block.limitMicrousd ?? block.maxMicrousd;
    if (
      block.budgetMode === 'strict-usd' &&
      rawLimit !== undefined &&
      isNonNegativeSafeInt(rawLimit) &&
      rawLimit > 0
    ) {
      strictLimits.push(rawLimit);
    }
  }

  const budgetMode: ControlBudgetMode =
    strictLimits.length > 0 ? 'strict-usd' : 'count-only';
  const frozenLimitMicrousd =
    strictLimits.length > 0 ? Math.min(...strictLimits) : undefined;

  let effectiveLimitMicrousd = frozenLimitMicrousd;
  if (
    options?.liveHostCapMicrousd !== undefined &&
    isNonNegativeSafeInt(options.liveHostCapMicrousd) &&
    options.liveHostCapMicrousd > 0
  ) {
    effectiveLimitMicrousd =
      effectiveLimitMicrousd !== undefined
        ? Math.min(effectiveLimitMicrousd, options.liveHostCapMicrousd)
        : options.liveHostCapMicrousd;
  }

  const maxPhaseAttempts =
    options?.maxPhaseAttempts ?? DEFAULT_ROOT_MAX_PHASE_ATTEMPTS;

  const rootBudget: RootControlBudget = Object.freeze({
    version: WORKFLOW_CONTROL_SCHEMA_VERSION,
    maxPhaseAttempts,
    budgetMode,
    ...(frozenLimitMicrousd !== undefined
      ? { maxMicrousd: frozenLimitMicrousd }
      : {})
  });

  return Object.freeze({
    rootBudget,
    budgetMode,
    ...(frozenLimitMicrousd !== undefined ? { frozenLimitMicrousd } : {}),
    ...(effectiveLimitMicrousd !== undefined ? { effectiveLimitMicrousd } : {})
  });
}

export type StrictUsdPauseReason =
  | 'spend-unverifiable'
  | 'spend-limit-reached'
  | 'spend-bound-exceeded';

export type StrictUsdAdmissionCheckOutcome =
  | {
      readonly allowed: true;
      readonly budgetMode: ControlBudgetMode;
      readonly reservedMicrousd: number;
      readonly effectiveLimitMicrousd?: number | undefined;
    }
  | {
      readonly allowed: false;
      readonly budgetMode: ControlBudgetMode;
      readonly pauseReason: StrictUsdPauseReason;
      readonly message: string;
      readonly effectiveLimitMicrousd?: number | undefined;
    };

export interface StrictUsdAdmissionCheckInput {
  readonly rootBudget: RootControlBudget;
  readonly rollup: ControlRootUsageRollup;
  readonly upperBoundMicrousd?: number | undefined;
  readonly upperBoundQuality?: 'verified' | 'estimated' | 'unavailable' | undefined;
  readonly liveHostCapMicrousd?: number | undefined;
}

/**
 * Evaluate `D6` `strict-usd` admission before committing a Phase attempt or availability check.
 */
export function checkStrictUsdAdmission(
  input: StrictUsdAdmissionCheckInput
): StrictUsdAdmissionCheckOutcome {
  const budgetMode: ControlBudgetMode =
    input.rootBudget.budgetMode ??
    (input.rootBudget.maxMicrousd !== undefined ? 'strict-usd' : 'count-only');

  const frozenLimit = input.rootBudget.maxMicrousd;
  const liveLimit =
    input.liveHostCapMicrousd !== undefined &&
    isNonNegativeSafeInt(input.liveHostCapMicrousd) &&
    input.liveHostCapMicrousd > 0
      ? input.liveHostCapMicrousd
      : undefined;

  const effectiveLimitMicrousd =
    frozenLimit !== undefined && liveLimit !== undefined
      ? Math.min(frozenLimit, liveLimit)
      : frozenLimit ?? liveLimit;

  if (budgetMode === 'count-only' && effectiveLimitMicrousd === undefined) {
    return Object.freeze({
      allowed: true,
      budgetMode: 'count-only',
      reservedMicrousd:
        input.upperBoundMicrousd !== undefined &&
        isNonNegativeSafeInt(input.upperBoundMicrousd)
          ? input.upperBoundMicrousd
          : 0
    });
  }

  // Strict-USD enforcement
  if (budgetMode === 'strict-usd') {
    if (input.rollup.unpricedAttemptCount > 0) {
      return Object.freeze({
        allowed: false,
        budgetMode,
        pauseReason: 'spend-unverifiable',
        message:
          'Cannot admit under strict-usd: root has prior unpriced attempts (unpricedAttemptCount > 0).',
        ...(effectiveLimitMicrousd !== undefined
          ? { effectiveLimitMicrousd }
          : {})
      });
    }

    if (input.rollup.uncertainReservationCount > 0) {
      return Object.freeze({
        allowed: false,
        budgetMode,
        pauseReason: 'spend-unverifiable',
        message:
          'Cannot admit under strict-usd: root has unresolved uncertain spend reservations.',
        ...(effectiveLimitMicrousd !== undefined
          ? { effectiveLimitMicrousd }
          : {})
      });
    }

    const quality = input.upperBoundQuality ?? 'verified';
    if (
      input.upperBoundMicrousd === undefined ||
      !isNonNegativeSafeInt(input.upperBoundMicrousd) ||
      quality !== 'verified'
    ) {
      return Object.freeze({
        allowed: false,
        budgetMode,
        pauseReason: 'spend-unverifiable',
        message:
          'Cannot admit under strict-usd: next operation lacks a qualified finite USD upper bound.',
        ...(effectiveLimitMicrousd !== undefined
          ? { effectiveLimitMicrousd }
          : {})
      });
    }
  }

  const nextUpperBound =
    input.upperBoundMicrousd !== undefined &&
    isNonNegativeSafeInt(input.upperBoundMicrousd)
      ? input.upperBoundMicrousd
      : 0;

  if (
    effectiveLimitMicrousd !== undefined &&
    input.rollup.verifiedMicrousd +
      input.rollup.reservedMicrousd +
      nextUpperBound >
      effectiveLimitMicrousd
  ) {
    return Object.freeze({
      allowed: false,
      budgetMode,
      pauseReason: 'spend-limit-reached',
      message: `Projected spend (${input.rollup.verifiedMicrousd + input.rollup.reservedMicrousd + nextUpperBound} micro-USD) exceeds effective limit (${effectiveLimitMicrousd} micro-USD).`,
      effectiveLimitMicrousd
    });
  }

  return Object.freeze({
    allowed: true,
    budgetMode,
    reservedMicrousd: nextUpperBound,
    ...(effectiveLimitMicrousd !== undefined ? { effectiveLimitMicrousd } : {})
  });
}

export interface ReconcileAttemptUsageInput {
  readonly rootRunId: string;
  readonly attemptId: string;
  readonly fence: ExecutionFence;
  readonly usageRecord: ControlUsageRecord;
  readonly outcomeUncertain?: boolean | undefined;
  readonly allowCurrentOwnerTeardownAfterGenerationAdvance?: boolean | undefined;
}

export type ReconcileAttemptUsageOutcome =
  | {
      readonly ok: true;
      readonly ledger: ControlLedger;
      readonly root: RootControlState;
      readonly rollup: ControlRootUsageRollup;
      readonly spendBoundExceeded: boolean;
      readonly pauseReason?: StrictUsdPauseReason | undefined;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
    };

export interface SponsorSubscriberCandidate {
  readonly rootRunId: string;
  readonly sequence: number;
  readonly generation: number;
  readonly pausedOrExpired?: boolean | undefined;
}

export interface SelectSharedCheckSponsorInput {
  readonly checkId: string;
  readonly observationId: string;
  readonly backend: BackendRunnerKind;
  readonly modelId?: string | undefined;
  readonly upperBoundMicrousd?: number | undefined;
  readonly upperBoundQuality?: 'verified' | 'estimated' | 'unavailable' | undefined;
  readonly subscribers: readonly SponsorSubscriberCandidate[];
  readonly liveHostCapMicrousd?: number | undefined;
}

export type SelectSharedCheckSponsorOutcome =
  | {
      readonly ok: true;
      readonly sponsorRootRunId: string;
      readonly sharedSubscriberRootIds: readonly string[];
      readonly reservedMicrousd: number;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'spend-unverifiable'
        | 'spend-limit-reached'
        | 'no-eligible-subscriber';
      readonly affectedRootRunIds: readonly string[];
      readonly message: string;
    };

export interface ReconcileSharedCheckUsageInput {
  readonly checkId: string;
  readonly observationId: string;
  readonly sponsorRootRunId: string;
  readonly sharedSubscriberRootIds: readonly string[];
  readonly usageRecord: ControlUsageRecord;
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly costUncertain?: boolean | undefined;
}

export type ReconcileSharedCheckUsageOutcome =
  | {
      readonly ok: true;
      readonly ledger: ControlLedger;
      readonly sponsorRollup: ControlRootUsageRollup;
      readonly spendBoundExceeded: boolean;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
    };

export interface ControlUsageAccountingDeps {
  readonly ledgerStore: ControlLedgerStore;
  readonly clock?: ControlClockPort | undefined;
}

const DEFAULT_CLOCK: ControlClockPort = {
  nowWallMs: () => Date.now(),
  nowMonotonicMs: () => Date.now()
};

function getOrInitRollup(root: RootControlState): ControlRootUsageRollup {
  if (root.usageRollup !== undefined) {
    return root.usageRollup;
  }
  return Object.freeze({
    verifiedMicrousd: root.settledMicrousd,
    estimatedMicrousd: 0,
    unpricedAttemptCount: 0,
    reservedMicrousd: root.reservedMicrousd,
    uncertainReservationCount: root.uncertainSpendCount ?? 0,
    sharedCheckMicrousd: root.sharedCheckMicrousd ?? 0,
    tokensByBackend: Object.freeze({}),
    usageRecordsByRef: Object.freeze({})
  });
}

function addBackendTokens(
  tokensByBackend: Readonly<Record<string, ControlBackendTokenUsage>>,
  backend: BackendRunnerKind,
  record: ControlUsageRecord
): Readonly<Record<string, ControlBackendTokenUsage>> {
  const existing = lookupRecord(tokensByBackend, backend) ?? {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0
  };
  const next: ControlBackendTokenUsage = Object.freeze({
    inputTokens: existing.inputTokens + (record.inputTokens ?? 0),
    outputTokens: existing.outputTokens + (record.outputTokens ?? 0),
    cachedTokens: existing.cachedTokens + (record.cachedTokens ?? 0)
  });
  return Object.freeze({
    ...tokensByBackend,
    [backend]: next
  });
}

export class ControlUsageAccountingService {
  private readonly store: ControlLedgerStore;
  private readonly clock: ControlClockPort;

  public constructor(deps: ControlUsageAccountingDeps) {
    this.store = deps.ledgerStore;
    this.clock = deps.clock ?? DEFAULT_CLOCK;
  }

  public getRootUsageRollup(rootRunId: string): ControlRootUsageRollup | null {
    const root = this.store.getRoot(rootRunId);
    if (root === null) return null;
    return getOrInitRollup(root);
  }

  /**
   * Reconcile an attempt's reserved upper bound against its final `UsageRecord`.
   * - Never coerces `quality: 'unavailable'` or token-only usage to `0` verified USD.
   * - Retains reservation when `outcomeUncertain === true`.
   * - Detects `spend-bound-exceeded` when actual `costMicrousd > reservedMicrousd`.
   */
  public async reconcileAttemptUsage(
    input: ReconcileAttemptUsageInput
  ): Promise<ReconcileAttemptUsageOutcome> {
    const validated = validateUsageRecord(input.usageRecord);
    if (!validated.ok) {
      return {
        ok: false,
        code: validated.code,
        message: validated.message
      };
    }
    const record = validated.value;
    if (record.attemptId !== input.attemptId) {
      return {
        ok: false,
        code: 'invalid-usage-record',
        message: `UsageRecord.attemptId ('${String(record.attemptId)}') must match '${input.attemptId}'.`
      };
    }

    const nowWallMs = this.clock.nowWallMs();
    const mutated = await this.store.mutate<{
      readonly root: RootControlState;
      readonly rollup: ControlRootUsageRollup;
      readonly spendBoundExceeded: boolean;
      readonly pauseReason?: StrictUsdPauseReason | undefined;
    }>(
      {
        targetRootId: input.rootRunId,
        ...(input.allowCurrentOwnerTeardownAfterGenerationAdvance === true
          ? {}
          : { expectedFence: input.fence }),
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

        const attempt = lookupRecord(root.attemptsById, input.attemptId);
        if (attempt === undefined) {
          return {
            commit: false,
            code: 'attempt-not-found',
            message: `Attempt '${input.attemptId}' not found in root '${input.rootRunId}'.`
          };
        }

        const currentRollup = getOrInitRollup(root);
        const refKey = `attempt:${input.attemptId}`;
        if (lookupRecord(currentRollup.usageRecordsByRef, refKey) !== undefined) {
          return {
            commit: true,
            plan: {
              nextLedger: ledger,
              targetRootId: input.rootRunId,
              allowSettlementReserve: true,
              result: {
                root,
                rollup: currentRollup,
                spendBoundExceeded: root.pauseCause === 'spend-bound-exceeded',
                ...(root.pauseCause === 'spend-bound-exceeded'
                  ? { pauseReason: 'spend-bound-exceeded' as const }
                  : {})
              }
            }
          };
        }

        const reservedForAttempt =
          record.upperBoundMicrousd ?? attempt.reservedMicrousd;
        const isStrictUsd =
          root.rootBudget.budgetMode === 'strict-usd' ||
          root.rootBudget.maxMicrousd !== undefined;

        let verifiedMicrousd = currentRollup.verifiedMicrousd;
        let estimatedMicrousd = currentRollup.estimatedMicrousd;
        let unpricedAttemptCount = currentRollup.unpricedAttemptCount;
        let reservedMicrousd = currentRollup.reservedMicrousd;
        let uncertainReservationCount = currentRollup.uncertainReservationCount;
        let spendBoundExceeded = false;
        let pauseReason: StrictUsdPauseReason | undefined;

        if (input.outcomeUncertain === true) {
          // Uncertain attempt retains its reservation and increments uncertainReservationCount
          uncertainReservationCount += 1;
        } else {
          reservedMicrousd = Math.max(0, reservedMicrousd - attempt.reservedMicrousd);
          if (
            record.denomination === 'usd' &&
            record.quality === 'verified' &&
            record.costMicrousd !== undefined
          ) {
            verifiedMicrousd += record.costMicrousd;
            if (
              (reservedForAttempt > 0 || isStrictUsd) &&
              record.costMicrousd > reservedForAttempt
            ) {
              spendBoundExceeded = true;
              pauseReason = 'spend-bound-exceeded';
            }
          } else if (
            record.denomination === 'usd' &&
            record.quality === 'estimated' &&
            record.costMicrousd !== undefined
          ) {
            estimatedMicrousd += record.costMicrousd;
            unpricedAttemptCount += 1;
            if (isStrictUsd) {
              pauseReason = 'spend-unverifiable';
            }
          } else {
            // Token-only or quality: 'unavailable' -> never coerced to 0 verified USD!
            unpricedAttemptCount += 1;
            if (isStrictUsd) {
              pauseReason = 'spend-unverifiable';
            }
          }
        }

        if (
          pauseReason === undefined &&
          root.rootBudget.maxMicrousd !== undefined &&
          verifiedMicrousd + reservedMicrousd > root.rootBudget.maxMicrousd
        ) {
          pauseReason = 'spend-limit-reached';
        }

        const nextTokens = addBackendTokens(
          currentRollup.tokensByBackend,
          record.backend,
          record
        );

        const nextRollup: ControlRootUsageRollup = Object.freeze({
          verifiedMicrousd,
          estimatedMicrousd,
          unpricedAttemptCount,
          reservedMicrousd,
          uncertainReservationCount,
          sharedCheckMicrousd: currentRollup.sharedCheckMicrousd,
          tokensByBackend: nextTokens,
          usageRecordsByRef: Object.freeze({
            ...currentRollup.usageRecordsByRef,
            [refKey]: record
          })
        });

        const nextRoot: RootControlState = Object.freeze({
          ...root,
          settledMicrousd: verifiedMicrousd,
          reservedMicrousd,
          uncertainSpendCount: uncertainReservationCount,
          usageRollup: nextRollup,
          ...(pauseReason !== undefined && isStrictUsd
            ? {
                status: 'paused',
                pauseCause: pauseReason
              }
            : {}),
          updatedAt: nowWallMs
        });

        return {
          commit: true,
          plan: {
            nextLedger: {
              ...ledger,
              roots: {
                ...ledger.roots,
                [input.rootRunId]: nextRoot
              }
            },
            targetRootId: input.rootRunId,
            allowSettlementReserve: true,
            result: {
              root: nextRoot,
              rollup: nextRollup,
              spendBoundExceeded,
              ...(pauseReason !== undefined ? { pauseReason } : {})
            }
          }
        };
      }
    );

    if (!mutated.ok) {
      return {
        ok: false,
        code: mutated.code,
        message: mutated.message
      };
    }

    return {
      ok: true,
      ledger: mutated.ledger,
      root: mutated.result.root,
      rollup: mutated.result.rollup,
      spendBoundExceeded: mutated.result.spendBoundExceeded,
      ...(mutated.result.pauseReason !== undefined
        ? { pauseReason: mutated.result.pauseReason }
        : {})
    };
  }

  /**
   * Select the lowest-sequence eligible subscribed root whose budget can admit the
   * check's qualified cost bound (`0` for a qualified zero-cost check) and reserve
   * that bound once on the sponsor root.
   */
  public async selectSharedCheckSponsor(
    input: SelectSharedCheckSponsorInput
  ): Promise<SelectSharedCheckSponsorOutcome> {
    const sortedSubscribers = [...input.subscribers]
      .filter((s) => s.pausedOrExpired !== true)
      .sort(
        (a, b) =>
          a.sequence - b.sequence || a.rootRunId.localeCompare(b.rootRunId)
      );

    if (sortedSubscribers.length === 0) {
      return {
        ok: false,
        reason: 'no-eligible-subscriber',
        affectedRootRunIds: Object.freeze([]),
        message: 'No active subscriber root is eligible to sponsor the availability check.'
      };
    }

    const readResult = this.store.read();
    if (!readResult.ok) {
      return {
        ok: false,
        reason: 'no-eligible-subscriber',
        affectedRootRunIds: Object.freeze([]),
        message: readResult.message
      };
    }
    const { ledger } = readResult;

    const eligibleSubscribers: SponsorSubscriberCandidate[] = [];
    for (const sub of sortedSubscribers) {
      const root = lookupRecord(ledger.roots, sub.rootRunId);
      if (
        root === undefined ||
        root.linkState !== 'active' ||
        root.status !== 'in-flight' ||
        root.fence.rootGeneration !== sub.generation
      ) {
        continue;
      }
      eligibleSubscribers.push(sub);
    }

    if (eligibleSubscribers.length === 0) {
      return {
        ok: false,
        reason: 'no-eligible-subscriber',
        affectedRootRunIds: Object.freeze([]),
        message: 'No subscriber root matched active generation and in-flight status.'
      };
    }

    let chosenSponsorId: string | undefined;
    let chosenReservedMicrousd = 0;
    let sawUnverifiable = false;
    let sawLimitReached = false;
    const affectedRootIds: string[] = [];

    for (const sub of eligibleSubscribers) {
      const root = lookupRecord(ledger.roots, sub.rootRunId);
      if (root === undefined) continue;
      const rollup = getOrInitRollup(root);
      const checkOutcome = checkStrictUsdAdmission({
        rootBudget: root.rootBudget,
        rollup,
        upperBoundMicrousd: input.upperBoundMicrousd ?? 0,
        upperBoundQuality: input.upperBoundQuality ?? 'verified',
        ...(input.liveHostCapMicrousd !== undefined
          ? { liveHostCapMicrousd: input.liveHostCapMicrousd }
          : {})
      });
      if (checkOutcome.allowed) {
        chosenSponsorId = sub.rootRunId;
        chosenReservedMicrousd = checkOutcome.reservedMicrousd;
        break;
      }
      affectedRootIds.push(sub.rootRunId);
      if (checkOutcome.pauseReason === 'spend-unverifiable') {
        sawUnverifiable = true;
      } else {
        sawLimitReached = true;
      }
    }

    if (chosenSponsorId === undefined) {
      const reason = sawUnverifiable
        ? 'spend-unverifiable'
        : sawLimitReached
          ? 'spend-limit-reached'
          : 'no-eligible-subscriber';
      return {
        ok: false,
        reason,
        affectedRootRunIds: Object.freeze(affectedRootIds),
        message: `No subscribed root could sponsor check '${input.checkId}' (${reason}).`
      };
    }

    const sharedSubscriberRootIds = eligibleSubscribers
      .map((s) => s.rootRunId)
      .filter((id) => id !== chosenSponsorId);

    const nowWallMs = this.clock.nowWallMs();
    const mutated = await this.store.mutate<void>(
      {
        targetRootId: chosenSponsorId,
        allowSettlementReserve: true
      },
      ({ ledger: currentLedger }) => {
        const sponsorRoot = lookupRecord(currentLedger.roots, chosenSponsorId);
        if (sponsorRoot === undefined) {
          return {
            commit: false,
            code: 'control-root-not-found',
            message: `Sponsor root '${chosenSponsorId}' not found.`
          };
        }
        const rollup = getOrInitRollup(sponsorRoot);
        const nextReserved = rollup.reservedMicrousd + chosenReservedMicrousd;
        const nextRollup: ControlRootUsageRollup = Object.freeze({
          ...rollup,
          reservedMicrousd: nextReserved
        });
        const nextRoot: RootControlState = Object.freeze({
          ...sponsorRoot,
          reservedMicrousd: nextReserved,
          usageRollup: nextRollup,
          updatedAt: nowWallMs
        });
        return {
          commit: true,
          plan: {
            nextLedger: {
              ...currentLedger,
              roots: {
                ...currentLedger.roots,
                [chosenSponsorId]: nextRoot
              }
            },
            targetRootId: chosenSponsorId,
            allowSettlementReserve: true,
            result: undefined
          }
        };
      }
    );

    if (!mutated.ok) {
      return {
        ok: false,
        reason: 'no-eligible-subscriber',
        affectedRootRunIds: Object.freeze([chosenSponsorId]),
        message: mutated.message
      };
    }

    return {
      ok: true,
      sponsorRootRunId: chosenSponsorId,
      sharedSubscriberRootIds: Object.freeze(sharedSubscriberRootIds),
      reservedMicrousd: chosenReservedMicrousd
    };
  }

  /**
   * Reconcile a settled availability check's usage on its sponsor root once and
   * record `sharedObservation: true` on non-sponsor subscriber roots.
   */
  public async reconcileSharedCheckUsage(
    input: ReconcileSharedCheckUsageInput
  ): Promise<ReconcileSharedCheckUsageOutcome> {
    const validated = validateUsageRecord({
      ...input.usageRecord,
      sharedObservation: false
    });
    if (!validated.ok) {
      return {
        ok: false,
        code: validated.code,
        message: validated.message
      };
    }
    const sponsorRecord = validated.value;
    if (sponsorRecord.checkId !== input.checkId) {
      return {
        ok: false,
        code: 'invalid-usage-record',
        message: `UsageRecord.checkId ('${String(sponsorRecord.checkId)}') must match '${input.checkId}'.`
      };
    }

    const nowWallMs = this.clock.nowWallMs();
    const mutated = await this.store.mutate<{
      readonly sponsorRollup: ControlRootUsageRollup;
      readonly spendBoundExceeded: boolean;
    }>({ allowSettlementReserve: true }, ({ ledger }) => {
      const sponsorRoot = lookupRecord(ledger.roots, input.sponsorRootRunId);
      if (sponsorRoot === undefined) {
        return {
          commit: false,
          code: 'control-root-not-found',
          message: `Sponsor root '${input.sponsorRootRunId}' not found.`
        };
      }

      const roots: Record<string, RootControlState> = { ...ledger.roots };
      const sponsorRollup = getOrInitRollup(sponsorRoot);
      const refKey = `check:${input.checkId}`;
      const reservedForCheck = sponsorRecord.upperBoundMicrousd ?? 0;
      const actualCost = sponsorRecord.costMicrousd ?? 0;

      let verifiedMicrousd = sponsorRollup.verifiedMicrousd;
      let reservedMicrousd = sponsorRollup.reservedMicrousd;
      let sharedCheckMicrousd = sponsorRollup.sharedCheckMicrousd;
      let uncertainReservationCount = sponsorRollup.uncertainReservationCount;
      let spendBoundExceeded = false;

      if (input.costUncertain === true) {
        uncertainReservationCount += 1;
      } else {
        reservedMicrousd = Math.max(0, reservedMicrousd - reservedForCheck);
        verifiedMicrousd += actualCost;
        sharedCheckMicrousd += actualCost;
        if (reservedForCheck > 0 && actualCost > reservedForCheck) {
          spendBoundExceeded = true;
        }
      }

      const nextSponsorRollup: ControlRootUsageRollup = Object.freeze({
        ...sponsorRollup,
        verifiedMicrousd,
        reservedMicrousd,
        sharedCheckMicrousd,
        uncertainReservationCount,
        tokensByBackend: addBackendTokens(
          sponsorRollup.tokensByBackend,
          sponsorRecord.backend,
          sponsorRecord
        ),
        usageRecordsByRef: Object.freeze({
          ...sponsorRollup.usageRecordsByRef,
          [refKey]: sponsorRecord
        })
      });

      const sponsorSummary: ControlSettledCheckSummaryRecord = Object.freeze({
        checkId: input.checkId,
        observationId: input.observationId,
        backend: sponsorRecord.backend,
        sponsorRootRunId: input.sponsorRootRunId,
        sharedObservation: false,
        status: input.status,
        costMicrousd: actualCost,
        settledAt: nowWallMs
      });

      roots[input.sponsorRootRunId] = Object.freeze({
        ...sponsorRoot,
        settledMicrousd: verifiedMicrousd,
        reservedMicrousd,
        sharedCheckMicrousd,
        uncertainSpendCount: uncertainReservationCount,
        usageRollup: nextSponsorRollup,
        settledCheckSummaries: Object.freeze([
          ...(sponsorRoot.settledCheckSummaries ?? []),
          sponsorSummary
        ]),
        updatedAt: nowWallMs
      });

      // Mark non-sponsor subscribers with sharedObservation: true and 0 debit
      for (const subRootId of input.sharedSubscriberRootIds) {
        if (subRootId === input.sponsorRootRunId) continue;
        const subRoot = lookupRecord(roots, subRootId);
        if (subRoot === undefined) continue;
        const subRollup = getOrInitRollup(subRoot);
        const sharedRecord: ControlUsageRecord = Object.freeze({
          ...sponsorRecord,
          costMicrousd: 0,
          upperBoundMicrousd: 0,
          sharedObservation: true
        });
        const sharedSummary: ControlSettledCheckSummaryRecord = Object.freeze({
          checkId: input.checkId,
          observationId: input.observationId,
          backend: sponsorRecord.backend,
          sponsorRootRunId: input.sponsorRootRunId,
          sharedObservation: true,
          status: input.status,
          costMicrousd: 0,
          settledAt: nowWallMs
        });
        roots[subRootId] = Object.freeze({
          ...subRoot,
          usageRollup: Object.freeze({
            ...subRollup,
            usageRecordsByRef: Object.freeze({
              ...subRollup.usageRecordsByRef,
              [refKey]: sharedRecord
            })
          }),
          settledCheckSummaries: Object.freeze([
            ...(subRoot.settledCheckSummaries ?? []),
            sharedSummary
          ]),
          updatedAt: nowWallMs
        });
      }

      return {
        commit: true,
        plan: {
          nextLedger: {
            ...ledger,
            roots
          },
          targetRootId: input.sponsorRootRunId,
          allowSettlementReserve: true,
          result: {
            sponsorRollup: nextSponsorRollup,
            spendBoundExceeded
          }
        }
      };
    });

    if (!mutated.ok) {
      return {
        ok: false,
        code: mutated.code,
        message: mutated.message
      };
    }

    return {
      ok: true,
      ledger: mutated.ledger,
      sponsorRollup: mutated.result.sponsorRollup,
      spendBoundExceeded: mutated.result.spendBoundExceeded
    };
  }
}
