/**
 * FR-R5-F30 (SPEC-08, D5, D4, D6, D7; WF-01, WF-02, WF-04..06, WF-11..19; AC-01..07, AC-24..29, AC-35) —
 * Generic CandidateBlockFrame reducer and runtime orchestrator.
 *
 * Responsibilities:
 * - Mint a unique `candidateOccurrenceId` per candidate slot on block initialization.
 * - Enforce per-candidate attempt caps (`1..20`, default `3`), block dispatch cap
 *   (`1..40`, default `min(40, sum(maxAttempts))`), and root phase attempt cap
 *   (`100` leaf dispatches across the root, including ordinary sibling leaves).
 * - Evaluate `first-ready`, `wait-for-selected`, and `stop-on-unavailability`
 *   selection policies in `(priority, authoredOrder)` order without preempting
 *   `executing` or `retry-delayed` work.
 * - Retire candidates on `attempts-exhausted` or `permanent-failure`, give
 *   `intervention-required` precedence over exhaustion on invalid/uncertain final
 *   outcomes, and commit `returnCommitId` once with only the winning candidate's
 *   validated outputs and `decisionResults`.
 * - Release leaf process-capacity slots on wait/pause states while preserving root
 *   queue order and lease, and enforce the 8-hour monitoring window.
 *
 * Zero `vscode` imports.
 */

import { randomUUID } from 'node:crypto';
import {
  CLOCK_DISCONTINUITY_THRESHOLD_MS,
  DEFAULT_MONITORING_WINDOW_MS,
  type FrozenPhaseQuotaTarget
} from '../../contracts/backend-availability';
import type { BackendRunnerKind } from '../../contracts/backend-kinds';
import {
  type CandidateRuntimeSlot,
  type ControlAttemptRecord,
  type ControlClockPort,
  type ControlDecisionSummaryRecord,
  type ControlFrame,
  type ControlLedger,
  type ControlUsageRecord,
  type ExecutionFence,
  type RootControlState
} from '../../contracts/control-ledger';
import type { DecisionFieldValue } from '../../contracts/decision-results';
import {
  DEFAULT_CANDIDATE_MAX_ATTEMPTS,
  MAX_CANDIDATE_ATTEMPTS,
  MAX_CANDIDATE_BLOCK_ATTEMPTS,
  type CandidateSelectionPolicy
} from '../../contracts/workflow-controls';
import { BackendAvailabilityService } from '../backend-availability-service';
import { ControlAttemptAdmissionService } from './control-attempt-admission';
import { ControlLedgerStore, lookupRecord } from './control-ledger-store';
import {
  ControlNotificationService,
  enforceBoundedRootHistory
} from './control-notification-service';
import {
  ControlUsageAccountingService,
  checkStrictUsdAdmission
} from './control-usage-accounting';
import { QuotaPermitArbiter } from './quota-permit-arbiter';

export const MONITORING_WINDOW_DURATION_MS = DEFAULT_MONITORING_WINDOW_MS;

export function evaluateMonitoringWindow(input: {
  readonly window: {
    readonly startedAt: number;
    readonly expiresAt: number;
    readonly renewalsUsed: number;
    readonly lastWallMs: number;
    readonly lastMonotonicMs: number;
    readonly hostEpoch: string;
  };
  readonly nowWallMs: number;
  readonly nowMonotonicMs: number;
  readonly currentHostEpoch: string;
}): {
  readonly expired: boolean;
  readonly reason?: 'window-elapsed' | 'clock-anomaly' | undefined;
} {
  if (input.nowWallMs >= input.window.expiresAt) {
    return { expired: true, reason: 'window-elapsed' };
  }
  if (input.currentHostEpoch === input.window.hostEpoch) {
    const wallDelta = input.nowWallMs - input.window.lastWallMs;
    const monoDelta = input.nowMonotonicMs - input.window.lastMonotonicMs;
    if (
      wallDelta < -CLOCK_DISCONTINUITY_THRESHOLD_MS ||
      Math.abs(wallDelta - monoDelta) > CLOCK_DISCONTINUITY_THRESHOLD_MS * 12
    ) {
      if (
        input.window.startedAt +
          Math.max(0, monoDelta) >=
        input.window.expiresAt
      ) {
        return { expired: true, reason: 'clock-anomaly' };
      }
    }
  }
  return { expired: false };
}

export interface CandidateMemberSpec {
  readonly candidateId: string;
  readonly nodeId: string;
  readonly backend: BackendRunnerKind;
  readonly modelId?: string | undefined;
  readonly priority: number;
  readonly authoredOrder: number;
  readonly maxAttempts?: number | undefined;
  readonly quotaTarget?: FrozenPhaseQuotaTarget | undefined;
  readonly quotaIds?: readonly string[] | undefined;
  readonly allowUnverifiedTrial?: boolean | undefined;
  readonly hasSideEffects?: boolean | undefined;
  readonly upperBoundMicrousd?: number | undefined;
  readonly upperBoundQuality?: 'verified' | 'estimated' | 'unavailable' | undefined;
}

export interface InitializeCandidateBlockInput {
  readonly rootRunId: string;
  readonly workflowId: string;
  readonly frameKey: string;
  readonly parentFrameKey?: string | null | undefined;
  readonly invocationId: string;
  readonly nodeId: string;
  readonly selectionPolicy?: CandidateSelectionPolicy | undefined;
  readonly maxBlockAttempts?: number | undefined;
  readonly candidates: readonly CandidateMemberSpec[];
  readonly fence: ExecutionFence;
  readonly hostEpoch?: string | undefined;
}

export type CandidateReducerAction =
  | {
      readonly kind: 'noop-active';
      readonly status: 'executing' | 'retry-delayed' | 'completed';
      readonly activeCandidateId?: string | undefined;
      readonly activeAttemptId?: string | undefined;
    }
  | {
      readonly kind: 'dispatch-candidate';
      readonly candidate: CandidateRuntimeSlot;
      readonly attemptOrdinal: number;
      readonly switchedFromCandidateId?: string | undefined;
    }
  | {
      readonly kind: 'wait-backoff';
      readonly candidate: CandidateRuntimeSlot;
      readonly nextEligibleAt: number;
    }
  | {
      readonly kind: 'wait-availability';
      readonly candidateIds: readonly string[];
      readonly nextCheckAt?: number | undefined;
      readonly monitoringExpiresAt: number;
    }
  | {
      readonly kind: 'pause-intervention';
      readonly pauseCause: string;
      readonly candidateId?: string | undefined;
    }
  | {
      readonly kind: 'pause-monitoring-expired';
      readonly pauseCause: 'monitoring-window-expired' | 'clock-trust-lost';
    }
  | {
      readonly kind: 'fail-exhausted';
      readonly failureCode:
        | 'all-candidates-exhausted'
        | 'block-attempt-cap-exhausted'
        | 'root-attempt-cap-exhausted';
    };

export interface SettleCandidateAttemptInput {
  readonly rootRunId: string;
  readonly frameKey: string;
  readonly attemptId: string;
  readonly candidateId: string;
  readonly fence: ExecutionFence;
  readonly outcome:
    | 'succeeded'
    | 'retryable-transient'
    | 'retryable-availability'
    | 'permanent-failure'
    | 'invalid-output'
    | 'uncertain-effect'
    | 'canceled';
  readonly failureCode?: string | undefined;
  readonly failureMessage?: string | undefined;
  readonly retryDelayMs?: number | undefined;
  readonly resetsAtMs?: number | null | undefined;
  readonly topUpRequired?: boolean | undefined;
  readonly validatedOutputs?: Readonly<Record<string, string>> | undefined;
  readonly decisionResults?: Readonly<Record<string, DecisionFieldValue>> | undefined;
  readonly usageRecord?: ControlUsageRecord | undefined;
  readonly quotaTarget?: FrozenPhaseQuotaTarget | undefined;
}

