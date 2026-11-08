/**
 * FR-R5-F28 (SPEC-06, D1, D4, D6, D7; WF-17..19; AC-24, AC-25, AC-27, AC-28) —
 * Backend availability service.
 *
 * Responsibilities:
 * - Resolve candidate quota context and observation IDs (qualified shared vs
 *   occurrence-scoped unknown identity with shared `unknown-local-quota` capacity 1).
 * - Normalize canonical credit/rate-limit diagnostics (`classifyCreditStatus`,
 *   `backoffForCause`) and counted-trial outcomes into `QuotaObservation` records
 *   while preserving 15-minute transient and 60-minute hard-credit dispatch floors.
 * - Execute bounded read-only availability checks with per-observation deduplication,
 *   60,000 ms minimum quota check start interval, 3-check concurrency, deadline +
 *   quota-byte-order scheduling, 10,000 ms absolute abort, and D6 check sponsorship
 *   in `ControlLedgerStore` without consuming Phase attempts.
 *
 * Zero `vscode` imports.
 */

import {
  AVAILABILITY_CHECK_TIMEOUT_MS,
  BACKEND_AVAILABILITY_VERSION,
  MIN_QUOTA_CHECK_INTERVAL_MS,
  MAX_CONCURRENT_AVAILABILITY_CHECKS,
  UNKNOWN_LOCAL_QUOTA_ID,
  buildUnknownObservationId,
  computeNextQuotaCheckSchedule,
  isQuotaObservationFreshReady,
  resolveObservationIdsForContext,
  validateQuotaContext,
  validateQuotaObservation,
  type AvailabilityAdapterCheckResponse,
  type BackendAvailabilityAdapter,
  type FrozenPhaseQuotaTarget,
  type QuotaContext,
  type QuotaObservation,
  type QuotaObservationSource,
  type QuotaObservationStatus
} from '../contracts/backend-availability';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import type {
  AvailabilityCheckRecord,
  ControlClockPort,
  QuotaObservationRecord,
  RootControlState
} from '../contracts/control-ledger';
import {
  backoffForCause,
  toDelayedRetryCause
} from '../controller/rate-limit-backoff';
import {
  classifyCreditStatus,
  type CreditStatusInput
} from '../parser/credit-status';
import {
  ControlLedgerStore,
  lookupRecord
} from './workflow-execution/control-ledger-store';

export interface AvailabilityClockPort extends ControlClockPort {
  readonly hostEpoch: string;
  sleepMs?(durationMs: number, signal?: AbortSignal): Promise<void>;
}

export interface CheckSubscriberSponsorCandidate {
  readonly rootRunId: string;
  readonly sequence: number;
  readonly generation: number;
  readonly pausedOrExpired?: boolean | undefined;
}

export interface AvailabilityCheckRequest {
  readonly requestId?: string | undefined;
  readonly candidateOccurrenceId: string;
  readonly frozenPhase: FrozenPhaseQuotaTarget;
  readonly generation: number;
  readonly dueAt?: number | undefined;
  readonly subscribers: readonly CheckSubscriberSponsorCandidate[];
  readonly getCurrentGeneration?: (() => number) | undefined;
}

export type AvailabilityCheckExecutionOutcome =
  | {
      readonly ok: true;
      readonly deduplicated: boolean;
      readonly checkId: string;
      readonly sponsorRootRunId: string;
      readonly sharedSubscriberRootIds: readonly string[];
      readonly observations: readonly QuotaObservation[];
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'check-unsupported'
        | 'check-rate-limited'
        | 'stale-generation'
        | 'wrong-identity'
        | 'spend-unverifiable'
        | 'spend-limit-reached'
        | 'no-eligible-subscriber'
        | 'ledger-error';
      readonly message: string;
      readonly observation?: QuotaObservation | undefined;
    };

export interface CandidateResolvedQuotaTarget {
  readonly candidateOccurrenceId: string;
  readonly backend: BackendRunnerKind;
  readonly context: QuotaContext;
  readonly observationIds: readonly string[];
}

export interface DiagnosticObservationInput {
  readonly candidateOccurrenceId: string;
  readonly frozenPhase: FrozenPhaseQuotaTarget;
  readonly generation: number;
  readonly cause?: string | undefined;
  readonly resetsAtMs?: number | null | undefined;
  readonly topUpRequired?: boolean | undefined;
  readonly processExitCode?: number | null | undefined;
  readonly creditStatusInput?: CreditStatusInput | undefined;
}

export interface CountedTrialObservationInput {
  readonly candidateOccurrenceId: string;
  readonly frozenPhase: FrozenPhaseQuotaTarget;
  readonly generation: number;
  readonly expectedGeneration: number;
  readonly trialSucceeded: boolean;
  readonly cause?: string | undefined;
  readonly resetsAtMs?: number | null | undefined;
}

function compareUtf8Bytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function defaultSleepMs(durationMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      resolve();
    }, durationMs);
    timer.unref();
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

function toObservationRecord(
  obs: QuotaObservation,
  backend: BackendRunnerKind,
  checkAttempts: number,
  lastCheckStartedAt?: number | undefined
): QuotaObservationRecord {
  return Object.freeze({
    quotaKey: obs.observationId,
    observationId: obs.observationId,
    quotaId: obs.quotaId,
    generation: obs.generation,
    backend,
    status: obs.status,
    source: obs.source,
    observedAt: obs.observedAt,
    ...(obs.observedMonotonicAt !== undefined
      ? { observedMonotonicAt: obs.observedMonotonicAt }
      : {}),
    hostEpoch: obs.hostEpoch,
    ...(obs.resetAt !== undefined ? { resetAt: obs.resetAt } : {}),
    ...(obs.notBefore !== undefined ? { notBefore: obs.notBefore } : {}),
    ...(obs.nextCheckAt !== undefined ? { nextCheckAt: obs.nextCheckAt } : {}),
    pollIndex: obs.pollIndex,
    capacity: obs.capacity,
    checkAttempts,
    ...(lastCheckStartedAt !== undefined ? { lastCheckStartedAt } : {})
  });
}

