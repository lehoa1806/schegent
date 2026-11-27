import { describe, expect, it } from 'vitest';
import {
  AVAILABILITY_CHECK_TIMEOUT_MS,
  BACKEND_AVAILABILITY_VERSION,
  MAX_POLL_INDEX,
  READY_OBSERVATION_TTL_MS,
  UNKNOWN_LOCAL_QUOTA_ID,
  UNKNOWN_RESET_POLL_INTERVALS_MS,
  computeDeterministicCheckJitterMs,
  computeNextQuotaCheckSchedule,
  isQuotaObservationFreshReady,
  validateMonitoringWindowMs,
  validateQuotaContext,
  validateQuotaObservation,
  type BackendAvailabilityAdapter,
  type FrozenPhaseQuotaTarget
} from '../../../src/contracts/backend-availability';
import {
  CONTROL_LEDGER_VERSION,
  createEmptyControlLedger,
  type RootControlState
} from '../../../src/contracts/control-ledger';
import {
  RATE_LIMIT_BACKOFF_MS,
  TRANSIENT_BACKOFF_MS
} from '../../../src/contracts/retry-bounds';
import {
  BackendAvailabilityService,
  type AvailabilityClockPort
} from '../../../src/services/backend-availability-service';
import { ControlLedgerStore } from '../../../src/services/workflow-execution/control-ledger-store';
import type { Memento } from '../../../src/state/workspace-state';

class InMemoryMemento implements Memento {
  private readonly data = new Map<string, unknown>();

  public get<T>(key: string, defaultValue?: T): T | undefined {
    if (!this.data.has(key)) return defaultValue;
    return this.data.get(key) as T;
  }

  public async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, JSON.parse(JSON.stringify(value)));
    }
  }
}

class FakeAvailabilityClock implements AvailabilityClockPort {
  public hostEpoch = 'epoch-1';
  public wallMs = 1_700_000_000_000;
  public monotonicMs = 100_000;

  public nowWallMs(): number {
    return this.wallMs;
  }

  public nowMonotonicMs(): number {
    return this.monotonicMs;
  }

  public advance(ms: number): void {
    this.wallMs += ms;
    this.monotonicMs += ms;
  }
}

function makePhase(
  id: string,
  runner: 'claude' | 'codex' | 'agy',
  quotaProfileId?: string
): FrozenPhaseQuotaTarget {
  return {
    id,
    runner,
    ...(quotaProfileId !== undefined ? { quotaProfileId } : {})
  };
}

function createSeededRoot(
  ledgerRunId: string,
  budgetMode: 'count-only' | 'strict-usd' = 'count-only',
  limitMicrousd = 10_000
): RootControlState {
  return {
    version: CONTROL_LEDGER_VERSION,
    ledgerRunId,
    connectedRunId: `conn-${ledgerRunId}`,
    rootWorkflowId: 'wf-main',
    queueId: `queue-${ledgerRunId}`,
    linkState: 'active',
    status: 'in-flight',
    fence: {
      primacyClaim: 'primacy-1',
      queueClaim: `claim-${ledgerRunId}`,
      rootGeneration: 1
    },
    rootBudget:
      budgetMode === 'strict-usd'
        ? {
            version: 1,
            maxPhaseAttempts: 100,
            strictUsdBudget: { mode: 'strict-usd', limitMicrousd }
          }
        : {
            version: 1,
            maxPhaseAttempts: 100
          },
    dispatchedAttempts: 0,
    settledMicrousd: 0,
    reservedMicrousd: 0,
    framesByKey: {
      root: {
        frameKey: 'root',
        parentFrameKey: null,
        invocationId: `inv-${ledgerRunId}`,
        workflowId: 'wf-main',
        kind: 'candidate-block',
        status: 'waiting-availability',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        dispatchedCount: 0
      }
    },
    attemptsById: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000
  };
}