export interface SettleCandidateAttemptResult {
  readonly ok: boolean;
  readonly frame?: ControlFrame | undefined;
  readonly root?: RootControlState | undefined;
  readonly returnCommitted: boolean;
  readonly returnCommitId?: string | undefined;
  readonly message?: string | undefined;
}

export interface StepCandidateBlockInput {
  readonly rootRunId: string;
  readonly frameKey: string;
  readonly fence: ExecutionFence;
  readonly candidateSpecsById?: Readonly<Record<string, CandidateMemberSpec>> | undefined;
  readonly hostEpoch?: string | undefined;
  readonly liveHostCapMicrousd?: number | undefined;
}

export interface StepCandidateBlockResult {
  readonly ok: boolean;
  readonly action: CandidateReducerAction;
  readonly frame?: ControlFrame | undefined;
  readonly root?: RootControlState | undefined;
  readonly attempt?: ControlAttemptRecord | undefined;
  readonly message?: string | undefined;
}

export interface CandidateBlockExecutorDeps {
  readonly ledgerStore: ControlLedgerStore;
  readonly admissionService: ControlAttemptAdmissionService;
  readonly availabilityService?: BackendAvailabilityService | undefined;
  readonly permitArbiter?: QuotaPermitArbiter | undefined;
  readonly usageAccounting?: ControlUsageAccountingService | undefined;
  readonly notificationService?: ControlNotificationService | undefined;
  readonly clock?: (ControlClockPort & { readonly hostEpoch?: string | undefined }) | undefined;
  readonly onReleaseProcessCapacitySlot?: (
    queueId: string,
    rootRunId: string,
    invocationId: string
  ) => void;
}

const DEFAULT_CLOCK: ControlClockPort & { readonly hostEpoch: string } = {
  nowWallMs: () => Date.now(),
  nowMonotonicMs: () => Date.now(),
  hostEpoch: 'default-epoch'
};

function clampCandidateMaxAttempts(raw: number | undefined): number {
  const val = raw ?? DEFAULT_CANDIDATE_MAX_ATTEMPTS;
  return Math.max(1, Math.min(MAX_CANDIDATE_ATTEMPTS, Math.trunc(val)));
}

function clampBlockMaxAttempts(
  raw: number | undefined,
  candidates: readonly { readonly maxAttempts: number }[]
): number {
  const sum = candidates.reduce((acc, c) => acc + c.maxAttempts, 0);
  const def = Math.min(MAX_CANDIDATE_BLOCK_ATTEMPTS, Math.max(1, sum));
  if (raw === undefined) return def;
  return Math.max(1, Math.min(MAX_CANDIDATE_BLOCK_ATTEMPTS, Math.trunc(raw)));
}

function sortCandidateSlots(
  slots: readonly CandidateRuntimeSlot[]
): readonly CandidateRuntimeSlot[] {
  return [...slots].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const orderA = a.authoredOrder ?? 0;
    const orderB = b.authoredOrder ?? 0;
    if (orderA !== orderB) return orderA - orderB;
    return a.candidateId.localeCompare(b.candidateId);
  });
}

function isCandidateRetired(slot: CandidateRuntimeSlot): boolean {
  return (
    slot.status === 'exhausted' ||
    slot.status === 'failed' ||
    slot.status === 'disabled' ||
    slot.dispatchedAttempts >= slot.maxAttempts
  );
}

/**
 * Pure deterministic reducer computing the next `CandidateReducerAction` for a
 * `CandidateBlockFrame`.
 */
