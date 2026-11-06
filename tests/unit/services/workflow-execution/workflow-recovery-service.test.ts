import { describe, expect, it } from 'vitest';
import type { PhaseDefinition } from '../../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../../src/contracts/workflow-definitions';
import type { ConnectedWorkflowRun } from '../../../../src/state/connected-workflow-run';
import { createComposableWorkflowRunSnapshot } from '../../../../src/services/workflow-execution/connected-run-factory';
import {
  completeComposableNodeAttempt,
  dispatchComposableNode
} from '../../../../src/services/workflow-execution/connected-run-coordinator';
import { continueWaitingHandoff } from '../../../../src/services/workflow-execution/continuation-service';
import {
  WorkflowRecoveryService,
  type WorkflowRecoveryStore
} from '../../../../src/services/workflow-execution/workflow-recovery-service';

const phases: readonly PhaseDefinition[] = [
  { phaseId: 'p1', name: 'Phase 1', version: 1, instruction: 'Do P1' },
  { phaseId: 'p2', name: 'Phase 2', version: 1, instruction: 'Do P2' }
];

const workflowWithManualHandoff: WorkflowDefinition = {
  workflowId: 'wf-recovery',
  name: 'Recovery Workflow',
  version: 1,
  startNodeIds: ['n1'],
  nodes: [
    { nodeId: 'n1', kind: 'phase', phaseId: 'p1' },
    { nodeId: 'n2', kind: 'phase', phaseId: 'p2' }
  ],
  connections: [
    {
      from: { nodeId: 'n1' },
      to: { kind: 'node', nodeId: 'n2' },
      handoff: 'manual'
    }
  ]
};

function createStore(): WorkflowRecoveryStore & {
  readonly seed: (run: ConnectedWorkflowRun) => void;
} {
  const map = new Map<string, ConnectedWorkflowRun>();
  return {
    get(id: string) {
      return map.get(id) ?? null;
    },
    list() {
      return Array.from(map.values());
    },
    seed(run: ConnectedWorkflowRun) {
      map.set(run.connectedRunId, run);
    },
    async compareAndSetConnectedRun(next: ConnectedWorkflowRun, expectedRevision: number) {
      const current = map.get(next.connectedRunId) ?? null;
      if (current === null || current.revision !== expectedRevision) {
        return { outcome: 'stale' as const, current };
      }
      map.set(next.connectedRunId, next);
      return { outcome: 'written' as const, run: next };
    }
  };
}

async function createStartedRun(
  store: WorkflowRecoveryStore & { readonly seed: (run: ConnectedWorkflowRun) => void },
  runId = 'run-rec-1',
  queueId = 'q-1'
) {
  let seq = 0;
  const dispatchPhase = async () => {
    seq += 1;
    return { outcome: 'dispatched' as const, queueItemId: `qi-${seq}` };
  };
  const snap = createComposableWorkflowRunSnapshot({
    connectedRunId: runId,
    workflow: workflowWithManualHandoff,
    effectiveWorkflows: [workflowWithManualHandoff],
    effectivePhases: phases,
    startedAt: 1000,
    queueId
  });
  if (snap.outcome !== 'created') throw new Error('Snapshot failed');
  store.seed(snap.run);
  await dispatchComposableNode(
    { connectedRuns: store, dispatchPhase },
    {
      run: snap.run,
      invocationId: snap.rootInvocationId,
      nodeId: 'n1',
      startedAt: 1010
    }
  );
  return { dispatchPhase, rootInvocationId: snap.rootInvocationId };
}

