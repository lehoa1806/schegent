import { describe, expect, it } from 'vitest';
import type {
  ExecutionFence,
  ProcessEvidenceSnapshot
} from '../../src/contracts/control-ledger';
import { ControlAttemptAdmissionService } from '../../src/services/workflow-execution/control-attempt-admission';
import {
  ControlLedgerStore,
  lookupRecord
} from '../../src/services/workflow-execution/control-ledger-store';
import { createComposableWorkflowRunSnapshot } from '../../src/services/workflow-execution/connected-run-factory';
import { WorkflowRecoveryService } from '../../src/services/workflow-execution/workflow-recovery-service';
import type { ConnectedWorkflowRun } from '../../src/state/connected-workflow-run';
import { KEYS, WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';

function createBackingMemento(): Memento & { readonly raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  return {
    raw,
    get<T>(key: string): T | undefined {
      return raw.get(key) as T | undefined;
    },
    update(key: string, value: unknown): Thenable<void> {
      if (value === undefined) {
        raw.delete(key);
      } else {
        raw.set(key, JSON.parse(JSON.stringify(value)));
      }
      return Promise.resolve();
    }
  };
}

const FENCE_GEN_1: ExecutionFence = {
  primacyClaim: 'primacy-1',
  queueClaim: 'queue-claim-1',
  rootGeneration: 1
};

const FENCE_GEN_2: ExecutionFence = {
  primacyClaim: 'primacy-2',
  queueClaim: 'queue-claim-2',
  rootGeneration: 2
};

function makeConnectedRun(
  connectedRunId: string,
  ledgerRunId?: string,
  queueId = 'default'
): ConnectedWorkflowRun {
  const created = createComposableWorkflowRunSnapshot({
    connectedRunId,
    workflow: {
      workflowId: 'wf-crash-test',
      name: 'Crash Test Workflow',
      version: 1,
      nodes: [{ nodeId: 'step-1', kind: 'phase', phaseId: 'phase-1', label: 'Step 1' }],
      connections: [],
      startNodeIds: ['step-1']
    },
    entryNodeId: 'step-1',
    effectivePhases: [
      {
        phaseId: 'phase-1',
        name: 'Phase 1',
        version: 1,
        runner: 'claude',
        instruction: 'Run step 1'
      }
    ],
    boundInputs: {},
    queueId,
    startedAt: 1_000
  });
  if (created.outcome !== 'created') {
    throw new Error('Failed to create test connected run');
  }
  if (ledgerRunId === undefined) {
    return created.run;
  }
  return Object.freeze({
    ...created.run,
    controlState: Object.freeze({ version: 1 as const, ledgerRunId })
  });
}

describe('Control admission crash-window reconciliation (FR-R5-F26 / SPEC-04 / D4 / AC-19)', () => {
  it('Crash Point 1: cleans up an unreferenced prepared root when crash occurs before ConnectedWorkflowRun link is written', async () => {
    const m = createBackingMemento();
    const wsStore = new WorkspaceStateStore(m);
    const ledgerStore = new ControlLedgerStore(wsStore);
    const service1 = new ControlAttemptAdmissionService({ ledgerStore });

    const prep = await service1.prepareRootLink({
      ledgerRunId: 'ledger-cp1',
      connectedRunId: 'crun-cp1',
      rootWorkflowId: 'wf-crash-test',
      queueId: 'queue-a',
      fence: FENCE_GEN_1
    });
    expect(prep.ok).toBe(true);
    expect(ledgerStore.getRoot('ledger-cp1')?.linkState).toBe('prepared');

    // Simulate host restart before ConnectedWorkflowRun is persisted
    const service2 = new ControlAttemptAdmissionService({
      ledgerStore: new ControlLedgerStore(wsStore)
    });
    const reconciled = await service2.reconcileControlRoot({
      ledgerRunId: 'ledger-cp1',
      connectedRun: null,
      newFence: FENCE_GEN_2
    });
    expect(reconciled.ok).toBe(true);
    expect(reconciled.disposition).toBe('cleaned-prepared-root');
    expect(ledgerStore.getRoot('ledger-cp1')).toBeNull();
  });

  it('Crash Point 2: activates a prepared root link when ConnectedWorkflowRun was persisted with matching controlState', async () => {
    const m = createBackingMemento();
    const wsStore = new WorkspaceStateStore(m);
    const ledgerStore = new ControlLedgerStore(wsStore);
    const service1 = new ControlAttemptAdmissionService({ ledgerStore });

    await service1.prepareRootLink({
      ledgerRunId: 'ledger-cp2',
      connectedRunId: 'crun-cp2',
      rootWorkflowId: 'wf-crash-test',
      queueId: 'default',
      fence: FENCE_GEN_1
    });
    const connectedRun = makeConnectedRun('crun-cp2', 'ledger-cp2');
    await wsStore.compareAndSetConnectedRun(connectedRun, 0);

    // Crash before activateRootLink: recreate service and reconcile
    const service2 = new ControlAttemptAdmissionService({
      ledgerStore: new ControlLedgerStore(wsStore)
    });
    const reconciled = await service2.reconcileControlRoot({
      ledgerRunId: 'ledger-cp2',
      connectedRun: wsStore.getConnectedRun('crun-cp2'),
      newFence: FENCE_GEN_2
    });
    expect(reconciled.ok).toBe(true);
    expect(reconciled.disposition).toBe('activated-prepared-root');
    expect(reconciled.root?.linkState).toBe('active');
    expect(reconciled.root?.fence).toEqual(FENCE_GEN_2);
  });

  it('Crash Point 3: committed pending-dispatch attempt before recordSpawnIntent fails pre-spawn without blind automatic replay when enqueue is missing', async () => {
    const m = createBackingMemento();
    const wsStore = new WorkspaceStateStore(m);
    const ledgerStore = new ControlLedgerStore(wsStore);
    const service1 = new ControlAttemptAdmissionService({ ledgerStore });

    await service1.prepareRootLink({
      ledgerRunId: 'ledger-cp3',
      connectedRunId: 'crun-cp3',
      rootWorkflowId: 'wf-crash-test',
      queueId: 'queue-a',
      fence: FENCE_GEN_1
    });
    await service1.activateRootLink({
      ledgerRunId: 'ledger-cp3',
      connectedRunId: 'crun-cp3',
      fence: FENCE_GEN_1
    });

    const prep = await service1.prepareAttempt({
      ledgerRunId: 'ledger-cp3',
      connectedRunId: 'crun-cp3',
      queueId: 'queue-a',
      frameKey: 'root',
      workflowId: 'wf-crash-test',
      invocationId: 'crun-cp3:root',
      nodeId: 'step-1',
      attemptId: 'att-cp3',
      backend: 'claude',
      reservedMicrousd: 25_000,
      quotaKeys: ['quota:claude'],
      fence: FENCE_GEN_1
    });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;

    const committed = await service1.commitAttempt(prep.token);
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    // Crash occurs right after commitAttempt (or ambiguous commit ack) before recordSpawnIntent.
    // Recreate service over persisted store with process evidence showing 'not-found' and no queue item.
    const service2 = new ControlAttemptAdmissionService({
      ledgerStore: new ControlLedgerStore(wsStore),
      processEvidencePort: {
        inspectAttempt: (): ProcessEvidenceSnapshot => ({
          processState: 'not-found',
          queueItemPresent: false
        })
      }
    });

    const connectedRun = makeConnectedRun('crun-cp3', 'ledger-cp3');
    const reconciled = await service2.reconcileControlRoot({
      ledgerRunId: 'ledger-cp3',
      connectedRun,
      newFence: FENCE_GEN_2
    });
    expect(reconciled.ok).toBe(true);
    expect(reconciled.disposition).toBe('failed-pre-spawn-attempt');
    expect(reconciled.root?.dispatchedAttempts).toBe(1);
    expect(reconciled.root?.reservedMicrousd).toBe(0);
    expect(reconciled.root?.attemptsById['att-cp3']?.stage).toBe('settled');
    expect(reconciled.root?.attemptsById['att-cp3']?.failureCode).toBe(
      'crash-before-spawn-intent'
    );
    expect(reconciled.ledger?.permits['permit:att-cp3']?.status).toBe('released');
  });

  it('Crash Points 4 & 5: crash after recordSpawnIntent or started with uncertain side effects pauses with recovery-uncertain-effect, holds permit across 24h fake clock advance, and leaves sibling queues and legacy state untouched', async () => {
    const legacyRunRecord = {
      id: 'legacy-run-1',
      status: 'running',
      featureId: 'feat-legacy'
    };
    const m = createBackingMemento();
    await m.update(KEYS.run, { 'queue-legacy': legacyRunRecord });

    const wsStore = new WorkspaceStateStore(m);
    const ledgerStore = new ControlLedgerStore(wsStore);
    let clockMs = 50_000;
    const clock = {
      nowWallMs: () => clockMs,
      nowMonotonicMs: () => clockMs
    };

    const service1 = new ControlAttemptAdmissionService({ ledgerStore, clock });

    // Prepare & activate root on default queue and a sibling root on queue-b
    await service1.prepareRootLink({
      ledgerRunId: 'ledger-a',
      connectedRunId: 'crun-a',
      rootWorkflowId: 'wf-crash-test',
      queueId: 'default',
      fence: FENCE_GEN_1
    });
    await service1.activateRootLink({
      ledgerRunId: 'ledger-a',
      connectedRunId: 'crun-a',
      fence: FENCE_GEN_1
    });

    const fenceB: ExecutionFence = {
      primacyClaim: 'primacy-1',
      queueClaim: 'queue-claim-b',
      rootGeneration: 1
    };
    await service1.prepareRootLink({
      ledgerRunId: 'ledger-b',
      connectedRunId: 'crun-b',
      rootWorkflowId: 'wf-crash-test',
      queueId: 'queue-b',
      fence: fenceB
    });
    await service1.activateRootLink({
      ledgerRunId: 'ledger-b',
      connectedRunId: 'crun-b',
      fence: fenceB
    });

    // Admit and recordSpawnIntent on default queue
    const prepA = await service1.prepareAttempt({
      ledgerRunId: 'ledger-a',
      connectedRunId: 'crun-a',
      queueId: 'default',
      frameKey: 'root',
      workflowId: 'wf-crash-test',
      invocationId: 'crun-a:root',
      nodeId: 'step-1',
      attemptId: 'att-a-1',
      backend: 'claude',
      hasSideEffects: true,
      quotaKeys: ['quota:shared-claude'],
      fence: FENCE_GEN_1
    });
    expect(prepA.ok).toBe(true);
    if (!prepA.ok) return;

    const commitA = await service1.commitAttempt(prepA.token);
    expect(commitA.ok).toBe(true);

    const spawnIntentA = await service1.recordSpawnIntent({
      ledgerRunId: 'ledger-a',
      attemptId: 'att-a-1',
      fence: FENCE_GEN_1,
      hasSideEffects: true
    });
    expect(spawnIntentA.ok).toBe(true);

    // Crash after recordSpawnIntent! Recreate service over persisted store; process is gone with no durable completion evidence.
    const service2 = new ControlAttemptAdmissionService({
      ledgerStore: new ControlLedgerStore(wsStore),
      clock,
      processEvidencePort: {
        inspectAttempt: (): ProcessEvidenceSnapshot => ({
          processState: 'not-found'
        })
      }
    });

    const runA = makeConnectedRun('crun-a', 'ledger-a', 'default');
    await wsStore.compareAndSetConnectedRun(runA, 0);

    const reconciledA = await service2.reconcileControlRoot({
      ledgerRunId: 'ledger-a',
      connectedRun: wsStore.getConnectedRun('crun-a'),
      newFence: FENCE_GEN_2
    });
    expect(reconciledA.ok).toBe(true);
    expect(reconciledA.disposition).toBe('paused-uncertain-effect');
    expect(reconciledA.pauseCause).toBe('recovery-uncertain-effect');
    expect(reconciledA.root?.status).toBe('paused');
    expect(reconciledA.root?.dispatchedAttempts).toBe(1);
    expect(reconciledA.ledger?.permits['permit:att-a-1']?.status).toBe('held-uncertain');

    // Advance fake clock by 24 hours: permit MUST remain 'held-uncertain' (no timeout releases it)
    clockMs += 24 * 60 * 60 * 1_000;
    const after24h = ledgerStore.read();
    expect(after24h.ok).toBe(true);
    if (!after24h.ok) return;
    expect(lookupRecord(after24h.ledger.permits, 'permit:att-a-1')?.status).toBe('held-uncertain');

    // Sibling queue-b root is untouched and still active
    expect(lookupRecord(after24h.ledger.roots, 'ledger-b')?.status).toBe('in-flight');
    expect(lookupRecord(after24h.ledger.roots, 'ledger-b')?.linkState).toBe('active');

    // Unrelated legacy state is unchanged
    expect(m.raw.get(KEYS.run)).toEqual({ 'queue-legacy': legacyRunRecord });

    // Also verify WorkflowRecoveryService never blindly dispatches a pending-dispatch attempt when controlState is linked and enqueue is missing
    let blindDispatchCount = 0;
    const recoveryService = new WorkflowRecoveryService({
      connectedRuns: {
        get: (id) => wsStore.getConnectedRun(id),
        compareAndSetConnectedRun: (next, rev) =>
          wsStore.compareAndSetConnectedRun(next, rev)
      },
      dispatchPhase: async () => {
        blindDispatchCount += 1;
        return { outcome: 'dispatched', queueItemId: 'should-not-happen' };
      },
      controlAdmission: service2,
      resolveRecoveryFence: () => FENCE_GEN_2
    });
    await recoveryService.reconcileRun('crun-a', clockMs);
    expect(blindDispatchCount).toBe(0);
  });
});