describe('BackendAvailabilityService & D7 contracts (FR-R5-F28 / SPEC-06)', () => {
  it('validates closed QuotaContext, QuotaObservation, and monitoring window bounds', () => {
    const validQualified = validateQuotaContext({
      version: BACKEND_AVAILABILITY_VERSION,
      adapterId: 'claude-qualified',
      adapterVersion: BACKEND_AVAILABILITY_VERSION,
      quotaIds: ['quota-shared-alpha', 'quota-tier-2'],
      identity: 'qualified',
      statusCheck: 'supported',
      capacity: 4,
      checkCostBoundMicrousd: 0
    });
    expect(validQualified.ok).toBe(true);

    // Reject unknown field
    expect(
      validateQuotaContext({
        version: 1,
        adapterId: 'claude-qualified',
        adapterVersion: 1,
        quotaIds: ['quota-1'],
        identity: 'qualified',
        statusCheck: 'supported',
        extraField: true
      }).ok
    ).toBe(false);

    // Reject secret/account email in quotaId
    expect(
      validateQuotaContext({
        version: 1,
        adapterId: 'claude-qualified',
        adapterVersion: 1,
        quotaIds: ['user@example.com'],
        identity: 'qualified',
        statusCheck: 'supported'
      }).ok
    ).toBe(false);

    expect(
      validateQuotaContext({
        version: 1,
        adapterId: 'claude-qualified',
        adapterVersion: 1,
        quotaIds: ['sk-ant-secret123'],
        identity: 'qualified',
        statusCheck: 'supported'
      }).ok
    ).toBe(false);

    // Reject capacity out of 1..20 or unknown identity with capacity > 1
    expect(
      validateQuotaContext({
        version: 1,
        adapterId: 'claude-qualified',
        adapterVersion: 1,
        quotaIds: ['quota-1'],
        identity: 'qualified',
        statusCheck: 'supported',
        capacity: 21
      }).ok
    ).toBe(false);

    expect(
      validateQuotaContext({
        version: 1,
        adapterId: 'claude-unknown',
        adapterVersion: 1,
        quotaIds: [UNKNOWN_LOCAL_QUOTA_ID],
        identity: 'unknown',
        statusCheck: 'unsupported',
        capacity: 2
      }).ok
    ).toBe(false);

    // Reject shared unknown-local-quota publishing readiness directly or top-up with resetAt
    expect(
      validateQuotaObservation({
        observationId: UNKNOWN_LOCAL_QUOTA_ID,
        quotaId: UNKNOWN_LOCAL_QUOTA_ID,
        generation: 1,
        status: 'ready',
        source: 'counted-trial',
        observedAt: 1_000,
        hostEpoch: 'epoch-1',
        pollIndex: 0,
        capacity: 1
      }).ok
    ).toBe(false);

    expect(
      validateQuotaObservation({
        observationId: 'quota-1',
        quotaId: 'quota-1',
        generation: 1,
        status: 'top-up-required',
        source: 'qualified-status',
        observedAt: 1_000,
        resetAt: 2_000,
        hostEpoch: 'epoch-1',
        pollIndex: 0,
        capacity: 1
      }).ok
    ).toBe(false);

    // Monitoring window bounds: 60,000..172,800,000 ms (48h), default 86,400,000 ms
    expect(validateMonitoringWindowMs(undefined)).toEqual({
      ok: true,
      durationMs: 86_400_000
    });
    expect(validateMonitoringWindowMs(59_999).ok).toBe(false);
    expect(validateMonitoringWindowMs(60_000).ok).toBe(true);
    expect(validateMonitoringWindowMs(172_800_000).ok).toBe(true);
    expect(validateMonitoringWindowMs(172_800_001).ok).toBe(false);
  });

  it('computes deterministic SHA-256 jitter once per generation and saturates unknown polling intervals', () => {
    const jitterA = computeDeterministicCheckJitterMs('quota-alpha', 3);
    const jitterB = computeDeterministicCheckJitterMs('quota-alpha', 3);
    const jitterNextGen = computeDeterministicCheckJitterMs('quota-alpha', 4);

    expect(jitterA).toBe(jitterB);
    expect(jitterA).toBeGreaterThanOrEqual(0);
    expect(jitterA).toBeLessThanOrEqual(5_000);
    expect(jitterNextGen).not.toBe(jitterA);

    const nowMs = 1_000_000;
    for (let idx = 0; idx <= MAX_POLL_INDEX; idx += 1) {
      const sched = computeNextQuotaCheckSchedule({
        nowMs,
        observationId: 'quota-alpha',
        generation: 3,
        status: 'cooldown-unknown',
        pollIndex: idx,
        advancePollIndex: true
      });
      expect(sched.nextCheckAt).toBe(
        nowMs + UNKNOWN_RESET_POLL_INTERVALS_MS[idx]! + jitterA
      );
      expect(sched.pollIndex).toBe(Math.min(MAX_POLL_INDEX, idx + 1));
    }

    // Known future reset uses max(now + 60_000, resetAt + 60_000) + jitter
    const knownFuture = computeNextQuotaCheckSchedule({
      nowMs,
      observationId: 'quota-alpha',
      generation: 3,
      status: 'cooldown-known',
      resetAt: nowMs + 300_000,
      pollIndex: 2
    });
    expect(knownFuture.nextCheckAt).toBe(nowMs + 300_000 + 60_000 + jitterA);
  });

  it('isolates unknown candidate readiness while sharing qualified observations across CLI backends', async () => {
    const memento = new InMemoryMemento();
    const ledgerStore = new ControlLedgerStore(memento);
    const clock = new FakeAvailabilityClock();

    const adapters: Record<'claude' | 'codex' | 'agy', BackendAvailabilityAdapter> = {
      claude: {
        adapterId: 'shared-gateway',
        adapterVersion: 1,
        backend: 'claude',
        statusCheck: 'supported',
        resolveQuotaContext: () => ({
          version: 1,
          adapterId: 'shared-gateway',
          adapterVersion: 1,
          quotaIds: ['pool-enterprise-1'],
          identity: 'qualified',
          statusCheck: 'supported',
          capacity: 2
        })
      },
      codex: {
        adapterId: 'shared-gateway',
        adapterVersion: 1,
        backend: 'codex',
        statusCheck: 'supported',
        resolveQuotaContext: () => ({
          version: 1,
          adapterId: 'shared-gateway',
          adapterVersion: 1,
          quotaIds: ['pool-enterprise-1'],
          identity: 'qualified',
          statusCheck: 'supported',
          capacity: 2
        })
      },
      agy: {
        adapterId: 'agy-unknown',
        adapterVersion: 1,
        backend: 'agy',
        statusCheck: 'unsupported',
        resolveQuotaContext: () => ({
          version: 1,
          adapterId: 'agy-unknown',
          adapterVersion: 1,
          quotaIds: [UNKNOWN_LOCAL_QUOTA_ID],
          identity: 'unknown',
          statusCheck: 'unsupported',
          capacity: 1
        })
      }
    };

    const service = new BackendAvailabilityService({
      ledgerStore,
      clock,
      getAdapter: (kind) => adapters[kind]
    });

    const claudeTarget = service.resolveCandidateQuotaTarget(
      makePhase('phase-a', 'claude'),
      'occ-claude-1'
    );
    const codexTarget = service.resolveCandidateQuotaTarget(
      makePhase('phase-b', 'codex'),
      'occ-codex-1'
    );
    expect(claudeTarget.observationIds).toEqual(['pool-enterprise-1']);
    expect(codexTarget.observationIds).toEqual(['pool-enterprise-1']);

    const unknownA = service.resolveCandidateQuotaTarget(
      makePhase('phase-c', 'agy'),
      'occ-agy-1'
    );
    const unknownB = service.resolveCandidateQuotaTarget(
      makePhase('phase-d', 'agy'),
      'occ-agy-2'
    );
    expect(unknownA.context.quotaIds).toEqual([UNKNOWN_LOCAL_QUOTA_ID]);
    expect(unknownB.context.quotaIds).toEqual([UNKNOWN_LOCAL_QUOTA_ID]);
    expect(unknownA.observationIds).toEqual(['unknown/occ-agy-1']);
    expect(unknownB.observationIds).toEqual(['unknown/occ-agy-2']);

    // Counted trial succeeds for unknownA: unknownA becomes ready, unknownB remains unready
    await service.recordCountedTrialOutcome({
      candidateOccurrenceId: 'occ-agy-1',
      frozenPhase: makePhase('phase-c', 'agy'),
      generation: 1,
      expectedGeneration: 1,
      trialSucceeded: true
    });

    expect(
      service.isCandidateReady(makePhase('phase-c', 'agy'), 'occ-agy-1')
    ).toBe(true);
    expect(
      service.isCandidateReady(makePhase('phase-d', 'agy'), 'occ-agy-2')
    ).toBe(false);

    // Advance past 30,000 ms ready TTL -> readiness expires
    clock.advance(READY_OBSERVATION_TTL_MS + 1);
    expect(
      service.isCandidateReady(makePhase('phase-c', 'agy'), 'occ-agy-1')
    ).toBe(false);
  });

  it('preserves 60-minute hard-credit and 15-minute transient dispatch floors even after positive status checks', async () => {
    const memento = new InMemoryMemento();
    const ledgerStore = new ControlLedgerStore(memento);
    const clock = new FakeAvailabilityClock();

    const adapter: BackendAvailabilityAdapter = {
      adapterId: 'claude-qualified',
      adapterVersion: 1,
      backend: 'claude',
      statusCheck: 'supported',
      resolveQuotaContext: (phase) => ({
        version: 1,
        adapterId: 'claude-qualified',
        adapterVersion: 1,
        quotaIds: [`quota-${phase.runner}-main`],
        identity: 'qualified',
        statusCheck: 'supported',
        capacity: 1
      }),
      checkAvailability: async () => ({
        version: 1,
        adapterId: 'claude-qualified',
        outcomes: [{ quotaId: 'quota-claude-main', status: 'ready' }]
      })
    };

    const service = new BackendAvailabilityService({
      ledgerStore,
      clock,
      getAdapter: () => adapter
    });

    const initialWall = clock.nowWallMs();
    // Out-of-credits with a past reset timestamp enforces the 60-minute floor
    const diagObs = await service.recordDiagnosticObservation({
      candidateOccurrenceId: 'occ-1',
      frozenPhase: makePhase('phase-1', 'claude'),
      generation: 1,
      cause: 'out-of-credits',
      resetsAtMs: initialWall - 5_000
    });
    expect(diagObs.at(0)?.status).toBe('cooldown-unknown');
    expect(diagObs.at(0)?.notBefore).toBe(initialWall + RATE_LIMIT_BACKOFF_MS);

    // A positive status check 2 minutes later records status: 'ready' but preserves notBefore!
    clock.advance(120_000);
    const checkOutcome = await service.checkCandidateAvailability({
      candidateOccurrenceId: 'occ-1',
      frozenPhase: makePhase('phase-1', 'claude'),
      generation: 1,
      subscribers: [{ rootRunId: 'root-1', sequence: 1, generation: 1 }]
    });
    expect(checkOutcome.ok).toBe(true);
    if (checkOutcome.ok) {
      expect(checkOutcome.observations.at(0)?.status).toBe('ready');
      expect(checkOutcome.observations.at(0)?.notBefore).toBe(
        initialWall + RATE_LIMIT_BACKOFF_MS
      );
    }
    // Because notBefore has not elapsed, isQuotaObservationFreshReady returns false!
    expect(
      isQuotaObservationFreshReady(
        service.getObservation('quota-claude-main'),
        clock.nowWallMs(),
        clock.hostEpoch
      )
    ).toBe(false);

    // Transient error records 15-minute floor and never proves readiness
    const transientObs = await service.recordDiagnosticObservation({
      candidateOccurrenceId: 'occ-2',
      frozenPhase: makePhase('phase-2', 'codex'),
      generation: 1,
      cause: 'transient_error'
    });
    expect(transientObs.at(0)?.status).toBe('unreachable');
    expect(transientObs.at(0)?.notBefore).toBe(
      clock.nowWallMs() + TRANSIENT_BACKOFF_MS
    );
  });

  interface Deferred<T = void> {
    readonly promise: Promise<T>;
    resolve(value: T | PromiseLike<T>): void;
  }

  function createDeferred<T = void>(): Deferred<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  interface PendingControllableSleep {
    readonly durationMs: number;
    readonly triggerTimeout: () => void;
    readonly isSettled: () => boolean;
  }

  async function createControllableCheckHarness(options?: {
    readonly gatedQuotaIds?: readonly string[];
    readonly hungQuotaIds?: readonly string[];
  }) {
    const memento = new InMemoryMemento();
    const ledgerStore = new ControlLedgerStore(memento);
    const clock = new FakeAvailabilityClock();

    await ledgerStore.mutate({}, () => ({
      commit: true,
      plan: {
        nextLedger: {
          ...createEmptyControlLedger(),
          roots: {
            'root-seq-1': createSeededRoot('root-seq-1', 'strict-usd', 500),
            'root-seq-2': createSeededRoot('root-seq-2', 'strict-usd', 500)
          }
        },
        result: undefined
      }
    }));

    const gatedSet = new Set(options?.gatedQuotaIds ?? []);
    const hungSet = new Set(options?.hungQuotaIds ?? []);
    const gatesByQuotaId = new Map<string, Deferred<void>>();
    const exitedByQuotaId = new Map<string, Deferred<void>>();
    const signalByQuotaId = new Map<string, AbortSignal>();
    const sleepBySignal = new Map<AbortSignal, PendingControllableSleep>();
    const startedWaiters: Array<{
      readonly targetCount: number;
      readonly deferred: Deferred<void>;
    }> = [];

    const startedOrder: string[] = [];
    let maxActive = 0;
    let currentActive = 0;

    function getGate(quotaId: string): Deferred<void> {
      let gate = gatesByQuotaId.get(quotaId);
      if (gate === undefined) {
        gate = createDeferred<void>();
        gatesByQuotaId.set(quotaId, gate);
      }
      return gate;
    }

    function getExited(quotaId: string): Deferred<void> {
      let exited = exitedByQuotaId.get(quotaId);
      if (exited === undefined) {
        exited = createDeferred<void>();
        exitedByQuotaId.set(quotaId, exited);
      }
      return exited;
    }

    function waitForStartedCount(targetCount: number): Promise<void> {
      if (startedOrder.length >= targetCount) {
        return Promise.resolve();
      }
      const deferred = createDeferred<void>();
      startedWaiters.push({ targetCount, deferred });
      return deferred.promise;
    }

    const service = new BackendAvailabilityService({
      ledgerStore,
      clock: {
        get hostEpoch() {
          return clock.hostEpoch;
        },
        nowWallMs: () => clock.nowWallMs(),
        nowMonotonicMs: () => clock.nowMonotonicMs(),
        sleepMs: async (durationMs, signal) => {
          const sleepDeferred = createDeferred<void>();
          let settled = false;
          const finish = (advanceClock: boolean) => {
            if (settled) return;
            settled = true;
            if (advanceClock) {
              clock.advance(durationMs);
            }
            sleepDeferred.resolve();
          };
          if (signal?.aborted) {
            finish(false);
            return sleepDeferred.promise;
          }
          signal?.addEventListener('abort', () => finish(false), {
            once: true
          });
          if (signal !== undefined) {
            sleepBySignal.set(signal, {
              durationMs,
              triggerTimeout: () => finish(true),
              isSettled: () => settled
            });
          }
          await sleepDeferred.promise;
        }
      },
      getAdapter: (kind) => ({
        adapterId: `${kind}-adapter`,
        adapterVersion: 1,
        backend: kind,
        statusCheck: 'supported',
        resolveQuotaContext: (phase) => ({
          version: 1,
          adapterId: `${kind}-adapter`,
          adapterVersion: 1,
          quotaIds: [phase.quotaProfileId ?? `quota-${phase.id}`],
          identity: 'qualified',
          statusCheck: 'supported',
          capacity: 1,
          checkCostBoundMicrousd: 100
        }),
        checkAvailability: async (ctx, signal) => {
          const qId = ctx.quotaIds.at(0)!;
          signalByQuotaId.set(qId, signal);
          startedOrder.push(qId);
          currentActive += 1;
          if (currentActive > maxActive) maxActive = currentActive;

          for (let i = startedWaiters.length - 1; i >= 0; i -= 1) {
            const waiter = startedWaiters.at(i)!;
            if (startedOrder.length >= waiter.targetCount) {
              startedWaiters.splice(i, 1);
              waiter.deferred.resolve();
            }
          }

          try {
            if (hungSet.has(qId)) {
              await new Promise<void>((resolve) => {
                if (signal.aborted) {
                  resolve();
                  return;
                }
                signal.addEventListener('abort', () => resolve(), {
                  once: true
                });
              });
              throw new Error('aborted');
            }
            if (gatedSet.has(qId)) {
              await getGate(qId).promise;
            }
            return {
              version: 1,
              adapterId: ctx.adapterId,
              outcomes: [{ quotaId: qId, status: 'ready' }],
              costMicrousd: 75
            };
          } finally {
            currentActive -= 1;
            getExited(qId).resolve();
          }
        }
      })
    });

    function buildStandardBatchRequests() {
      return [
        {
          candidateOccurrenceId: 'occ-c',
          frozenPhase: makePhase('c', 'claude', 'quota-c'),
          generation: 1,
          dueAt: 2_000,
          subscribers: [
            { rootRunId: 'root-seq-2', sequence: 2, generation: 1 },
            { rootRunId: 'root-seq-1', sequence: 1, generation: 1 }
          ]
        },
        {
          candidateOccurrenceId: 'occ-hung',
          frozenPhase: makePhase('hung', 'claude', 'quota-hung'),
          generation: 1,
          dueAt: 1_000,
          subscribers: [{ rootRunId: 'root-seq-1', sequence: 1, generation: 1 }]
        },
        {
          candidateOccurrenceId: 'occ-b',
          frozenPhase: makePhase('b', 'codex', 'quota-b'),
          generation: 1,
          dueAt: 1_000,
          subscribers: [{ rootRunId: 'root-seq-1', sequence: 1, generation: 1 }]
        },
        {
          candidateOccurrenceId: 'occ-a',
          frozenPhase: makePhase('a', 'agy', 'quota-a'),
          generation: 1,
          dueAt: 1_000,
          subscribers: [{ rootRunId: 'root-seq-1', sequence: 1, generation: 1 }]
        }
      ] as const;
    }

    function getPendingSleepFor(quotaId: string): PendingControllableSleep {
      const signal = signalByQuotaId.get(quotaId);
      if (signal === undefined) {
        throw new Error(`No active AbortSignal recorded for ${quotaId}`);
      }
      const pending = sleepBySignal.get(signal);
      if (pending === undefined) {
        throw new Error(`No controllable sleep recorded for ${quotaId}`);
      }
      return pending;
    }

    return {
      ledgerStore,
      clock,
      service,
      startedOrder,
      getCurrentActive: () => currentActive,
      getMaxActive: () => maxActive,
      waitForStartedCount,
      releaseGate: (quotaId: string) => getGate(quotaId).resolve(),
      waitForExited: (quotaId: string) => getExited(quotaId).promise,
      getSignalFor: (quotaId: string) => signalByQuotaId.get(quotaId),
      getPendingSleepFor,
      buildStandardBatchRequests
    };
  }

  it('enforces the 3-check concurrency cap and schedules due checks by dueAt then UTF-8 quotaId', async () => {
    const h = await createControllableCheckHarness({
      gatedQuotaIds: ['quota-a', 'quota-b', 'quota-hung', 'quota-c']
    });

    const batchPromise = h.service.runDueChecks(h.buildStandardBatchRequests());

    // Exactly 3 slots start first, ordered by dueAt=1000 then UTF-8 quotaId
    await h.waitForStartedCount(3);
    expect(h.startedOrder).toEqual(['quota-a', 'quota-b', 'quota-hung']);
    expect(h.getCurrentActive()).toBe(3);
    expect(h.getMaxActive()).toBe(3);

    // Releasing one slot admits the 4th check (dueAt=2000 quota-c) without exceeding cap 3
    h.releaseGate('quota-a');
    await h.waitForStartedCount(4);
    expect(h.startedOrder).toEqual([
      'quota-a',
      'quota-b',
      'quota-hung',
      'quota-c'
    ]);
    expect(h.getMaxActive()).toBeLessThanOrEqual(3);

    h.releaseGate('quota-b');
    h.releaseGate('quota-hung');
    h.releaseGate('quota-c');

    const batchOutcomes = await batchPromise;
    expect(batchOutcomes).toHaveLength(4);
  });

  it('aborts a hung check at 10,000 ms into unreachable without blocking other concurrency slots', async () => {
    const h = await createControllableCheckHarness({
      gatedQuotaIds: ['quota-a', 'quota-b', 'quota-c'],
      hungQuotaIds: ['quota-hung']
    });

    const batchPromise = h.service.runDueChecks(h.buildStandardBatchRequests());

    await h.waitForStartedCount(3);
    h.releaseGate('quota-a');
    h.releaseGate('quota-b');

    // quota-c enters and finishes while quota-hung is still hung on its slot
    await h.waitForStartedCount(4);
    h.releaseGate('quota-c');
    await h.waitForExited('quota-c');
    expect(h.getSignalFor('quota-hung')?.aborted).toBe(false);

    // Trigger the 10,000 ms absolute timeout for quota-hung deterministically
    const hungSleep = h.getPendingSleepFor('quota-hung');
    expect(hungSleep.durationMs).toBe(AVAILABILITY_CHECK_TIMEOUT_MS);
    expect(AVAILABILITY_CHECK_TIMEOUT_MS).toBe(10_000);
    hungSleep.triggerTimeout();

    const batchOutcomes = await batchPromise;
    expect(batchOutcomes).toHaveLength(4);

    const hungObs = h.service.getObservation('quota-hung');
    expect(hungObs?.status).toBe('unreachable');
    expect(hungObs?.nextCheckAt).toBeGreaterThan(h.clock.nowWallMs());

    const cObs = h.service.getObservation('quota-c');
    expect(cObs?.status).toBe('ready');
  });

  it('deduplicates concurrent in-flight availability checks for the same observationId', async () => {
    const h = await createControllableCheckHarness({
      gatedQuotaIds: ['quota-c']
    });

    const firstPromise = h.service.checkCandidateAvailability({
      candidateOccurrenceId: 'occ-c-1',
      frozenPhase: makePhase('c', 'claude', 'quota-c'),
      generation: 1,
      subscribers: [{ rootRunId: 'root-seq-1', sequence: 1, generation: 1 }]
    });
    const secondPromise = h.service.checkCandidateAvailability({
      candidateOccurrenceId: 'occ-c-2',
      frozenPhase: makePhase('c', 'claude', 'quota-c'),
      generation: 1,
      subscribers: [{ rootRunId: 'root-seq-2', sequence: 2, generation: 1 }]
    });

    await h.waitForStartedCount(1);
    h.releaseGate('quota-c');

    const [firstOutcome, secondOutcome] = await Promise.all([
      firstPromise,
      secondPromise
    ]);
    expect(h.startedOrder).toEqual(['quota-c']);
    expect(firstOutcome.ok).toBe(true);
    expect(secondOutcome.ok).toBe(true);
    if (firstOutcome.ok && secondOutcome.ok) {
      expect(firstOutcome.deduplicated).toBe(false);
      expect(secondOutcome.deduplicated).toBe(true);
      expect(secondOutcome.checkId).toBe(firstOutcome.checkId);
    }
    expect(h.ledgerStore.getRoot('root-seq-1')?.settledMicrousd).toBe(75);
  });

  it('rate-limits immediate availability re-checks within the 60,000 ms minimum interval', async () => {
    const h = await createControllableCheckHarness();

    const initial = await h.service.checkCandidateAvailability({
      candidateOccurrenceId: 'occ-c',
      frozenPhase: makePhase('c', 'claude', 'quota-c'),
      generation: 1,
      subscribers: [{ rootRunId: 'root-seq-1', sequence: 1, generation: 1 }]
    });
    expect(initial.ok).toBe(true);

    const rateLimited = await h.service.checkCandidateAvailability({
      candidateOccurrenceId: 'occ-c',
      frozenPhase: makePhase('c', 'claude', 'quota-c'),
      generation: 1,
      subscribers: [{ rootRunId: 'root-seq-1', sequence: 1, generation: 1 }]
    });
    expect(rateLimited.ok).toBe(false);
    if (!rateLimited.ok) {
      expect(rateLimited.reason).toBe('check-rate-limited');
    }
  });

  it('charges check sponsorship to the lowest-sequence eligible subscriber under D6 without consuming Phase attempts', async () => {
    const h = await createControllableCheckHarness({
      hungQuotaIds: ['quota-hung']
    });

    const batchPromise = h.service.runDueChecks(h.buildStandardBatchRequests());
    await h.waitForStartedCount(4);
    await h.waitForExited('quota-c');
    h.getPendingSleepFor('quota-hung').triggerTimeout();

    const batchOutcomes = await batchPromise;
    expect(batchOutcomes).toHaveLength(4);
    const cOutcome = batchOutcomes.at(0);
    expect(cOutcome?.ok).toBe(true);
    if (cOutcome?.ok) {
      expect(cOutcome.sponsorRootRunId).toBe('root-seq-1');
      expect(cOutcome.sharedSubscriberRootIds).toEqual(['root-seq-2']);
    }

    // Lowest-sequence eligible subscriber (root-seq-1) sponsored the 3 successful checks once; no Phase attempts consumed
    const root1 = h.ledgerStore.getRoot('root-seq-1')!;
    const root2 = h.ledgerStore.getRoot('root-seq-2')!;
    expect(root1.dispatchedAttempts).toBe(0);
    expect(root2.dispatchedAttempts).toBe(0);
    expect(root1.settledMicrousd).toBe(225); // 3 successful checks * 75 microusd
    expect(root2.settledMicrousd).toBe(0);
  });
});