export function fromObservationRecord(
  record: QuotaObservationRecord
): QuotaObservation | undefined {
  const candidate: QuotaObservation = {
    observationId: record.observationId ?? record.quotaKey,
    quotaId: record.quotaId ?? record.quotaKey,
    generation: record.generation ?? 0,
    status:
      record.status === 'rate-limited'
        ? record.resetAt !== undefined
          ? 'cooldown-known'
          : 'cooldown-unknown'
        : record.status === 'credit-exhausted'
          ? 'cooldown-unknown'
          : record.status === 'unknown'
            ? 'unreachable'
            : record.status === 'unsupported'
              ? 'check-unsupported'
              : record.status,
    source: record.source ?? 'qualified-status',
    observedAt: record.observedAt,
    ...(record.observedMonotonicAt !== undefined
      ? { observedMonotonicAt: record.observedMonotonicAt }
      : {}),
    hostEpoch: record.hostEpoch ?? 'legacy-epoch',
    ...(record.resetAt !== undefined ? { resetAt: record.resetAt } : {}),
    ...(record.notBefore !== undefined ? { notBefore: record.notBefore } : {}),
    ...(record.nextCheckAt !== undefined ? { nextCheckAt: record.nextCheckAt } : {}),
    pollIndex: record.pollIndex ?? 0,
    capacity: record.capacity ?? 1
  };
  const validated = validateQuotaObservation(candidate);
  return validated.ok ? validated.value : undefined;
}

export interface BackendAvailabilityServiceDeps {
  readonly ledgerStore: ControlLedgerStore;
  readonly clock: AvailabilityClockPort;
  readonly getAdapter: (kind: BackendRunnerKind) => BackendAvailabilityAdapter;
}

export class BackendAvailabilityService {
  private readonly ledgerStore: ControlLedgerStore;
  private readonly clock: AvailabilityClockPort;
  private readonly getAdapter: (kind: BackendRunnerKind) => BackendAvailabilityAdapter;
  private readonly inFlightByObservationId = new Map<
    string,
    Promise<AvailabilityCheckExecutionOutcome>
  >();
  private readonly lastCheckStartByQuotaKey = new Map<string, number>();
  private checkCounter = 0;

  public constructor(deps: BackendAvailabilityServiceDeps) {
    this.ledgerStore = deps.ledgerStore;
    this.clock = deps.clock;
    this.getAdapter = deps.getAdapter;
  }

  public resolveCandidateQuotaTarget(
    frozenPhase: FrozenPhaseQuotaTarget,
    candidateOccurrenceId: string
  ): CandidateResolvedQuotaTarget {
    const adapter = this.getAdapter(frozenPhase.runner);
    const rawContext = adapter.resolveQuotaContext(frozenPhase);
    const validated = validateQuotaContext(rawContext);
    if (!validated.ok) {
      throw new Error(validated.message);
    }
    const context = validated.value;
    const observationIds = resolveObservationIdsForContext(
      context,
      candidateOccurrenceId
    );
    return Object.freeze({
      candidateOccurrenceId,
      backend: frozenPhase.runner,
      context,
      observationIds
    });
  }

  public isCandidateReady(
    frozenPhase: FrozenPhaseQuotaTarget,
    candidateOccurrenceId: string
  ): boolean {
    const target = this.resolveCandidateQuotaTarget(
      frozenPhase,
      candidateOccurrenceId
    );
    const readResult = this.ledgerStore.read();
    if (!readResult.ok) return false;
    const nowWallMs = this.clock.nowWallMs();
    for (const obsId of target.observationIds) {
      const record = lookupRecord(readResult.ledger.quotaObservations, obsId);
      const obs = record !== undefined ? fromObservationRecord(record) : undefined;
      if (
        !isQuotaObservationFreshReady(obs, nowWallMs, this.clock.hostEpoch)
      ) {
        return false;
      }
    }
    return true;
  }

  public getObservation(observationId: string): QuotaObservation | undefined {
    const readResult = this.ledgerStore.read();
    if (!readResult.ok) return undefined;
    const record = lookupRecord(
      readResult.ledger.quotaObservations,
      observationId
    );
    return record !== undefined ? fromObservationRecord(record) : undefined;
  }