export function selectNextCandidateAction(input: {
  readonly root: RootControlState;
  readonly frame: ControlFrame;
  readonly nowWallMs: number;
  readonly nowMonotonicMs: number;
  readonly hostEpoch: string;
  readonly isSlotReady: (slot: CandidateRuntimeSlot) => {
    readonly ready: boolean;
    readonly topUpRequired: boolean;
    readonly nextCheckAt?: number | undefined;
  };
}): CandidateReducerAction {
  const { root, frame, nowWallMs, nowMonotonicMs, hostEpoch } = input;

  if (frame.status === 'completed' || frame.returnCommitId !== undefined) {
    return {
      kind: 'noop-active',
      status: 'completed',
      activeCandidateId: frame.winningCandidateId,
      activeAttemptId: frame.winningAttemptId
    };
  }

  // Non-preemption: never preempt an executing candidate or active local retry backoff
  if (frame.status === 'executing' && frame.activeAttemptId !== undefined) {
    return {
      kind: 'noop-active',
      status: 'executing',
      activeCandidateId: frame.selectedCandidateId,
      activeAttemptId: frame.activeAttemptId
    };
  }

  const orderedSlots = sortCandidateSlots(frame.candidateSlots ?? []);
  const inFlightSlot = orderedSlots.find((s) => s.status === 'in-flight');
  if (inFlightSlot !== undefined) {
    return {
      kind: 'noop-active',
      status: 'executing',
      activeCandidateId: inFlightSlot.candidateId,
      activeAttemptId: frame.activeAttemptId ?? inFlightSlot.lastAttemptId
    };
  }

  const backoffSlot = orderedSlots.find(
    (s) =>
      s.status === 'waiting-backoff' &&
      s.nextEligibleAt !== undefined &&
      s.nextEligibleAt > nowWallMs
  );
  if (backoffSlot !== undefined && backoffSlot.nextEligibleAt !== undefined) {
    return {
      kind: 'wait-backoff',
      candidate: backoffSlot,
      nextEligibleAt: backoffSlot.nextEligibleAt
    };
  }

  // Root and block cap checks
  if (root.dispatchedAttempts >= root.rootBudget.maxPhaseAttempts) {
    return {
      kind: 'fail-exhausted',
      failureCode: 'root-attempt-cap-exhausted'
    };
  }
  if (
    frame.maxDispatches !== undefined &&
    frame.dispatchedCount >= frame.maxDispatches
  ) {
    return {
      kind: 'fail-exhausted',
      failureCode: 'block-attempt-cap-exhausted'
    };
  }

  const allowedSet =
    frame.allowedCandidateIds !== undefined
      ? new Set(frame.allowedCandidateIds)
      : undefined;
  const nonRetired = orderedSlots.filter(
    (s) =>
      !isCandidateRetired(s) &&
      (allowedSet === undefined || allowedSet.has(s.candidateId))
  );
  if (nonRetired.length === 0) {
    return {
      kind: 'fail-exhausted',
      failureCode: 'all-candidates-exhausted'
    };
  }

  // Check monitoring window if frame is already in waiting-availability
  if (
    frame.monitoringStartedAt !== undefined &&
    frame.monitoringExpiresAt !== undefined
  ) {
    const monCheck = evaluateMonitoringWindow({
      window: {
        startedAt: frame.monitoringStartedAt,
        expiresAt: frame.monitoringExpiresAt,
        renewalsUsed: frame.monitoringRenewals ?? 0,
        lastWallMs: frame.lastClockWallMs ?? frame.monitoringStartedAt,
        lastMonotonicMs: frame.lastClockMonotonicMs ?? 0,
        hostEpoch: frame.lastClockHostEpoch ?? hostEpoch
      },
      nowWallMs,
      nowMonotonicMs,
      currentHostEpoch: hostEpoch
    });
    if (monCheck.expired) {
      return {
        kind: 'pause-monitoring-expired',
        pauseCause:
          monCheck.reason === 'clock-anomaly'
            ? 'clock-trust-lost'
            : 'monitoring-window-expired'
      };
    }
  }

  // D8 one-admission manualSelectionCandidateId override:
  // Next admission considers only that eligible candidate, waiting for its
  // readiness and deadlines instead of silently picking another under first-ready.
  if (frame.manualSelectionCandidateId !== undefined) {
    const manualTarget = nonRetired.find(
      (s) => s.candidateId === frame.manualSelectionCandidateId
    );
    if (manualTarget !== undefined) {
      if (
        manualTarget.nextEligibleAt !== undefined &&
        manualTarget.nextEligibleAt > nowWallMs
      ) {
        return {
          kind: 'wait-backoff',
          candidate: manualTarget,
          nextEligibleAt: manualTarget.nextEligibleAt
        };
      }
      const readiness = input.isSlotReady(manualTarget);
      if (readiness.topUpRequired) {
        return {
          kind: 'pause-intervention',
          pauseCause: 'credit-top-up-required',
          candidateId: manualTarget.candidateId
        };
      }
      if (readiness.ready) {
        const prevSelected = frame.selectedCandidateId;
        return {
          kind: 'dispatch-candidate',
          candidate: manualTarget,
          attemptOrdinal: manualTarget.dispatchedAttempts + 1,
          ...(prevSelected !== undefined &&
          prevSelected !== manualTarget.candidateId
            ? { switchedFromCandidateId: prevSelected }
            : {})
        };
      }
      return {
        kind: 'wait-availability',
        candidateIds: Object.freeze([manualTarget.candidateId]),
        ...(readiness.nextCheckAt !== undefined
          ? { nextCheckAt: readiness.nextCheckAt }
          : {}),
        monitoringExpiresAt:
          frame.monitoringExpiresAt ?? nowWallMs + MONITORING_WINDOW_DURATION_MS
      };
    }
  }

  const policy: CandidateSelectionPolicy =
    frame.selectionPolicy ?? 'first-ready';

  if (policy === 'wait-for-selected') {
    const target =
      (frame.selectedCandidateId !== undefined
        ? nonRetired.find((s) => s.candidateId === frame.selectedCandidateId)
        : undefined) ?? nonRetired.at(0);
    if (target === undefined) {
      return {
        kind: 'fail-exhausted',
        failureCode: 'all-candidates-exhausted'
      };
    }
    const readiness = input.isSlotReady(target);
    if (readiness.topUpRequired) {
      return {
        kind: 'pause-intervention',
        pauseCause: 'credit-top-up-required',
        candidateId: target.candidateId
      };
    }
    if (
      readiness.ready &&
      (target.nextEligibleAt === undefined || target.nextEligibleAt <= nowWallMs)
    ) {
      const prevSelected = frame.selectedCandidateId;
      return {
        kind: 'dispatch-candidate',
        candidate: target,
        attemptOrdinal: target.dispatchedAttempts + 1,
        ...(prevSelected !== undefined && prevSelected !== target.candidateId
          ? { switchedFromCandidateId: prevSelected }
          : {})
      };
    }
    return {
      kind: 'wait-availability',
      candidateIds: Object.freeze([target.candidateId]),
      ...(readiness.nextCheckAt !== undefined
        ? { nextCheckAt: readiness.nextCheckAt }
        : {}),
      monitoringExpiresAt:
        frame.monitoringExpiresAt ?? nowWallMs + MONITORING_WINDOW_DURATION_MS
    };
  }

  if (policy === 'stop-on-unavailability') {
    const target =
      (frame.selectedCandidateId !== undefined
        ? nonRetired.find((s) => s.candidateId === frame.selectedCandidateId)
        : undefined) ?? nonRetired.at(0);
    if (target === undefined) {
      return {
        kind: 'fail-exhausted',
        failureCode: 'all-candidates-exhausted'
      };
    }
    const readiness = input.isSlotReady(target);
    if (!readiness.ready || readiness.topUpRequired) {
      return {
        kind: 'pause-intervention',
        pauseCause: readiness.topUpRequired
          ? 'credit-top-up-required'
          : 'candidate-unavailable-stop-policy',
        candidateId: target.candidateId
      };
    }
    const prevSelected = frame.selectedCandidateId;
    return {
      kind: 'dispatch-candidate',
      candidate: target,
      attemptOrdinal: target.dispatchedAttempts + 1,
      ...(prevSelected !== undefined && prevSelected !== target.candidateId
        ? { switchedFromCandidateId: prevSelected }
        : {})
    };
  }

  // Default policy: 'first-ready' in (priority, authoredOrder) order
  let earliestNextCheckAt: number | undefined;
  let allRequireTopUp = true;
  const waitingIds: string[] = [];

  for (const slot of nonRetired) {
    if (slot.nextEligibleAt !== undefined && slot.nextEligibleAt > nowWallMs) {
      waitingIds.push(slot.candidateId);
      allRequireTopUp = false;
      earliestNextCheckAt =
        earliestNextCheckAt !== undefined
          ? Math.min(earliestNextCheckAt, slot.nextEligibleAt)
          : slot.nextEligibleAt;
      continue;
    }

    const readiness = input.isSlotReady(slot);
    if (readiness.ready && !readiness.topUpRequired) {
      const firstNonRetired = nonRetired.at(0);
      const prevSelected =
        frame.selectedCandidateId ??
        (slot !== firstNonRetired ? firstNonRetired?.candidateId : undefined);
      return {
        kind: 'dispatch-candidate',
        candidate: slot,
        attemptOrdinal: slot.dispatchedAttempts + 1,
        ...(prevSelected !== undefined && prevSelected !== slot.candidateId
          ? { switchedFromCandidateId: prevSelected }
          : {})
      };
    }

    waitingIds.push(slot.candidateId);
    if (!readiness.topUpRequired) {
      allRequireTopUp = false;
    }
    if (readiness.nextCheckAt !== undefined) {
      earliestNextCheckAt =
        earliestNextCheckAt !== undefined
          ? Math.min(earliestNextCheckAt, readiness.nextCheckAt)
          : readiness.nextCheckAt;
    }
  }

  if (allRequireTopUp && waitingIds.length > 0) {
    return {
      kind: 'pause-intervention',
      pauseCause: 'credit-top-up-required',
      candidateId: waitingIds[0]
    };
  }

  return {
    kind: 'wait-availability',
    candidateIds: Object.freeze(waitingIds),
    ...(earliestNextCheckAt !== undefined
      ? { nextCheckAt: earliestNextCheckAt }
      : {}),
    monitoringExpiresAt:
      frame.monitoringExpiresAt ?? nowWallMs + MONITORING_WINDOW_DURATION_MS
  };
}

export class CandidateBlockExecutor {
  private readonly store: ControlLedgerStore;
  private readonly admissionService: ControlAttemptAdmissionService;
  private readonly availabilityService: BackendAvailabilityService | undefined;
  private readonly permitArbiter: QuotaPermitArbiter | undefined;
  private readonly usageAccounting: ControlUsageAccountingService;
  private readonly notificationService: ControlNotificationService;
  private readonly clock: ControlClockPort & {
    readonly hostEpoch?: string | undefined;
  };
  private readonly onReleaseProcessCapacitySlot:
    | ((queueId: string, rootRunId: string, invocationId: string) => void)
    | undefined;

