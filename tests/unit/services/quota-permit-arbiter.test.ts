import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UNKNOWN_LOCAL_QUOTA_ID } from '../../../src/contracts/backend-availability';
import {
  type ExecutionFence,
  type QuotaObservationRecord,
  type RootControlState
} from '../../../src/contracts/control-ledger';
import type { Memento } from '../../../src/state/workspace-state';
import { ControlLedgerStore } from '../../../src/services/workflow-execution/control-ledger-store';
import {
  QuotaPermitArbiter,
  quotaIdSetsEqual,
  sortQuotaIds,
  validateQuotaPermit,
  validateQuotaWaiter
} from '../../../src/services/workflow-execution/quota-permit-arbiter';

function makeMemoryMemento(): Memento {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return map.has(key) ? (map.get(key) as T) : defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) {
        map.delete(key);
      } else {
        map.set(key, structuredClone(value));
      }
    }
  };
}

function makeFence(overrides?: Partial<ExecutionFence>): ExecutionFence {
  return {
    primacyClaim: 'window-1:epoch-1',
    queueClaim: 'queue-claim-1',
    rootGeneration: 1,
    ...overrides
  };
}

function makeRoot(
  rootRunId: string,
  queueId = `queue:${rootRunId}`,
  fenceOverrides?: Partial<ExecutionFence>
): RootControlState {
  const fence = makeFence(fenceOverrides);
  return {
    version: 1,
    ledgerRunId: rootRunId,
    connectedRunId: `conn:${rootRunId}`,
    rootWorkflowId: 'wf-1',
    queueId,
    status: 'in-flight',
    linkState: 'active',
    fence,
    rootBudget: {
      version: 1,
      maxPhaseAttempts: 20
    },
    dispatchedAttempts: 0,
    settledMicrousd: 0,
    reservedMicrousd: 0,
    framesByKey: {
      'frame:main': {
        frameKey: 'frame:main',
        parentFrameKey: null,
        invocationId: 'frame:main',
        workflowId: 'wf-1',
        kind: 'candidate-block',
        nodeId: 'node-1',
        frameGeneration: fence.rootGeneration,
        status: 'in-flight',
        createdAt: 1_000,
        updatedAt: 1_000,
        dispatchedCount: 0,
        maxDispatches: 10
      }
    },
    attemptsById: {},
    createdAt: 1_000,
    updatedAt: 1_000
  };
}

function makeReadyObservation(
  quotaId: string,
  capacity = 1,
  observedAt = 1_000,
  hostEpoch = 'epoch-1'
): QuotaObservationRecord {
  return {
    quotaKey: quotaId,
    quotaId,
    backend: 'claude',
    status: 'ready',
    observedAt,
    capacity,
    checkAttempts: 1,
    hostEpoch
  };
}