  /**
   * Normalize canonical credit/rate-limit diagnostics and persist updated observations.
   * Non-credit process failures never establish readiness.
   * Existing 15-minute transient and 60-minute hard-credit dispatch floors retain authority.
   */
  public async recordDiagnosticObservation(
    input: DiagnosticObservationInput
  ): Promise<readonly QuotaObservation[]> {
    const target = this.resolveCandidateQuotaTarget(
      input.frozenPhase,
      input.candidateOccurrenceId
    );
    const nowWallMs = this.clock.nowWallMs();
    const nowMonotonicMs = this.clock.nowMonotonicMs();

    let status: QuotaObservationStatus;
    let source: QuotaObservationSource = 'canonical-diagnostic';
    let resetAt: number | undefined;
    let notBeforeDelayMs: number | undefined;

    if (input.topUpRequired === true) {
      status = 'top-up-required';
    } else if (input.creditStatusInput !== undefined) {
      const creditStatus = classifyCreditStatus(input.creditStatusInput);
      source = 'qualified-status';
      if (creditStatus === 'recovered') {
        status = 'ready';
      } else if (creditStatus === 'unreachable') {
        status = 'unreachable';
      } else {
        status =
          input.resetsAtMs !== undefined &&
          input.resetsAtMs !== null &&
          Number.isFinite(input.resetsAtMs) &&
          input.resetsAtMs > nowWallMs
            ? 'cooldown-known'
            : 'cooldown-unknown';
        if (status === 'cooldown-known' && typeof input.resetsAtMs === 'number') {
          resetAt = input.resetsAtMs;
        }
      }
    } else {
      const delayedCause = toDelayedRetryCause(input.cause);
      if (delayedCause === 'rate_limit') {
        notBeforeDelayMs = backoffForCause(
          'rate_limit',
          input.resetsAtMs,
          { now: () => nowWallMs },
          input.cause
        );
        if (
          input.resetsAtMs !== undefined &&
          input.resetsAtMs !== null &&
          Number.isFinite(input.resetsAtMs) &&
          input.resetsAtMs > nowWallMs
        ) {
          status = 'cooldown-known';
          resetAt = input.resetsAtMs;
        } else {
          status = 'cooldown-unknown';
        }
      } else if (delayedCause === 'transient_error') {
        notBeforeDelayMs = backoffForCause('transient_error', null, {
          now: () => nowWallMs
        });
        status = 'unreachable';
      } else {
        // Non-credit process error: never proves readiness.
        status = 'unreachable';
      }
    }

    const updatedObservations: QuotaObservation[] = [];

    await this.ledgerStore.mutate({}, ({ ledger }) => {
      const nextObservations: Record<string, QuotaObservationRecord> = {
        ...ledger.quotaObservations
      };

      for (let i = 0; i < target.observationIds.length; i += 1) {
        const obsId = target.observationIds.at(i)!;
        const quotaId =
          target.context.identity === 'unknown'
            ? UNKNOWN_LOCAL_QUOTA_ID
            : (target.context.quotaIds.at(i) ?? target.context.quotaIds.at(0)!);
        const existingRecord = lookupRecord(nextObservations, obsId);
        const existingObs =
          existingRecord !== undefined
            ? fromObservationRecord(existingRecord)
            : undefined;

        const existingNotBefore = existingObs?.notBefore;
        const candidateNotBefore =
          notBeforeDelayMs !== undefined ? nowWallMs + notBeforeDelayMs : undefined;
        const effectiveNotBefore =
          existingNotBefore !== undefined && candidateNotBefore !== undefined
            ? Math.max(existingNotBefore, candidateNotBefore)
            : (candidateNotBefore ?? existingNotBefore);

        const currentPollIndex = existingObs?.pollIndex ?? 0;
        const schedule =
           target.context.statusCheck === 'unsupported' && status !== 'top-up-required' && status !== 'ready'
            ? { nextCheckAt: undefined, pollIndex: currentPollIndex }
            : computeNextQuotaCheckSchedule({
                nowMs: nowWallMs,
                observationId: obsId,
                generation: input.generation,
                status,
                resetAt,
                pollIndex: currentPollIndex,
                advancePollIndex: false,
                lastCheckStartedAt: existingRecord?.lastCheckStartedAt
              });

        const obsCandidate: QuotaObservation = {
          observationId: obsId,
          quotaId,
          generation: input.generation,
          status:
            target.context.statusCheck === 'unsupported' &&
            status !== 'top-up-required' &&
            status !== 'cooldown-known' &&
            status !== 'cooldown-unknown'
              ? 'check-unsupported'
              : status,
          source,
          observedAt: nowWallMs,
          observedMonotonicAt: nowMonotonicMs,
          hostEpoch: this.clock.hostEpoch,
          ...(resetAt !== undefined ? { resetAt } : {}),
          ...(effectiveNotBefore !== undefined
            ? { notBefore: effectiveNotBefore }
            : {}),
          ...(schedule.nextCheckAt !== undefined
            ? { nextCheckAt: schedule.nextCheckAt }
            : {}),
          pollIndex: schedule.pollIndex,
          capacity: target.context.capacity ?? 1
        };

        const validated = validateQuotaObservation(obsCandidate);
        if (!validated.ok) {
          continue;
        }
        updatedObservations.push(validated.value);
        nextObservations[obsId] = toObservationRecord(
          validated.value,
          target.backend,
          existingRecord?.checkAttempts ?? 0,
          existingRecord?.lastCheckStartedAt
        );
      }

      return {
        commit: true,
        plan: {
          nextLedger: {
            ...ledger,
            quotaObservations: nextObservations
          },
          result: undefined
        }
      };
    });

    return Object.freeze(updatedObservations);
  }

