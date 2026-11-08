/**
 * FR-R5-F28 (SPEC-06, D1, D4, D6, D7; WF-17..19; AC-24, AC-25, AC-26, AC-27, AC-28) —
 * Durable control wakeup planner, monitoring window authority, and wall/monotonic
 * clock reconciliation service.
 *
 * Invariants:
 * - Persists wakeup deadlines, deterministic jitter, and monitoring windows in
 *   `ControlLedgerStore` BEFORE arming in-memory timers.
 * - Callbacks wake the authority for serialized reconciliation and never directly
 *   dispatch a Phase.
 * - Enforces the 5,000 ms wall/monotonic clock discontinuity threshold, invalidates
 *   cached readiness on restart or >5,000 ms drift, preserves monotonic lower-bound
 *   dispatch floors (15m transient, 60m hard-credit), and pauses with
 *   `intervention-required` (`clock-regressed`) on >5,000 ms backward wall jumps.
 * - Enforces the 60,000..172,800,000 ms monitoring window (default 86,400,000 ms);
 *   expiry before a future known reset transitions to resumable `monitoring-expired`
 *   without auto-renewal or early dispatch.
 *
 * Zero `vscode` imports.
 */

import {
  CLOCK_DISCONTINUITY_THRESHOLD_MS,
  DEFAULT_MONITORING_WINDOW_MS,
  UNKNOWN_LOCAL_QUOTA_ID,
  computeNextQuotaCheckSchedule,
  isQuotaObservationFreshReady,
  validateMonitoringWindowMs,
  validateQuotaObservation,
  type FrozenPhaseQuotaTarget,
  type QuotaObservation
} from '../../contracts/backend-availability';
import type {
  CandidateRuntimeSlot,
  ControlFrame,
  QuotaObservationRecord
} from '../../contracts/control-ledger';
import type {
  AvailabilityCheckExecutionOutcome,
  AvailabilityClockPort,
  BackendAvailabilityService,
  CheckSubscriberSponsorCandidate
} from '../backend-availability-service';
import { fromObservationRecord } from '../backend-availability-service';
import type { DeadlineTimer } from '../retry-coordinator';
import {
  ControlLedgerStore,
  lookupRecord
} from './control-ledger-store';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

const defaultDeadlineTimer: DeadlineTimer = {
  set(fn, delayMs) {
    const handle = setTimeout(fn, delayMs);
    handle.unref();
    return { clear: () => clearTimeout(handle) };
  }
};

export interface CandidateWakeupDescriptor {
  readonly candidateId: string;
  readonly candidateOccurrenceId: string;
  readonly frozenPhase: FrozenPhaseQuotaTarget;
  readonly priority: number;
  readonly allowUnverifiedTrial?: boolean | undefined;
  readonly retired?: boolean | undefined;
  readonly policyExcluded?: boolean | undefined;
  readonly notBeforeMs?: number | undefined;
}

export interface WaitingFrameRegistrationInput {
  readonly rootRunId: string;
  readonly frameKey: string;
  readonly sequence: number;
  readonly generation: number;
  readonly monitoringWindowMs?: number | undefined;
  readonly candidates: readonly CandidateWakeupDescriptor[];
}

export interface ControlWakeupEvent {
  readonly rootRunId: string;
  readonly frameKey: string;
  readonly generation: number;
  readonly firedAtWallMs: number;
  readonly reason: 'check-due' | 'not-before-elapsed' | 'monitoring-expired';
}

export type FrameWakeupEvaluationOutcome =
  | {
      readonly status: 'ready-to-admit';
      readonly readyCandidateIds: readonly string[];
      readonly selectedCandidateId: string;
      readonly generation: number;
    }
  | {
      readonly status: 'waiting-availability';
      readonly nextWakeupAt?: number | undefined;
      readonly monitoringExpiresAt: number;
      readonly generation: number;
    }
  | {
      readonly status: 'monitoring-expired';
      readonly monitoringExpiresAt: number;
      readonly generation: number;
    }
  | {
      readonly status: 'intervention-required';
      readonly pauseCause:
        | 'clock-regressed'
        | 'manual-recovery-required'
        | 'top-up-required'
        | 'spend-unverifiable'
        | 'spend-limit-reached';
      readonly generation: number;
    }
  | {
      readonly status: 'paused-or-inactive';
      readonly generation: number;
    };

export interface ControlWakeupPlannerDeps {
  readonly ledgerStore: ControlLedgerStore;
  readonly availabilityService: BackendAvailabilityService;
  readonly clock: AvailabilityClockPort;
  readonly timer?: DeadlineTimer | undefined;
  readonly onWakeupDue?: ((event: ControlWakeupEvent) => void | Promise<void>) | undefined;
}

interface ArmedFrameTimer {
  readonly rootRunId: string;
  readonly frameKey: string;
  readonly generation: number;
  readonly firesAtWallMs: number;
  readonly reason: ControlWakeupEvent['reason'];
  readonly handle: { clear(): void };
}

interface RegisteredFrameConfig {
  readonly rootRunId: string;
  readonly frameKey: string;
  readonly sequence: number;
  readonly candidates: readonly CandidateWakeupDescriptor[];
}

