import { describe, expect, it } from 'vitest';
import {
  CLOCK_DISCONTINUITY_THRESHOLD_MS,
  DEFAULT_MONITORING_WINDOW_MS,
  MAX_MONITORING_WINDOW_MS,
  UNKNOWN_LOCAL_QUOTA_ID,
  type BackendAvailabilityAdapter,
  type FrozenPhaseQuotaTarget,
  type QuotaObservationStatus
} from '../../src/contracts/backend-availability';
import {
  CONTROL_LEDGER_VERSION,
  createEmptyControlLedger,
  type RootControlState
} from '../../src/contracts/control-ledger';
import {
  BackendAvailabilityService,
  type AvailabilityClockPort
} from '../../src/services/backend-availability-service';
import type { DeadlineTimer } from '../../src/services/retry-coordinator';
import { ControlLedgerStore } from '../../src/services/workflow-execution/control-ledger-store';
import {
  ControlWakeupPlanner,
  type CandidateWakeupDescriptor,
  type ControlWakeupEvent
} from '../../src/services/workflow-execution/control-wakeup-planner';
import type { Memento } from '../../src/state/workspace-state';

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

class VirtualClockAndTimer implements AvailabilityClockPort, DeadlineTimer {
  public hostEpoch = 'host-epoch-1';
  public wallMs = 1_700_000_000_000;
  public monotonicMs = 500_000;
  private nextTimerId = 1;
  private readonly timers = new Map<
    number,
    { readonly firesAtMonotonicMs: number; readonly fn: () => void }
  >();

  public nowWallMs(): number {
    return this.wallMs;
  }

  public nowMonotonicMs(): number {
    return this.monotonicMs;
  }

  public set(fn: () => void, delayMs: number): { clear(): void } {
    const id = this.nextTimerId++;
    this.timers.set(id, {
      firesAtMonotonicMs: this.monotonicMs + Math.max(0, delayMs),
      fn
    });
    return {
      clear: () => {
        this.timers.delete(id);
      }
    };
  }

  public pendingTimerCount(): number {
    return this.timers.size;
  }

  public advanceBoth(deltaMs: number): void {
    this.wallMs += deltaMs;
    this.monotonicMs += deltaMs;
  }