describe('WorkflowRecoveryService — US3: Deterministic Restart Recovery (FR-R5-F03-T06)', () => {
  it('preserves waiting-for-handoff frames without synthesizing a continuation (clean-handoff)', async () => {
    const store = createStore();
    const { dispatchPhase, rootInvocationId } = await createStartedRun(store);

    // Complete n1 -> enters waiting-for-handoff before n2
    await completeComposableNodeAttempt(
      { connectedRuns: store, dispatchPhase },
      {
        run: store.get('run-rec-1')!,
        invocationId: rootInvocationId,
        nodeId: 'n1',
        status: 'completed',
        completedAt: 1050
      }
    );

    const recovery = new WorkflowRecoveryService({
      connectedRuns: store,
      dispatchPhase
    });

    const reconciled = await recovery.reconcileRun('run-rec-1', 2000);
    expect(reconciled).toBeDefined();
    expect(reconciled?.disposition?.status).toBe('clean-handoff');
    const rootFrame = reconciled!.run.invocations![rootInvocationId]!;
    expect(rootFrame.status).toBe('waiting-for-handoff');
    expect(rootFrame.attemptsByNodeId['n2']).toBeUndefined();
  });

  it('recovers a persisted InvocationInputEnvelope after a post-acceptance pre-dispatch crash (pending-dispatch-recovered)', async () => {
    const store = createStore();
    const { dispatchPhase, rootInvocationId } = await createStartedRun(store);

    await completeComposableNodeAttempt(
      { connectedRuns: store, dispatchPhase },
      {
        run: store.get('run-rec-1')!,
        invocationId: rootInvocationId,
        nodeId: 'n1',
        status: 'completed',
        completedAt: 1050
      }
    );

    // Accept handoff with deferDispatch: true (simulating crash after acceptance & before dispatch)
    const waitingRun = store.get('run-rec-1')!;
    const accepted = await continueWaitingHandoff(
      { connectedRuns: store },
      {
        run: waitingRun,
        expectedRevision: waitingRun.revision,
        invocationId: rootInvocationId,
        targetNodeId: 'n2',
        request: {
          pipelineId: 'n2',
          workflowId: 'wf-recovery',
          inputs: [{ portId: 'promptOverride', type: 'text', value: 'use-persisted-envelope' }],
          supplemental: [],
          outputs: []
        },
        acceptedAt: 1100,
        deferDispatch: true
      }
    );
    expect(accepted.outcome).toBe('accepted');

    const recovery = new WorkflowRecoveryService({
      connectedRuns: store,
      dispatchPhase
    });

    const reconciled = await recovery.reconcileRun('run-rec-1', 2000);
    expect(reconciled?.disposition?.status).toBe('pending-dispatch-recovered');
    const rootFrame = reconciled!.run.invocations![rootInvocationId]!;
    expect(rootFrame.status).toBe('in-flight');
    expect(rootFrame.activeNodeId).toBe('n2');
    expect(rootFrame.attemptsByNodeId['n2']).toHaveLength(1);
    expect(rootFrame.attemptsByNodeId['n2']?.[0]?.inputEnvelope.inputsByPort['promptOverride']?.value).toBe(
      'use-persisted-envelope'
    );
  });

  it('leaves the Workflow public inputs alone when it recovers an accepted hand-off (FR-R5-F02)', async () => {
    const store = createStore();
    const { dispatchPhase, rootInvocationId } = await createStartedRun(store);

    await completeComposableNodeAttempt(
      { connectedRuns: store, dispatchPhase },
      {
        run: store.get('run-rec-1')!,
        invocationId: rootInvocationId,
        nodeId: 'n1',
        status: 'completed',
        completedAt: 1050
      }
    );

    // The crash lands after the operator's hand-off was accepted and before n2 was dispatched.
    const waitingRun = store.get('run-rec-1')!;
    await continueWaitingHandoff(
      { connectedRuns: store },
      {
        run: waitingRun,
        expectedRevision: waitingRun.revision,
        invocationId: rootInvocationId,
        targetNodeId: 'n2',
        request: {
          pipelineId: 'n2',
          workflowId: 'wf-recovery',
          inputs: [{ portId: 'promptOverride', type: 'text', value: 'operator-edit' }],
          supplemental: [],
          outputs: []
        },
        acceptedAt: 1100,
        deferDispatch: true
      }
    );

    const recovery = new WorkflowRecoveryService({ connectedRuns: store, dispatchPhase });
    const reconciled = await recovery.reconcileRun('run-rec-1', 2000);

    expect(reconciled?.disposition?.status).toBe('pending-dispatch-recovered');
    const recoveredFrame = reconciled?.run.invocations?.[rootInvocationId];
    expect(recoveredFrame?.attemptsByNodeId['n2']).toHaveLength(1);
    // The edit reaches n2 through the persisted envelope. The frame's `boundInputs` are the
    // Workflow's public inputs, which a later node's `workflow-input` binding reads, so the edit
    // must not be merged into them: the launch supplied none, and none may appear.
    expect(recoveredFrame?.boundInputs).toEqual({});
  });

  it('settles an in-flight Phase attempt forward when durable completion evidence exists (settled-from-evidence)', async () => {
    const store = createStore();
    const { dispatchPhase, rootInvocationId } = await createStartedRun(store);

    const recovery = new WorkflowRecoveryService({
      connectedRuns: store,
      dispatchPhase,
      checkDurableAttemptEvidence: () => ({
        completed: true,
        status: 'completed',
        completedAt: 1500
      })
    });

    const reconciled = await recovery.reconcileRun('run-rec-1', 2000);
    expect(reconciled?.disposition?.status).toBe('settled-from-evidence');
    const rootFrame = reconciled!.run.invocations![rootInvocationId]!;
    // n1 settled as completed and transitioned to waiting-for-handoff on n2
    expect(rootFrame.attemptsByNodeId['n1']?.[0]?.status).toBe('completed');
    expect(rootFrame.status).toBe('waiting-for-handoff');
  });

  it('pauses an interrupted in-flight Phase attempt as recovery-uncertain-effect when completion evidence is missing (uncertain-effect-paused)', async () => {
    const store = createStore();
    const { dispatchPhase, rootInvocationId } = await createStartedRun(store);

    const recovery = new WorkflowRecoveryService({
      connectedRuns: store,
      dispatchPhase,
      checkDurableAttemptEvidence: () => ({ completed: false })
    });

    const reconciled = await recovery.reconcileRun('run-rec-1', 2000);
    expect(reconciled?.disposition?.status).toBe('uncertain-effect-paused');
    const rootFrame = reconciled!.run.invocations![rootInvocationId]!;
    expect(rootFrame.status).toBe('paused');
    expect(rootFrame.controlMarkers?.manualPauseCause).toBe('recovery-uncertain-effect');
    expect(rootFrame.controlMarkers?.manualPauseAt).toBe(2000);
    expect(rootFrame.attemptsByNodeId['n1']?.[0]?.status).toBe('paused');
    expect(reconciled?.projection.rootAllowedActions).toContain('retry-phase');
    expect(reconciled?.projection.rootAllowedActions).toContain('resume');
    expect(reconciled?.projection.rootAllowedActions).toContain('cancel');
  });

  it('cancels only the orphaned run when its bound queue or task was deleted without touching sibling queues (orphaned-canceled)', async () => {
    const store = createStore();
    const { dispatchPhase } = await createStartedRun(store, 'run-orphan', 'q-deleted');
    await createStartedRun(store, 'run-sibling', 'q-active');

    const releasedLeases: string[] = [];
    const recovery = new WorkflowRecoveryService({
      connectedRuns: store,
      dispatchPhase,
      isQueueOrTaskPresent: (queueId) => queueId !== 'q-deleted',
      releaseQueueLease: (queueId, runId) => {
        releasedLeases.push(`${queueId}:${runId}`);
      }
    });

    const orphanResult = await recovery.reconcileRun('run-orphan', 3000);
    expect(orphanResult?.disposition?.status).toBe('orphaned-canceled');
    expect(orphanResult?.projection.status).toBe('canceled');
    expect(releasedLeases).toEqual(['q-deleted:run-orphan']);

    // Sibling queue run is unaffected by q-deleted's deletion
    const siblingRun = store.get('run-sibling')!;
    expect(siblingRun.invocations!['run-sibling:root']!.status).toBe('in-flight');
  });

  it('recovers a pending-dispatch Phase attempt by binding an existing enqueued task or re-dispatching (FR-R5-F08)', async () => {
    const store = createStore();
    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-pending-disp',
      workflow: workflowWithManualHandoff,
      effectiveWorkflows: [workflowWithManualHandoff],
      effectivePhases: phases,
      startedAt: 1000,
      queueId: 'q-1'
    });
    if (snap.outcome !== 'created') throw new Error('Snapshot failed');
    store.seed(snap.run);

    // Simulate crash inside dispatchPhase after pending-dispatch was persisted
    await expect(
      dispatchComposableNode(
        {
          connectedRuns: store,
          dispatchPhase: async () => {
            throw new Error('crash-mid-dispatch');
          }
        },
        {
          run: snap.run,
          invocationId: snap.rootInvocationId,
          nodeId: 'n1',
          startedAt: 1010
        }
      )
    ).rejects.toThrow('crash-mid-dispatch');

    const crashedRun = store.get('run-pending-disp')!;
    expect(crashedRun.invocations![snap.rootInvocationId]!.attemptsByNodeId['n1']![0]!.status).toBe(
      'pending-dispatch'
    );

    const recovery = new WorkflowRecoveryService({
      connectedRuns: store,
      dispatchPhase: async () => ({ outcome: 'dispatched', queueItemId: 'qi-recovered-1' })
    });

    const reconciled = await recovery.reconcileRun('run-pending-disp', 2000);
    expect(reconciled!.disposition!.status).toBe('pending-dispatch-recovered');
    const recoveredAttempt =
      reconciled!.run.invocations![snap.rootInvocationId]!.attemptsByNodeId['n1']![0]!;
    expect(recoveredAttempt.status).toBe('in-flight');
    expect(recoveredAttempt.queueItemId).toBe('qi-recovered-1');
  });

  it('falls back to paused with recovery-uncertain-effect when accepted-handoff redispatch fails (FR-R5-F08)', async () => {
    const store = createStore();
    const { dispatchPhase, rootInvocationId } = await createStartedRun(store);

    await completeComposableNodeAttempt(
      { connectedRuns: store, dispatchPhase },
      {
        run: store.get('run-rec-1')!,
        invocationId: rootInvocationId,
        nodeId: 'n1',
        status: 'completed',
        completedAt: 1050
      }
    );

    const waitingRun = store.get('run-rec-1')!;
    await continueWaitingHandoff(
      { connectedRuns: store },
      {
        run: waitingRun,
        expectedRevision: waitingRun.revision,
        invocationId: rootInvocationId,
        targetNodeId: 'n2',
        request: {
          pipelineId: 'n2',
          workflowId: 'wf-recovery',
          inputs: [{ portId: 'promptOverride', type: 'text', value: 'use-persisted-envelope' }],
          supplemental: [],
          outputs: []
        },
        acceptedAt: 1100,
        deferDispatch: true
      }
    );

    const recovery = new WorkflowRecoveryService({
      connectedRuns: store,
      dispatchPhase: async () => ({ outcome: 'rejected', reason: 'launcher-unavailable' })
    });

    const reconciled = await recovery.reconcileRun('run-rec-1', 2000);
    expect(reconciled!.disposition!.status).toBe('uncertain-effect-paused');
    expect(reconciled!.disposition!.reasonCode).toBe('handoff-redispatch-failed');
    const rootFrame = reconciled!.run.invocations![rootInvocationId]!;
    expect(rootFrame.status).toBe('paused');
    expect(rootFrame.controlMarkers?.manualPauseCause).toBe('recovery-uncertain-effect');
  });
});