  /**
   * Record the outcome of an explicitly configured counted execution trial.
   * For unknown quota identity, readiness is scoped strictly to `unknown/<candidateOccurrenceId>`
   * and never shared with other unknown candidates or `unknown-local-quota`.
   */
  public async recordCountedTrialOutcome(
    input: CountedTrialObservationInput
  ): Promise<readonly QuotaObservation[]> {
    if (input.generation !== input.expectedGeneration) {
      return Object.freeze([]);
    }
    const target = this.resolveCandidateQuotaTarget(
      input.frozenPhase,
      input.candidateOccurrenceId
    );
    if (!input.trialSucceeded) {
      return this.recordDiagnosticObservation({
        candidateOccurrenceId: input.candidateOccurrenceId,
        frozenPhase: input.frozenPhase,
        generation: input.generation,
        cause: input.cause,
        resetsAtMs: input.resetsAtMs
      });
    }

    const nowWallMs = this.clock.nowWallMs();
    const nowMonotonicMs = this.clock.nowMonotonicMs();
    const updated: QuotaObservation[] = [];

    await this.ledgerStore.mutate({}, ({ ledger }) => {
      const nextObservations: Record<string, QuotaObservationRecord> = {
        ...ledger.quotaObservations
      };
      for (let i = 0; i < target.observationIds.length; i += 1) {
        const obsId = target.observationIds.at(i)!;
        const quotaId =
          target.context.identity === 'unknown'
            ? UNKNOWN_LOCAL_QUOTA_ID
            : (target.context.quotaIds.at(i) ?? target.context.quotaIds.at(0)!);
        const existingRecord = lookupRecord(nextObservations, obsId);
        const existingObs =
          existingRecord !== undefined
            ? fromObservationRecord(existingRecord)
            : undefined;

        const obsCandidate: QuotaObservation = {
          observationId: obsId,
          quotaId,
          generation: input.generation,
          status: 'ready',
          source: 'counted-trial',
          observedAt: nowWallMs,
          observedMonotonicAt: nowMonotonicMs,
          hostEpoch: this.clock.hostEpoch,
          ...(existingObs?.notBefore !== undefined
            ? { notBefore: existingObs.notBefore }
            : {}),
          pollIndex: 0,
          capacity: target.context.capacity ?? 1
        };
        const validated = validateQuotaObservation(obsCandidate);
        if (validated.ok) {
          updated.push(validated.value);
          nextObservations[obsId] = toObservationRecord(
            validated.value,
            target.backend,
            existingRecord?.checkAttempts ?? 0,
            existingRecord?.lastCheckStartedAt
          );
        }
      }
      return {
        commit: true,
        plan: {
          nextLedger: {
            ...ledger,
            quotaObservations: nextObservations
          },
          result: undefined
        }
      };
    });

    return Object.freeze(updated);
  }