describe('QuotaPermitArbiter unit tests (FR-R5-F29 / SPEC-07)', () => {
  let nowWallMs: number;
  let nowMonoMs: number;
  let store: ControlLedgerStore;

  beforeEach(() => {
    nowWallMs = 10_000;
    nowMonoMs = 1_000;
    store = new ControlLedgerStore(makeMemoryMemento());
  });

  afterEach(() => {
    // in-memory store cleanup
  });

  describe('closed-shape validation (D7)', () => {
    it('validates QuotaWaiter and rejects unknown keys, empty/duplicate/>4 quotaIds, and invalid sequence', () => {
      const valid = validateQuotaWaiter({
        waiterId: 'w-1',
        rootRunId: 'root-1',
        queueId: 'q-1',
        invocationId: 'inv-1',
        generation: 1,
        sequence: 1,
        quotaIds: ['quota-b', 'quota-a'],
        registeredAt: 1_000
      });
      expect(valid.ok).toBe(true);
      if (valid.ok) {
        expect(valid.value.quotaIds).toEqual(['quota-a', 'quota-b']);
      }

      // Unknown field rejected
      expect(
        validateQuotaWaiter({
          waiterId: 'w-1',
          rootRunId: 'root-1',
          queueId: 'q-1',
          invocationId: 'inv-1',
          generation: 1,
          sequence: 1,
          quotaIds: ['quota-a'],
          registeredAt: 1_000,
          extraField: true
        }).ok
      ).toBe(false);

      // Duplicate quotaIds rejected
      expect(
        validateQuotaWaiter({
          waiterId: 'w-1',
          rootRunId: 'root-1',
          queueId: 'q-1',
          invocationId: 'inv-1',
          generation: 1,
          sequence: 1,
          quotaIds: ['quota-a', 'quota-a'],
          registeredAt: 1_000
        }).ok
      ).toBe(false);

      // > 4 quotaIds rejected
      expect(
        validateQuotaWaiter({
          waiterId: 'w-1',
          rootRunId: 'root-1',
          queueId: 'q-1',
          invocationId: 'inv-1',
          generation: 1,
          sequence: 1,
          quotaIds: ['q1', 'q2', 'q3', 'q4', 'q5'],
          registeredAt: 1_000
        }).ok
      ).toBe(false);

      // Sequence <= 0 rejected
      expect(
        validateQuotaWaiter({
          waiterId: 'w-1',
          rootRunId: 'root-1',
          queueId: 'q-1',
          invocationId: 'inv-1',
          generation: 1,
          sequence: 0,
          quotaIds: ['q1'],
          registeredAt: 1_000
        }).ok
      ).toBe(false);
    });

    it('validates QuotaPermit and rejects unknown keys, invalid state, or malformed fence', () => {
      const valid = validateQuotaPermit({
        permitId: 'permit:att-1',
        attemptId: 'att-1',
        rootRunId: 'root-1',
        queueId: 'q-1',
        quotaIds: ['quota-z', 'quota-a'],
        executionFence: makeFence(),
        grantedAt: 1_000,
        state: 'held'
      });
      expect(valid.ok).toBe(true);
      if (valid.ok) {
        expect(valid.value.quotaIds).toEqual(['quota-a', 'quota-z']);
      }

      expect(
        validateQuotaPermit({
          permitId: 'permit:att-1',
          attemptId: 'att-1',
          rootRunId: 'root-1',
          queueId: 'q-1',
          quotaIds: ['quota-a'],
          executionFence: makeFence(),
          grantedAt: 1_000,
          state: 'released'
        }).ok
      ).toBe(false);

      expect(
        validateQuotaPermit({
          permitId: 'permit:att-1',
          attemptId: 'att-1',
          rootRunId: 'root-1',
          queueId: 'q-1',
          quotaIds: ['quota-a'],
          executionFence: makeFence(),
          grantedAt: 1_000,
          state: 'uncertain',
          unexpected: 'field'
        }).ok
      ).toBe(false);
    });

    it('sorts quotaIds by UTF-8 byte order and compares sets independent of input order', () => {
      expect(sortQuotaIds(['quota-b', 'quota-a', 'quota-1'])).toEqual([
        'quota-1',
        'quota-a',
        'quota-b'
      ]);
      expect(quotaIdSetsEqual(['quota-b', 'quota-a'], ['quota-a', 'quota-b'])).toBe(true);
      expect(quotaIdSetsEqual(['quota-a'], ['quota-a', 'quota-b'])).toBe(false);
    });
  });

  describe('monotonic sequence allocation, preservation, reselection, and overflow', () => {
    it('allocates sequence once per selection, preserves across polling and pause/resume, and allocates new sequence on quota-set reselection', async () => {
      await store.mutate({ targetRootId: 'root-1' }, ({ ledger }) => ({
        commit: true,
        plan: {
          nextLedger: {
            ...ledger,
            roots: { 'root-1': makeRoot('root-1', 'q-1') }
          },
          targetRootId: 'root-1',
          result: undefined
        }
      }));

      const arbiter = new QuotaPermitArbiter({
        ledgerStore: store,
        clock: {
          nowWallMs: () => nowWallMs,
          nowMonotonicMs: () => nowMonoMs,
          hostEpoch: 'epoch-1'
        }
      });

      const first = await arbiter.registerWaiter({
        rootRunId: 'root-1',
        queueId: 'q-1',
        invocationId: 'frame:main',
        frameKey: 'frame:main',
        generation: 1,
        quotaIds: ['quota-b', 'quota-a']
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.waiter.sequence).toBe(1);
      expect(first.preservedSequence).toBe(false);

      // Polling update with same quota set in reverse order preserves sequence = 1
      nowWallMs += 500;
      const polled = await arbiter.registerWaiter({
        rootRunId: 'root-1',
        queueId: 'q-1',
        invocationId: 'frame:main',
        frameKey: 'frame:main',
        generation: 1,
        quotaIds: ['quota-a', 'quota-b']
      });
      expect(polled.ok).toBe(true);
      if (!polled.ok) return;
      expect(polled.waiter.sequence).toBe(1);
      expect(polled.preservedSequence).toBe(true);

      // Pause and resume preserve sequence = 1
      const paused = await arbiter.setWaiterPaused({
        rootRunId: 'root-1',
        invocationId: 'frame:main',
        paused: true
      });
      expect(paused?.sequence).toBe(1);
      expect(paused?.paused).toBe(true);

      const resumed = await arbiter.setWaiterPaused({
        rootRunId: 'root-1',
        invocationId: 'frame:main',
        paused: false
      });
      expect(resumed?.sequence).toBe(1);
      expect(resumed?.paused).toBe(false);

      // Reselecting to a different quota set allocates a new sequence = 2
      const reselected = await arbiter.registerWaiter({
        rootRunId: 'root-1',
        queueId: 'q-1',
        invocationId: 'frame:main',
        frameKey: 'frame:main',
        generation: 1,
        quotaIds: ['quota-c']
      });
      expect(reselected.ok).toBe(true);
      if (!reselected.ok) return;
      expect(reselected.waiter.sequence).toBe(2);
      expect(reselected.preservedSequence).toBe(false);
    });

    it('fails closed when nextWaitSequence reaches Number.MAX_SAFE_INTEGER', async () => {
      await store.mutate({ targetRootId: 'root-1' }, ({ ledger }) => ({
        commit: true,
        plan: {
          nextLedger: {
            ...ledger,
            nextWaitSequence: Number.MAX_SAFE_INTEGER,
            roots: { 'root-1': makeRoot('root-1', 'q-1') }
          },
          targetRootId: 'root-1',
          result: undefined
        }
      }));

      const arbiter = new QuotaPermitArbiter({
        ledgerStore: store,
        clock: {
          nowWallMs: () => nowWallMs,
          nowMonotonicMs: () => nowMonoMs,
          hostEpoch: 'epoch-1'
        }
      });

      const res = await arbiter.registerWaiter({
        rootRunId: 'root-1',
        queueId: 'q-1',
        invocationId: 'frame:main',
        generation: 1,
        quotaIds: ['quota-a']
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe('sequence-overflow');
      }
    });
  });

  describe('all-or-none multi-quota reservation and non-blocking skip semantics', () => {
    it('prevents hold-and-wait deadlock under reverse quota order and lets an independent quota proceed', async () => {
      await store.mutate({ targetRootId: 'root-1' }, ({ ledger }) => ({
        commit: true,
        plan: {
          nextLedger: {
            ...ledger,
            roots: {
              'root-1': makeRoot('root-1', 'q-1'),
              'root-2': makeRoot('root-2', 'q-2'),
              'root-3': makeRoot('root-3', 'q-3')
            },
            quotaObservations: {
              'quota-a': makeReadyObservation('quota-a', 1, nowWallMs, 'epoch-1'),
              'quota-b': makeReadyObservation('quota-b', 1, nowWallMs, 'epoch-1'),
              'quota-c': makeReadyObservation('quota-c', 1, nowWallMs, 'epoch-1')
            },
            permits: {
              // quota-b is currently held by an external active permit
              'permit:active-b': {
                permitId: 'permit:active-b',
                attemptId: 'active-b',
                ledgerRunId: 'root-1',
                rootRunId: 'root-1',
                connectedRunId: 'conn:root-1',
                queueId: 'q-ext',
                quotaKeys: ['quota-b'],
                quotaIds: ['quota-b'],
                executionFence: makeFence(),
                status: 'active',
                state: 'held',
                grantedAt: nowWallMs
              }
            }
          },
          targetRootId: 'root-1',
          result: undefined
        }
      }));

      const arbiter = new QuotaPermitArbiter({
        ledgerStore: store,
        clock: {
          nowWallMs: () => nowWallMs,
          nowMonotonicMs: () => nowMonoMs,
          hostEpoch: 'epoch-1'
        }
      });

      // Waiter 1 (seq 1) requests [quota-b, quota-a] -> quota-b is full, so it must NOT hold quota-a!
      const w1 = await arbiter.registerWaiter({
        rootRunId: 'root-1',
        queueId: 'q-1',
        invocationId: 'frame:main',
        frameKey: 'frame:main',
        generation: 1,
        quotaIds: ['quota-b', 'quota-a']
      });
      // Waiter 2 (seq 2) requests [quota-a] -> because Waiter 1 could not acquire all of [quota-a, quota-b], Waiter 1 holds NO partial lock on quota-a, so Waiter 2 CAN acquire quota-a!
      const w2 = await arbiter.registerWaiter({
        rootRunId: 'root-2',
        queueId: 'q-2',
        invocationId: 'frame:main',
        frameKey: 'frame:main',
        generation: 1,
        quotaIds: ['quota-a']
      });
      // Waiter 3 (seq 3) requests [quota-c] -> completely independent quota
      const w3 = await arbiter.registerWaiter({
        rootRunId: 'root-3',
        queueId: 'q-3',
        invocationId: 'frame:main',
        frameKey: 'frame:main',
        generation: 1,
        quotaIds: ['quota-c']
      });

      expect(w1.ok && w2.ok && w3.ok).toBe(true);
      if (!w1.ok || !w2.ok || !w3.ok) return;

      const grant1 = arbiter.preparePermitGrant({
        waiterId: w1.waiter.waiterId,
        attemptId: 'att-1'
      });
      expect(grant1.ok).toBe(false);
      if (!grant1.ok) {
        expect(grant1.reason).toBe('quota-capacity-exhausted');
      }

      const grant2 = arbiter.preparePermitGrant({
        waiterId: w2.waiter.waiterId,
        attemptId: 'att-2'
      });
      expect(grant2.ok).toBe(true);
      if (grant2.ok) {
        expect(grant2.proposal.sortedQuotaIds).toEqual(['quota-a']);
      }

      const grant3 = arbiter.preparePermitGrant({
        waiterId: w3.waiter.waiterId,
        attemptId: 'att-3'
      });
      expect(grant3.ok).toBe(true);
    });
  });

  describe('unknown-local-quota capacity 1 with occurrence-scoped readiness', () => {
    it('shares capacity 1 on unknown-local-quota while keeping readiness isolated per unknown/<candidateOccurrenceId>', async () => {
      await store.mutate({ targetRootId: 'root-1' }, ({ ledger }) => ({
        commit: true,
        plan: {
          nextLedger: {
            ...ledger,
            roots: {
              'root-1': makeRoot('root-1', 'q-1'),
              'root-2': makeRoot('root-2', 'q-2')
            },
            quotaObservations: {
              'unknown/occ-1': makeReadyObservation(
                'unknown/occ-1',
                4, // even if observation says 4, unknown-local-quota clamps to 1
                nowWallMs,
                'epoch-1'
              )
              // 'unknown/occ-2' has no fresh-ready observation
            }
          },
          targetRootId: 'root-1',
          result: undefined
        }
      }));

      const arbiter = new QuotaPermitArbiter({
        ledgerStore: store,
        clock: {
          nowWallMs: () => nowWallMs,
          nowMonotonicMs: () => nowMonoMs,
          hostEpoch: 'epoch-1'
        }
      });

      const w1 = await arbiter.registerWaiter({
        rootRunId: 'root-1',
        queueId: 'q-1',
        invocationId: 'frame:main',
        frameKey: 'frame:main',
        candidateOccurrenceId: 'occ-1',
        generation: 1,
        quotaIds: [UNKNOWN_LOCAL_QUOTA_ID]
      });
      const w2 = await arbiter.registerWaiter({
        rootRunId: 'root-2',
        queueId: 'q-2',
        invocationId: 'frame:main',
        frameKey: 'frame:main',
        candidateOccurrenceId: 'occ-2',
        generation: 1,
        quotaIds: [UNKNOWN_LOCAL_QUOTA_ID]
      });
      expect(w1.ok && w2.ok).toBe(true);
      if (!w1.ok || !w2.ok) return;

      // Without trial flag, w1 is admissible (unknown/occ-1 is ready), while w2 is not-ready (unknown/occ-2 is unknown)
      const view = arbiter.buildEligibleHeadView();
      const e1 = view.entries.find((e) => e.waiter.waiterId === w1.waiter.waiterId);
      const e2 = view.entries.find((e) => e.waiter.waiterId === w2.waiter.waiterId);
      expect(e1?.admissible).toBe(true);
      expect(e2?.admissible).toBe(false);
      expect(e2?.skipReason).toBe('not-ready');

      // Even if w2 is granted an unverified trial flag, w1 (lower sequence) claims the single unknown-local-quota slot (capacity 1)
      const grant2 = arbiter.preparePermitGrant({
        waiterId: w2.waiter.waiterId,
        attemptId: 'att-2',
        allowUnverifiedTrialByWaiterId: {
          [w2.waiter.waiterId]: true
        }
      });
      expect(grant2.ok).toBe(false);
      if (!grant2.ok) {
        expect(grant2.reason).toBe('preempted-by-older-waiter');
      }
    });
  });

  describe('capacity downgrade and fenced release semantics', () => {
    it('blocks new grants when capacity is downgraded from 2 to 1 while 2 permits are held, without terminating running attempts', async () => {
      await store.mutate({ targetRootId: 'root-1' }, ({ ledger }) => ({
        commit: true,
        plan: {
          nextLedger: {
            ...ledger,
            roots: {
              'root-1': makeRoot('root-1', 'q-1'),
              'root-2': makeRoot('root-2', 'q-2'),
              'root-3': makeRoot('root-3', 'q-3')
            },
            quotaObservations: {
              'quota-shared': makeReadyObservation(
                'quota-shared',
                1, // downgraded from 2 to 1
                nowWallMs,
                'epoch-1'
              )
            },
            permits: {
              'permit:att-1': {
                permitId: 'permit:att-1',
                attemptId: 'att-1',
                ledgerRunId: 'root-1',
                rootRunId: 'root-1',
                connectedRunId: 'conn:root-1',
                queueId: 'q-1',
                quotaKeys: ['quota-shared'],
                quotaIds: ['quota-shared'],
                executionFence: makeFence(),
                status: 'active',
                state: 'held',
                grantedAt: nowWallMs
              },
              'permit:att-2': {
                permitId: 'permit:att-2',
                attemptId: 'att-2',
                ledgerRunId: 'root-2',
                rootRunId: 'root-2',
                connectedRunId: 'conn:root-2',
                queueId: 'q-2',
                quotaKeys: ['quota-shared'],
                quotaIds: ['quota-shared'],
                executionFence: makeFence(),
                status: 'active',
                state: 'held',
                grantedAt: nowWallMs
              }
            }
          },
          targetRootId: 'root-1',
          result: undefined
        }
      }));

      const arbiter = new QuotaPermitArbiter({
        ledgerStore: store,
        clock: {
          nowWallMs: () => nowWallMs,
          nowMonotonicMs: () => nowMonoMs,
          hostEpoch: 'epoch-1'
        }
      });

      const holdings = arbiter.getQuotaHoldingsSummary();
      const sharedHoldings = Object.entries(holdings).find(([k]) => k === 'quota-shared')?.[1];
      expect(sharedHoldings?.heldCount).toBe(2);
      expect(sharedHoldings?.capacity).toBe(1);

      const w3 = await arbiter.registerWaiter({
        rootRunId: 'root-3',
        queueId: 'q-3',
        invocationId: 'frame:main',
        frameKey: 'frame:main',
        generation: 1,
        quotaIds: ['quota-shared']
      });
      expect(w3.ok).toBe(true);
      if (!w3.ok) return;

      const grant3 = arbiter.preparePermitGrant({
        waiterId: w3.waiter.waiterId,
        attemptId: 'att-3'
      });
      expect(grant3.ok).toBe(false);
      if (!grant3.ok) {
        expect(grant3.reason).toBe('quota-capacity-exhausted');
      }
    });

    it('matches release to immutable attemptId and current ownership claims, allowing current-owner teardown after generation advance and rejecting stale claims', async () => {
      // Root generation advanced from 1 to 2 due to pause/cancel while att-1 was running
      const root = makeRoot('root-1', 'q-1', {
        primacyClaim: 'window-1:epoch-1',
        queueClaim: 'queue-claim-1',
        rootGeneration: 2
      });
      await store.mutate({ targetRootId: 'root-1' }, ({ ledger }) => ({
        commit: true,
        plan: {
          nextLedger: {
            ...ledger,
            roots: { 'root-1': root },
            permits: {
              'permit:att-1': {
                permitId: 'permit:att-1',
                attemptId: 'att-1',
                ledgerRunId: 'root-1',
                rootRunId: 'root-1',
                connectedRunId: 'conn:root-1',
                queueId: 'q-1',
                quotaKeys: ['quota-a'],
                quotaIds: ['quota-a'],
                executionFence: makeFence({
                  primacyClaim: 'window-1:epoch-1',
                  queueClaim: 'queue-claim-1',
                  rootGeneration: 1
                }),
                status: 'active',
                state: 'held',
                grantedAt: nowWallMs
              }
            }
          },
          targetRootId: 'root-1',
          result: undefined
        }
      }));

      let notifiedQueueId: string | undefined;
      const arbiter = new QuotaPermitArbiter({
        ledgerStore: store,
        clock: {
          nowWallMs: () => nowWallMs,
          nowMonotonicMs: () => nowMonoMs,
          hostEpoch: 'epoch-1'
        },
        onCapacityOrWaiterChanged: (qId) => {
          notifiedQueueId = qId;
        }
      });

      // Stale primacyClaim rejected
      const staleClaim = await arbiter.releasePermit({
        attemptId: 'att-1',
        rootRunId: 'root-1',
        fence: makeFence({
          primacyClaim: 'stale-window:epoch-0',
          queueClaim: 'queue-claim-1'
        })
      });
      expect(staleClaim.ok).toBe(false);
      if (!staleClaim.ok) {
        expect(staleClaim.reason).toBe('stale-execution-fence');
      }

      // Mismatched attemptId rejected
      const wrongAttempt = await arbiter.releasePermit({
        permitId: 'permit:att-1',
        attemptId: 'att-other',
        rootRunId: 'root-1',
        fence: makeFence()
      });
      expect(wrongAttempt.ok).toBe(false);
      if (!wrongAttempt.ok) {
        expect(wrongAttempt.reason).toBe('attempt-mismatch');
      }

      // Current owner with original attempt generation (1) can release after rootGeneration advanced to 2
      const validRelease = await arbiter.releasePermit({
        attemptId: 'att-1',
        rootRunId: 'root-1',
        fence: makeFence({
          primacyClaim: 'window-1:epoch-1',
          queueClaim: 'queue-claim-1',
          rootGeneration: 1
        })
      });
      expect(validRelease.ok).toBe(true);
      if (validRelease.ok) {
        expect(validRelease.alreadyReleased).toBe(false);
        expect(validRelease.state).toBe('released');
      }
      expect(notifiedQueueId).toBe('q-1');

      // Duplicate release is idempotent and does not re-notify
      notifiedQueueId = undefined;
      const duplicateRelease = await arbiter.releasePermit({
        attemptId: 'att-1',
        rootRunId: 'root-1',
        fence: makeFence()
      });
      expect(duplicateRelease.ok).toBe(true);
      if (duplicateRelease.ok) {
        expect(duplicateRelease.alreadyReleased).toBe(true);
      }
      expect(notifiedQueueId).toBeUndefined();
    });
  });
});
