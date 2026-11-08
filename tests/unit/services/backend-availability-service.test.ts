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

  it('enforces 3-check concurrency, 10s abort without blocking other slots, deduplication, and D6 sponsorship', async () => {
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

    const startedOrder: string[] = [];
    let maxActive = 0;
    let currentActive = 0;

    const service = new BackendAvailabilityService({
      ledgerStore,
      clock: {
        get hostEpoch() {
          return clock.hostEpoch;
        },
        nowWallMs: () => clock.nowWallMs(),
        nowMonotonicMs: () => clock.nowMonotonicMs(),
        sleepMs: async (durationMs, signal) => {
          await new Promise<void>((resolve) => {
            const t = setTimeout(() => {
              clock.advance(durationMs);
              resolve();
            }, 15);
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                resolve();
              },
              { once: true }
            );
          });
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
          startedOrder.push(qId);
          currentActive += 1;
          if (currentActive > maxActive) maxActive = currentActive;
          try {
            if (qId === 'quota-hung') {
              // Hang until abortSignal fires
              await new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => resolve(), { once: true });
              });
              throw new Error('aborted');
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
            return {
              version: 1,
              adapterId: ctx.adapterId,
              outcomes: [{ quotaId: qId, status: 'ready' }],
              costMicrousd: 75
            };
          } finally {
            currentActive -= 1;
          }
        }
      })
    });

    const batchOutcomes = await service.runDueChecks([
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
    ]);

    // Tie-break at dueAt=1000 is UTF-8 byte order: quota-a, quota-b, quota-hung, then dueAt=2000 quota-c
    expect(startedOrder).toEqual([
      'quota-a',
      'quota-b',
      'quota-hung',
      'quota-c'
    ]);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(batchOutcomes).toHaveLength(4);

    // quota-hung aborted into unreachable while quota-c still completed ready!
    const hungObs = service.getObservation('quota-hung');
    expect(hungObs?.status).toBe('unreachable');
    expect(hungObs?.nextCheckAt).toBeGreaterThan(clock.nowWallMs());

    const cObs = service.getObservation('quota-c');
    expect(cObs?.status).toBe('ready');

    // Lowest-sequence eligible subscriber (root-seq-1) sponsored the checks once; no Phase attempts consumed
    const root1 = ledgerStore.getRoot('root-seq-1')!;
    const root2 = ledgerStore.getRoot('root-seq-2')!;
    expect(root1.dispatchedAttempts).toBe(0);
    expect(root2.dispatchedAttempts).toBe(0);
    expect(root1.settledMicrousd).toBe(225); // 3 successful checks * 75 microusd
    expect(root2.settledMicrousd).toBe(0);

    // Immediate re-check within 60,000 ms is rate-limited
    const rateLimited = await service.checkCandidateAvailability({
      candidateOccurrenceId: 'occ-c',
      frozenPhase: makePhase('c', 'claude', 'quota-c'),
      generation: 1,
      subscribers: [{ rootRunId: 'root-seq-1', sequence: 1, generation: 1 }]
    });
    expect(rateLimited.ok).toBe(false);
    if (!rateLimited.ok) {
      expect(rateLimited.reason).toBe('check-rate-limited');
    }
    expect(AVAILABILITY_CHECK_TIMEOUT_MS).toBe(10_000);
  });
});