  /**
   * Run a batch of due availability checks, respecting:
   * - Earliest due deadline ordering with quota-ID UTF-8 byte-order tie-breaking
   * - Deduplication by `observationId`
   * - Per-quota minimum start interval (60,000 ms)
   * - Maximum 3 concurrent checks (`MAX_CONCURRENT_AVAILABILITY_CHECKS = 3`)
   * - Absolute 10,000 ms abort per check so one hung check never stalls other slots
   */
  public async runDueChecks(
    requests: readonly AvailabilityCheckRequest[]
  ): Promise<readonly AvailabilityCheckExecutionOutcome[]> {
    if (requests.length === 0) return Object.freeze([]);

    const indexed = requests.map((req, index) => {
      const target = this.resolveCandidateQuotaTarget(
        req.frozenPhase,
        req.candidateOccurrenceId
      );
      const primaryQuotaId = target.context.quotaIds.at(0) ?? UNKNOWN_LOCAL_QUOTA_ID;
      const primaryObservationId =
        target.observationIds.at(0) ??
        buildUnknownObservationId(req.candidateOccurrenceId);
      return {
        index,
        req,
        target,
        primaryQuotaId,
        primaryObservationId,
        dueAt: req.dueAt ?? this.clock.nowWallMs()
      };
    });

    indexed.sort((a, b) => {
      if (a.dueAt !== b.dueAt) return a.dueAt - b.dueAt;
      const quotaCmp = compareUtf8Bytes(a.primaryQuotaId, b.primaryQuotaId);
      if (quotaCmp !== 0) return quotaCmp;
      return compareUtf8Bytes(a.primaryObservationId, b.primaryObservationId);
    });

    const results = new Array<AvailabilityCheckExecutionOutcome>(requests.length);
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < indexed.length) {
        const currentIdx = cursor;
        cursor += 1;
        const item = indexed.at(currentIdx);
        if (item === undefined) break;
        const outcome = await this.checkCandidateAvailability(item.req);
        results[item.index] = outcome;
      }
    };

    const workerCount = Math.min(
      MAX_CONCURRENT_AVAILABILITY_CHECKS,
      indexed.length
    );
    const workers: Promise<void>[] = [];
    for (let w = 0; w < workerCount; w += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);

    return Object.freeze(results);
  }

  /**
   * Execute or join a bounded status check for a single candidate request.
   */
  public async checkCandidateAvailability(
    request: AvailabilityCheckRequest
  ): Promise<AvailabilityCheckExecutionOutcome> {
    if (
      request.getCurrentGeneration !== undefined &&
      request.getCurrentGeneration() !== request.generation
    ) {
      return {
        ok: false,
        reason: 'stale-generation',
        message: 'Check request generation is already stale before start.'
      };
    }

    const adapter = this.getAdapter(request.frozenPhase.runner);
    const rawContext = adapter.resolveQuotaContext(request.frozenPhase);
    const validatedContext = validateQuotaContext(rawContext);
    if (!validatedContext.ok) {
      return {
        ok: false,
        reason: 'wrong-identity',
        message: validatedContext.message
      };
    }
    const context = validatedContext.value;
    const observationIds = resolveObservationIdsForContext(
      context,
      request.candidateOccurrenceId
    );
    const primaryObsId =
      observationIds.at(0) ??
      buildUnknownObservationId(request.candidateOccurrenceId);

    // If an in-flight check already exists for this observationId, deduplicate and join it.
    const existingInFlight = this.inFlightByObservationId.get(primaryObsId);
    if (existingInFlight !== undefined) {
      const joined = await existingInFlight;
      if (!joined.ok) return joined;
      return {
        ...joined,
        deduplicated: true
      };
    }

    const promise = this.executeSingleCheck(
      request,
      adapter,
      context,
      observationIds,
      primaryObsId
    );
    this.inFlightByObservationId.set(primaryObsId, promise);
    try {
      return await promise;
    } finally {
      this.inFlightByObservationId.delete(primaryObsId);
    }
  }

  private async executeSingleCheck(
    request: AvailabilityCheckRequest,
    adapter: BackendAvailabilityAdapter,
    context: QuotaContext,
    observationIds: readonly string[],
    primaryObsId: string
  ): Promise<AvailabilityCheckExecutionOutcome> {
    const nowStartMs = this.clock.nowWallMs();
    const nowStartMonotonicMs = this.clock.nowMonotonicMs();

    // Unsupported adapter check handling
    if (
      context.statusCheck === 'unsupported' ||
      adapter.statusCheck === 'unsupported' ||
      adapter.checkAvailability === undefined
    ) {
      const unsupportedObs = await this.persistUnsupportedObservation(
        request,
        context,
        observationIds,
        nowStartMs,
        nowStartMonotonicMs
      );
      return {
        ok: false,
        reason: 'check-unsupported',
        message: `Adapter '${context.adapterId}' does not support non-executing status checks.`,
        ...(unsupportedObs !== undefined ? { observation: unsupportedObs } : {})
      };
    }

    // Per-quota minimum start-rate limit (60,000 ms)
    for (const qId of context.quotaIds) {
      const rateKey =
        context.identity === 'unknown' ? primaryObsId : qId;
      const lastStart = this.lastCheckStartByQuotaKey.get(rateKey);
      if (
        lastStart !== undefined &&
        nowStartMs - lastStart < MIN_QUOTA_CHECK_INTERVAL_MS
      ) {
        return {
          ok: false,
          reason: 'check-rate-limited',
          message: `Quota '${rateKey}' was checked less than ${MIN_QUOTA_CHECK_INTERVAL_MS} ms ago.`
        };
      }
    }

    // Select lowest-sequence eligible sponsor from subscribers and reserve cost bound in ledger
    const checkId = `chk-${++this.checkCounter}-${nowStartMs}`;
    const reservationOutcome = await this.reserveCheckInLedger({
      checkId,
      primaryObsId,
      backend: request.frozenPhase.runner,
      generation: request.generation,
      startedAt: nowStartMs,
      deadlineAt: nowStartMs + AVAILABILITY_CHECK_TIMEOUT_MS,
      checkCostBoundMicrousd: context.checkCostBoundMicrousd ?? 0,
      subscribers: request.subscribers
    });

    if (!reservationOutcome.ok) {
      return {
        ok: false,
        reason: reservationOutcome.reason,
        message: reservationOutcome.message
      };
    }

    for (const qId of context.quotaIds) {
      const rateKey =
        context.identity === 'unknown' ? primaryObsId : qId;
      this.lastCheckStartByQuotaKey.set(rateKey, nowStartMs);
    }

    // Run `adapter.checkAvailability` with absolute 10,000 ms abort
    const abortController = new AbortController();
    const sleepFn = this.clock.sleepMs?.bind(this.clock) ?? defaultSleepMs;

    const timeoutPromise = sleepFn(
      AVAILABILITY_CHECK_TIMEOUT_MS,
      abortController.signal
    ).then((): { readonly kind: 'timeout' } => {
      abortController.abort();
      return { kind: 'timeout' };
    });

    const adapterPromise = adapter
      .checkAvailability(context, abortController.signal)
      .then(
        (response): { readonly kind: 'response'; readonly response: AvailabilityAdapterCheckResponse } => ({
          kind: 'response',
          response
        }),
        (): { readonly kind: 'error' } => ({
          kind: 'error'
        })
      );

    const raced = await Promise.race([adapterPromise, timeoutPromise]);
    if (raced.kind !== 'timeout') {
      abortController.abort();
    }

    const completedAtMs = this.clock.nowWallMs();
    const completedMonotonicMs = this.clock.nowMonotonicMs();

    // Check if generation was invalidated while check was in flight
    if (
      request.getCurrentGeneration !== undefined &&
      request.getCurrentGeneration() !== request.generation
    ) {
      await this.settleAbortedOrStaleCheck(
        checkId,
        reservationOutcome.sponsorRootRunId,
        completedAtMs,
        reservationOutcome.reservedMicrousd
      );
      return {
        ok: false,
        reason: 'stale-generation',
        message: 'Observation generation was invalidated while check was in flight.'
      };
    }

    if (raced.kind === 'timeout' || raced.kind === 'error') {
      const unreachableObs = await this.settleCheckAndObservations({
        checkId,
        sponsorRootRunId: reservationOutcome.sponsorRootRunId,
        sharedSubscriberRootIds: reservationOutcome.sharedSubscriberRootIds,
        reservedMicrousd: reservationOutcome.reservedMicrousd,
        costMicrousd: 0,
        costUncertain: false,
        checkStatus: raced.kind === 'timeout' ? 'aborted' : 'failed',
        checkStage: 'settled',
        completedAtMs,
        completedMonotonicMs,
        startedAtMs: nowStartMs,
        request,
        context,
        observationIds,
        outcomesByQuotaId: new Map()
      });
      return {
        ok: true,
        deduplicated: false,
        checkId,
        sponsorRootRunId: reservationOutcome.sponsorRootRunId,
        sharedSubscriberRootIds: reservationOutcome.sharedSubscriberRootIds,
        observations: unreachableObs
      };
    }

    const response = raced.response;
    if (
      (response.version as number) !== BACKEND_AVAILABILITY_VERSION ||
      response.adapterId !== context.adapterId
    ) {
      await this.settleAbortedOrStaleCheck(
        checkId,
        reservationOutcome.sponsorRootRunId,
        completedAtMs,
        reservationOutcome.reservedMicrousd
      );
      return {
        ok: false,
        reason: 'wrong-identity',
        message: 'Availability check response version or adapterId mismatched.'
      };
    }

    const allowedQuotaIds = new Set(context.quotaIds);
    const outcomesByQuotaId = new Map<
      string,
      {
        readonly status: QuotaObservationStatus;
        readonly observedAt?: number | undefined;
        readonly resetAt?: number | undefined;
        readonly capacity?: number | undefined;
      }
    >();

    for (const item of response.outcomes) {
      if (!allowedQuotaIds.has(item.quotaId)) {
        await this.settleAbortedOrStaleCheck(
          checkId,
          reservationOutcome.sponsorRootRunId,
          completedAtMs,
          reservationOutcome.reservedMicrousd
        );
        return {
          ok: false,
          reason: 'wrong-identity',
          message: `Availability check returned outcome for unexpected quotaId '${item.quotaId}'.`
        };
      }
      outcomesByQuotaId.set(item.quotaId, item);
    }

    const settledObservations = await this.settleCheckAndObservations({
      checkId,
      sponsorRootRunId: reservationOutcome.sponsorRootRunId,
      sharedSubscriberRootIds: reservationOutcome.sharedSubscriberRootIds,
      reservedMicrousd: reservationOutcome.reservedMicrousd,
      costMicrousd: response.costMicrousd ?? 0,
      costUncertain: response.costUncertain ?? false,
      checkStatus: 'completed',
      checkStage: response.costUncertain ? 'uncertain' : 'settled',
      completedAtMs,
      completedMonotonicMs,
      startedAtMs: nowStartMs,
      request,
      context,
      observationIds,
      outcomesByQuotaId
    });

    return {
      ok: true,
      deduplicated: false,
      checkId,
      sponsorRootRunId: reservationOutcome.sponsorRootRunId,
      sharedSubscriberRootIds: reservationOutcome.sharedSubscriberRootIds,
      observations: settledObservations
    };
  }

  private async persistUnsupportedObservation(
    request: AvailabilityCheckRequest,
    context: QuotaContext,
    observationIds: readonly string[],
    nowWallMs: number,
    nowMonotonicMs: number
  ): Promise<QuotaObservation | undefined> {
    let firstObs: QuotaObservation | undefined;
    await this.ledgerStore.mutate({}, ({ ledger }) => {
      const nextObservations: Record<string, QuotaObservationRecord> = {
        ...ledger.quotaObservations
      };
      for (let i = 0; i < observationIds.length; i += 1) {
        const obsId = observationIds.at(i)!;
        const quotaId =
          context.identity === 'unknown'
            ? UNKNOWN_LOCAL_QUOTA_ID
            : (context.quotaIds.at(i) ?? context.quotaIds.at(0)!);
        const existingRecord = lookupRecord(nextObservations, obsId);
        const existingObs =
          existingRecord !== undefined
            ? fromObservationRecord(existingRecord)
            : undefined;
        const candidate: QuotaObservation = {
          observationId: obsId,
          quotaId,
          generation: request.generation,
          status: 'check-unsupported',
          source: 'qualified-status',
          observedAt: nowWallMs,
          observedMonotonicAt: nowMonotonicMs,
          hostEpoch: this.clock.hostEpoch,
          ...(existingObs?.notBefore !== undefined
            ? { notBefore: existingObs.notBefore }
            : {}),
          pollIndex: existingObs?.pollIndex ?? 0,
          capacity: context.capacity ?? 1
        };
        const validated = validateQuotaObservation(candidate);
        if (validated.ok) {
          if (firstObs === undefined) firstObs = validated.value;
          nextObservations[obsId] = toObservationRecord(
            validated.value,
            request.frozenPhase.runner,
            existingRecord?.checkAttempts ?? 0,
            existingRecord?.lastCheckStartedAt
          );
        }
      }
      return {
        commit: true,
        plan: {
          nextLedger: {
            ...ledger,
            quotaObservations: nextObservations
          },
          result: undefined
        }
      };
    });
    return firstObs;
  }

  private async reserveCheckInLedger(params: {
    readonly checkId: string;
    readonly primaryObsId: string;
    readonly backend: BackendRunnerKind;
    readonly generation: number;
    readonly startedAt: number;
    readonly deadlineAt: number;
    readonly checkCostBoundMicrousd: number | undefined;
    readonly subscribers: readonly CheckSubscriberSponsorCandidate[];
  }): Promise<
    | {
        readonly ok: true;
        readonly sponsorRootRunId: string;
        readonly sharedSubscriberRootIds: readonly string[];
        readonly reservedMicrousd: number;
      }
    | {
        readonly ok: false;
        readonly reason:
          | 'no-eligible-subscriber'
          | 'spend-unverifiable'
          | 'spend-limit-reached'
          | 'ledger-error';
        readonly message: string;
      }
  > {
    const eligibleSubscribers = [...params.subscribers]
      .filter((s) => !s.pausedOrExpired)
      .sort(
        (a, b) =>
          a.sequence - b.sequence ||
          compareUtf8Bytes(a.rootRunId, b.rootRunId)
      );

    if (eligibleSubscribers.length === 0) {
      return {
        ok: false,
        reason: 'no-eligible-subscriber',
        message: 'No active non-expired subscriber root is eligible to sponsor the status check.'
      };
    }

    let failureReason: string = 'no-eligible-subscriber';

    const outcome = await this.ledgerStore.mutate<{
      readonly sponsorRootRunId: string;
      readonly sharedSubscriberRootIds: readonly string[];
      readonly reservedMicrousd: number;
    }>({}, ({ ledger }) => {
      let chosenSponsor: CheckSubscriberSponsorCandidate | undefined;
      let reservedMicrousd = 0;

      for (const candidate of eligibleSubscribers) {
        const root = lookupRecord(ledger.roots, candidate.rootRunId);
        if (root === undefined) {
          // Allow standalone/fixture subscriber when root is not in ledger
          chosenSponsor = candidate;
          reservedMicrousd = params.checkCostBoundMicrousd ?? 0;
          break;
        }
        if (root.status !== 'in-flight') {
          continue;
        }
        if (root.rootBudget.strictUsdBudget !== undefined) {
          if (
            params.checkCostBoundMicrousd === undefined ||
            (root.uncertainSpendCount ?? 0) > 0
          ) {
            failureReason = 'spend-unverifiable';
            continue;
          }
          const projected =
            root.settledMicrousd +
            root.reservedMicrousd +
            params.checkCostBoundMicrousd;
          if (projected > root.rootBudget.strictUsdBudget.limitMicrousd) {
            failureReason = 'spend-limit-reached';
            continue;
          }
          chosenSponsor = candidate;
          reservedMicrousd = params.checkCostBoundMicrousd;
          break;
        } else {
          chosenSponsor = candidate;
          reservedMicrousd = params.checkCostBoundMicrousd ?? 0;
          break;
        }
      }

      if (chosenSponsor === undefined) {
        return {
          commit: false,
          code: 'strict-usd-budget-exceeded',
          message: `Unable to sponsor availability check (${failureReason}).`
        };
      }

      const nextRoots: Record<string, RootControlState> = { ...ledger.roots };
      const sponsorRoot = lookupRecord(nextRoots, chosenSponsor.rootRunId);
      if (sponsorRoot !== undefined && reservedMicrousd > 0) {
        nextRoots[chosenSponsor.rootRunId] = {
          ...sponsorRoot,
          reservedMicrousd: sponsorRoot.reservedMicrousd + reservedMicrousd,
          updatedAt: params.startedAt
        };
      }

      const checkRecord: AvailabilityCheckRecord = {
        checkId: params.checkId,
        quotaKey: params.primaryObsId,
        observationId: params.primaryObsId,
        backend: params.backend,
        sponsorLedgerRunId: chosenSponsor.rootRunId,
        sponsorRootRunId: chosenSponsor.rootRunId,
        generation: params.generation,
        status: 'running',
        stage: 'started',
        startedAt: params.startedAt,
        deadlineAt: params.deadlineAt,
        reservedMicrousd
      };

      const sharedSubscriberRootIds = eligibleSubscribers
        .filter((s) => s.rootRunId !== chosenSponsor.rootRunId)
        .map((s) => s.rootRunId);

      return {
        commit: true,
        plan: {
          nextLedger: {
            ...ledger,
            roots: nextRoots,
            checks: {
              ...ledger.checks,
              [params.checkId]: checkRecord
            }
          },
          result: {
            sponsorRootRunId: chosenSponsor.rootRunId,
            sharedSubscriberRootIds,
            reservedMicrousd
          }
        }
      };
    });

    if (!outcome.ok) {
      if (
        failureReason === 'spend-unverifiable' ||
        failureReason === 'spend-limit-reached'
      ) {
        return {
          ok: false,
          reason: failureReason,
          message: outcome.message
        };
      }
      return {
        ok: false,
        reason: 'ledger-error',
        message: outcome.message
      };
    }

    return {
      ok: true,
      ...outcome.result
    };
  }

  private async settleAbortedOrStaleCheck(
    checkId: string,
    sponsorRootRunId: string,
    completedAtMs: number,
    reservedMicrousd: number
  ): Promise<void> {
    await this.ledgerStore.mutate({}, ({ ledger }) => {
      const existingCheck = lookupRecord(ledger.checks, checkId);
      if (existingCheck === undefined) {
        return {
          commit: true,
          plan: { nextLedger: ledger, result: undefined }
        };
      }
      const nextRoots: Record<string, RootControlState> = { ...ledger.roots };
      const sponsorRoot = lookupRecord(nextRoots, sponsorRootRunId);
      if (sponsorRoot !== undefined && reservedMicrousd > 0) {
        nextRoots[sponsorRootRunId] = {
          ...sponsorRoot,
          reservedMicrousd: Math.max(
            0,
            sponsorRoot.reservedMicrousd - reservedMicrousd
          ),
          updatedAt: completedAtMs
        };
      }
      return {
        commit: true,
        plan: {
          nextLedger: {
            ...ledger,
            roots: nextRoots,
            checks: {
              ...ledger.checks,
              [checkId]: {
                ...existingCheck,
                status: 'aborted',
                stage: 'settled',
                completedAt: completedAtMs,
                costMicrousd: 0
              }
            }
          },
          result: undefined
        }
      };
    });
  }

  private async settleCheckAndObservations(params: {
    readonly checkId: string;
    readonly sponsorRootRunId: string;
    readonly sharedSubscriberRootIds: readonly string[];
    readonly reservedMicrousd: number;
    readonly costMicrousd: number;
    readonly costUncertain: boolean;
    readonly checkStatus: 'completed' | 'failed' | 'aborted';
    readonly checkStage: 'settled' | 'uncertain';
    readonly completedAtMs: number;
    readonly completedMonotonicMs: number;
    readonly startedAtMs: number;
    readonly request: AvailabilityCheckRequest;
    readonly context: QuotaContext;
    readonly observationIds: readonly string[];
    readonly outcomesByQuotaId: ReadonlyMap<
      string,
      {
        readonly status: QuotaObservationStatus;
        readonly observedAt?: number | undefined;
        readonly resetAt?: number | undefined;
        readonly capacity?: number | undefined;
      }
    >;
  }): Promise<readonly QuotaObservation[]> {
    const settledList: QuotaObservation[] = [];

    await this.ledgerStore.mutate({}, ({ ledger }) => {
      const nextRoots: Record<string, RootControlState> = { ...ledger.roots };
      const sponsorRoot = lookupRecord(nextRoots, params.sponsorRootRunId);
      if (sponsorRoot !== undefined) {
        // Debit sponsor once; keep reservation held if cost is uncertain.
        if (params.costUncertain) {
          nextRoots[params.sponsorRootRunId] = {
            ...sponsorRoot,
            uncertainSpendCount: (sponsorRoot.uncertainSpendCount ?? 0) + 1,
            updatedAt: params.completedAtMs
          };
        } else {
          nextRoots[params.sponsorRootRunId] = {
            ...sponsorRoot,
            reservedMicrousd: Math.max(
              0,
              sponsorRoot.reservedMicrousd - params.reservedMicrousd
            ),
            settledMicrousd: sponsorRoot.settledMicrousd + params.costMicrousd,
            sharedCheckMicrousd:
              (sponsorRoot.sharedCheckMicrousd ?? 0) + params.costMicrousd,
            updatedAt: params.completedAtMs
          };
        }
      }

      const existingCheck = lookupRecord(ledger.checks, params.checkId);
      const nextChecks: Record<string, AvailabilityCheckRecord> = {
        ...ledger.checks
      };
      if (existingCheck !== undefined) {
        nextChecks[params.checkId] = {
          ...existingCheck,
          status: params.checkStatus,
          stage: params.checkStage,
          completedAt: params.completedAtMs,
          costMicrousd: params.costMicrousd,
          costUncertain: params.costUncertain
        };
      }

      const nextObservations: Record<string, QuotaObservationRecord> = {
        ...ledger.quotaObservations
      };

      for (let i = 0; i < params.observationIds.length; i += 1) {
        const obsId = params.observationIds.at(i)!;
        const quotaId =
          params.context.identity === 'unknown'
            ? UNKNOWN_LOCAL_QUOTA_ID
            : (params.context.quotaIds.at(i) ?? params.context.quotaIds.at(0)!);
        const existingRecord = lookupRecord(nextObservations, obsId);
        const existingObs =
          existingRecord !== undefined
            ? fromObservationRecord(existingRecord)
            : undefined;

        const outcomeItem = params.outcomesByQuotaId.get(quotaId);
        let status: QuotaObservationStatus = outcomeItem?.status ?? 'unreachable';
        let resetAt = outcomeItem?.resetAt;

        // Past reset timestamp cannot establish readiness or future cooldown-known
        if (
          status === 'cooldown-known' &&
          (resetAt === undefined || resetAt <= params.completedAtMs)
        ) {
          status = 'cooldown-unknown';
          resetAt = undefined;
        }
        if (status === 'top-up-required') {
          resetAt = undefined;
        }

        const currentPollIndex = existingObs?.pollIndex ?? 0;
        const schedule = computeNextQuotaCheckSchedule({
          nowMs: params.completedAtMs,
          observationId: obsId,
          generation: params.request.generation,
          status,
          resetAt,
          pollIndex: currentPollIndex,
          advancePollIndex: status !== 'ready' && status !== 'cooldown-known',
          lastCheckStartedAt: params.startedAtMs
        });

        const capacity =
          params.context.identity === 'unknown'
            ? 1
            : (outcomeItem?.capacity ??
              params.context.capacity ??
              existingObs?.capacity ??
              1);

        // Preserve existing notBefore dispatch floor even when status check reports ready!
        const preservedNotBefore = existingObs?.notBefore;

        const obsCandidate: QuotaObservation = {
          observationId: obsId,
          quotaId,
          generation: params.request.generation,
          status,
          source: 'qualified-status',
          observedAt: outcomeItem?.observedAt ?? params.completedAtMs,
          observedMonotonicAt: params.completedMonotonicMs,
          hostEpoch: this.clock.hostEpoch,
          ...(resetAt !== undefined ? { resetAt } : {}),
          ...(preservedNotBefore !== undefined
            ? { notBefore: preservedNotBefore }
            : {}),
          ...(schedule.nextCheckAt !== undefined
            ? { nextCheckAt: schedule.nextCheckAt }
            : {}),
          pollIndex: schedule.pollIndex,
          capacity
        };

        const validated = validateQuotaObservation(obsCandidate);
        if (validated.ok) {
          settledList.push(validated.value);
          nextObservations[obsId] = toObservationRecord(
            validated.value,
            params.request.frozenPhase.runner,
            (existingRecord?.checkAttempts ?? 0) + 1,
            params.startedAtMs
          );
        }
      }

      return {
        commit: true,
        plan: {
          nextLedger: {
            ...ledger,
            roots: nextRoots,
            checks: nextChecks,
            quotaObservations: nextObservations
          },
          result: undefined
        }
      };
    });

    return Object.freeze(settledList);
  }
}
