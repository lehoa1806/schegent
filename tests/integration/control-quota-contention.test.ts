import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ExecutionFence,
  type QuotaObservationRecord
} from '../../src/contracts/control-ledger';
import type { Memento } from '../../src/state/workspace-state';
import { ControlAttemptAdmissionService } from '../../src/services/workflow-execution/control-attempt-admission';
import { ControlLedgerStore } from '../../src/services/workflow-execution/control-ledger-store';
import { QuotaPermitArbiter } from '../../src/services/workflow-execution/quota-permit-arbiter';

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

function makeFence(
  rootId: string,
  overrides?: Partial<ExecutionFence>
): ExecutionFence {
  return {
    primacyClaim: 'window-1:epoch-1',
    queueClaim: `claim:${rootId}`,
    rootGeneration: 1,
    ...overrides
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

describe('Control quota contention and crash recovery integration tests (FR-R5-F29 / SPEC-07)', () => {
  let nowWallMs: number;
  let nowMonoMs: number;
  let store: ControlLedgerStore;
  let admission: ControlAttemptAdmissionService;
  let arbiter: QuotaPermitArbiter;

  beforeEach(() => {
    nowWallMs = 10_000;
    nowMonoMs = 1_000;
    store = new ControlLedgerStore(makeMemoryMemento());
    admission = new ControlAttemptAdmissionService({
      ledgerStore: store,
      clock: {
        nowWallMs: () => nowWallMs,
        nowMonotonicMs: () => nowMonoMs
      }
    });
    arbiter = new QuotaPermitArbiter({
      ledgerStore: store,
      clock: {
        nowWallMs: () => nowWallMs,
        nowMonotonicMs: () => nowMonoMs,
        hostEpoch: 'epoch-1'
      }
    });
  });

  afterEach(() => {
    // in-memory store cleanup
  });

  async function setupActiveRoot(rootId: string, queueId = `queue:${rootId}`) {
    const fence = makeFence(rootId);
    const prep = await admission.prepareRootLink({
      ledgerRunId: rootId,
      connectedRunId: `conn:${rootId}`,
      rootWorkflowId: 'wf-test',
      queueId,
      fence
    });
    expect(prep.ok).toBe(true);
    const act = await admission.activateRootLink({
      ledgerRunId: rootId,
      connectedRunId: `conn:${rootId}`,
      fence
    });
    expect(act.ok).toBe(true);
    return fence;
  }

  it('fairly arbitrates 20 contending queues on a shared quota, skips paused lowest-sequence waiter without losing its sequence, and lets independent quotas proceed without starvation (AC-33, AC-26, AC-28)', async () => {
    const fencesByRoot = new Map<string, ExecutionFence>();
    for (let i = 1; i <= 20; i += 1) {
      const rootId = `root-${i}`;
      const fence = await setupActiveRoot(rootId, `queue-${i}`);
      fencesByRoot.set(rootId, fence);
    }

    await store.mutate({ targetRootId: 'root-1' }, ({ ledger }) => ({
      commit: true,
      plan: {
        nextLedger: {
          ...ledger,
          quotaObservations: {
            'quota-shared': makeReadyObservation('quota-shared', 1, nowWallMs, 'epoch-1'),
            'quota-independent': makeReadyObservation(
              'quota-independent',
              1,
              nowWallMs,
              'epoch-1'
            )
          }
        },
        targetRootId: 'root-1',
        result: undefined
      }
    }));

    // Register 19 waiters on 'quota-shared' and the 20th on 'quota-independent'
    const waiterIdsByRoot = new Map<string, string>();
    for (let i = 1; i <= 20; i += 1) {
      const rootId = `root-${i}`;
      const quotaId = i === 20 ? 'quota-independent' : 'quota-shared';
      const reg = await arbiter.registerWaiter({
        rootRunId: rootId,
        queueId: `queue-${i}`,
        invocationId: `conn:${rootId}:root`,
        frameKey: 'root',
        nodeId: 'node-1',
        generation: 1,
        quotaIds: [quotaId]
      });
      expect(reg.ok).toBe(true);
      if (reg.ok) {
        expect(reg.waiter.sequence).toBe(i);
        waiterIdsByRoot.set(rootId, reg.waiter.waiterId);
      }
    }

    // Pause the lowest-sequence waiter (root-1, sequence 1)
    const pausedW1 = await arbiter.setWaiterPaused({
      rootRunId: 'root-1',
      invocationId: 'conn:root-1:root',
      paused: true
    });
    expect(pausedW1?.sequence).toBe(1);
    expect(pausedW1?.paused).toBe(true);

    // Waiter 2 (sequence 2) can now acquire 'quota-shared' because Waiter 1 is paused and skipped without losing sequence 1
    const grantW2 = arbiter.preparePermitGrant({
      waiterId: waiterIdsByRoot.get('root-2'),
      attemptId: 'att-root-2'
    });
    expect(grantW2.ok).toBe(true);
    if (!grantW2.ok) return;

    // Waiter 20 (sequence 20, on 'quota-independent') is NOT blocked by 18 earlier waiters on 'quota-shared'
    const grantW20 = arbiter.preparePermitGrant({
      waiterId: waiterIdsByRoot.get('root-20'),
      attemptId: 'att-root-20'
    });
    expect(grantW20.ok).toBe(true);

    // Commit Waiter 2's attempt atomically via ControlAttemptAdmissionService
    const prep2 = await admission.prepareAttempt({
      ledgerRunId: 'root-2',
      connectedRunId: 'conn:root-2',
      queueId: 'queue-2',
      frameKey: 'root',
      workflowId: 'wf-test',
      invocationId: 'conn:root-2:root',
      nodeId: 'node-1',
      attemptId: 'att-root-2',
      backend: 'claude',
      fence: fencesByRoot.get('root-2')!,
      quotaKeys: grantW2.proposal.sortedQuotaIds,
      observationIds: grantW2.proposal.observationIds,
      requireFreshReady: grantW2.proposal.requireFreshReady,
      hostEpoch: grantW2.proposal.hostEpoch,
      capacitiesByQuotaId: grantW2.proposal.capacitiesByQuotaId,
      satisfiedWaiterId: grantW2.proposal.waiter.waiterId,
      expectedWaiterSequence: grantW2.proposal.waiter.sequence,
      expectedWaiterGeneration: grantW2.proposal.waiter.generation
    });
    expect(prep2.ok).toBe(true);
    if (!prep2.ok) return;

    const commit2 = await admission.commitAttempt(prep2.token);
    expect(commit2.ok).toBe(true);

    // While root-2 holds 'quota-shared', root-3 is blocked by quota-capacity-exhausted
    const grantW3WhileHeld = arbiter.preparePermitGrant({
      waiterId: waiterIdsByRoot.get('root-3'),
      attemptId: 'att-root-3'
    });
    expect(grantW3WhileHeld.ok).toBe(false);
    if (!grantW3WhileHeld.ok) {
      expect(grantW3WhileHeld.reason).toBe('quota-capacity-exhausted');
    }

    // Resume Waiter 1 (still has sequence 1!) before root-2 finishes
    const resumedW1 = await arbiter.setWaiterPaused({
      rootRunId: 'root-1',
      invocationId: 'conn:root-1:root',
      paused: false
    });
    expect(resumedW1?.sequence).toBe(1);
    expect(resumedW1?.paused).toBe(false);

    // Settle root-2's attempt -> releases 'quota-shared'
    const settled2 = await admission.settleAttempt({
      ledgerRunId: 'root-2',
      attemptId: 'att-root-2',
      fence: fencesByRoot.get('root-2')!,
      terminalStatus: 'completed'
    });
    expect(settled2.ok).toBe(true);

    // Now that Waiter 1 is resumed with sequence 1, Waiter 1 reclaims priority ahead of Waiter 3 (sequence 3)!
    const grantW3AfterResume = arbiter.preparePermitGrant({
      waiterId: waiterIdsByRoot.get('root-3'),
      attemptId: 'att-root-3'
    });
    expect(grantW3AfterResume.ok).toBe(false);
    if (!grantW3AfterResume.ok) {
      expect(grantW3AfterResume.reason).toBe('preempted-by-older-waiter');
    }

    const grantW1AfterResume = arbiter.preparePermitGrant({
      waiterId: waiterIdsByRoot.get('root-1'),
      attemptId: 'att-root-1'
    });
    expect(grantW1AfterResume.ok).toBe(true);
  });

  it('prevents same-queue overtaking when two waiters share the same queueId', async () => {
    await setupActiveRoot('root-a', 'shared-queue');
    await setupActiveRoot('root-b', 'shared-queue');

    await store.mutate({ targetRootId: 'root-a' }, ({ ledger }) => ({
      commit: true,
      plan: {
        nextLedger: {
          ...ledger,
          quotaObservations: {
            'quota-fast': makeReadyObservation('quota-fast', 1, nowWallMs, 'epoch-1')
            // 'quota-slow' is not ready
          }
        },
        targetRootId: 'root-a',
        result: undefined
      }
    }));

    // Waiter A (head of shared-queue, seq 1) waits on 'quota-slow' (not ready)
    const wA = await arbiter.registerWaiter({
      rootRunId: 'root-a',
      queueId: 'shared-queue',
      invocationId: 'conn:root-a:root',
      frameKey: 'root',
      generation: 1,
      quotaIds: ['quota-slow']
    });
    // Waiter B (later item on shared-queue, seq 2) waits on 'quota-fast' (ready)
    const wB = await arbiter.registerWaiter({
      rootRunId: 'root-b',
      queueId: 'shared-queue',
      invocationId: 'conn:root-b:root',
      frameKey: 'root',
      generation: 1,
      quotaIds: ['quota-fast']
    });
    expect(wA.ok && wB.ok).toBe(true);
    if (!wA.ok || !wB.ok) return;

    // Waiter B must NOT overtake Waiter A on the same queueId!
    const view = arbiter.buildEligibleHeadView();
    const entryB = view.entries.find((e) => e.waiter.waiterId === wB.waiter.waiterId);
    expect(entryB?.admissible).toBe(false);
    expect(entryB?.skipReason).toBe('queue-head-blocked');
  });

  it('revalidates fresh readiness, capacity, and waiter state inside ControlAttemptAdmissionService.commitAttempt with zero partial side effects on failure', async () => {
    const fence1 = await setupActiveRoot('root-1', 'queue-1');

    await store.mutate({ targetRootId: 'root-1' }, ({ ledger }) => ({
      commit: true,
      plan: {
        nextLedger: {
          ...ledger,
          quotaObservations: {
            'quota-1': makeReadyObservation('quota-1', 1, nowWallMs, 'epoch-1')
          }
        },
        targetRootId: 'root-1',
        result: undefined
      }
    }));

    const reg = await arbiter.registerWaiter({
      rootRunId: 'root-1',
      queueId: 'queue-1',
      invocationId: 'conn:root-1:root',
      frameKey: 'root',
      nodeId: 'node-1',
      generation: 1,
      quotaIds: ['quota-1']
    });
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;

    const grant = arbiter.preparePermitGrant({
      waiterId: reg.waiter.waiterId,
      attemptId: 'att-1'
    });
    expect(grant.ok).toBe(true);
    if (!grant.ok) return;

    const prep = await admission.prepareAttempt({
      ledgerRunId: 'root-1',
      connectedRunId: 'conn:root-1',
      queueId: 'queue-1',
      frameKey: 'root',
      workflowId: 'wf-test',
      invocationId: 'conn:root-1:root',
      nodeId: 'node-1',
      attemptId: 'att-1',
      backend: 'claude',
      fence: fence1,
      quotaKeys: grant.proposal.sortedQuotaIds,
      observationIds: grant.proposal.observationIds,
      requireFreshReady: grant.proposal.requireFreshReady,
      hostEpoch: grant.proposal.hostEpoch,
      capacitiesByQuotaId: grant.proposal.capacitiesByQuotaId,
      satisfiedWaiterId: grant.proposal.waiter.waiterId,
      expectedWaiterSequence: grant.proposal.waiter.sequence,
      expectedWaiterGeneration: grant.proposal.waiter.generation
    });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;

    // Advance clock past freshUntil (10_000 + 60_000) before commitAttempt runs
    nowWallMs += 120_000;

    const commit = await admission.commitAttempt(prep.token);
    expect(commit.ok).toBe(false);
    if (!commit.ok) {
      expect(commit.code).toBe('quota-capacity-unavailable');
    }

    // Verify zero partial side effects: no permit created, waiter still waiting with sequence 1, dispatchedAttempts still 0
    const afterRead = store.read();
    expect(afterRead.ok).toBe(true);
    if (afterRead.ok) {
      expect(Object.keys(afterRead.ledger.permits)).toHaveLength(0);
      expect(afterRead.ledger.roots['root-1'].dispatchedAttempts).toBe(0);
      expect(afterRead.ledger.waiters).toHaveLength(1);
      expect(afterRead.ledger.waiters[0].sequence).toBe(1);
      expect(afterRead.ledger.waiters[0].status).toBe('waiting');
    }
  });

  it('retains uncertain permits across restart and fake-clock time advances until resolved (AC-34)', async () => {
    const fence1 = await setupActiveRoot('root-1', 'queue-1');
    const fence2 = await setupActiveRoot('root-2', 'queue-2');

    await store.mutate({ targetRootId: 'root-1' }, ({ ledger }) => ({
      commit: true,
      plan: {
        nextLedger: {
          ...ledger,
          quotaObservations: {
            'quota-1': makeReadyObservation('quota-1', 1, nowWallMs, 'epoch-1')
          }
        },
        targetRootId: 'root-1',
        result: undefined
      }
    }));

    const reg1 = await arbiter.registerWaiter({
      rootRunId: 'root-1',
      queueId: 'queue-1',
      invocationId: 'conn:root-1:root',
      frameKey: 'root',
      nodeId: 'node-1',
      generation: 1,
      quotaIds: ['quota-1']
    });
    expect(reg1.ok).toBe(true);
    if (!reg1.ok) return;

    const grant1 = arbiter.preparePermitGrant({
      waiterId: reg1.waiter.waiterId,
      attemptId: 'att-1'
    });
    expect(grant1.ok).toBe(true);
    if (!grant1.ok) return;

    const prep1 = await admission.prepareAttempt({
      ledgerRunId: 'root-1',
      connectedRunId: 'conn:root-1',
      queueId: 'queue-1',
      frameKey: 'root',
      workflowId: 'wf-test',
      invocationId: 'conn:root-1:root',
      nodeId: 'node-1',
      attemptId: 'att-1',
      backend: 'claude',
      fence: fence1,
      quotaKeys: grant1.proposal.sortedQuotaIds,
      observationIds: grant1.proposal.observationIds,
      requireFreshReady: grant1.proposal.requireFreshReady,
      hostEpoch: grant1.proposal.hostEpoch,
      capacitiesByQuotaId: grant1.proposal.capacitiesByQuotaId,
      satisfiedWaiterId: grant1.proposal.waiter.waiterId,
      expectedWaiterSequence: grant1.proposal.waiter.sequence,
      expectedWaiterGeneration: grant1.proposal.waiter.generation
    });
    expect(prep1.ok).toBe(true);
    if (!prep1.ok) return;

    const commit1 = await admission.commitAttempt(prep1.token);
    expect(commit1.ok).toBe(true);

    // Record spawn-intent so the attempt is side-effecting and in-flight before simulated crash
    const spawn1 = await admission.recordSpawnIntent({
      ledgerRunId: 'root-1',
      attemptId: 'att-1',
      fence: fence1,
      hasSideEffects: true
    });
    expect(spawn1.ok).toBe(true);

    // Simulate host crash and reconcile root-1 without process evidence -> transitions permit to held-uncertain / uncertain
    const reconciled = await admission.reconcileControlRoot({
      ledgerRunId: 'root-1',
      connectedRun: null,
      newFence: makeFence('root-1', {
        primacyClaim: 'window-2:epoch-2',
        rootGeneration: 2
      })
    });
    expect(reconciled.ok).toBe(true);
    expect(reconciled.disposition).toBe('paused-uncertain-effect');

    // Advance virtual clock by 24 hours; refresh observation so it remains ready
    nowWallMs += 86_400_000;
    nowMonoMs += 86_400_000;
    await store.mutate({ targetRootId: 'root-2' }, ({ ledger }) => ({
      commit: true,
      plan: {
        nextLedger: {
          ...ledger,
          quotaObservations: {
            'quota-1': makeReadyObservation('quota-1', 1, nowWallMs, 'epoch-1')
          }
        },
        targetRootId: 'root-2',
        result: undefined
      }
    }));

    // Verify uncertain permit is STILL retained after 24 hours and blocks root-2 from acquiring 'quota-1'
    const holdingsAfter24h = arbiter.getQuotaHoldingsSummary();
    expect(holdingsAfter24h['quota-1'].uncertainCount).toBe(1);
    expect(holdingsAfter24h['quota-1'].totalActiveCount).toBe(1);

    const reg2 = await arbiter.registerWaiter({
      rootRunId: 'root-2',
      queueId: 'queue-2',
      invocationId: 'conn:root-2:root',
      frameKey: 'root',
      nodeId: 'node-1',
      generation: 1,
      quotaIds: ['quota-1']
    });
    expect(reg2.ok).toBe(true);
    if (!reg2.ok) return;

    const grant2Blocked = arbiter.preparePermitGrant({
      waiterId: reg2.waiter.waiterId,
      attemptId: 'att-2'
    });
    expect(grant2Blocked.ok).toBe(false);
    if (!grant2Blocked.ok) {
      expect(grant2Blocked.reason).toBe('quota-capacity-exhausted');
    }
    expect(fence2.rootGeneration).toBe(1);
  });
});