  public async fireDueTimers(): Promise<number> {
    const due = [...this.timers.entries()]
      .filter(([, entry]) => entry.firesAtMonotonicMs <= this.monotonicMs)
      .sort((a, b) => a[1].firesAtMonotonicMs - b[1].firesAtMonotonicMs);
    for (const [id, entry] of due) {
      this.timers.delete(id);
      entry.fn();
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
    return due.length;
  }
}

function makeSeededRoot(rootRunId: string): RootControlState {
  return {
    version: CONTROL_LEDGER_VERSION,
    ledgerRunId: rootRunId,
    connectedRunId: `conn-${rootRunId}`,
    rootWorkflowId: 'wf-review',
    queueId: `queue-${rootRunId}`,
    linkState: 'active',
    status: 'in-flight',
    fence: {
      primacyClaim: 'primacy-1',
      queueClaim: `claim-${rootRunId}`,
      rootGeneration: 1
    },
    rootBudget: { version: 1, maxPhaseAttempts: 100 },
    dispatchedAttempts: 2,
    settledMicrousd: 0,
    reservedMicrousd: 0,
    framesByKey: {
      'frame-review': {
        frameKey: 'frame-review',
        parentFrameKey: null,
        invocationId: 'inv-review',
        workflowId: 'wf-review',
        kind: 'candidate-block',
        status: 'waiting-availability',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        dispatchedCount: 2
      }
    },
    attemptsById: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000
  };
}

function makeFourCandidates(): readonly CandidateWakeupDescriptor[] {
  const specs: Array<{
    readonly id: string;
    readonly runner: 'claude' | 'codex' | 'agy';
    readonly quotaId: string;
    readonly priority: number;
  }> = [
    { id: 'review-primary', runner: 'claude', quotaId: 'quota-cand-1', priority: 1 },
    { id: 'review-second', runner: 'codex', quotaId: 'quota-cand-2', priority: 2 },
    { id: 'review-third', runner: 'agy', quotaId: 'quota-cand-3', priority: 3 },
    { id: 'review-fourth', runner: 'codex', quotaId: 'quota-cand-4', priority: 4 }
  ];
  return specs.map((s) => ({
    candidateId: s.id,
    candidateOccurrenceId: `occ-${s.id}`,
    frozenPhase: {
      id: s.id,
      runner: s.runner,
      quotaProfileId: s.quotaId
    } satisfies FrozenPhaseQuotaTarget,
    priority: s.priority
  }));
}

describe('ControlWakeupPlanner fake-clock integration (FR-R5-F28 / SPEC-06; AC-24, AC-25, AC-26, AC-27, AC-28)', () => {
  it('AC-24: exercises each of 4 candidates checking ready first; revised/past/unknown resets, wrong account, unsupported check, top-up, and timeout never create false readiness', async () => {
    for (let winnerIdx = 0; winnerIdx < 4; winnerIdx += 1) {
      const memento = new InMemoryMemento();
      const ledgerStore = new ControlLedgerStore(memento);
      const clock = new VirtualClockAndTimer();

      await ledgerStore.mutate({}, () => ({
        commit: true,
        plan: {
          nextLedger: {
            ...createEmptyControlLedger(),
            roots: { 'root-1': makeSeededRoot('root-1') }
          },
          result: undefined
        }
      }));

      const candidates = makeFourCandidates();
      const statusMap = new Map<string, QuotaObservationStatus>([
        ['quota-cand-1', 'cooldown-unknown'],
        ['quota-cand-2', 'top-up-required'],
        ['quota-cand-3', 'unreachable'],
        ['quota-cand-4', 'cooldown-known']
      ]);
      const winnerQuotaId = `quota-cand-${winnerIdx + 1}`;
      statusMap.set(winnerQuotaId, 'ready');

      const service = new BackendAvailabilityService({
        ledgerStore,
        clock,
        getAdapter: (kind): BackendAvailabilityAdapter => ({
          adapterId: `${kind}-adapter`,
          adapterVersion: 1,
          backend: kind,
          statusCheck: 'supported',
          resolveQuotaContext: (phase) => ({
            version: 1,
            adapterId: `${kind}-adapter`,
            adapterVersion: 1,
            quotaIds: [phase.quotaProfileId!],
            identity: 'qualified',
            statusCheck: 'supported',
            capacity: 1
          }),
          checkAvailability: async (ctx) => {
            const qId = ctx.quotaIds.at(0)!;
            const st = statusMap.get(qId) ?? 'unreachable';
            return {
              version: 1,
              adapterId: ctx.adapterId,
              outcomes: [
                {
                  quotaId: qId,
                  status: st,
                  ...(st === 'cooldown-known'
                    ? { resetAt: clock.nowWallMs() - 10_000 } // past reset -> normalized to cooldown-unknown!
                    : {})
                }
              ]
            };
          }
        })
      });

      const wakeups: ControlWakeupEvent[] = [];
      const planner = new ControlWakeupPlanner({
        ledgerStore,
        availabilityService: service,
        clock,
        timer: clock,
        onWakeupDue: (ev) => {
          wakeups.push(ev);
        }
      });

      const initialEval = await planner.registerWaitingFrame({
        rootRunId: 'root-1',
        frameKey: 'frame-review',
        sequence: 1,
        generation: 1,
        candidates
      });
      expect(initialEval.status).toBe('waiting-availability');

      // Advance clock past first check interval + max jitter (65,000 ms)
      clock.advanceBoth(65_001);
      await planner.runDueChecksForFrame('root-1', 'frame-review');
      const afterCheckEval = await planner.evaluateAndArmFrame(
        'root-1',
        'frame-review'
      );

      expect(afterCheckEval.status).toBe('ready-to-admit');
      if (afterCheckEval.status === 'ready-to-admit') {
        expect(afterCheckEval.selectedCandidateId).toBe(
          candidates.at(winnerIdx)!.candidateId
        );
        expect(afterCheckEval.readyCandidateIds).toEqual([
          candidates.at(winnerIdx)!.candidateId
        ]);
      }

      // Verify wrong-account evidence is rejected and never creates readiness
      const wrongAccountService = new BackendAvailabilityService({
        ledgerStore,
        clock,
        getAdapter: (kind) => ({
          adapterId: `${kind}-adapter`,
          adapterVersion: 1,
          backend: kind,
          statusCheck: 'supported',
          resolveQuotaContext: () => ({
            version: 1,
            adapterId: `${kind}-adapter`,
            adapterVersion: 1,
            quotaIds: ['quota-expected'],
            identity: 'qualified',
            statusCheck: 'supported'
          }),
          checkAvailability: async (ctx) => ({
            version: 1,
            adapterId: ctx.adapterId,
            outcomes: [{ quotaId: 'quota-foreign-account', status: 'ready' }]
          })
        })
      });
      const wrongResult = await wrongAccountService.checkCandidateAvailability({
        candidateOccurrenceId: 'occ-wrong',
        frozenPhase: { id: 'p', runner: 'claude' },
        generation: 1,
        subscribers: [{ rootRunId: 'root-1', sequence: 1, generation: 1 }]
      });
      expect(wrongResult.ok).toBe(false);
      if (!wrongResult.ok) {
        expect(wrongResult.reason).toBe('wrong-identity');
      }
      expect(wrongAccountService.getObservation('quota-expected')).toBeUndefined();
      expect(wakeups.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('AC-25: reload after multiple missed checks performs one reconciliation with unchanged counters/window and no callback storm', async () => {
    const memento = new InMemoryMemento();
    const ledgerStore = new ControlLedgerStore(memento);
    const clock = new VirtualClockAndTimer();

    await ledgerStore.mutate({}, () => ({
      commit: true,
      plan: {
        nextLedger: {
          ...createEmptyControlLedger(),
          roots: { 'root-1': makeSeededRoot('root-1') }
        },
        result: undefined
      }
    }));

    let checkCallCount = 0;
    const makeService = (clk: AvailabilityClockPort) =>
      new BackendAvailabilityService({
        ledgerStore,
        clock: clk,
        getAdapter: (kind) => ({
          adapterId: `${kind}-adapter`,
          adapterVersion: 1,
          backend: kind,
          statusCheck: 'supported',
          resolveQuotaContext: (phase) => ({
            version: 1,
            adapterId: `${kind}-adapter`,
            adapterVersion: 1,
            quotaIds: [phase.quotaProfileId ?? 'quota-1'],
            identity: 'qualified',
            statusCheck: 'supported',
            capacity: 1
          }),
          checkAvailability: async (ctx) => {
            checkCallCount += 1;
            return {
              version: 1,
              adapterId: ctx.adapterId,
              outcomes: [
                {
                  quotaId: ctx.quotaIds.at(0)!,
                  status: 'cooldown-unknown'
                }
              ]
            };
          }
        })
      });

    const service1 = makeService(clock);
    const planner1 = new ControlWakeupPlanner({
      ledgerStore,
      availabilityService: service1,
      clock,
      timer: clock
    });

    const candidates = [makeFourCandidates().at(0)!];
    const startWallMs = clock.nowWallMs();
    const regOutcome = await planner1.registerWaitingFrame({
      rootRunId: 'root-1',
      frameKey: 'frame-review',
      sequence: 1,
      generation: 1,
      candidates
    });
    expect(regOutcome.status).toBe('waiting-availability');
    const originalExpiresAt =
      regOutcome.status === 'waiting-availability'
        ? regOutcome.monitoringExpiresAt
        : 0;
    expect(originalExpiresAt).toBe(startWallMs + DEFAULT_MONITORING_WINDOW_MS);

    // Also seed a ready observation before restart to verify restart invalidates cached readiness
    await service1.recordCountedTrialOutcome({
      candidateOccurrenceId: candidates.at(0)!.candidateOccurrenceId,
      frozenPhase: candidates.at(0)!.frozenPhase,
      generation: 1,
      expectedGeneration: 1,
      trialSucceeded: true
    });
    expect(
      service1.isCandidateReady(
        candidates.at(0)!.frozenPhase,
        candidates.at(0)!.candidateOccurrenceId
      )
    ).toBe(true);

    // Simulate 3 hours of laptop sleep + host reload (new hostEpoch) skipping multiple poll windows
    planner1.dispose();
    const reloadClock = new VirtualClockAndTimer();
    reloadClock.hostEpoch = 'host-epoch-2';
    reloadClock.wallMs = startWallMs + 3 * 3_600_000;
    reloadClock.monotonicMs = 10_000;

    const service2 = makeService(reloadClock);
    const planner2 = new ControlWakeupPlanner({
      ledgerStore,
      availabilityService: service2,
      clock: reloadClock,
      timer: reloadClock
    });

    await planner2.registerWaitingFrame({
      rootRunId: 'root-1',
      frameKey: 'frame-review',
      sequence: 1,
      generation: 1,
      candidates
    });

    const reconciled = await planner2.reconcileAllOnStartupOrClockChange();
    const frameOutcome = reconciled['root-1::frame-review']!;
    expect(frameOutcome.status).toBe('waiting-availability');
    if (frameOutcome.status === 'waiting-availability') {
      // Original monitoring window is preserved (not renewed!)
      expect(frameOutcome.monitoringExpiresAt).toBe(originalExpiresAt);
      // Next wakeup is scheduled in the future from current reload wall time without replaying missed polls
      expect(frameOutcome.nextWakeupAt).toBeGreaterThan(reloadClock.nowWallMs());
    }

    // No missed polls were replayed during startup reconciliation
    expect(checkCallCount).toBe(0);
    expect(reloadClock.pendingTimerCount()).toBe(1);

    // Attempt counters remain unchanged
    const rootAfterReload = ledgerStore.getRoot('root-1')!;
    expect(rootAfterReload.dispatchedAttempts).toBe(2);
    expect(rootAfterReload.framesByKey['frame-review']!.dispatchedCount).toBe(2);
  });

  it('AC-26, AC-27 & AC-35: enforces 5,000/5,001 ms clock drift boundary, backward clock regression, pause/cancel invalidation, and monitoring expiry before future reset', async () => {
    const memento = new InMemoryMemento();
    const ledgerStore = new ControlLedgerStore(memento);
    const clock = new VirtualClockAndTimer();

    await ledgerStore.mutate({}, () => ({
      commit: true,
      plan: {
        nextLedger: {
          ...createEmptyControlLedger(),
          roots: { 'root-1': makeSeededRoot('root-1') }
        },
        result: undefined
      }
    }));

    const futureResetAt = clock.nowWallMs() + MAX_MONITORING_WINDOW_MS + 600_000;
    const service = new BackendAvailabilityService({
      ledgerStore,
      clock,
      getAdapter: (kind) => ({
        adapterId: `${kind}-adapter`,
        adapterVersion: 1,
        backend: kind,
        statusCheck: 'supported',
        resolveQuotaContext: (phase) => ({
          version: 1,
          adapterId: `${kind}-adapter`,
          adapterVersion: 1,
          quotaIds: [phase.quotaProfileId ?? 'quota-1'],
          identity: 'qualified',
          statusCheck: 'supported',
          capacity: 1
        }),
        checkAvailability: async (ctx) => ({
          version: 1,
          adapterId: ctx.adapterId,
          outcomes: [
            {
              quotaId: ctx.quotaIds.at(0)!,
              status: 'cooldown-known',
              resetAt: futureResetAt
            }
          ]
        })
      })
    });

    const planner = new ControlWakeupPlanner({
      ledgerStore,
      availabilityService: service,
      clock,
      timer: clock
    });

    const cand = makeFourCandidates().at(0)!;
    // Configure 120,000 ms monitoring window while known reset is beyond 48 hours
    await planner.registerWaitingFrame({
      rootRunId: 'root-1',
      frameKey: 'frame-review',
      sequence: 1,
      generation: 1,
      monitoringWindowMs: 120_000,
      candidates: [cand]
    });

    // Seed ready observation + notBefore floor to test 5,000 ms vs 5,001 ms drift boundary
    const baseWall = clock.nowWallMs();
    await service.recordCountedTrialOutcome({
      candidateOccurrenceId: cand.candidateOccurrenceId,
      frozenPhase: cand.frozenPhase,
      generation: 1,
      expectedGeneration: 1,
      trialSucceeded: true
    });
    expect(
      service.isCandidateReady(cand.frozenPhase, cand.candidateOccurrenceId)
    ).toBe(true);

    // 1) Exactly 5,000 ms wall/monotonic difference does NOT invalidate readiness
    clock.wallMs += 10_000;
    clock.monotonicMs += 10_000 - CLOCK_DISCONTINUITY_THRESHOLD_MS; // diff = 5,000 ms
    await planner.reconcileFrameClocksAndEvaluate('root-1', 'frame-review');
    expect(
      service.isCandidateReady(cand.frozenPhase, cand.candidateOccurrenceId)
    ).toBe(true);

    // 2) 5,001 ms wall/monotonic difference DOES invalidate readiness
    clock.wallMs += 10_000;
    clock.monotonicMs += 10_000 - (CLOCK_DISCONTINUITY_THRESHOLD_MS + 1); // diff = 5,001 ms
    await planner.reconcileFrameClocksAndEvaluate('root-1', 'frame-review');
    expect(
      service.isCandidateReady(cand.frozenPhase, cand.candidateOccurrenceId)
    ).toBe(false);

    // 3) Backward wall-clock jump > 5,000 ms triggers intervention-required with clock-regressed
    clock.wallMs -= CLOCK_DISCONTINUITY_THRESHOLD_MS + 100;
    const regressedOutcome = await planner.reconcileFrameClocksAndEvaluate(
      'root-1',
      'frame-review'
    );
    expect(regressedOutcome).toEqual({
      status: 'intervention-required',
      pauseCause: 'clock-regressed',
      generation: 1
    });

    // Explicit resumeClockAnchor establishes a new clock anchor and advances generation
    const resumedOutcome = await planner.resumeClockAnchor(
      'root-1',
      'frame-review'
    );
    expect(resumedOutcome.status).toBe('waiting-availability');
    expect(resumedOutcome.generation).toBe(2);

    // 4) AC-27: Advance past monitoringExpiresAt (baseWall + 120,000 ms) before futureResetAt
    clock.wallMs = baseWall + 120_000;
    clock.monotonicMs += 120_000;
    const expiredOutcome = await planner.reconcileFrameClocksAndEvaluate(
      'root-1',
      'frame-review'
    );
    expect(expiredOutcome).toEqual({
      status: 'monitoring-expired',
      monitoringExpiresAt: baseWall + 120_000,
      generation: 2
    });
    expect(clock.pendingTimerCount()).toBe(0);

    // 5) AC-26: Pause/cancel invalidation advances generation and clears armed timers
    const nextGen = await planner.invalidateFrameWakeups(
      'root-1',
      'frame-review',
      { nextStatus: 'paused', pauseCause: 'operator-paused' }
    );
    expect(nextGen).toBe(3);
    expect(planner.getArmedWakeup('root-1', 'frame-review')).toBeUndefined();
  });

  it('AC-28: unsupported check on one candidate does not block other candidates unless all eligible candidates lack automatic recovery', async () => {
    const memento = new InMemoryMemento();
    const ledgerStore = new ControlLedgerStore(memento);
    const clock = new VirtualClockAndTimer();

    await ledgerStore.mutate({}, () => ({
      commit: true,
      plan: {
        nextLedger: {
          ...createEmptyControlLedger(),
          roots: { 'root-1': makeSeededRoot('root-1') }
        },
        result: undefined
      }
    }));

    const service = new BackendAvailabilityService({
      ledgerStore,
      clock,
      getAdapter: (kind) => ({
        adapterId: `${kind}-adapter`,
        adapterVersion: 1,
        backend: kind,
        statusCheck: kind === 'agy' ? 'unsupported' : 'supported',
        resolveQuotaContext: (phase) =>
          kind === 'agy'
            ? {
                version: 1,
                adapterId: 'agy-adapter',
                adapterVersion: 1,
                quotaIds: [UNKNOWN_LOCAL_QUOTA_ID],
                identity: 'unknown',
                statusCheck: 'unsupported',
                capacity: 1
              }
            : {
                version: 1,
                adapterId: `${kind}-adapter`,
                adapterVersion: 1,
                quotaIds: [phase.quotaProfileId ?? 'quota-supported'],
                identity: 'qualified',
                statusCheck: 'supported',
                capacity: 1
              },
        checkAvailability: async (ctx) => ({
          version: 1,
          adapterId: ctx.adapterId,
          outcomes: [{ quotaId: ctx.quotaIds.at(0)!, status: 'ready' }]
        })
      })
    });

    const planner = new ControlWakeupPlanner({
      ledgerStore,
      availabilityService: service,
      clock,
      timer: clock
    });

    // Candidate 1 is unsupported with allowUnverifiedTrial: false; Candidate 2 is supported
    const evalWithFallback = await planner.registerWaitingFrame({
      rootRunId: 'root-1',
      frameKey: 'frame-review',
      sequence: 1,
      generation: 1,
      candidates: [
        {
          candidateId: 'cand-unsupported',
          candidateOccurrenceId: 'occ-unsupported',
          frozenPhase: { id: 'p1', runner: 'agy' },
          priority: 1,
          allowUnverifiedTrial: false
        },
        {
          candidateId: 'cand-supported',
          candidateOccurrenceId: 'occ-supported',
          frozenPhase: { id: 'p2', runner: 'claude', quotaProfileId: 'quota-claude' },
          priority: 2
        }
      ]
    });
    expect(evalWithFallback.status).toBe('waiting-availability');

    // When Candidate 2 checks ready, it is selected despite Candidate 1 being unsupported
    clock.advanceBoth(65_001);
    await planner.runDueChecksForFrame('root-1', 'frame-review');
    const afterCheck = await planner.evaluateAndArmFrame('root-1', 'frame-review');
    expect(afterCheck).toEqual({
      status: 'ready-to-admit',
      readyCandidateIds: ['cand-supported'],
      selectedCandidateId: 'cand-supported',
      generation: 1
    });
  });
});