  public constructor(deps: CandidateBlockExecutorDeps) {
    this.store = deps.ledgerStore;
    this.admissionService = deps.admissionService;
    this.availabilityService = deps.availabilityService;
    this.permitArbiter = deps.permitArbiter;
    this.clock = deps.clock ?? DEFAULT_CLOCK;
    this.usageAccounting =
      deps.usageAccounting ??
      new ControlUsageAccountingService({
        ledgerStore: deps.ledgerStore,
        clock: this.clock
      });
    this.notificationService =
      deps.notificationService ??
      new ControlNotificationService({
        ledgerStore: deps.ledgerStore,
        clock: this.clock
      });
    this.onReleaseProcessCapacitySlot = deps.onReleaseProcessCapacitySlot;
  }

  /**
   * Initialize a `CandidateFrame` in `ControlLedgerStore` with per-candidate
   * `candidateOccurrenceId` UUIDs and bounded attempt budgets.
   */
  public async initializeCandidateBlock(
    input: InitializeCandidateBlockInput
  ): Promise<{
    readonly ok: boolean;
    readonly frame?: ControlFrame | undefined;
    readonly root?: RootControlState | undefined;
    readonly ledger?: ControlLedger | undefined;
    readonly message?: string | undefined;
  }> {
    const nowWallMs = this.clock.nowWallMs();
    const nowMonoMs = this.clock.nowMonotonicMs();
    const hostEpoch = input.hostEpoch ?? this.clock.hostEpoch ?? 'default-epoch';

    const slots: CandidateRuntimeSlot[] = input.candidates.map((spec) => {
      const occurrenceId = randomUUID();
      const maxAttempts = clampCandidateMaxAttempts(spec.maxAttempts);
      let quotaIds = spec.quotaIds;
      let observationIds: readonly string[] | undefined;

      if (
        this.availabilityService !== undefined &&
        spec.quotaTarget !== undefined
      ) {
        const resolved = this.availabilityService.resolveCandidateQuotaTarget(
          spec.quotaTarget,
          occurrenceId
        );
        quotaIds = resolved.context.quotaIds;
        observationIds = resolved.observationIds;
      }

      return Object.freeze({
        candidateId: spec.candidateId,
        nodeId: spec.nodeId,
        backend: spec.backend,
        priority: spec.priority,
        authoredOrder: spec.authoredOrder,
        candidateOccurrenceId: occurrenceId,
        maxAttempts,
        dispatchedAttempts: 0,
        status: 'eligible' as const,
        ...(quotaIds !== undefined ? { quotaIds: Object.freeze([...quotaIds]) } : {}),
        ...(observationIds !== undefined
          ? { observationIds: Object.freeze([...observationIds]) }
          : {}),
        ...(spec.allowUnverifiedTrial !== undefined
          ? { allowUnverifiedTrial: spec.allowUnverifiedTrial }
          : {})
      });
    });

    const maxDispatches = clampBlockMaxAttempts(input.maxBlockAttempts, slots);
    const frame: ControlFrame = Object.freeze({
      frameKey: input.frameKey,
      parentFrameKey: input.parentFrameKey ?? 'root',
      invocationId: input.invocationId,
      workflowId: input.workflowId,
      nodeId: input.nodeId,
      kind: 'candidate-block',
      status: 'selecting',
      createdAt: nowWallMs,
      updatedAt: nowWallMs,
      dispatchedCount: 0,
      maxDispatches,
      frameGeneration: input.fence.rootGeneration,
      lastClockWallMs: nowWallMs,
      lastClockMonotonicMs: nowMonoMs,
      lastClockHostEpoch: hostEpoch,
      selectionPolicy: input.selectionPolicy ?? 'first-ready',
      candidateSlots: Object.freeze(sortCandidateSlots(slots))
    });

    const mutated = await this.store.mutate<RootControlState>(
      {
        targetRootId: input.rootRunId,
        expectedFence: input.fence
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
        const nextRoot: RootControlState = Object.freeze({
          ...root,
          framesByKey: Object.freeze({
            ...root.framesByKey,
            [input.frameKey]: frame
          }),
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
            expectedFence: input.fence,
            result: nextRoot
          }
        };
      }
    );

    if (!mutated.ok) {
      return {
        ok: false,
        message: mutated.message
      };
    }

    return {
      ok: true,
      frame,
      root: mutated.result,
      ledger: mutated.ledger
    };
  }

  private evaluateSlotReadiness(
    ledger: ControlLedger,
    slot: CandidateRuntimeSlot
  ): {
    readonly ready: boolean;
    readonly topUpRequired: boolean;
    readonly nextCheckAt?: number | undefined;
  } {
    const obsIds = slot.observationIds ?? slot.quotaIds ?? [];
    if (obsIds.length === 0) {
      return { ready: true, topUpRequired: false };
    }
    const nowWallMs = this.clock.nowWallMs();
    let ready = true;
    let topUpRequired = false;
    let nextCheckAt: number | undefined;

    for (const obsId of obsIds) {
      const rec = lookupRecord(ledger.quotaObservations, obsId);
      if (rec === undefined) {
        if (!slot.allowUnverifiedTrial) {
          ready = false;
        }
        continue;
      }
      if (rec.status === 'top-up-required') {
        topUpRequired = true;
        ready = false;
        continue;
      }
      if (rec.notBefore !== undefined && rec.notBefore > nowWallMs) {
        ready = false;
        nextCheckAt =
          nextCheckAt !== undefined
            ? Math.min(nextCheckAt, rec.notBefore)
            : rec.notBefore;
        continue;
      }
      if (rec.status !== 'ready') {
        if (
          slot.allowUnverifiedTrial &&
          (rec.status === 'check-unsupported' || rec.status === 'unsupported')
        ) {
          continue;
        }
        ready = false;
        const due = rec.nextCheckAt ?? rec.resetAt;
        if (due !== undefined) {
          nextCheckAt =
            nextCheckAt !== undefined ? Math.min(nextCheckAt, due) : due;
        }
      }
    }

    return {
      ready,
      topUpRequired,
      ...(nextCheckAt !== undefined ? { nextCheckAt } : {})
    };
  }

