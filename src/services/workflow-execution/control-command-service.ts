/**
 * FR-R5-F31 (SPEC-09, D8, D1, D4, D5; WF-09, WF-19; AC-10, AC-11, AC-14, AC-26, AC-29) —
 * Shared legal workflow/candidate control command service for editor and headless parity.
 *
 * Responsibilities:
 * - Validate version-1 `ControlCommandEnvelope` payloads before any effect.
 * - Correlate `commandId` with canonical payload digest (`<= 256` receipts per root
 *   plus monotonic `receiptHighWaterGeneration` protection against evicted replay).
 * - Enforce `expectedGeneration`, ownership fence, workspace trust, and legal-state matrix
 *   across `check-now`, `try-now`, `select-candidate`, `set-policy`,
 *   `set-allowed-candidates`, `renew-monitoring`, `pause`, `resume`, and `cancel`.
 * - Redirect generic `retry-phase` on block-owned leaves through this authority.
 *
 * Zero `vscode` imports.
 */

import { createHash } from 'node:crypto';
import { MIN_QUOTA_CHECK_INTERVAL_MS } from '../../contracts/backend-availability';
import {
  MAX_ACTIVE_AVAILABILITY_CHECKS,
  MAX_CONTROL_COMMAND_RECEIPTS_PER_ROOT,
  type CandidateRuntimeSlot,
  type ControlAttemptRecord,
  type ControlClockPort,
  type ControlCommandReceiptRecord,
  type ControlFrame,
  type ControlFrameStatus,
  type ControlLedger,
  type ControlPolicyOverrideRecord,
  type ExecutionFence,
  type RootControlState
} from '../../contracts/control-ledger';
import {
  CONTROL_ACTION_KINDS,
  CONTROL_COMMAND_VERSION,
  validateControlCommandEnvelope,
  type ControlAction,
  type ControlActionKind,
  type ControlCandidateProjection,
  type ControlCommandAcknowledgement,
  type ControlCommandEnvelope,
  type ControlCommandRefusalReason,
  type ControlLegalActionEntry,
  type ControlProjection
} from '../../contracts/sidebar-ipc/workflow-run';
import { MAX_ROOT_CONTROL_DISPATCHES } from '../../contracts/workflow-controls';
import { ControlLedgerStore, lookupRecord } from './control-ledger-store';
import { checkStrictUsdAdmission } from './control-usage-accounting';

const DEFAULT_CLOCK: ControlClockPort = {
  nowWallMs: () => Date.now(),
  nowMonotonicMs: () => Math.floor(performance.now()),
  hostEpoch: 'default-epoch'
};

const TERMINAL_FRAME_STATES: ReadonlySet<ControlFrameStatus> = new Set([
  'completed',
  'failed',
  'canceled'
]);

const ACTIVE_DISPATCH_STATES: ReadonlySet<ControlFrameStatus> = new Set([
  'executing',
  'dispatch-pending'
]);

const PAUSED_FRAME_STATES: ReadonlySet<ControlFrameStatus> = new Set([
  'paused',
  'monitoring-expired',
  'intervention-required'
]);

const QUIESCENT_MUTABLE_STATES: ReadonlySet<ControlFrameStatus> = new Set([
  'in-flight',
  'selecting',
  'retry-delayed',
  'waiting-availability',
  'waiting-permit',
  'waiting-handoff',
  'monitoring-expired',
  'intervention-required',
  'paused'
]);

function isCandidateSlotRetired(slot: CandidateRuntimeSlot): boolean {
  return (
    slot.retirementReason !== undefined ||
    slot.status === 'exhausted' ||
    slot.status === 'disabled' ||
    slot.dispatchedAttempts >= slot.maxAttempts
  );
}

