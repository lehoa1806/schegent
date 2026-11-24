import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ExecutionFence,
  type QuotaObservationRecord
} from '../../src/contracts/control-ledger';
import type { Memento } from '../../src/state/workspace-state';
import { ControlAttemptAdmissionService } from '../../src/services/workflow-execution/control-attempt-admission';
import {
  ControlLedgerStore,
  lookupRecord
} from '../../src/services/workflow-execution/control-ledger-store';
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

  async function setupTwentyContendingQueues() {
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
    const sequencesByRoot = new Map<string, number>();
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
        waiterIdsByRoot.set(rootId, reg.waiter.waiterId);
        sequencesByRoot.set(rootId, reg.waiter.sequence);
      }
    }

    return { fencesByRoot, waiterIdsByRoot, sequencesByRoot };
  }

  async function commitGrantedWaiterAttempt(params: {
    readonly rootId: string;
    readonly queueId: string;
    readonly attemptId: string;
    readonly fence: ExecutionFence;
    readonly waiterId: string | undefined;
  }): Promise<void> {
    const grant = arbiter.preparePermitGrant({
      waiterId: params.waiterId,
      attemptId: params.attemptId
    });
    expect(grant.ok).toBe(true);
    if (!grant.ok) return;

    const prep = await admission.prepareAttempt({
      ledgerRunId: params.rootId,
      connectedRunId: `conn:${params.rootId}`,
      queueId: params.queueId,
      frameKey: 'root',
      workflowId: 'wf-test',
      invocationId: `conn:${params.rootId}:root`,
      nodeId: 'node-1',
      attemptId: params.attemptId,
      backend: 'claude',
      fence: params.fence,
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

    const commit = await admission.commitAttempt(prep.token);
    expect(commit.ok).toBe(true);
  }

  it('assigns monotonic wait sequences 1..20 across 20 contending queues and grants shared quota strictly to sequence 1 (AC-33)', async () => {
    const { waiterIdsByRoot, sequencesByRoot } = await setupTwentyContendingQueues();

    for (let i = 1; i <= 20; i += 1) {
      expect(sequencesByRoot.get(`root-${i}`)).toBe(i);
    }

    const grantW2Preempted = arbiter.preparePermitGrant({
      waiterId: waiterIdsByRoot.get('root-2'),
      attemptId: 'att-root-2'
    });
    expect(grantW2Preempted.ok).toBe(false);
    if (!grantW2Preempted.ok) {
      expect(grantW2Preempted.reason).toBe('preempted-by-older-waiter');
    }

    const grantW1 = arbiter.preparePermitGrant({
      waiterId: waiterIdsByRoot.get('root-1'),
      attemptId: 'att-root-1'
    });
    expect(grantW1.ok).toBe(true);
  });

  it('skips a paused lowest-sequence waiter across 20 queues without losing its sequence so sequence 2 can acquire shared quota (AC-26, AC-33)', async () => {
    const { waiterIdsByRoot } = await setupTwentyContendingQueues();

    const pausedW1 = await arbiter.setWaiterPaused({
      rootRunId: 'root-1',
      invocationId: 'conn:root-1:root',
      paused: true
    });
    expect(pausedW1?.sequence).toBe(1);
    expect(pausedW1?.paused).toBe(true);

    const grantW2 = arbiter.preparePermitGrant({
      waiterId: waiterIdsByRoot.get('root-2'),
      attemptId: 'att-root-2'
    });
    expect(grantW2.ok).toBe(true);
  });

  it('allows an independent-quota waiter at sequence 20 to proceed without starvation behind 19 shared-quota queues (AC-28, AC-33)', async () => {
    const { waiterIdsByRoot } = await setupTwentyContendingQueues();

    await arbiter.setWaiterPaused({
      rootRunId: 'root-1',
      invocationId: 'conn:root-1:root',
      paused: true
    });

    const grantW20 = arbiter.preparePermitGrant({
      waiterId: waiterIdsByRoot.get('root-20'),
      attemptId: 'att-root-20'
    });
    expect(grantW20.ok).toBe(true);
  });

  it('atomically commits waiter 2 via ControlAttemptAdmissionService and blocks waiter 3 with quota-capacity-exhausted while held (AC-33)', async () => {
    const { fencesByRoot, waiterIdsByRoot } = await setupTwentyContendingQueues();

    await arbiter.setWaiterPaused({
      rootRunId: 'root-1',
      invocationId: 'conn:root-1:root',
      paused: true
    });

    await commitGrantedWaiterAttempt({
      rootId: 'root-2',
      queueId: 'queue-2',
      attemptId: 'att-root-2',
      fence: fencesByRoot.get('root-2')!,
      waiterId: waiterIdsByRoot.get('root-2')
    });

    const grantW3WhileHeld = arbiter.preparePermitGrant({
      waiterId: waiterIdsByRoot.get('root-3'),
      attemptId: 'att-root-3'
    });
    expect(grantW3WhileHeld.ok).toBe(false);
    if (!grantW3WhileHeld.ok) {
      expect(grantW3WhileHeld.reason).toBe('quota-capacity-exhausted');
    }
  });

  it('reclaims shared-quota priority for resumed sequence-1 waiter ahead of sequence 3 once waiter 2 settles (AC-26, AC-33)', async () => {
    const { fencesByRoot, waiterIdsByRoot } = await setupTwentyContendingQueues();

    await arbiter.setWaiterPaused({
      rootRunId: 'root-1',
      invocationId: 'conn:root-1:root',
      paused: true
    });

    await commitGrantedWaiterAttempt({
      rootId: 'root-2',
      queueId: 'queue-2',
      attemptId: 'att-root-2',
      fence: fencesByRoot.get('root-2')!,
      waiterId: waiterIdsByRoot.get('root-2')
    });

    // Resume Waiter 1 (still has sequence 1) before root-2 finishes
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

    // Resumed Waiter 1 reclaims priority ahead of Waiter 3 (sequence 3)
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
      expect(lookupRecord(afterRead.ledger.roots, 'root-1')?.dispatchedAttempts).toBe(0);
      expect(afterRead.ledger.waiters).toHaveLength(1);
      expect(afterRead.ledger.waiters.at(0)?.sequence).toBe(1);
      expect(afterRead.ledger.waiters.at(0)?.status).toBe('waiting');
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
    expect(lookupRecord(holdingsAfter24h, 'quota-1')?.uncertainCount).toBe(1);
    expect(lookupRecord(holdingsAfter24h, 'quota-1')?.totalActiveCount).toBe(1);

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