function frameMapKey(rootRunId: string, frameKey: string): string {
  return `${rootRunId}::${frameKey}`;
}

export class ControlWakeupPlanner {
  private readonly ledgerStore: ControlLedgerStore;
  private readonly availabilityService: BackendAvailabilityService;
  private readonly clock: AvailabilityClockPort;
  private readonly timer: DeadlineTimer;
  private readonly onWakeupDue:
    | ((event: ControlWakeupEvent) => void | Promise<void>)
    | undefined;
  private readonly armedTimers = new Map<string, ArmedFrameTimer>();
  private readonly registeredFrames = new Map<string, RegisteredFrameConfig>();

  public constructor(deps: ControlWakeupPlannerDeps) {
    this.ledgerStore = deps.ledgerStore;
    this.availabilityService = deps.availabilityService;
    this.clock = deps.clock;
    this.timer = deps.timer ?? defaultDeadlineTimer;
    this.onWakeupDue = deps.onWakeupDue;
  }

  public dispose(): void {
    for (const armed of this.armedTimers.values()) {
      armed.handle.clear();
    }
    this.armedTimers.clear();
  }

  public getArmedWakeup(
    rootRunId: string,
    frameKey: string
  ):
    | {
        readonly generation: number;
        readonly firesAtWallMs: number;
        readonly reason: ControlWakeupEvent['reason'];
      }
    | undefined {
    const armed = this.armedTimers.get(frameMapKey(rootRunId, frameKey));
    if (armed === undefined) return undefined;
    return {
      generation: armed.generation,
      firesAtWallMs: armed.firesAtWallMs,
      reason: armed.reason
    };
  }

  /**
   * Register or update a waiting candidate-block frame, persisting its monitoring window
   * and initial check schedules before arming its wakeup timer.
   */
  public async registerWaitingFrame(
    input: WaitingFrameRegistrationInput
  ): Promise<FrameWakeupEvaluationOutcome> {
    const validatedWindow = validateMonitoringWindowMs(input.monitoringWindowMs);
    if (!validatedWindow.ok) {
      throw new Error(validatedWindow.message);
    }
    const key = frameMapKey(input.rootRunId, input.frameKey);
    this.registeredFrames.set(key, {
      rootRunId: input.rootRunId,
      frameKey: input.frameKey,
      sequence: input.sequence,
      candidates: input.candidates
    });

    const nowWallMs = this.clock.nowWallMs();
    const nowMonotonicMs = this.clock.nowMonotonicMs();

    await this.ledgerStore.mutate(
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
        const frame = lookupRecord(root.framesByKey, input.frameKey);
        if (frame === undefined) {
          return {
            commit: false,
            code: 'control-ledger-corrupt',
            message: `Control frame '${input.frameKey}' not found.`
          };
        }

        // Preserve original monitoringStartedAt and monitoringExpiresAt across re-evaluations/restarts
        const monitoringStartedAt = frame.monitoringStartedAt ?? nowWallMs;
        const monitoringExpiresAt =
          frame.monitoringExpiresAt ??
          monitoringStartedAt + validatedWindow.durationMs;

        const nextObservations: Record<string, QuotaObservationRecord> = {
          ...ledger.quotaObservations
        };
        const nextSlots: CandidateRuntimeSlot[] = [];

        for (const cand of input.candidates) {
          const target = this.availabilityService.resolveCandidateQuotaTarget(
            cand.frozenPhase,
            cand.candidateOccurrenceId
          );
          const existingSlot = frame.candidateSlots?.find(
            (s) => s.candidateId === cand.candidateId
          );

          for (let i = 0; i < target.observationIds.length; i += 1) {
            const obsId = target.observationIds.at(i)!;
            const quotaId =
              target.context.identity === 'unknown'
                ? UNKNOWN_LOCAL_QUOTA_ID
                : (target.context.quotaIds.at(i) ?? target.context.quotaIds.at(0)!);
            const existingRec = lookupRecord(nextObservations, obsId);
            const existingObs =
              existingRec !== undefined
                ? fromObservationRecord(existingRec)
                : undefined;

            if (existingObs === undefined) {
              const initialStatus =
                target.context.statusCheck === 'unsupported'
                  ? 'check-unsupported'
                  : 'cooldown-unknown';
              const schedule =
                initialStatus === 'check-unsupported'
                  ? { nextCheckAt: undefined, pollIndex: 0 }
                  : computeNextQuotaCheckSchedule({
                      nowMs: nowWallMs,
                      observationId: obsId,
                      generation: input.generation,
                      status: initialStatus,
                      pollIndex: 0,
                      advancePollIndex: false
                    });
              const created: QuotaObservation = {
                observationId: obsId,
                quotaId,
                generation: input.generation,
                status: initialStatus,
                source: 'qualified-status',
                observedAt: nowWallMs,
                observedMonotonicAt: nowMonotonicMs,
                hostEpoch: this.clock.hostEpoch,
                ...(cand.notBeforeMs !== undefined
                  ? { notBefore: cand.notBeforeMs }
                  : {}),
                ...(schedule.nextCheckAt !== undefined
                  ? { nextCheckAt: schedule.nextCheckAt }
                  : {}),
                pollIndex: schedule.pollIndex,
                capacity: target.context.capacity ?? 1
              };
              const validatedObs = validateQuotaObservation(created);
              if (validatedObs.ok) {
                nextObservations[obsId] = {
                  quotaKey: obsId,
                  observationId: obsId,
                  quotaId,
                  generation: input.generation,
                  backend: cand.frozenPhase.runner,
                  status: created.status,
                  source: created.source,
                  observedAt: nowWallMs,
                  observedMonotonicAt: nowMonotonicMs,
                  hostEpoch: this.clock.hostEpoch,
                  ...(created.notBefore !== undefined
                    ? { notBefore: created.notBefore }
                    : {}),
                  ...(created.nextCheckAt !== undefined
                    ? { nextCheckAt: created.nextCheckAt }
                    : {}),
                  pollIndex: created.pollIndex,
                  capacity: created.capacity,
                  checkAttempts: 0
                };
              }
            }
          }

          nextSlots.push({
            candidateId: cand.candidateId,
            nodeId:
              existingSlot?.nodeId ??
              cand.frozenPhase.id ??
              cand.frozenPhase.phaseId ??
              cand.candidateId,
            backend: cand.frozenPhase.runner,
            priority: cand.priority,
            maxAttempts: existingSlot?.maxAttempts ?? 3,
            dispatchedAttempts: existingSlot?.dispatchedAttempts ?? 0,
            status: cand.retired
              ? 'exhausted'
              : cand.policyExcluded
                ? 'disabled'
                : (existingSlot?.status ?? 'waiting-availability'),
            ...(cand.notBeforeMs !== undefined
              ? { nextEligibleAt: cand.notBeforeMs }
              : existingSlot?.nextEligibleAt !== undefined
                ? { nextEligibleAt: existingSlot.nextEligibleAt }
                : {}),
            ...(existingSlot?.lastAttemptId !== undefined
              ? { lastAttemptId: existingSlot.lastAttemptId }
              : {}),
            ...(existingSlot?.lastFailureCode !== undefined
              ? { lastFailureCode: existingSlot.lastFailureCode }
              : {}),
            quotaIds: target.context.quotaIds,
            observationIds: target.observationIds,
            ...(cand.allowUnverifiedTrial !== undefined
              ? { allowUnverifiedTrial: cand.allowUnverifiedTrial }
              : {})
          });
        }

        const updatedFrame: ControlFrame = {
          ...frame,
          status:
            frame.status === 'paused' ||
            frame.status === 'completed' ||
            frame.status === 'failed' ||
            frame.status === 'canceled'
              ? frame.status
              : 'waiting-availability',
          frameGeneration: input.generation,
          monitoringStartedAt,
          monitoringExpiresAt,
          monitoringRenewals: frame.monitoringRenewals ?? 0,
          lastClockWallMs: nowWallMs,
          lastClockMonotonicMs: nowMonotonicMs,
          lastClockHostEpoch: this.clock.hostEpoch,
          candidateSlots: nextSlots,
          updatedAt: nowWallMs
        };

        return {
          commit: true,
          plan: {
            nextLedger: {
              ...ledger,
              roots: {
                ...ledger.roots,
                [input.rootRunId]: {
                  ...root,
                  framesByKey: {
                    ...root.framesByKey,
                    [input.frameKey]: updatedFrame
                  },
                  updatedAt: nowWallMs
                }
              },
              quotaObservations: nextObservations
            },
            result: undefined
          }
        };
      }
    );