export function computeControlCommandDigest(envelope: ControlCommandEnvelope): string {
  const canonical = JSON.stringify({
    version: envelope.version,
    rootRunId: envelope.rootRunId,
    queueId: envelope.queueId,
    invocationId: envelope.invocationId,
    expectedGeneration: envelope.expectedGeneration,
    action: envelope.action
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function sanitizeProjectionText(value: string, sanitize?: (s: string) => string): string {
  const cleaned = sanitize !== undefined ? sanitize(value) : value;
  return cleaned
    .replace(/<[a-z!/][^>]*>/gi, '')
    .replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\)[^\s"']+/g, '[redacted-path]')
    .slice(0, 256);
}

export interface BuildControlProjectionOptions {
  readonly root: RootControlState;
  readonly frame: ControlFrame;
  readonly ledger: ControlLedger;
  readonly nowWallMs: number;
  readonly currentHostEpoch?: string | undefined;
  readonly isTrusted?: boolean | undefined;
  readonly sanitize?: ((value: string) => string) | undefined;
  readonly recoveryCoverage?: 'complete' | 'partial' | 'unavailable' | undefined;
  readonly effectCertainty?: 'safe' | 'uncertain' | 'unknown' | undefined;
  readonly policyObservations?:
    | readonly Readonly<Record<string, string | number | boolean>>[]
    | undefined;
  readonly evidenceRefs?: readonly string[] | undefined;
}

export type BuildControlProjectionInput = BuildControlProjectionOptions;
export type ControlActionLegalityDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: ControlCommandRefusalReason };

export interface EvaluateControlActionLegalityInput {
  readonly root: RootControlState;
  readonly frame: ControlFrame;
  readonly ledger: ControlLedger;
  readonly action: ControlAction;
  readonly nowWallMs: number;
  readonly isTrusted?: boolean | undefined;
}

export function evaluateControlActionLegality(input: {
  readonly root: RootControlState;
  readonly frame: ControlFrame;
  readonly ledger: ControlLedger;
  readonly action: ControlAction;
  readonly nowWallMs: number;
  readonly isTrusted?: boolean | undefined;
}): { readonly allowed: true } | { readonly allowed: false; readonly reason: ControlCommandRefusalReason } {
  const { root, frame, ledger, action, nowWallMs } = input;
  if (input.isTrusted === false) {
    return { allowed: false, reason: 'trust-denied' };
  }

  if (
    TERMINAL_FRAME_STATES.has(frame.status) ||
    root.status === 'completed' ||
    root.status === 'failed' ||
    root.status === 'canceled'
  ) {
    return { allowed: false, reason: 'illegal-state' };
  }

  const slots = frame.candidateSlots ?? [];
  const allowedSet =
    frame.allowedCandidateIds !== undefined
      ? new Set(frame.allowedCandidateIds)
      : undefined;

  const hasUncertainPermitOrAttempt =
    frame.pauseCause === 'recovery-uncertain-effect' ||
    frame.pauseCause === 'uncertain-effect' ||
    (root.uncertainSpendCount ?? 0) > 0 ||
    Object.values(ledger.permits).some(
      (p) => p.rootRunId === root.ledgerRunId && p.state === 'uncertain'
    );

  switch (action.kind) {
    case 'pause': {
      if (PAUSED_FRAME_STATES.has(frame.status)) {
        return { allowed: false, reason: 'illegal-state' };
      }
      return { allowed: true };
    }
    case 'resume': {
      if (
        !PAUSED_FRAME_STATES.has(frame.status) ||
        frame.pauseCause === 'repeat-exhausted' ||
        frame.repeatState?.exhaustionReason === 'repeat-exhausted'
      ) {
        return { allowed: false, reason: 'illegal-state' };
      }
      if (
        frame.status === 'monitoring-expired' &&
        (frame.monitoringExpiresAt === undefined || frame.monitoringExpiresAt <= nowWallMs)
      ) {
        return { allowed: false, reason: 'monitoring-expired' };
      }
      if (hasUncertainPermitOrAttempt) {
        return { allowed: false, reason: 'uncertain-effect' };
      }
      if (frame.pauseCause === 'spend-limit-reached') {
        return { allowed: false, reason: 'spend-limit-reached' };
      }
      if (
        frame.pauseCause === 'spend-unverifiable' ||
        frame.pauseCause === 'spend-bound-exceeded'
      ) {
        return { allowed: false, reason: 'spend-unverifiable' };
      }
      return { allowed: true };
    }
    case 'cancel': {
      return { allowed: true };
    }
    case 'renew-monitoring': {
      if (ACTIVE_DISPATCH_STATES.has(frame.status) || !QUIESCENT_MUTABLE_STATES.has(frame.status)) {
        return { allowed: false, reason: 'illegal-state' };
      }
      return { allowed: true };
    }
    case 'set-policy': {
      if (ACTIVE_DISPATCH_STATES.has(frame.status) || !QUIESCENT_MUTABLE_STATES.has(frame.status)) {
        return { allowed: false, reason: 'illegal-state' };
      }
      return { allowed: true };
    }
    case 'set-allowed-candidates': {
      if (ACTIVE_DISPATCH_STATES.has(frame.status) || !QUIESCENT_MUTABLE_STATES.has(frame.status)) {
        return { allowed: false, reason: 'illegal-state' };
      }
      for (const id of action.candidateIds) {
        if (!slots.some((s) => s.candidateId === id)) {
          return { allowed: false, reason: 'unknown-target' };
        }
      }
      const nonRetiredInSet = slots.filter(
        (s) => action.candidateIds.includes(s.candidateId) && !isCandidateSlotRetired(s)
      );
      if (nonRetiredInSet.length === 0) {
        return { allowed: false, reason: 'candidate-ineligible' };
      }
      return { allowed: true };
    }
    case 'select-candidate': {
      if (ACTIVE_DISPATCH_STATES.has(frame.status) || !QUIESCENT_MUTABLE_STATES.has(frame.status)) {
        return { allowed: false, reason: 'illegal-state' };
      }
      const slot = slots.find((s) => s.candidateId === action.candidateId);
      if (slot === undefined) {
        return { allowed: false, reason: 'unknown-target' };
      }
      if (
        isCandidateSlotRetired(slot) ||
        (allowedSet !== undefined && !allowedSet.has(slot.candidateId))
      ) {
        return { allowed: false, reason: 'candidate-ineligible' };
      }
      return { allowed: true };
    }
    case 'check-now': {
      if (ACTIVE_DISPATCH_STATES.has(frame.status) || !QUIESCENT_MUTABLE_STATES.has(frame.status)) {
        return { allowed: false, reason: 'illegal-state' };
      }
      let targetSlots: readonly CandidateRuntimeSlot[];
      if (action.candidateId !== undefined) {
        const found = slots.find((s) => s.candidateId === action.candidateId);
        if (found === undefined) {
          return { allowed: false, reason: 'unknown-target' };
        }
        targetSlots = [found];
      } else {
        targetSlots = slots.filter(
          (s) =>
            !isCandidateSlotRetired(s) &&
            (allowedSet === undefined || allowedSet.has(s.candidateId))
        );
      }
      if (targetSlots.length === 0) {
        return { allowed: false, reason: 'candidate-ineligible' };
      }
      for (const slot of targetSlots) {
        if (
          isCandidateSlotRetired(slot) ||
          (allowedSet !== undefined && !allowedSet.has(slot.candidateId))
        ) {
          return { allowed: false, reason: 'candidate-ineligible' };
        }
        const obsId = slot.observationIds?.[0] ?? slot.quotaIds?.[0];
        const obs = obsId !== undefined ? lookupRecord(ledger.quotaObservations, obsId) : undefined;
        if (obs?.status === 'check-unsupported') {
          return { allowed: false, reason: 'candidate-ineligible' };
        }
        const activeChecks = Object.values(ledger.checks).filter(
          (c) => c.stage === 'pending' || c.stage === 'started'
        );
        const joinable =
          obsId !== undefined &&
          activeChecks.some((c) => c.observationId === obsId || c.quotaKey === obsId);
        if (!joinable) {
          if (
            obs !== undefined &&
            nowWallMs - obs.observedAt < MIN_QUOTA_CHECK_INTERVAL_MS
          ) {
            return { allowed: false, reason: 'check-rate-limited' };
          }
          if (activeChecks.length >= MAX_ACTIVE_AVAILABILITY_CHECKS) {
            return { allowed: false, reason: 'check-rate-limited' };
          }
        }
      }
      return { allowed: true };
    }
    case 'try-now': {
      if (
        ACTIVE_DISPATCH_STATES.has(frame.status) ||
        frame.status === 'paused' ||
        !QUIESCENT_MUTABLE_STATES.has(frame.status)
      ) {
        return { allowed: false, reason: 'illegal-state' };
      }
      if (
        frame.status === 'monitoring-expired' ||
        (frame.monitoringExpiresAt !== undefined && frame.monitoringExpiresAt <= nowWallMs)
      ) {
        return { allowed: false, reason: 'monitoring-expired' };
      }
      const slot = slots.find((s) => s.candidateId === action.candidateId);
      if (slot === undefined) {
        return { allowed: false, reason: 'unknown-target' };
      }
      const maxPhaseAttempts =
        root.rootBudget.maxPhaseAttempts > 0
          ? Math.min(root.rootBudget.maxPhaseAttempts, MAX_ROOT_CONTROL_DISPATCHES)
          : MAX_ROOT_CONTROL_DISPATCHES;
      if (
        isCandidateSlotRetired(slot) ||
        (allowedSet !== undefined && !allowedSet.has(slot.candidateId)) ||
        slot.allowUnverifiedTrial !== true ||
        (frame.maxDispatches !== undefined && frame.dispatchedCount >= frame.maxDispatches) ||
        root.dispatchedAttempts >= maxPhaseAttempts
      ) {
        return { allowed: false, reason: 'candidate-ineligible' };
      }
      const obsId = slot.observationIds?.[0] ?? slot.quotaIds?.[0];
      const obs = obsId !== undefined ? lookupRecord(ledger.quotaObservations, obsId) : undefined;
      const notBefore = Math.max(slot.nextEligibleAt ?? 0, obs?.notBefore ?? 0);
      if (notBefore > nowWallMs) {
        return { allowed: false, reason: 'not-before' };
      }
      if (hasUncertainPermitOrAttempt) {
        return { allowed: false, reason: 'uncertain-effect' };
      }
      if (frame.pauseCause === 'spend-limit-reached') {
        return { allowed: false, reason: 'spend-limit-reached' };
      }
      if (
        frame.pauseCause === 'spend-unverifiable' ||
        frame.pauseCause === 'spend-bound-exceeded'
      ) {
        return { allowed: false, reason: 'spend-unverifiable' };
      }
      if (root.usageRollup !== undefined) {
        const strictRes = checkStrictUsdAdmission({
          rootBudget: root.rootBudget,
          rollup: root.usageRollup,
          upperBoundMicrousd: 0,
          upperBoundQuality: 'verified'
        });
        if (!strictRes.allowed) {
          return {
            allowed: false,
            reason:
              strictRes.pauseReason === 'spend-unverifiable'
                ? 'spend-unverifiable'
                : 'spend-limit-reached'
          };
        }
      }
      return { allowed: true };
    }
  }
}

export function buildControlProjection(options: BuildControlProjectionOptions): ControlProjection {
  const { root, frame, ledger, nowWallMs } = options;
  const hostEpoch = options.currentHostEpoch ?? 'default-epoch';
  const generation = frame.frameGeneration ?? root.fence.rootGeneration;
  const slots = frame.candidateSlots ?? [];
  const allowedIds =
    frame.allowedCandidateIds ??
    slots.map((s) => s.candidateId);
  const allowedSet = new Set(allowedIds);

  const candidates: ControlCandidateProjection[] = slots.map((slot, idx) => {
    const retired = isCandidateSlotRetired(slot);
    const policyExcluded = !allowedSet.has(slot.candidateId);
    const obsId = slot.observationIds?.[0] ?? slot.quotaIds?.[0];
    const obs = obsId !== undefined ? lookupRecord(ledger.quotaObservations, obsId) : undefined;
    const isTopUp = obs?.status === 'top-up-required';
    const eligibility: 'eligible' | 'intervention' | 'retired' = retired
      ? 'retired'
      : isTopUp
        ? 'intervention'
        : 'eligible';
    const fresh =
      obs !== undefined &&
      obs.status === 'ready' &&
      obs.hostEpoch === hostEpoch &&
      nowWallMs - obs.observedAt <= 30_000;
    const notBeforeCandidate =
      slot.nextEligibleAt !== undefined && obs?.notBefore !== undefined
        ? Math.max(slot.nextEligibleAt, obs.notBefore)
        : slot.nextEligibleAt ?? obs?.notBefore;

    return Object.freeze({
      candidateId: slot.candidateId,
      nodeId: slot.nodeId,
      backend: slot.backend,
      priority: slot.priority,
      authoredOrder: slot.authoredOrder ?? idx,
      attemptsUsed: slot.dispatchedAttempts,
      maxAttempts: slot.maxAttempts,
      eligibility,
      ...(slot.retirementReason === 'attempts-exhausted' ||
      slot.retirementReason === 'permanent-failure'
        ? { retirementReason: slot.retirementReason }
        : {}),
      policyExcluded,
      ...(obs?.status !== undefined ? { availabilityStatus: obs.status } : {}),
      ...(obs?.source !== undefined ? { availabilitySource: obs.source } : {}),
      ...(obs !== undefined ? { fresh } : {}),
      ...(obs?.resetAt !== undefined ? { resetAt: obs.resetAt } : {}),
      ...(obs?.nextCheckAt !== undefined ? { nextCheckAt: obs.nextCheckAt } : {}),
      ...(notBeforeCandidate !== undefined ? { notBefore: notBeforeCandidate } : {})
    });
  });

  const defaultCandidateId =
    frame.selectedCandidateId ??
    slots.find((s) => !isCandidateSlotRetired(s) && allowedSet.has(s.candidateId))?.candidateId ??
    slots.at(0)?.candidateId ??
    'default';

  const legalActions: ControlLegalActionEntry[] = CONTROL_ACTION_KINDS.map(
    (kind: ControlActionKind): ControlLegalActionEntry => {
      let sampleAction: ControlAction;
      switch (kind) {
        case 'check-now':
          sampleAction =
            defaultCandidateId !== 'default'
              ? { kind: 'check-now', candidateId: defaultCandidateId }
              : { kind: 'check-now' };
          break;
        case 'try-now':
          sampleAction = { kind: 'try-now', candidateId: defaultCandidateId };
          break;
        case 'select-candidate':
          sampleAction = { kind: 'select-candidate', candidateId: defaultCandidateId };
          break;
        case 'set-policy':
          sampleAction = {
            kind: 'set-policy',
            availabilityPolicy: frame.selectionPolicy ?? 'first-ready'
          };
          break;
        case 'set-allowed-candidates':
          sampleAction = {
            kind: 'set-allowed-candidates',
            candidateIds: allowedIds.length > 0 ? allowedIds : [defaultCandidateId]
          };
          break;
        case 'renew-monitoring':
          sampleAction = { kind: 'renew-monitoring', durationMs: 60_000 };
          break;
        case 'pause':
        case 'resume':
        case 'cancel':
          sampleAction = { kind };
          break;
      }

      const evalRes = evaluateControlActionLegality({
        root,
        frame,
        ledger,
        action: sampleAction,
        nowWallMs,
        isTrusted: options.isTrusted
      });
      return Object.freeze({
        kind,
        allowed: evalRes.allowed,
        ...(!evalRes.allowed ? { reason: evalRes.reason } : {})
      });
    }
  );

  const strictMaxMicrousd =
    root.rootBudget.strictUsdBudget?.limitMicrousd ?? root.rootBudget.maxMicrousd;
  const spendMode: 'count-only' | 'strict-usd' =
    root.rootBudget.budgetMode === 'strict-usd' || strictMaxMicrousd !== undefined
      ? 'strict-usd'
      : 'count-only';
  const rollup = root.usageRollup;
  const spendEnforcementQuality: 'verified' | 'estimated' | 'unavailable' | 'count-only' =
    spendMode === 'count-only'
      ? 'count-only'
      : (rollup?.unpricedAttemptCount ?? 0) > 0 || (root.uncertainSpendCount ?? 0) > 0
        ? 'unavailable'
        : (rollup?.estimatedMicrousd ?? 0) > 0
          ? 'estimated'
          : 'verified';

  const maxDispatches = frame.maxDispatches ?? 40;
  const rootMaxDispatches =
    root.rootBudget.maxPhaseAttempts > 0
      ? Math.min(root.rootBudget.maxPhaseAttempts, MAX_ROOT_CONTROL_DISPATCHES)
      : MAX_ROOT_CONTROL_DISPATCHES;

  const evidenceRefs = Object.freeze(
    (options.evidenceRefs ?? []).map((ref) => sanitizeProjectionText(ref, options.sanitize))
  );

  return Object.freeze({
    version: 1,
    rootRunId: root.ledgerRunId,
    queueId: root.queueId,
    invocationId: frame.invocationId,
    workflowId: frame.workflowId,
    ...(frame.nodeId !== undefined ? { nodeId: frame.nodeId } : {}),
    generation,
    frameKind: frame.kind,
    state: frame.status,
    ...(frame.selectionPolicy !== undefined
      ? { availabilityPolicy: frame.selectionPolicy }
      : {}),
    ...(frame.selectedCandidateId !== undefined
      ? { selectedCandidateId: frame.selectedCandidateId }
      : {}),
    ...(frame.manualSelectionCandidateId !== undefined
      ? { manualSelectionCandidateId: frame.manualSelectionCandidateId }
      : {}),
    ...(slots.length > 0
      ? {
          allowedCandidateIds: Object.freeze([...allowedIds]),
          candidates: Object.freeze(candidates)
        }
      : {}),
    attemptsUsed: frame.dispatchedCount,
    maxDispatches,
    rootDispatchesUsed: root.dispatchedAttempts,
    rootMaxDispatches,
    ...(frame.monitoringStartedAt !== undefined
      ? { monitoringStartedAt: frame.monitoringStartedAt }
      : {}),
    ...(frame.monitoringExpiresAt !== undefined
      ? { monitoringExpiresAt: frame.monitoringExpiresAt }
      : {}),
    ...(frame.monitoringRenewals !== undefined
      ? { monitoringRenewals: frame.monitoringRenewals }
      : {}),
    ...(frame.winningAttemptId !== undefined
      ? { resultStatus: 'done', resultReason: 'completed' }
      : frame.failureCode !== undefined
        ? {
            resultStatus: 'failed',
            resultReason: sanitizeProjectionText(frame.failureCode, options.sanitize)
          }
        : {}),
    ...(options.recoveryCoverage !== undefined
      ? { recoveryCoverage: options.recoveryCoverage }
      : {}),
    ...(options.effectCertainty !== undefined
      ? { effectCertainty: options.effectCertainty }
      : {}),
    spendMode,
    spendEnforcementQuality,
    ...(rollup !== undefined
      ? {
          verifiedMicrousd: rollup.verifiedMicrousd,
          estimatedMicrousd: rollup.estimatedMicrousd,
          unpricedAttemptCount: rollup.unpricedAttemptCount
        }
      : {
          verifiedMicrousd: root.settledMicrousd,
          estimatedMicrousd: 0,
          unpricedAttemptCount: 0
        }),
    ...(strictMaxMicrousd !== undefined ? { maxMicrousd: strictMaxMicrousd } : {}),
    ...(options.policyObservations !== undefined
      ? { policyObservations: Object.freeze([...options.policyObservations]) }
      : {}),
    legalActions: Object.freeze(legalActions),
    evidenceRefs
  });
}

export interface ControlCommandServiceDeps {
  readonly ledgerStore: ControlLedgerStore;
  readonly clock?: ControlClockPort | undefined;
  readonly isTrusted?: (() => boolean) | undefined;
  readonly verifyFence?: ((root: RootControlState) => boolean) | undefined;
  readonly sanitize?: ((value: string) => string) | undefined;
  readonly onTeardownActiveAttempt?:
    | ((input: {
        readonly rootRunId: string;
        readonly invocationId: string;
        readonly attemptId: string;
        readonly reason: 'pause' | 'cancel';
      }) => Promise<void> | void)
    | undefined;
  readonly onCheckNow?:
    | ((input: {
        readonly rootRunId: string;
        readonly invocationId: string;
        readonly candidateIds: readonly string[];
      }) => Promise<void> | void)
    | undefined;
}

const sharedControlCommandQueueTail = new Map<string, Promise<unknown>>();

export class ControlCommandService {
  private readonly clock: ControlClockPort;

  constructor(private readonly deps: ControlCommandServiceDeps) {
    this.clock = deps.clock ?? DEFAULT_CLOCK;
  }

  private serializeOnQueue<T>(queueId: string, fn: () => Promise<T>): Promise<T> {
    const prev = sharedControlCommandQueueTail.get(queueId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tracked = next.then(
      () => undefined,
      () => undefined
    );
    sharedControlCommandQueueTail.set(queueId, tracked);
    return next;
  }

  public async executeControlCommand(
    rawInput: unknown
  ): Promise<ControlCommandAcknowledgement> {
    const validated = validateControlCommandEnvelope(rawInput);
    if (!validated.ok) {
      return Object.freeze({
        version: CONTROL_COMMAND_VERSION,
        commandId: validated.commandId ?? '00000000-0000-0000-0000-000000000000',
        outcome: 'refused',
        generation: 0,
        reason: validated.reason
      });
    }

    const envelope = validated.envelope;
    return this.serializeOnQueue(envelope.queueId, () =>
      this.executeValidatedLocked(envelope)
    );
  }

  /**
   * Redirect a generic `retry-phase` command targeting a candidate-block invocation
   * through the shared candidate control authority so it cannot spawn separately
   * or restore exhausted counters.
   */
  public async redirectLegacyRetryPhase(input: {
    readonly commandId: string;
    readonly rootRunId: string;
    readonly queueId: string;
    readonly invocationId: string;
    readonly candidateId?: string | undefined;
    readonly expectedGeneration?: number | undefined;
  }): Promise<ControlCommandAcknowledgement> {
    const root = this.deps.ledgerStore.getRoot(input.rootRunId);
    const frame = root !== null ? this.findFrame(root, input.invocationId) : undefined;
    const currentGen =
      input.expectedGeneration ??
      frame?.frameGeneration ??
      root?.fence.rootGeneration ??
      0;
    const targetCandidateId =
      input.candidateId ??
      frame?.selectedCandidateId ??
      frame?.candidateSlots?.[0]?.candidateId ??
      'default';

    // If the frame is paused/intervention/monitoring-expired, redirect to 'resume';
    // otherwise redirect to 'try-now' so it must pass all candidate/block/root budget & trial gates.
    const action: ControlAction =
      frame !== undefined && PAUSED_FRAME_STATES.has(frame.status)
        ? { kind: 'resume' }
        : { kind: 'try-now', candidateId: targetCandidateId };

    return this.executeValidatedLocked({
      version: 1,
      commandId: input.commandId,
      rootRunId: input.rootRunId,
      queueId: input.queueId,
      invocationId: input.invocationId,
      expectedGeneration: currentGen,
      action
    });
  }

  public hasCandidateFrame(rootRunId: string, invocationId: string): boolean {
    const root = this.deps.ledgerStore.getRoot(rootRunId);
    if (root === null) return false;
    return this.findFrame(root, invocationId) !== undefined;
  }

  private findFrame(
    root: RootControlState,
    invocationId: string
  ): ControlFrame | undefined {
    const direct = lookupRecord(root.framesByKey, invocationId);
    if (direct !== undefined) return direct;
    return Object.values(root.framesByKey).find(
      (f) => f.invocationId === invocationId
    );
  }

  private async executeValidatedLocked(
    envelope: ControlCommandEnvelope
  ): Promise<ControlCommandAcknowledgement> {
    const nowWallMs = this.clock.nowWallMs();
    const nowMonoMs = this.clock.nowMonotonicMs();
    const hostEpoch = this.clock.hostEpoch ?? 'default-epoch';
    const payloadDigest = computeControlCommandDigest(envelope);

    let trusted = true;
    if (this.deps.isTrusted !== undefined) {
      try {
        trusted = this.deps.isTrusted() === true;
      } catch {
        trusted = false;
      }
    }

    const readRes = this.deps.ledgerStore.read();
    if (!readRes.ok) {
      return Object.freeze({
        version: CONTROL_COMMAND_VERSION,
        commandId: envelope.commandId,
        outcome: 'refused',
        generation: envelope.expectedGeneration,
        reason:
          readRes.code === 'unsupported-control-ledger-version'
            ? 'unsupported-control-version'
            : 'invalid-command'
      });
    }

    const initialRoot = lookupRecord(readRes.ledger.roots, envelope.rootRunId);
    if (initialRoot === undefined || initialRoot.queueId !== envelope.queueId) {
      return Object.freeze({
        version: CONTROL_COMMAND_VERSION,
        commandId: envelope.commandId,
        outcome: 'refused',
        generation: 0,
        reason: trusted ? 'unknown-target' : 'trust-denied'
      });
    }

    const initialFrame = this.findFrame(initialRoot, envelope.invocationId);
    if (initialFrame === undefined) {
      return Object.freeze({
        version: CONTROL_COMMAND_VERSION,
        commandId: envelope.commandId,
        outcome: 'refused',
        generation: initialRoot.fence.rootGeneration,
        reason: trusted ? 'unknown-target' : 'trust-denied'
      });
    }

    const currentGeneration =
      initialFrame.frameGeneration ?? initialRoot.fence.rootGeneration;

    // 1. Check command receipt deduplication BEFORE generation check so identical retries
    //    return their original persisted acknowledgement.
    const existingReceipt = (initialRoot.commandReceipts ?? []).find(
      (r) => r.commandId === envelope.commandId
    );
    if (existingReceipt !== undefined) {
      const projection = buildControlProjection({
        root: initialRoot,
        frame: initialFrame,
        ledger: readRes.ledger,
        nowWallMs,
        currentHostEpoch: hostEpoch,
        isTrusted: trusted,
        sanitize: this.deps.sanitize
      });
      if (existingReceipt.payloadDigest !== payloadDigest) {
        return Object.freeze({
          version: CONTROL_COMMAND_VERSION,
          commandId: envelope.commandId,
          outcome: 'refused',
          generation: currentGeneration,
          reason: 'invalid-command',
          projection
        });
      }
      return Object.freeze({
        version: CONTROL_COMMAND_VERSION,
        commandId: envelope.commandId,
        outcome: existingReceipt.acknowledgement.outcome,
        generation: existingReceipt.acknowledgement.generation,
        ...(existingReceipt.acknowledgement.reason !== undefined
          ? {
              reason: existingReceipt.acknowledgement
                .reason as ControlCommandRefusalReason
            }
          : {}),
        projection
      });
    }

    // 2. Check workspace trust
    if (!trusted) {
      const projection = buildControlProjection({
        root: initialRoot,
        frame: initialFrame,
        ledger: readRes.ledger,
        nowWallMs,
        currentHostEpoch: hostEpoch,
        isTrusted: false,
        sanitize: this.deps.sanitize
      });
      return Object.freeze({
        version: CONTROL_COMMAND_VERSION,
        commandId: envelope.commandId,
        outcome: 'refused',
        generation: currentGeneration,
        reason: 'trust-denied',
        projection
      });
    }

    // 3. Check generation high-water mark, expectedGeneration, and ownership fence
    const fenceValid =
      this.deps.verifyFence === undefined || this.deps.verifyFence(initialRoot);
    if (
      !fenceValid ||
      (initialRoot.receiptHighWaterGeneration !== undefined &&
        envelope.expectedGeneration <= initialRoot.receiptHighWaterGeneration) ||
      envelope.expectedGeneration !== currentGeneration
    ) {
      const projection = buildControlProjection({
        root: initialRoot,
        frame: initialFrame,
        ledger: readRes.ledger,
        nowWallMs,
        currentHostEpoch: hostEpoch,
        isTrusted: true,
        sanitize: this.deps.sanitize
      });
      return Object.freeze({
        version: CONTROL_COMMAND_VERSION,
        commandId: envelope.commandId,
        outcome: 'refused',
        generation: currentGeneration,
        reason: 'stale-generation',
        projection
      });
    }

    // 4. Evaluate action legality against current state, candidates, deadlines, and budgets
    const legality = evaluateControlActionLegality({
      root: initialRoot,
      frame: initialFrame,
      ledger: readRes.ledger,
      action: envelope.action,
      nowWallMs,
      isTrusted: true
    });
    if (!legality.allowed) {
      const projection = buildControlProjection({
        root: initialRoot,
        frame: initialFrame,
        ledger: readRes.ledger,
        nowWallMs,
        currentHostEpoch: hostEpoch,
        isTrusted: true,
        sanitize: this.deps.sanitize
      });
      return Object.freeze({
        version: CONTROL_COMMAND_VERSION,
        commandId: envelope.commandId,
        outcome: 'refused',
        generation: currentGeneration,
        reason: legality.reason,
        projection
      });
    }

    // 5. If pause/cancel targets an active attempt, run teardown hook
    const activeAttemptId = initialFrame.activeAttemptId;
    if (
      (envelope.action.kind === 'pause' || envelope.action.kind === 'cancel') &&
      activeAttemptId !== undefined
    ) {
      await this.deps.onTeardownActiveAttempt?.({
        rootRunId: envelope.rootRunId,
        invocationId: initialFrame.invocationId,
        attemptId: activeAttemptId,
        reason: envelope.action.kind
      });
    }

    // 6. Commit accepted command mutation, generation advance, and receipt in one ledger write
    const nextGeneration = currentGeneration + 1;
    const mutated = await this.deps.ledgerStore.mutate<{
      readonly ack: ControlCommandAcknowledgement;
      readonly checkCandidateIds?: readonly string[];
    }>({}, ({ ledger }) => {
      const root = lookupRecord(ledger.roots, envelope.rootRunId);
      const frame = root !== undefined ? this.findFrame(root, envelope.invocationId) : undefined;
      if (root === undefined || frame === undefined) {
        return {
          commit: false,
          code: 'control-ledger-corrupt',
          message: 'Target root or frame disappeared before commit.'
        };
      }

      const slots = frame.candidateSlots ?? [];
      let nextFrame: ControlFrame = {
        ...frame,
        frameGeneration: nextGeneration,
        updatedAt: nowWallMs
      };
      let nextRootStatus = root.status;
      let nextRootPauseCause = root.pauseCause;
      let nextRootDispatches = root.dispatchedAttempts;
      let nextAttemptsById = root.attemptsById;
      let nextPermits = ledger.permits;
      let nextChecks = ledger.checks;
      let nextObservations = ledger.quotaObservations;
      let checkCandidateIds: readonly string[] | undefined;

      const appendOverride = (
        override: Omit<ControlPolicyOverrideRecord, 'commandId' | 'generation' | 'appliedAt'>
      ): readonly ControlPolicyOverrideRecord[] =>
        Object.freeze([
          ...(frame.policyOverrides ?? []),
          Object.freeze({
            commandId: envelope.commandId,
            generation: nextGeneration,
            appliedAt: nowWallMs,
            ...override
          })
        ]);

      switch (envelope.action.kind) {
        case 'select-candidate': {
          nextFrame = Object.freeze({
            ...nextFrame,
            selectedCandidateId: envelope.action.candidateId,
            manualSelectionCandidateId: envelope.action.candidateId,
            policyOverrides: appendOverride({
              manualSelectionCandidateId: envelope.action.candidateId
            })
          });
          break;
        }
        case 'set-policy': {
          nextFrame = Object.freeze({
            ...nextFrame,
            selectionPolicy: envelope.action.availabilityPolicy,
            policyOverrides: appendOverride({
              availabilityPolicy: envelope.action.availabilityPolicy
            })
          });
          break;
        }
        case 'set-allowed-candidates': {
          const allowed = Object.freeze([...envelope.action.candidateIds]);
          const currentManual = frame.manualSelectionCandidateId;
          const keepManual =
            currentManual !== undefined &&
            allowed.includes(currentManual);
          const { manualSelectionCandidateId: _prevManual, ...restFrame } = nextFrame;
          nextFrame = Object.freeze({
            ...restFrame,
            ...(keepManual ? { manualSelectionCandidateId: currentManual } : {}),
            allowedCandidateIds: allowed,
            policyOverrides: appendOverride({
              allowedCandidateIds: allowed
            })
          });
          break;
        }
        case 'renew-monitoring': {
          nextFrame = Object.freeze({
            ...nextFrame,
            monitoringStartedAt: frame.monitoringStartedAt ?? nowWallMs,
            monitoringExpiresAt: nowWallMs + envelope.action.durationMs,
            monitoringRenewals: (frame.monitoringRenewals ?? 0) + 1,
            lastClockWallMs: nowWallMs,
            lastClockMonotonicMs: nowMonoMs,
            lastClockHostEpoch: hostEpoch,
            policyOverrides: appendOverride({
              monitoringDurationMs: envelope.action.durationMs
            })
          });
          break;
        }
        case 'check-now': {
          const allowedSet =
            frame.allowedCandidateIds !== undefined
              ? new Set(frame.allowedCandidateIds)
              : undefined;
          const actionCandidateId = envelope.action.candidateId;
          const targetSlots =
            actionCandidateId !== undefined
              ? slots.filter((s) => s.candidateId === actionCandidateId)
              : slots.filter(
                  (s) =>
                    !isCandidateSlotRetired(s) &&
                    (allowedSet === undefined || allowedSet.has(s.candidateId))
                );
          checkCandidateIds = Object.freeze(targetSlots.map((s) => s.candidateId));
          const updatedChecks = { ...nextChecks };
          const updatedObservations = { ...nextObservations };
          for (const slot of targetSlots) {
            const obsId = slot.observationIds?.[0] ?? slot.quotaIds?.[0] ?? `obs:${slot.candidateId}`;
            const alreadyInFlight = Object.values(updatedChecks).some(
              (c) =>
                (c.stage === 'pending' || c.stage === 'started') &&
                (c.observationId === obsId || c.quotaKey === obsId)
            );
            if (!alreadyInFlight) {
              const checkId = `chk:${envelope.commandId}:${slot.candidateId}`;
              updatedChecks[checkId] = Object.freeze({
                checkId,
                quotaKey: obsId,
                observationId: obsId,
                backend: slot.backend,
                sponsorLedgerRunId: root.ledgerRunId,
                sponsorRootRunId: root.ledgerRunId,
                generation: nextGeneration,
                startedAt: nowWallMs,
                deadlineAt: nowWallMs + 10_000,
                stage: 'settled' as const,
                completedAt: nowWallMs,
                status: 'completed' as const
              });
              const prevObs = lookupRecord(updatedObservations, obsId);
              updatedObservations[obsId] = Object.freeze({
                quotaKey: obsId,
                observationId: obsId,
                backend: slot.backend,
                status: prevObs?.status ?? 'ready',
                source: prevObs?.source ?? 'qualified-status',
                observedAt: nowWallMs,
                observedMonotonicAt: nowMonoMs,
                hostEpoch,
                checkAttempts: (prevObs?.checkAttempts ?? 0) + 1,
                lastCheckStartedAt: nowWallMs
              });
            }
          }
          nextChecks = Object.freeze(updatedChecks);
          nextObservations = Object.freeze(updatedObservations);
          nextFrame = Object.freeze(nextFrame);
          break;
        }
        case 'try-now': {
          const targetId = envelope.action.candidateId;
          const nextSlots = slots.map((s) =>
            s.candidateId === targetId
              ? Object.freeze({
                  ...s,
                  dispatchedAttempts: s.dispatchedAttempts + 1,
                  status: 'in-flight' as const
                })
              : s
          );
          const slot = nextSlots.find((s) => s.candidateId === targetId)!;
          const attemptId = `${frame.invocationId}:${targetId}:attempt-${slot.dispatchedAttempts}`;
          const nextFence: ExecutionFence = Object.freeze({
            ...root.fence,
            rootGeneration: Math.max(root.fence.rootGeneration, nextGeneration)
          });
          const attemptRecord: ControlAttemptRecord = Object.freeze({
            attemptId,
            ledgerRunId: root.ledgerRunId,
            connectedRunId: root.connectedRunId,
            queueId: root.queueId,
            frameKey: frame.frameKey,
            invocationId: frame.invocationId,
            nodeId: slot.nodeId,
            attemptIndex: slot.dispatchedAttempts,
            candidateId: slot.candidateId,
            backend: slot.backend,
            stage: 'pending-dispatch',
            reservedMicrousd: 0,
            committedAt: nowWallMs,
            fence: nextFence
          });
          nextAttemptsById = Object.freeze({
            ...root.attemptsById,
            [attemptId]: attemptRecord
          });
          nextRootDispatches = root.dispatchedAttempts + 1;
          const { manualSelectionCandidateId: _clearedManual, ...restFrame } = nextFrame;
          nextFrame = Object.freeze({
            ...restFrame,
            status: 'dispatch-pending',
            selectedCandidateId: targetId,
            activeAttemptId: attemptId,
            dispatchedCount: frame.dispatchedCount + 1,
            candidateSlots: Object.freeze(nextSlots)
          });
          break;
        }
        case 'pause': {
          if (frame.activeAttemptId !== undefined) {
            const activeAttempt = lookupRecord(root.attemptsById, frame.activeAttemptId);
            if (activeAttempt !== undefined && activeAttempt.stage !== 'settled') {
              nextAttemptsById = Object.freeze({
                ...root.attemptsById,
                [activeAttempt.attemptId]: Object.freeze({
                  ...activeAttempt,
                  stage: 'settled',
                  terminalStatus: 'canceled',
                  settledAt: nowWallMs
                })
              });
            }
            const releasedPermits = { ...nextPermits };
            for (const [pid, permit] of Object.entries(releasedPermits)) {
              if (permit.attemptId === frame.activeAttemptId) {
                delete releasedPermits[pid];
              }
            }
            nextPermits = Object.freeze(releasedPermits);
          }
          const { activeAttemptId: _clearedActive, ...restFrame } = nextFrame;
          nextFrame = Object.freeze({
            ...restFrame,
            status: 'paused',
            pauseCause: 'operator-pause',
            waitStateReleasedSlot: true
          });
          nextRootStatus = 'paused';
          nextRootPauseCause = 'operator-pause';
          break;
        }
        case 'resume': {
          const { pauseCause: _clearedPause, ...restFrame } = nextFrame;
          const resumedStatus: ControlFrameStatus =
            frame.status === 'monitoring-expired' ? 'waiting-availability' : 'selecting';
          nextFrame = Object.freeze({
            ...restFrame,
            status: resumedStatus,
            lastClockWallMs: nowWallMs,
            lastClockMonotonicMs: nowMonoMs,
            lastClockHostEpoch: hostEpoch
          });
          nextRootStatus = 'in-flight';
          nextRootPauseCause = undefined;
          break;
        }
        case 'cancel': {
          if (frame.activeAttemptId !== undefined) {
            const activeAttempt = lookupRecord(root.attemptsById, frame.activeAttemptId);
            if (activeAttempt !== undefined && activeAttempt.stage !== 'settled') {
              nextAttemptsById = Object.freeze({
                ...root.attemptsById,
                [activeAttempt.attemptId]: Object.freeze({
                  ...activeAttempt,
                  stage: 'settled',
                  terminalStatus: 'canceled',
                  settledAt: nowWallMs
                })
              });
            }
            const releasedPermits = { ...nextPermits };
            for (const [pid, permit] of Object.entries(releasedPermits)) {
              if (permit.attemptId === frame.activeAttemptId) {
                delete releasedPermits[pid];
              }
            }
            nextPermits = Object.freeze(releasedPermits);
          }
          const {
            activeAttemptId: _clearedActive,
            manualSelectionCandidateId: _clearedManual,
            ...restFrame
          } = nextFrame;
          nextFrame = Object.freeze({
            ...restFrame,
            status: 'canceled',
            completedAt: nowWallMs,
            waitStateReleasedSlot: true
          });
          nextRootStatus = 'canceled';
          break;
        }
      }

      const newReceipt: ControlCommandReceiptRecord = Object.freeze({
        commandId: envelope.commandId,
        payloadDigest,
        invocationId: frame.invocationId,
        generation: nextGeneration,
        acceptedAt: nowWallMs,
        acknowledgement: Object.freeze({
          version: CONTROL_COMMAND_VERSION,
          commandId: envelope.commandId,
          outcome: 'accepted' as const,
          generation: nextGeneration
        })
      });

      let receipts = [...(root.commandReceipts ?? []), newReceipt];
      let highWater = root.receiptHighWaterGeneration;
      if (receipts.length > MAX_CONTROL_COMMAND_RECEIPTS_PER_ROOT) {
        const overflow = receipts.length - MAX_CONTROL_COMMAND_RECEIPTS_PER_ROOT;
        const evicted = receipts.slice(0, overflow);
        receipts = receipts.slice(overflow);
        for (const ev of evicted) {
          highWater =
            highWater !== undefined
              ? Math.max(highWater, ev.generation)
              : ev.generation;
        }
      }

      const nextFence: ExecutionFence = Object.freeze({
        ...root.fence,
        rootGeneration: Math.max(root.fence.rootGeneration, nextGeneration)
      });

      const { pauseCause: _oldPauseCause, ...restRoot } = root;
      const nextRoot: RootControlState = Object.freeze({
        ...restRoot,
        status: nextRootStatus,
        ...(nextRootPauseCause !== undefined ? { pauseCause: nextRootPauseCause } : {}),
        ...(nextRootStatus === 'canceled' ? { completedAt: nowWallMs } : {}),
        fence: nextFence,
        dispatchedAttempts: nextRootDispatches,
        attemptsById: nextAttemptsById,
        framesByKey: Object.freeze({
          ...root.framesByKey,
          [frame.frameKey]: nextFrame
        }),
        commandReceipts: Object.freeze(receipts),
        ...(highWater !== undefined ? { receiptHighWaterGeneration: highWater } : {}),
        updatedAt: nowWallMs
      });

      const nextLedger: ControlLedger = Object.freeze({
        ...ledger,
        roots: Object.freeze({
          ...ledger.roots,
          [envelope.rootRunId]: nextRoot
        }),
        quotaObservations: nextObservations,
        permits: nextPermits,
        checks: nextChecks
      });

      const projection = buildControlProjection({
        root: nextRoot,
        frame: nextFrame,
        ledger: nextLedger,
        nowWallMs,
        currentHostEpoch: hostEpoch,
        isTrusted: true,
        sanitize: this.deps.sanitize
      });

      const ack: ControlCommandAcknowledgement = Object.freeze({
        version: CONTROL_COMMAND_VERSION,
        commandId: envelope.commandId,
        outcome: 'accepted',
        generation: nextGeneration,
        projection
      });

      return {
        commit: true,
        plan: {
          nextLedger,
          targetRootId: envelope.rootRunId,
          expectedFence: root.fence,
          allowSettlementReserve:
            envelope.action.kind === 'pause' || envelope.action.kind === 'cancel',
          result: {
            ack,
            ...(checkCandidateIds !== undefined ? { checkCandidateIds } : {})
          }
        }
      };
    });

    if (!mutated.ok) {
      return Object.freeze({
        version: CONTROL_COMMAND_VERSION,
        commandId: envelope.commandId,
        outcome: 'refused',
        generation: currentGeneration,
        reason: 'stale-generation'
      });
    }

    if (
      envelope.action.kind === 'check-now' &&
      mutated.result.checkCandidateIds !== undefined
    ) {
      await this.deps.onCheckNow?.({
        rootRunId: envelope.rootRunId,
        invocationId: envelope.invocationId,
        candidateIds: mutated.result.checkCandidateIds
      });
    }

    return mutated.result.ack;
  }
}