  /**
   * Advance the candidate block by one reducer step:
   * - Dispatches the selected ready candidate via `ControlAttemptAdmissionService`
   *   (after checking `strict-usd` admission and quota permits), OR
   * - Transitions the block into wait/pause/exhausted state, releasing any leaf
   *   process-capacity slot on wait/pause states and recording durable notifications.
   */
  public async stepCandidateBlock(
    input: StepCandidateBlockInput
  ): Promise<StepCandidateBlockResult> {
    const readResult = this.store.read();
    if (!readResult.ok) {
      return {
        ok: false,
        action: {
          kind: 'pause-intervention',
          pauseCause: 'control-ledger-corrupt'
        },
        message: readResult.message
      };
    }

    const root = lookupRecord(readResult.ledger.roots, input.rootRunId);
    if (root === undefined) {
      return {
        ok: false,
        action: {
          kind: 'pause-intervention',
          pauseCause: 'control-root-not-found'
        },
        message: `Control root '${input.rootRunId}' not found.`
      };
    }

    const frame = lookupRecord(root.framesByKey, input.frameKey);
    if (frame === undefined) {
      return {
        ok: false,
        action: {
          kind: 'pause-intervention',
          pauseCause: 'candidate-frame-not-found'
        },
        message: `Candidate frame '${input.frameKey}' not found.`
      };
    }

    const nowWallMs = this.clock.nowWallMs();
    const nowMonoMs = this.clock.nowMonotonicMs();
    const hostEpoch = input.hostEpoch ?? this.clock.hostEpoch ?? 'default-epoch';

    const action = selectNextCandidateAction({
      root,
      frame,
      nowWallMs,
      nowMonotonicMs: nowMonoMs,
      hostEpoch,
      isSlotReady: (slot) =>
        this.evaluateSlotReadiness(readResult.ledger, slot)
    });

    if (action.kind === 'noop-active') {
      return {
        ok: true,
        action,
        frame,
        root
      };
    }

    if (action.kind === 'dispatch-candidate') {
      const slot = action.candidate;
      const spec = input.candidateSpecsById?.[slot.candidateId];
      const rollup = this.usageAccounting.getRootUsageRollup(input.rootRunId);

      // Evaluate D6 strict-usd pre-dispatch admission before committing attempt
      if (rollup !== null) {
        const spendAdmission = checkStrictUsdAdmission({
          rootBudget: root.rootBudget,
          rollup,
          upperBoundMicrousd: spec?.upperBoundMicrousd,
          upperBoundQuality: spec?.upperBoundQuality,
          liveHostCapMicrousd: input.liveHostCapMicrousd
        });
        if (!spendAdmission.allowed) {
          const pausedRes = await this.transitionFrameToPause({
            rootRunId: input.rootRunId,
            frameKey: input.frameKey,
            fence: input.fence,
            status: 'intervention-required',
            pauseCause: spendAdmission.pauseReason
          });
          await this.notificationService.recordNotification({
            rootRunId: input.rootRunId,
            invocationId: frame.invocationId,
            frameKey: input.frameKey,
            generation: frame.frameGeneration ?? input.fence.rootGeneration,
            reason: spendAdmission.pauseReason,
            summary: spendAdmission.message
          });
          return {
            ok: false,
            action: {
              kind: 'pause-intervention',
              pauseCause: spendAdmission.pauseReason,
              candidateId: slot.candidateId
            },
            frame: pausedRes.frame,
            root: pausedRes.root,
            message: spendAdmission.message
          };
        }
      }

      const attemptId = `${frame.invocationId}:${slot.candidateId}:attempt-${action.attemptOrdinal}`;
      const prepareOutcome = await this.admissionService.prepareAttempt({
        ledgerRunId: input.rootRunId,
        connectedRunId: root.connectedRunId,
        queueId: root.queueId,
        frameKey: input.frameKey,
        frameKind: 'candidate-block',
        workflowId: frame.workflowId,
        invocationId: frame.invocationId,
        nodeId: slot.nodeId,
        attemptId,
        attemptIndex: action.attemptOrdinal,
        candidateId: slot.candidateId,
        backend: slot.backend,
        ...(spec?.modelId !== undefined ? { modelId: spec.modelId, model: spec.modelId } : {}),
        reservedMicrousd: spec?.upperBoundMicrousd ?? 0,
        hasSideEffects: spec?.hasSideEffects ?? true,
        fence: input.fence,
        ...(slot.quotaIds !== undefined ? { quotaKeys: slot.quotaIds } : {}),
        ...(slot.observationIds !== undefined
          ? { observationIds: slot.observationIds }
          : {}),
        maxDispatches: frame.maxDispatches,
        candidateMaxAttempts: slot.maxAttempts
      });

      if (!prepareOutcome.ok) {
        return {
          ok: false,
          action,
          frame,
          root,
          message: prepareOutcome.message
        };
      }

      const commitOutcome = await this.admissionService.commitAttempt(
        prepareOutcome.token
      );
      if (!commitOutcome.ok) {
        return {
          ok: false,
          action,
          frame,
          root,
          message: commitOutcome.message
        };
      }

      // Record candidate switch notification + decision summary if switched
      if (action.switchedFromCandidateId !== undefined) {
        await this.notificationService.recordNotification({
          rootRunId: input.rootRunId,
          invocationId: frame.invocationId,
          frameKey: input.frameKey,
          generation: frame.frameGeneration ?? input.fence.rootGeneration,
          reason: 'candidate-switched',
          summary: `Switched candidate from '${action.switchedFromCandidateId}' to '${slot.candidateId}'.`
        });
      }

      // Clear one-admission manualSelectionCandidateId override upon admitted dispatch (D8)
      if (frame.manualSelectionCandidateId !== undefined) {
        await this.store.mutate({}, ({ ledger }) => {
          const r = lookupRecord(ledger.roots, input.rootRunId);
          const f = r !== undefined ? lookupRecord(r.framesByKey, input.frameKey) : undefined;
          if (r === undefined || f === undefined) {
            return {
              commit: false,
              code: 'control-ledger-corrupt',
              message: 'Target root or frame disappeared while clearing manualSelectionCandidateId.'
            };
          }
          const { manualSelectionCandidateId: _cleared, ...restF } = f;
          const nextF: ControlFrame = Object.freeze({ ...restF });
          const nextR: RootControlState = Object.freeze({
            ...r,
            framesByKey: Object.freeze({
              ...r.framesByKey,
              [input.frameKey]: nextF
            })
          });
          return {
            commit: true,
            plan: {
              nextLedger: {
                ...ledger,
                roots: {
                  ...ledger.roots,
                  [input.rootRunId]: nextR
                }
              },
              targetRootId: input.rootRunId,
              expectedFence: input.fence,
              result: nextF
            }
          };
        });
      }

      const updatedRoot = this.store.getRoot(input.rootRunId) ?? commitOutcome.root;
      const updatedFrame =
        lookupRecord(updatedRoot.framesByKey, input.frameKey) ??
        commitOutcome.frame;

      return {
        ok: true,
        action,
        frame: updatedFrame,
        root: updatedRoot,
        attempt: commitOutcome.attempt
      };
    }

    if (action.kind === 'wait-backoff') {
      const waitRes = await this.transitionFrameToWait({
        rootRunId: input.rootRunId,
        frameKey: input.frameKey,
        fence: input.fence,
        status: 'retry-delayed',
        hostEpoch
      });
      return {
        ok: true,
        action,
        frame: waitRes.frame,
        root: waitRes.root
      };
    }

    if (action.kind === 'wait-availability') {
      if (this.permitArbiter !== undefined) {
        const firstId = action.candidateIds[0];
        const firstSlot = frame.candidateSlots?.find(
          (s) => s.candidateId === firstId
        );
        if (
          firstSlot !== undefined &&
          firstSlot.quotaIds !== undefined &&
          firstSlot.quotaIds.length > 0
        ) {
          await this.permitArbiter.registerWaiter({
            rootRunId: input.rootRunId,
            queueId: root.queueId,
            frameKey: input.frameKey,
            invocationId: frame.invocationId,
            generation: frame.frameGeneration ?? input.fence.rootGeneration,
            nodeId: firstSlot.nodeId,
            candidateId: firstSlot.candidateId,
            ...(firstSlot.candidateOccurrenceId !== undefined
              ? { candidateOccurrenceId: firstSlot.candidateOccurrenceId }
              : {}),
            quotaIds: firstSlot.quotaIds,
            ...(firstSlot.observationIds !== undefined
              ? { observationIds: firstSlot.observationIds }
              : {})
          });
        }
      }

      const waitRes = await this.transitionFrameToWait({
        rootRunId: input.rootRunId,
        frameKey: input.frameKey,
        fence: input.fence,
        status: 'waiting-availability',
        monitoringExpiresAt: action.monitoringExpiresAt,
        hostEpoch
      });

      await this.notificationService.recordNotification({
        rootRunId: input.rootRunId,
        invocationId: frame.invocationId,
        frameKey: input.frameKey,
        generation: frame.frameGeneration ?? input.fence.rootGeneration,
        reason: 'waiting-availability',
        summary: `Waiting for backend quota availability (${action.candidateIds.join(', ')}).`
      });

      return {
        ok: true,
        action,
        frame: waitRes.frame,
        root: waitRes.root
      };
    }

    if (action.kind === 'pause-monitoring-expired') {
      const pausedRes = await this.transitionFrameToPause({
        rootRunId: input.rootRunId,
        frameKey: input.frameKey,
        fence: input.fence,
        status: 'monitoring-expired',
        pauseCause: action.pauseCause
      });
      await this.notificationService.recordNotification({
        rootRunId: input.rootRunId,
        invocationId: frame.invocationId,
        frameKey: input.frameKey,
        generation: frame.frameGeneration ?? input.fence.rootGeneration,
        reason: 'monitoring-expired',
        summary: `Candidate availability monitoring window expired (${action.pauseCause}).`
      });
      return {
        ok: true,
        action,
        frame: pausedRes.frame,
        root: pausedRes.root
      };
    }

    if (action.kind === 'pause-intervention') {
      const pausedRes = await this.transitionFrameToPause({
        rootRunId: input.rootRunId,
        frameKey: input.frameKey,
        fence: input.fence,
        status: 'intervention-required',
        pauseCause: action.pauseCause
      });
      await this.notificationService.recordNotification({
        rootRunId: input.rootRunId,
        invocationId: frame.invocationId,
        frameKey: input.frameKey,
        generation: frame.frameGeneration ?? input.fence.rootGeneration,
        reason: 'intervention-required',
        summary: `Candidate block paused for intervention (${action.pauseCause}).`
      });
      return {
        ok: true,
        action,
        frame: pausedRes.frame,
        root: pausedRes.root
      };
    }

    // action.kind === 'fail-exhausted'
    const failedRes = await this.transitionFrameToFailed({
      rootRunId: input.rootRunId,
      frameKey: input.frameKey,
      fence: input.fence,
      failureCode: action.failureCode
    });
    return {
      ok: true,
      action,
      frame: failedRes.frame,
      root: failedRes.root
    };
  }