    return this.evaluateAndArmFrame(input.rootRunId, input.frameKey);
  }

  /**
   * Invalidate obsolete callbacks and advance generation on pause, cancel, policy change,
   * return, or deletion.
   */
  public async invalidateFrameWakeups(
    rootRunId: string,
    frameKey: string,
    options?: {
      readonly nextStatus?: ControlFrame['status'] | undefined;
      readonly pauseCause?: string | undefined;
      readonly removeRegistration?: boolean | undefined;
    }
  ): Promise<number> {
    const key = frameMapKey(rootRunId, frameKey);
    const armed = this.armedTimers.get(key);
    if (armed !== undefined) {
      armed.handle.clear();
      this.armedTimers.delete(key);
    }
    if (options?.removeRegistration) {
      this.registeredFrames.delete(key);
    }

    const nowWallMs = this.clock.nowWallMs();
    let updatedGeneration = 0;

    await this.ledgerStore.mutate({ targetRootId: rootRunId }, ({ ledger }) => {
      const root = lookupRecord(ledger.roots, rootRunId);
      if (root === undefined) {
        return {
          commit: true,
          plan: { nextLedger: ledger, result: undefined }
        };
      }
      const frame = lookupRecord(root.framesByKey, frameKey);
      if (frame === undefined) {
        return {
          commit: true,
          plan: { nextLedger: ledger, result: undefined }
        };
      }
      updatedGeneration = (frame.frameGeneration ?? root.fence.rootGeneration) + 1;
      const nextFrame: ControlFrame = {
        ...frame,
        frameGeneration: updatedGeneration,
        ...(options?.nextStatus !== undefined
          ? { status: options.nextStatus }
          : {}),
        ...(options?.pauseCause !== undefined
          ? { pauseCause: options.pauseCause }
          : {}),
        updatedAt: nowWallMs
      };
      return {
        commit: true,
        plan: {
          nextLedger: {
            ...ledger,
            roots: {
              ...ledger.roots,
              [rootRunId]: {
                ...root,
                fence: {
                  ...root.fence,
                  rootGeneration: Math.max(
                    root.fence.rootGeneration,
                    updatedGeneration
                  )
                },
                framesByKey: {
                  ...root.framesByKey,
                  [frameKey]: nextFrame
                },
                updatedAt: nowWallMs
              }
            }
          },
          result: undefined
        }
      };
    });

    return updatedGeneration;
  }

  /**
   * Explicitly resume a frame that was paused for `clock-regressed` or `monitoring-expired`,
   * establishing a new clock anchor without erasing remaining monotonic delay budgets
   * or replenishing attempt counters.
   */
  public async resumeClockAnchor(
    rootRunId: string,
    frameKey: string
  ): Promise<FrameWakeupEvaluationOutcome> {
    const nowWallMs = this.clock.nowWallMs();
    const nowMonotonicMs = this.clock.nowMonotonicMs();

    await this.ledgerStore.mutate({ targetRootId: rootRunId }, ({ ledger }) => {
      const root = lookupRecord(ledger.roots, rootRunId);
      if (root === undefined) {
        return {
          commit: true,
          plan: { nextLedger: ledger, result: undefined }
        };
      }
      const frame = lookupRecord(root.framesByKey, frameKey);
      if (frame === undefined) {
        return {
          commit: true,
          plan: { nextLedger: ledger, result: undefined }
        };
      }
      const nextGen = (frame.frameGeneration ?? root.fence.rootGeneration) + 1;
      const { pauseCause: _discardedPauseCause, ...restFrame } = frame;
      const nextFrame: ControlFrame = {
        ...restFrame,
        status: 'waiting-availability',
        frameGeneration: nextGen,
        lastClockWallMs: nowWallMs,
        lastClockMonotonicMs: nowMonotonicMs,
        lastClockHostEpoch: this.clock.hostEpoch,
        updatedAt: nowWallMs
      };
      return {
        commit: true,
        plan: {
          nextLedger: {
            ...ledger,
            roots: {
              ...ledger.roots,
              [rootRunId]: {
                ...root,
                framesByKey: {
                  ...root.framesByKey,
                  [frameKey]: nextFrame
                },
                updatedAt: nowWallMs
              }
            }
          },
          result: undefined
        }
      };
    });

    return this.evaluateAndArmFrame(rootRunId, frameKey);
  }

  /**
   * Reconcile all persisted waiting frames once after host restart, sleep, or clock change.
   * Does not replay missed polls, renew monitoring windows, or reset attempt counters.
   */
  public async reconcileAllOnStartupOrClockChange(): Promise<
    Readonly<Record<string, FrameWakeupEvaluationOutcome>>
  > {
    const outcomes: Record<string, FrameWakeupEvaluationOutcome> = {};
    for (const [key, config] of this.registeredFrames.entries()) {
      outcomes[key] = await this.reconcileFrameClocksAndEvaluate(
        config.rootRunId,
        config.frameKey
      );
    }
    return Object.freeze(outcomes);
  }

  /**
   * Reconcile wall/monotonic clocks for a single frame, run any due checks if within
   * the monitoring window, and evaluate/re-arm the next deadline.
   */
  public async reconcileFrameClocksAndEvaluate(
    rootRunId: string,
    frameKey: string,
    options?: { readonly runDueChecksNow?: boolean | undefined }
  ): Promise<FrameWakeupEvaluationOutcome> {
    const nowWallMs = this.clock.nowWallMs();
    const nowMonotonicMs = this.clock.nowMonotonicMs();
    const currentEpoch = this.clock.hostEpoch;
    const config = this.registeredFrames.get(frameMapKey(rootRunId, frameKey));

    const mutateRes = await this.ledgerStore.mutate<boolean>(
      { targetRootId: rootRunId },
      ({ ledger }) => {
        const root = lookupRecord(ledger.roots, rootRunId);
        if (root === undefined) {
          return {
            commit: true,
            plan: { nextLedger: ledger, result: false }
          };
        }
        const frame = lookupRecord(root.framesByKey, frameKey);
        if (frame === undefined) {
          return {
            commit: true,
            plan: { nextLedger: ledger, result: false }
          };
        }

        const prevWallMs = frame.lastClockWallMs;
        const prevMonotonicMs = frame.lastClockMonotonicMs;
        const prevEpoch = frame.lastClockHostEpoch;

        const isRestart = prevEpoch !== undefined && prevEpoch !== currentEpoch;
        const deltaWall =
          prevWallMs !== undefined ? nowWallMs - prevWallMs : 0;
        const deltaMonotonic =
          prevMonotonicMs !== undefined ? nowMonotonicMs - prevMonotonicMs : 0;

        const isBackwardRegression =
          prevWallMs !== undefined &&
          nowWallMs < prevWallMs - CLOCK_DISCONTINUITY_THRESHOLD_MS;

        const isDiscontinuity =
          !isRestart &&
          prevWallMs !== undefined &&
          prevMonotonicMs !== undefined &&
          Math.abs(deltaWall - deltaMonotonic) > CLOCK_DISCONTINUITY_THRESHOLD_MS;

        const nextObservations: Record<string, QuotaObservationRecord> = {
          ...ledger.quotaObservations
        };

        if (isRestart || isDiscontinuity || isBackwardRegression) {
          // Invalidate cached ready observations and preserve monotonic lower-bound delays
          for (const [obsKey, rec] of Object.entries(nextObservations)) {
            let nextNotBefore = rec.notBefore;
            if (
              !isRestart &&
              rec.notBefore !== undefined &&
              prevWallMs !== undefined &&
              deltaMonotonic >= 0
            ) {
              const remainingMonotonicDelay = Math.max(
                0,
                rec.notBefore - prevWallMs - deltaMonotonic
              );
              nextNotBefore = Math.max(
                rec.notBefore,
                nowWallMs + remainingMonotonicDelay
              );
            } else if (
              isBackwardRegression &&
              rec.notBefore !== undefined
            ) {
              const remainingDelay = Math.max(0, rec.notBefore - prevWallMs);
              nextNotBefore = Math.max(rec.notBefore, nowWallMs + remainingDelay);
            }

            const shouldInvalidateReady = rec.status === 'ready';
            const updatedStatus = shouldInvalidateReady
              ? 'cooldown-unknown'
              : rec.status;

            // On restart or discontinuity, if nextCheckAt was in the past, schedule once from nowWallMs without replaying missed polls
            let nextCheckAt = rec.nextCheckAt;
            if (
              (shouldInvalidateReady ||
                (nextCheckAt !== undefined && nextCheckAt <= nowWallMs)) &&
              updatedStatus !== 'check-unsupported' &&
              updatedStatus !== 'top-up-required'
            ) {
              const sched = computeNextQuotaCheckSchedule({
                nowMs: nowWallMs,
                observationId: rec.observationId ?? obsKey,
                generation:
                  rec.generation ??
                  frame.frameGeneration ??
                  root.fence.rootGeneration,
                status:
                  updatedStatus === 'cooldown-known' &&
                  rec.resetAt !== undefined &&
                  rec.resetAt > nowWallMs
                    ? 'cooldown-known'
                    : 'cooldown-unknown',
                resetAt: rec.resetAt,
                pollIndex: rec.pollIndex ?? 0,
                advancePollIndex: false
              });
              nextCheckAt = sched.nextCheckAt;
            }

            nextObservations[obsKey] = {
              ...rec,
              status: updatedStatus,
              hostEpoch: currentEpoch,
              ...(nextNotBefore !== undefined ? { notBefore: nextNotBefore } : {}),
              ...(nextCheckAt !== undefined ? { nextCheckAt } : {})
            };
          }
        }

        const nextSlots = frame.candidateSlots?.map((slot) => {
          if (slot.nextEligibleAt === undefined || prevWallMs === undefined) {
            return slot;
          }
          if (!isRestart && (isDiscontinuity || isBackwardRegression)) {
            const elapsedMono = Math.max(0, deltaMonotonic);
            const remainingMono = Math.max(
              0,
              slot.nextEligibleAt - prevWallMs - elapsedMono
            );
            return {
              ...slot,
              nextEligibleAt: Math.max(
                slot.nextEligibleAt,
                nowWallMs + remainingMono
              )
            };
          }
          return slot;
        });

        const nextFrame: ControlFrame = {
          ...frame,
          ...(isBackwardRegression
            ? {
                status: 'intervention-required',
                pauseCause: 'clock-regressed'
              }
            : {}),
          ...(nextSlots !== undefined ? { candidateSlots: nextSlots } : {}),
          lastClockWallMs: nowWallMs,
          lastClockMonotonicMs: nowMonotonicMs,
          lastClockHostEpoch: currentEpoch,
          updatedAt: nowWallMs
        };

        return {
          commit: true,
          plan: {
            nextLedger: {
              ...ledger,
              roots: {
                ...ledger.roots,
                [rootRunId]: {
                  ...root,
                  framesByKey: {
                    ...root.framesByKey,
                    [frameKey]: nextFrame
                  },
                  updatedAt: nowWallMs
                }
              },
              quotaObservations: nextObservations
            },
            result: isBackwardRegression
          }
        };
      }
    );

    if (mutateRes.ok && mutateRes.result) {
      this.disarmFrameTimer(rootRunId, frameKey);
      const root = this.ledgerStore.getRoot(rootRunId);
      const frame = root !== null ? lookupRecord(root.framesByKey, frameKey) : undefined;
      return {
        status: 'intervention-required',
        pauseCause: 'clock-regressed',
        generation: frame?.frameGeneration ?? root?.fence.rootGeneration ?? 1
      };
    }

    if (options?.runDueChecksNow && config !== undefined) {
      await this.runDueChecksForFrame(rootRunId, frameKey);
    }

    return this.evaluateAndArmFrame(rootRunId, frameKey);
  }

  /**
   * Execute due availability checks for all eligible candidates in a waiting frame.
   */
  public async runDueChecksForFrame(
    rootRunId: string,
    frameKey: string
  ): Promise<readonly AvailabilityCheckExecutionOutcome[]> {
    const key = frameMapKey(rootRunId, frameKey);
    const config = this.registeredFrames.get(key);
    if (config === undefined) return Object.freeze([]);

    const root = this.ledgerStore.getRoot(rootRunId);
    const frame =
      root !== null ? lookupRecord(root.framesByKey, frameKey) : undefined;
    if (root === null || frame === undefined) return Object.freeze([]);

    if (
      frame.status === 'paused' ||
      frame.status === 'monitoring-expired' ||
      frame.status === 'intervention-required' ||
      frame.status === 'completed' ||
      frame.status === 'failed' ||
      frame.status === 'canceled'
    ) {
      return Object.freeze([]);
    }

    const nowWallMs = this.clock.nowWallMs();
    const expiresAt =
      frame.monitoringExpiresAt ?? nowWallMs + DEFAULT_MONITORING_WINDOW_MS;
    if (nowWallMs >= expiresAt) {
      return Object.freeze([]);
    }

    const currentGeneration =
      frame.frameGeneration ?? root.fence.rootGeneration;
    const readResult = this.ledgerStore.read();
    if (!readResult.ok) return Object.freeze([]);

    const dueRequests = [];
    for (const cand of config.candidates) {
      if (cand.retired || cand.policyExcluded) continue;
      const target = this.availabilityService.resolveCandidateQuotaTarget(
        cand.frozenPhase,
        cand.candidateOccurrenceId
      );
      if (target.context.statusCheck === 'unsupported') {
        continue;
      }
      const primaryObsId = target.observationIds.at(0);
      const obsRec =
        primaryObsId !== undefined
          ? lookupRecord(readResult.ledger.quotaObservations, primaryObsId)
          : undefined;
      const obs =
        obsRec !== undefined ? fromObservationRecord(obsRec) : undefined;

      if (isQuotaObservationFreshReady(obs, nowWallMs, this.clock.hostEpoch)) {
        continue;
      }
      if (obs?.status === 'top-up-required' || obs?.status === 'check-unsupported') {
        continue;
      }

      const nextCheckAt = obs?.nextCheckAt ?? nowWallMs;
      if (nextCheckAt <= nowWallMs) {
        const subscribers: CheckSubscriberSponsorCandidate[] = [
          {
            rootRunId,
            sequence: config.sequence,
            generation: currentGeneration,
            pausedOrExpired: false
          }
        ];
        dueRequests.push({
          candidateOccurrenceId: cand.candidateOccurrenceId,
          frozenPhase: cand.frozenPhase,
          generation: currentGeneration,
          dueAt: nextCheckAt,
          subscribers,
          getCurrentGeneration: () => {
            const latestRoot = this.ledgerStore.getRoot(rootRunId);
            const latestFrame =
              latestRoot !== null
                ? lookupRecord(latestRoot.framesByKey, frameKey)
                : undefined;
            if (
              latestRoot === null ||
              latestFrame === undefined ||
              latestFrame.status === 'paused' ||
              latestFrame.status === 'canceled' ||
              latestFrame.status === 'completed' ||
              latestFrame.status === 'failed' ||
              latestFrame.status === 'monitoring-expired'
            ) {
              return -1;
            }
            return (
              latestFrame.frameGeneration ?? latestRoot.fence.rootGeneration
            );
          }
        });
      }
    }

    if (dueRequests.length === 0) return Object.freeze([]);
    return this.availabilityService.runDueChecks(dueRequests);
  }

  /**
   * Evaluate the current state of a waiting frame, transition to `monitoring-expired`
   * or `intervention-required` if applicable, or arm the earliest wakeup deadline.
   */
  public async evaluateAndArmFrame(
    rootRunId: string,
    frameKey: string
  ): Promise<FrameWakeupEvaluationOutcome> {
    const key = frameMapKey(rootRunId, frameKey);
    const config = this.registeredFrames.get(key);
    const readResult = this.ledgerStore.read();
    if (!readResult.ok) {
      return { status: 'paused-or-inactive', generation: 0 };
    }
    const root = lookupRecord(readResult.ledger.roots, rootRunId);
    const frame =
      root !== undefined ? lookupRecord(root.framesByKey, frameKey) : undefined;
    if (root === undefined || frame === undefined) {
      this.disarmFrameTimer(rootRunId, frameKey);
      return { status: 'paused-or-inactive', generation: 0 };
    }

    const generation = frame.frameGeneration ?? root.fence.rootGeneration;

    if (
      root.status !== 'in-flight' ||
      frame.status === 'paused' ||
      frame.status === 'completed' ||
      frame.status === 'failed' ||
      frame.status === 'canceled'
    ) {
      this.disarmFrameTimer(rootRunId, frameKey);
      return { status: 'paused-or-inactive', generation };
    }

    if (frame.status === 'intervention-required') {
      this.disarmFrameTimer(rootRunId, frameKey);
      return {
        status: 'intervention-required',
        pauseCause:
          (frame.pauseCause as
            | 'clock-regressed'
            | 'manual-recovery-required'
            | 'top-up-required'
            | 'spend-unverifiable'
            | 'spend-limit-reached'
            | undefined) ?? 'manual-recovery-required',
        generation
      };
    }

    const nowWallMs = this.clock.nowWallMs();
    const monitoringExpiresAt =
      frame.monitoringExpiresAt ?? nowWallMs + DEFAULT_MONITORING_WINDOW_MS;

    // Check monitoring window expiry first — never auto-renew or dispatch early!
    if (nowWallMs >= monitoringExpiresAt || frame.status === 'monitoring-expired') {
      this.disarmFrameTimer(rootRunId, frameKey);
      if (frame.status !== 'monitoring-expired') {
        await this.ledgerStore.mutate({ targetRootId: rootRunId }, ({ ledger }) => {
          const latestRoot = lookupRecord(ledger.roots, rootRunId);
          const latestFrame =
            latestRoot !== undefined
              ? lookupRecord(latestRoot.framesByKey, frameKey)
              : undefined;
          if (latestRoot === undefined || latestFrame === undefined) {
            return {
              commit: true,
              plan: { nextLedger: ledger, result: undefined }
            };
          }
          return {
            commit: true,
            plan: {
              nextLedger: {
                ...ledger,
                roots: {
                  ...ledger.roots,
                  [rootRunId]: {
                    ...latestRoot,
                    framesByKey: {
                      ...latestRoot.framesByKey,
                      [frameKey]: {
                        ...latestFrame,
                        status: 'monitoring-expired',
                        pauseCause: 'monitoring-expired',
                        updatedAt: nowWallMs
                      }
                    },
                    updatedAt: nowWallMs
                  }
                }
              },
              result: undefined
            }
          };
        });
      }
      return {
        status: 'monitoring-expired',
        monitoringExpiresAt,
        generation
      };
    }

    const candidates = config?.candidates ?? [];
    const eligibleCandidates = [...candidates]
      .filter((c) => !c.retired && !c.policyExcluded)
      .sort((a, b) => a.priority - b.priority);

    const readyCandidateIds: string[] = [];
    let earliestCheckWakeupAt: number | undefined;
    let earliestNotBeforeWakeupAt: number | undefined;
    let hasAutomaticRecoveryCandidate = false;
    let hasTopUpRequired = false;

    for (const cand of eligibleCandidates) {
      const target = this.availabilityService.resolveCandidateQuotaTarget(
        cand.frozenPhase,
        cand.candidateOccurrenceId
      );
      const slot = frame.candidateSlots?.find(
        (s) => s.candidateId === cand.candidateId
      );
      const slotNotBefore = slot?.nextEligibleAt ?? cand.notBeforeMs;

      let allObservationsReady = true;
      let maxNotBeforeMs = slotNotBefore;
      let candidateCanRecoverAutomatically = false;

      for (const obsId of target.observationIds) {
        const obsRec = lookupRecord(readResult.ledger.quotaObservations, obsId);
        const obs =
          obsRec !== undefined ? fromObservationRecord(obsRec) : undefined;

        if (obs?.notBefore !== undefined) {
          maxNotBeforeMs =
            maxNotBeforeMs !== undefined
              ? Math.max(maxNotBeforeMs, obs.notBefore)
              : obs.notBefore;
        }

        const freshReady =
          obs !== undefined &&
          obs.status === 'ready' &&
          obs.hostEpoch === this.clock.hostEpoch &&
          nowWallMs - obs.observedAt >= 0 &&
          nowWallMs - obs.observedAt <= 30_000;

        if (!freshReady) {
          allObservationsReady = false;
        }

        if (obs?.status === 'top-up-required') {
          hasTopUpRequired = true;
        } else if (
          target.context.statusCheck === 'supported' &&
          obs?.status !== 'check-unsupported'
        ) {
          candidateCanRecoverAutomatically = true;
          const nextCheck = obs?.nextCheckAt;
          if (nextCheck !== undefined) {
            earliestCheckWakeupAt =
              earliestCheckWakeupAt !== undefined
                ? Math.min(earliestCheckWakeupAt, nextCheck)
                : nextCheck;
          }
        } else if (cand.allowUnverifiedTrial === true) {
          candidateCanRecoverAutomatically = true;
        }
      }

      if (candidateCanRecoverAutomatically || allObservationsReady) {
        hasAutomaticRecoveryCandidate = true;
      }

      const notBeforeSatisfied =
        maxNotBeforeMs === undefined || nowWallMs >= maxNotBeforeMs;

      if (allObservationsReady && notBeforeSatisfied) {
        readyCandidateIds.push(cand.candidateId);
      } else if (
        (allObservationsReady || cand.allowUnverifiedTrial === true) &&
        maxNotBeforeMs !== undefined &&
        maxNotBeforeMs > nowWallMs
      ) {
        earliestNotBeforeWakeupAt =
          earliestNotBeforeWakeupAt !== undefined
            ? Math.min(earliestNotBeforeWakeupAt, maxNotBeforeMs)
            : maxNotBeforeMs;
      }
    }

    if (readyCandidateIds.length > 0) {
      this.disarmFrameTimer(rootRunId, frameKey);
      return {
        status: 'ready-to-admit',
        readyCandidateIds: Object.freeze(readyCandidateIds),
        selectedCandidateId: readyCandidateIds.at(0)!,
        generation
      };
    }

    if (!hasAutomaticRecoveryCandidate && eligibleCandidates.length > 0) {
      this.disarmFrameTimer(rootRunId, frameKey);
      const pauseCause = hasTopUpRequired
        ? 'top-up-required'
        : 'manual-recovery-required';
      await this.ledgerStore.mutate({ targetRootId: rootRunId }, ({ ledger }) => {
        const latestRoot = lookupRecord(ledger.roots, rootRunId);
        const latestFrame =
          latestRoot !== undefined
            ? lookupRecord(latestRoot.framesByKey, frameKey)
            : undefined;
        if (latestRoot === undefined || latestFrame === undefined) {
          return {
            commit: true,
            plan: { nextLedger: ledger, result: undefined }
          };
        }
        return {
          commit: true,
          plan: {
            nextLedger: {
              ...ledger,
              roots: {
                ...ledger.roots,
                [rootRunId]: {
                  ...latestRoot,
                  framesByKey: {
                    ...latestRoot.framesByKey,
                    [frameKey]: {
                      ...latestFrame,
                      status: 'intervention-required',
                      pauseCause,
                      updatedAt: nowWallMs
                    }
                  },
                  updatedAt: nowWallMs
                }
              }
            },
            result: undefined
          }
        };
      });
      return {
        status: 'intervention-required',
        pauseCause,
        generation
      };
    }

    // Determine earliest wakeup among nextCheckAt, notBefore, and monitoringExpiresAt
    let nextWakeupAt: number = monitoringExpiresAt;
    let wakeupReason: ControlWakeupEvent['reason'] = 'monitoring-expired';

    if (
      earliestCheckWakeupAt !== undefined &&
      earliestCheckWakeupAt < nextWakeupAt
    ) {
      nextWakeupAt = earliestCheckWakeupAt;
      wakeupReason = 'check-due';
    }
    if (
      earliestNotBeforeWakeupAt !== undefined &&
      earliestNotBeforeWakeupAt < nextWakeupAt
    ) {
      nextWakeupAt = earliestNotBeforeWakeupAt;
      wakeupReason = 'not-before-elapsed';
    }

    this.armFrameTimer({
      rootRunId,
      frameKey,
      generation,
      firesAtWallMs: nextWakeupAt,
      reason: wakeupReason
    });

    return {
      status: 'waiting-availability',
      nextWakeupAt,
      monitoringExpiresAt,
      generation
    };
  }

  private disarmFrameTimer(rootRunId: string, frameKey: string): void {
    const key = frameMapKey(rootRunId, frameKey);
    const existing = this.armedTimers.get(key);
    if (existing !== undefined) {
      existing.handle.clear();
      this.armedTimers.delete(key);
    }
  }

  private armFrameTimer(input: {
    readonly rootRunId: string;
    readonly frameKey: string;
    readonly generation: number;
    readonly firesAtWallMs: number;
    readonly reason: ControlWakeupEvent['reason'];
  }): void {
    const key = frameMapKey(input.rootRunId, input.frameKey);
    const existing = this.armedTimers.get(key);
    if (
      existing !== undefined &&
      existing.generation === input.generation &&
      existing.firesAtWallMs === input.firesAtWallMs &&
      existing.reason === input.reason
    ) {
      return;
    }
    if (existing !== undefined) {
      existing.handle.clear();
      this.armedTimers.delete(key);
    }

    const nowWallMs = this.clock.nowWallMs();
    const delayMs = Math.min(
      Math.max(0, input.firesAtWallMs - nowWallMs),
      MAX_TIMER_DELAY_MS
    );

    const handle = this.timer.set(() => {
      this.armedTimers.delete(key);
      void this.handleTimerFired(input);
    }, delayMs);

    this.armedTimers.set(key, {
      ...input,
      handle
    });
  }

  private async handleTimerFired(input: {
    readonly rootRunId: string;
    readonly frameKey: string;
    readonly generation: number;
    readonly firesAtWallMs: number;
    readonly reason: ControlWakeupEvent['reason'];
  }): Promise<void> {
    const root = this.ledgerStore.getRoot(input.rootRunId);
    const frame =
      root !== null
        ? lookupRecord(root.framesByKey, input.frameKey)
        : undefined;
    if (root === null || frame === undefined) return;
    const currentGen = frame.frameGeneration ?? root.fence.rootGeneration;
    if (currentGen !== input.generation) {
      // Obsolete callback generation: ignore completely.
      return;
    }
    if (
      root.status !== 'in-flight' ||
      frame.status === 'paused' ||
      frame.status === 'completed' ||
      frame.status === 'failed' ||
      frame.status === 'canceled'
    ) {
      return;
    }

    // Reconcile clocks, run due checks if check-due, and re-evaluate
    await this.reconcileFrameClocksAndEvaluate(
      input.rootRunId,
      input.frameKey,
      { runDueChecksNow: input.reason === 'check-due' }
    );

    if (this.onWakeupDue !== undefined) {
      await Promise.resolve(
        this.onWakeupDue({
          rootRunId: input.rootRunId,
          frameKey: input.frameKey,
          generation: input.generation,
          firedAtWallMs: this.clock.nowWallMs(),
          reason: input.reason
        })
      ).catch(() => undefined);
    }
  }
}