  /**
   * Settle a candidate attempt and update the `CandidateBlockFrame`:
   * - On `succeeded`: commits `returnCommitId` once and publishes only the winning
   *   candidate's validated outputs and `decisionResults` (ignoring duplicates).
   * - On `invalid-output` or `uncertain-effect`: transitions to `intervention-required`,
   *   taking precedence over `attempts-exhausted`.
   * - On `permanent-failure`: retires the candidate immediately (`permanent-failure`).
   * - On `retryable-transient` / `retryable-availability`: retires the candidate with
   *   `attempts-exhausted` if `dispatchedAttempts >= maxAttempts`, or places it in
   *   `waiting-backoff` / `waiting-availability`.
   */
  public async settleCandidateAttempt(
    input: SettleCandidateAttemptInput
  ): Promise<SettleCandidateAttemptResult> {
    const existingRoot = this.store.getRoot(input.rootRunId);
    if (existingRoot === null) {
      return {
        ok: false,
        returnCommitted: false,
        message: `Control root '${input.rootRunId}' not found.`
      };
    }
    const existingFrame = lookupRecord(existingRoot.framesByKey, input.frameKey);
    if (existingFrame === undefined) {
      return {
        ok: false,
        returnCommitted: false,
        message: `Candidate frame '${input.frameKey}' not found.`
      };
    }

    // If frame already committed its return, ignore late/duplicate completion
    if (existingFrame.returnCommitId !== undefined) {
      return {
        ok: true,
        frame: existingFrame,
        root: existingRoot,
        returnCommitted: false,
        returnCommitId: existingFrame.returnCommitId
      };
    }

    const isUncertain = input.outcome === 'uncertain-effect';
    const terminalStatus =
      input.outcome === 'succeeded'
        ? 'completed'
        : input.outcome === 'canceled'
          ? 'canceled'
          : 'failed';

    const settledAttemptRes = await this.admissionService.settleAttempt({
      ledgerRunId: input.rootRunId,
      attemptId: input.attemptId,
      fence: input.fence,
      terminalStatus,
      settledMicrousd: input.usageRecord?.costMicrousd ?? 0,
      ...(input.failureCode !== undefined
        ? { failureCode: input.failureCode }
        : {}),
      ...(input.failureMessage !== undefined
        ? { failureMessage: input.failureMessage }
        : {}),
      ...(input.outcome === 'succeeded' && input.decisionResults !== undefined
        ? { decisionResults: input.decisionResults }
        : {}),
      holdPermitUncertain: isUncertain,
      ...(isUncertain ? { uncertainReason: 'recovery-uncertain-effect' } : {})
    });

    if (!settledAttemptRes.ok) {
      return {
        ok: false,
        returnCommitted: false,
        message: settledAttemptRes.message
      };
    }

    if (input.usageRecord !== undefined) {
      await this.usageAccounting.reconcileAttemptUsage({
        rootRunId: input.rootRunId,
        attemptId: input.attemptId,
        fence: input.fence,
        usageRecord: input.usageRecord,
        outcomeUncertain: isUncertain
      });
    }

    const slot = existingFrame.candidateSlots?.find(
      (s) => s.candidateId === input.candidateId
    );
    if (
      input.outcome === 'retryable-availability' &&
      this.availabilityService !== undefined &&
      input.quotaTarget !== undefined &&
      slot?.candidateOccurrenceId !== undefined
    ) {
      await this.availabilityService.recordDiagnosticObservation({
        candidateOccurrenceId: slot.candidateOccurrenceId,
        frozenPhase: input.quotaTarget,
        generation:
          existingFrame.frameGeneration ?? input.fence.rootGeneration,
        cause: input.failureCode ?? 'rate_limit',
        resetsAtMs: input.resetsAtMs,
        topUpRequired: input.topUpRequired
      });
    }

    const nowWallMs = this.clock.nowWallMs();
    const mutated = await this.store.mutate<{
      readonly frame: ControlFrame;
      readonly root: RootControlState;
      readonly returnCommitted: boolean;
      readonly returnCommitId?: string | undefined;
      readonly pauseNoticeReason?:
        | 'intervention-required'
        | 'waiting-availability'
        | undefined;
    }>(
      {
        targetRootId: input.rootRunId,
        expectedFence: input.fence,
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
        const frame = lookupRecord(root.framesByKey, input.frameKey);
        if (frame === undefined) {
          return {
            commit: false,
            code: 'attempt-not-found',
            message: `Candidate frame '${input.frameKey}' not found.`
          };
        }
        if (frame.returnCommitId !== undefined) {
          return {
            commit: true,
            plan: {
              nextLedger: ledger,
              targetRootId: input.rootRunId,
              allowSettlementReserve: true,
              result: {
                frame,
                root,
                returnCommitted: false,
                returnCommitId: frame.returnCommitId
              }
            }
          };
        }

        const currentSlots = frame.candidateSlots ?? [];
        let returnCommitted = false;
        let returnCommitId: string | undefined;
        let nextFrameStatus = frame.status;
        let nextPauseCause = frame.pauseCause;
        let nextRootStatus = root.status;
        let pauseNoticeReason:
          | 'intervention-required'
          | 'waiting-availability'
          | undefined;

        const nextSlots = currentSlots.map((s) => {
          if (s.candidateId !== input.candidateId) return s;

          if (input.outcome === 'succeeded') {
            return Object.freeze({
              ...s,
              status: 'succeeded' as const,
              lastAttemptId: input.attemptId
            });
          }

          if (
            input.outcome === 'invalid-output' ||
            input.outcome === 'uncertain-effect'
          ) {
            // Intervention takes precedence over attempts-exhausted even on final attempt!
            return Object.freeze({
              ...s,
              status: 'failed' as const,
              lastAttemptId: input.attemptId,
              lastFailureCode:
                input.failureCode ??
                (input.outcome === 'invalid-output'
                  ? 'invalid-candidate-output'
                  : 'recovery-uncertain-effect')
            });
          }

          if (input.outcome === 'permanent-failure') {
            return Object.freeze({
              ...s,
              status: 'failed' as const,
              retirementReason: 'permanent-failure' as const,
              lastAttemptId: input.attemptId,
              ...(input.failureCode !== undefined
                ? { lastFailureCode: input.failureCode }
                : {})
            });
          }

          // Retryable transient or availability outcome: check if candidate exhausted its attempts
          if (s.dispatchedAttempts >= s.maxAttempts) {
            return Object.freeze({
              ...s,
              status: 'exhausted' as const,
              retirementReason: 'attempts-exhausted' as const,
              lastAttemptId: input.attemptId,
              ...(input.failureCode !== undefined
                ? { lastFailureCode: input.failureCode }
                : {})
            });
          }

          if (input.outcome === 'retryable-transient') {
            const delayMs = Math.max(0, input.retryDelayMs ?? 1_000);
            return Object.freeze({
              ...s,
              status: 'waiting-backoff' as const,
              nextEligibleAt: nowWallMs + delayMs,
              lastAttemptId: input.attemptId,
              ...(input.failureCode !== undefined
                ? { lastFailureCode: input.failureCode }
                : {})
            });
          }

          return Object.freeze({
            ...s,
            status: 'waiting-availability' as const,
            ...(input.resetsAtMs !== undefined && input.resetsAtMs !== null
              ? { nextEligibleAt: input.resetsAtMs }
              : {}),
            lastAttemptId: input.attemptId,
            ...(input.failureCode !== undefined
              ? { lastFailureCode: input.failureCode }
              : {})
          });
        });

        const decisionSummaries: ControlDecisionSummaryRecord[] = [
          ...(root.decisionSummaries ?? [])
        ];

        if (input.outcome === 'succeeded') {
          returnCommitted = true;
          returnCommitId = `return:${frame.invocationId}:${input.attemptId}`;
          nextFrameStatus = 'completed';
          decisionSummaries.push(
            Object.freeze({
              summaryId: returnCommitId,
              rootRunId: input.rootRunId,
              invocationId: frame.invocationId,
              frameKey: input.frameKey,
              generation:
                frame.frameGeneration ?? input.fence.rootGeneration,
              eventKind: 'candidate-returned',
              candidateId: input.candidateId,
              attemptId: input.attemptId,
              createdAt: nowWallMs
            })
          );
        } else if (
          input.outcome === 'invalid-output' ||
          input.outcome === 'uncertain-effect'
        ) {
          nextFrameStatus = 'intervention-required';
          nextPauseCause =
            input.failureCode ??
            (input.outcome === 'invalid-output'
              ? 'invalid-candidate-output'
              : 'recovery-uncertain-effect');
          nextRootStatus = 'paused';
          pauseNoticeReason = 'intervention-required';
        } else if (
          input.outcome === 'retryable-transient' &&
          nextSlots.find((s) => s.candidateId === input.candidateId)?.status ===
            'waiting-backoff'
        ) {
          nextFrameStatus = 'retry-delayed';
        } else {
          nextFrameStatus = 'selecting';
        }

        const settledSlot = nextSlots.find(
          (s) => s.candidateId === input.candidateId
        );
        const clearManualSelection =
          settledSlot !== undefined &&
          isCandidateRetired(settledSlot) &&
          frame.manualSelectionCandidateId === input.candidateId;
        const {
          activeAttemptId: _cleared,
          manualSelectionCandidateId: existingManualSelection,
          ...restFrame
        } = frame;
        const nextFrame: ControlFrame = Object.freeze({
          ...restFrame,
          ...(existingManualSelection !== undefined && !clearManualSelection
            ? { manualSelectionCandidateId: existingManualSelection }
            : {}),
          status: nextFrameStatus,
          candidateSlots: Object.freeze(nextSlots),
          ...(nextPauseCause !== undefined ? { pauseCause: nextPauseCause } : {}),
          ...(returnCommitId !== undefined
            ? {
                returnCommitId,
                winningCandidateId: input.candidateId,
                winningAttemptId: input.attemptId,
                completedAt: nowWallMs,
                ...(input.validatedOutputs !== undefined
                  ? { winningOutputs: Object.freeze({ ...input.validatedOutputs }) }
                  : {}),
                ...(input.decisionResults !== undefined
                  ? { decisionResults: Object.freeze({ ...input.decisionResults }) }
                  : {})
              }
            : {}),
          updatedAt: nowWallMs
        });

        const nextRoot = enforceBoundedRootHistory(
          Object.freeze({
            ...root,
            status: nextRootStatus,
            ...(nextPauseCause !== undefined && nextRootStatus === 'paused'
              ? { pauseCause: nextPauseCause }
              : {}),
            framesByKey: Object.freeze({
              ...root.framesByKey,
              [input.frameKey]: nextFrame
            }),
            decisionSummaries: Object.freeze(decisionSummaries),
            updatedAt: nowWallMs
          })
        );

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
            expectedFence: input.fence,
            allowSettlementReserve: true,
            result: {
              frame: nextFrame,
              root: nextRoot,
              returnCommitted,
              ...(returnCommitId !== undefined ? { returnCommitId } : {}),
              ...(pauseNoticeReason !== undefined ? { pauseNoticeReason } : {})
            }
          }
        };
      }
    );

    if (!mutated.ok) {
      return {
        ok: false,
        returnCommitted: false,
        message: mutated.message
      };
    }

    if (mutated.result.pauseNoticeReason !== undefined) {
      this.onReleaseProcessCapacitySlot?.(
        mutated.result.root.queueId,
        input.rootRunId,
        mutated.result.frame.invocationId
      );
      await this.notificationService.recordNotification({
        rootRunId: input.rootRunId,
        invocationId: mutated.result.frame.invocationId,
        frameKey: input.frameKey,
        generation:
          mutated.result.frame.frameGeneration ?? input.fence.rootGeneration,
        reason: mutated.result.pauseNoticeReason,
        summary: `Candidate attempt '${input.attemptId}' requires intervention (${mutated.result.frame.pauseCause ?? 'unknown'}).`
      });
    }

    return {
      ok: true,
      frame: mutated.result.frame,
      root: mutated.result.root,
      returnCommitted: mutated.result.returnCommitted,
      ...(mutated.result.returnCommitId !== undefined
        ? { returnCommitId: mutated.result.returnCommitId }
        : {})
    };
  }

  /**
   * Count an ordinary sibling leaf Phase dispatch outside any Candidate/Repeat/ForEach
   * block against the root's `maxPhaseAttempts` cap (`100`).
   */
  public async recordOrdinaryLeafDispatch(input: {
    readonly rootRunId: string;
    readonly nodeId: string;
    readonly backend: BackendRunnerKind;
    readonly fence: ExecutionFence;
  }): Promise<{
    readonly ok: boolean;
    readonly dispatchedAttempts?: number | undefined;
    readonly code?: string | undefined;
    readonly message?: string | undefined;
  }> {
    const nowWallMs = this.clock.nowWallMs();
    const mutated = await this.store.mutate<number>(
      {
        targetRootId: input.rootRunId,
        expectedFence: input.fence
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
        if (root.dispatchedAttempts >= root.rootBudget.maxPhaseAttempts) {
          return {
            commit: false,
            code: 'root-attempt-budget-exhausted',
            message: `Root '${input.rootRunId}' reached maxPhaseAttempts (${root.rootBudget.maxPhaseAttempts}).`
          };
        }
        const nextCount = root.dispatchedAttempts + 1;
        const nextRoot: RootControlState = Object.freeze({
          ...root,
          dispatchedAttempts: nextCount,
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
            expectedFence: input.fence,
            result: nextCount
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
      dispatchedAttempts: mutated.result
    };
  }

  private async transitionFrameToWait(input: {
    readonly rootRunId: string;
    readonly frameKey: string;
    readonly fence: ExecutionFence;
    readonly status: 'waiting-availability' | 'retry-delayed';
    readonly monitoringExpiresAt?: number | undefined;
    readonly hostEpoch: string;
  }): Promise<{
    readonly frame?: ControlFrame | undefined;
    readonly root?: RootControlState | undefined;
  }> {
    const nowWallMs = this.clock.nowWallMs();
    const nowMonoMs = this.clock.nowMonotonicMs();
    const mutated = await this.store.mutate<{
      readonly frame: ControlFrame;
      readonly root: RootControlState;
    }>(
      {
        targetRootId: input.rootRunId,
        expectedFence: input.fence,
        allowSettlementReserve: true
      },
      ({ ledger }) => {
        const root = lookupRecord(ledger.roots, input.rootRunId);
        if (root === undefined) {
          return {
            commit: false,
            code: 'control-root-not-found',
            message: 'Root not found.'
          };
        }
        const frame = lookupRecord(root.framesByKey, input.frameKey);
        if (frame === undefined) {
          return {
            commit: false,
            code: 'attempt-not-found',
            message: 'Frame not found.'
          };
        }
        const nextFrame: ControlFrame = Object.freeze({
          ...frame,
          status: input.status,
          waitStateReleasedSlot: true,
          ...(input.status === 'waiting-availability'
            ? {
                monitoringStartedAt: frame.monitoringStartedAt ?? nowWallMs,
                monitoringExpiresAt:
                  frame.monitoringExpiresAt ??
                  input.monitoringExpiresAt ??
                  nowWallMs + MONITORING_WINDOW_DURATION_MS,
                monitoringRenewals: frame.monitoringRenewals ?? 0
              }
            : {}),
          lastClockWallMs: nowWallMs,
          lastClockMonotonicMs: nowMonoMs,
          lastClockHostEpoch: input.hostEpoch,
          updatedAt: nowWallMs
        });
        const nextRoot: RootControlState = Object.freeze({
          ...root,
          framesByKey: Object.freeze({
            ...root.framesByKey,
            [input.frameKey]: nextFrame
          }),
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
            expectedFence: input.fence,
            allowSettlementReserve: true,
            result: { frame: nextFrame, root: nextRoot }
          }
        };
      }
    );

    if (mutated.ok) {
      this.onReleaseProcessCapacitySlot?.(
        mutated.result.root.queueId,
        input.rootRunId,
        mutated.result.frame.invocationId
      );
      return mutated.result;
    }
    return {};
  }

  private async transitionFrameToPause(input: {
    readonly rootRunId: string;
    readonly frameKey: string;
    readonly fence: ExecutionFence;
    readonly status: 'intervention-required' | 'monitoring-expired';
    readonly pauseCause: string;
  }): Promise<{
    readonly frame?: ControlFrame | undefined;
    readonly root?: RootControlState | undefined;
  }> {
    const nowWallMs = this.clock.nowWallMs();
    const mutated = await this.store.mutate<{
      readonly frame: ControlFrame;
      readonly root: RootControlState;
    }>(
      {
        targetRootId: input.rootRunId,
        expectedFence: input.fence,
        allowSettlementReserve: true
      },
      ({ ledger }) => {
        const root = lookupRecord(ledger.roots, input.rootRunId);
        if (root === undefined) {
          return {
            commit: false,
            code: 'control-root-not-found',
            message: 'Root not found.'
          };
        }
        const frame = lookupRecord(root.framesByKey, input.frameKey);
        if (frame === undefined) {
          return {
            commit: false,
            code: 'attempt-not-found',
            message: 'Frame not found.'
          };
        }
        const nextFrame: ControlFrame = Object.freeze({
          ...frame,
          status: input.status,
          pauseCause: input.pauseCause,
          waitStateReleasedSlot: true,
          updatedAt: nowWallMs
        });
        const nextRoot: RootControlState = Object.freeze({
          ...root,
          status: 'paused',
          pauseCause: input.pauseCause,
          framesByKey: Object.freeze({
            ...root.framesByKey,
            [input.frameKey]: nextFrame
          }),
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
            expectedFence: input.fence,
            allowSettlementReserve: true,
            result: { frame: nextFrame, root: nextRoot }
          }
        };
      }
    );

    if (mutated.ok) {
      this.onReleaseProcessCapacitySlot?.(
        mutated.result.root.queueId,
        input.rootRunId,
        mutated.result.frame.invocationId
      );
      return mutated.result;
    }
    return {};
  }

  private async transitionFrameToFailed(input: {
    readonly rootRunId: string;
    readonly frameKey: string;
    readonly fence: ExecutionFence;
    readonly failureCode: string;
  }): Promise<{
    readonly frame?: ControlFrame | undefined;
    readonly root?: RootControlState | undefined;
  }> {
    const nowWallMs = this.clock.nowWallMs();
    const mutated = await this.store.mutate<{
      readonly frame: ControlFrame;
      readonly root: RootControlState;
    }>(
      {
        targetRootId: input.rootRunId,
        expectedFence: input.fence,
        allowSettlementReserve: true
      },
      ({ ledger }) => {
        const root = lookupRecord(ledger.roots, input.rootRunId);
        if (root === undefined) {
          return {
            commit: false,
            code: 'control-root-not-found',
            message: 'Root not found.'
          };
        }
        const frame = lookupRecord(root.framesByKey, input.frameKey);
        if (frame === undefined) {
          return {
            commit: false,
            code: 'attempt-not-found',
            message: 'Frame not found.'
          };
        }
        const nextFrame: ControlFrame = Object.freeze({
          ...frame,
          status: 'failed',
          failureCode: input.failureCode,
          completedAt: nowWallMs,
          updatedAt: nowWallMs
        });
        const nextRoot: RootControlState = Object.freeze({
          ...root,
          status: 'failed',
          failureCode: input.failureCode,
          framesByKey: Object.freeze({
            ...root.framesByKey,
            [input.frameKey]: nextFrame
          }),
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
            expectedFence: input.fence,
            allowSettlementReserve: true,
            result: { frame: nextFrame, root: nextRoot }
          }
        };
      }
    );

    return mutated.ok ? mutated.result : {};
  }
}
