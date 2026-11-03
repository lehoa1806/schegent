import { describe, expect, it } from 'vitest';
import type { PhaseDefinition } from '../../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../../src/contracts/workflow-definitions';
import {
  DEFAULT_INVOCATION_CONTROL_MARKERS,
  MAX_COMMAND_RECEIPTS,
  upsertInvocationFrame,
  type ConnectedWorkflowRun
} from '../../../../src/state/connected-workflow-run';
import { createComposableWorkflowRunSnapshot } from '../../../../src/services/workflow-execution/connected-run-factory';
import {
  completeComposableNodeAttempt,
  dispatchComposableNode,
  type PhaseAttemptDispatchInput,
  type PhaseAttemptDispatchResult
} from '../../../../src/services/workflow-execution/connected-run-coordinator';
import {
  WorkflowControlService,
  type ActiveLeafAbortInput,
  type WorkflowControlStore
} from '../../../../src/services/workflow-execution/workflow-control-service';

const phases: readonly PhaseDefinition[] = [
  { phaseId: 'p-prep', name: 'Prep', version: 1, instruction: 'Prep' },
  { phaseId: 'p-c1', name: 'Child Step 1', version: 1, instruction: 'C1' },
  { phaseId: 'p-c2', name: 'Child Step 2', version: 1, instruction: 'C2' },
  { phaseId: 'p-fallback', name: 'Fallback', version: 1, instruction: 'Fallback' },
  { phaseId: 'p-final', name: 'Final', version: 1, instruction: 'Final' }
];

const childWorkflow: WorkflowDefinition = {
  workflowId: 'wf-child',
  name: 'Child Workflow',
  version: 1,
  startNodeIds: ['c1'],
  nodes: [
    { nodeId: 'c1', kind: 'phase', phaseId: 'p-c1' },
    { nodeId: 'c2', kind: 'phase', phaseId: 'p-c2' }
  ],
  connections: [{ from: { nodeId: 'c1' }, to: { kind: 'node', nodeId: 'c2' } }]
};

const rootWorkflowWithCancelFallback: WorkflowDefinition = {
  workflowId: 'wf-root-fallback',
  name: 'Root With Cancel Fallback',
  version: 1,
  startNodeIds: ['prep'],
  nodes: [
    { nodeId: 'prep', kind: 'phase', phaseId: 'p-prep' },
    { nodeId: 'call-child', kind: 'workflow', workflowId: 'wf-child' },
    { nodeId: 'on-cancel', kind: 'phase', phaseId: 'p-fallback' },
    { nodeId: 'final', kind: 'phase', phaseId: 'p-final' }
  ],
  connections: [
    { from: { nodeId: 'prep' }, to: { kind: 'node', nodeId: 'call-child' } },
    {
      from: { nodeId: 'call-child' },
      to: { kind: 'node', nodeId: 'on-cancel' },
      priority: 1,
      condition: {
        left: { source: 'node-status', nodeId: 'call-child' },
        operator: 'equals',
        right: 'canceled'
      }
    },
    {
      from: { nodeId: 'call-child' },
      to: { kind: 'node', nodeId: 'final' },
      priority: 2,
      condition: {
        left: { source: 'node-status', nodeId: 'call-child' },
        operator: 'equals',
        right: 'completed'
      }
    }
  ]
};

const rootWorkflowNoCancelEdge: WorkflowDefinition = {
  workflowId: 'wf-root-strict',
  name: 'Root Without Cancel Edge',
  version: 1,
  startNodeIds: ['call-child'],
  nodes: [
    { nodeId: 'call-child', kind: 'workflow', workflowId: 'wf-child' },
    { nodeId: 'final', kind: 'phase', phaseId: 'p-final' }
  ],
  connections: [
    {
      from: { nodeId: 'call-child' },
      to: { kind: 'node', nodeId: 'final' },
      condition: {
        left: { source: 'node-status', nodeId: 'call-child' },
        operator: 'equals',
        right: 'completed'
      }
    }
  ]
};

const manualHandoffWorkflow: WorkflowDefinition = {
  workflowId: 'wf-manual-handoff',
  name: 'Manual Handoff',
  version: 1,
  startNodeIds: ['first'],
  nodes: [
    { nodeId: 'first', kind: 'phase', phaseId: 'p-c1' },
    { nodeId: 'second', kind: 'phase', phaseId: 'p-c2' }
  ],
  connections: [
    { from: { nodeId: 'first' }, to: { kind: 'node', nodeId: 'second' }, handoff: 'manual' }
  ]
};

function createInMemoryControlStore(
  initial?: ConnectedWorkflowRun
): WorkflowControlStore & { readonly seed: (run: ConnectedWorkflowRun) => void } {
  const map = new Map<string, ConnectedWorkflowRun>();
  if (initial !== undefined) {
    map.set(initial.connectedRunId, initial);
  }
  return {
    get(connectedRunId: string): ConnectedWorkflowRun | null {
      return map.get(connectedRunId) ?? null;
    },
    seed(run: ConnectedWorkflowRun): void {
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

async function setupActiveChildAtC2(workflow: WorkflowDefinition = rootWorkflowWithCancelFallback) {
  let seq = 0;
  const store = createInMemoryControlStore();
  const dispatchPhase = async () => {
    seq += 1;
    return { outcome: 'dispatched' as const, queueItemId: `qi-${seq}` };
  };
  const snap = createComposableWorkflowRunSnapshot({
    connectedRunId: 'run-ctrl-1',
    workflow,
    effectiveWorkflows: [workflow, childWorkflow],
    effectivePhases: phases,
    startedAt: 1000,
    queueId: 'q-main'
  });
  if (snap.outcome !== 'created') throw new Error('Failed snapshot');
  store.seed(snap.run);

  const entryNode = workflow.startNodeIds[0]!;
  await dispatchComposableNode(
    { connectedRuns: store, dispatchPhase },
    {
      run: store.get('run-ctrl-1')!,
      invocationId: snap.rootInvocationId,
      nodeId: entryNode,
      startedAt: 1010
    }
  );

  if (entryNode === 'prep') {
    await completeComposableNodeAttempt(
      { connectedRuns: store, dispatchPhase },
      {
        run: store.get('run-ctrl-1')!,
        invocationId: snap.rootInvocationId,
        nodeId: 'prep',
        status: 'completed',
        completedAt: 1020
      }
    );
  }

  // Find child invocation ID and advance c1 -> c2
  const afterCall = store.get('run-ctrl-1')!;
  const childInvId = Object.keys(afterCall.invocations ?? {}).find(
    (id) => id !== snap.rootInvocationId
  )!;

  await completeComposableNodeAttempt(
    { connectedRuns: store, dispatchPhase },
    {
      run: afterCall,
      invocationId: childInvId,
      nodeId: 'c1',
      status: 'completed',
      completedAt: 1030
    }
  );

  return {
    store,
    dispatchPhase,
    rootInvocationId: snap.rootInvocationId,
    childInvocationId: childInvId
  };
}

describe('WorkflowControlService — US1: Pause, Resume, Cancel & Idempotency (FR-R5-F03-T02, T03, T05, T07)', () => {
  it('pauses an active child invocation with paired markers, aborts leaf, clears retry timers, retains lease, and resumes cleanly', async () => {
    const { store, dispatchPhase, rootInvocationId, childInvocationId } =
      await setupActiveChildAtC2();

    // Seed an armed retry timer marker on child to verify pause clears it
    const beforePause = store.get('run-ctrl-1')!;
    const childBefore = beforePause.invocations![childInvocationId]!;
    const withArmedTimer = upsertInvocationFrame(beforePause, {
      ...childBefore,
      controlMarkers: {
        ...DEFAULT_INVOCATION_CONTROL_MARKERS,
        pendingRetryAt: 5000,
        pendingRetryCause: 'transient-backoff',
        delayedRetryCount: 1
      }
    });
    store.seed(withArmedTimer);

    const abortedLeaves: ActiveLeafAbortInput[] = [];
    const canceledTimers: string[] = [];
    const releasedLeases: string[] = [];

    const service = new WorkflowControlService({
      connectedRuns: store,
      dispatchPhase,
      abortActiveLeaf: (info) => {
        abortedLeaves.push(info);
      },
      cancelRetryTimer: (_q, _r, invId) => {
        canceledTimers.push(invId);
      },
      releaseQueueLease: (q) => {
        releasedLeases.push(q);
      }
    });

    const currentRev = store.get('run-ctrl-1')!.revision;
    const pauseResult = await service.executeCommand({
      runId: 'run-ctrl-1',
      commandId: 'cmd-pause-1',
      expectedRevision: currentRev,
      operation: 'pause',
      targetInvocationId: childInvocationId,
      now: 2000
    });

    expect(pauseResult.accepted).toBe(true);
    if (!pauseResult.accepted) return;

    expect(pauseResult.idempotentReplay).toBe(false);
    expect(abortedLeaves).toHaveLength(1);
    expect(abortedLeaves[0]?.invocationId).toBe(childInvocationId);
    expect(abortedLeaves[0]?.nodeId).toBe('c2');
    expect(canceledTimers).toContain(childInvocationId);
    // Lease MUST NOT be released on pause (Rule 4)
    expect(releasedLeases).toHaveLength(0);

    const pausedChild = pauseResult.run.invocations![childInvocationId]!;
    expect(pausedChild.status).toBe('paused');
    expect(pausedChild.controlMarkers?.manualPauseAt).toBe(2000);
    expect(pausedChild.controlMarkers?.manualPauseCause).toBe('operator-pause');
    expect(pausedChild.controlMarkers?.pendingRetryAt).toBeNull();
    expect(pausedChild.controlMarkers?.pendingRetryCause).toBeNull();
    expect(pausedChild.attemptsByNodeId['c2']?.[0]?.status).toBe('paused');

    // Replaying the exact same commandId returns idempotent receipt even with old expectedRevision
    const replayResult = await service.executeCommand({
      runId: 'run-ctrl-1',
      commandId: 'cmd-pause-1',
      expectedRevision: currentRev,
      operation: 'pause',
      targetInvocationId: childInvocationId,
      now: 2050
    });
    expect(replayResult.accepted).toBe(true);
    if (replayResult.accepted) {
      expect(replayResult.idempotentReplay).toBe(true);
      expect(replayResult.receipt.committedRevision).toBe(pauseResult.receipt.committedRevision);
    }
    expect(abortedLeaves).toHaveLength(1);

    // Resume the paused child invocation
    const resumeResult = await service.executeCommand({
      runId: 'run-ctrl-1',
      commandId: 'cmd-resume-1',
      expectedRevision: pauseResult.run.revision,
      operation: 'resume',
      targetInvocationId: childInvocationId,
      now: 2100
    });
    expect(resumeResult.accepted).toBe(true);
    if (!resumeResult.accepted) return;

    const resumedChild = resumeResult.run.invocations![childInvocationId]!;
    const resumedRoot = resumeResult.run.invocations![rootInvocationId]!;
    expect(resumedChild.status).toBe('in-flight');
    expect(resumedRoot.status).toBe('in-flight');
    expect(resumedChild.controlMarkers?.manualPauseAt).toBeNull();
    expect(resumedChild.controlMarkers?.manualPauseCause).toBeNull();
    expect(resumedChild.attemptsByNodeId['c2']).toHaveLength(2);
    expect(resumedChild.attemptsByNodeId['c2']?.[0]?.status).toBe('paused');
    expect(resumedChild.attemptsByNodeId['c2']?.[1]?.status).toBe('in-flight');
    expect(resumedChild.attemptsByNodeId['c2']?.[1]?.attemptIndex).toBe(2);
  });

  it('cancels only an active child invocation and routes the parent along an explicit node-status == canceled edge', async () => {
    const { store, dispatchPhase, rootInvocationId, childInvocationId } =
      await setupActiveChildAtC2(rootWorkflowWithCancelFallback);

    const releasedLeases: string[] = [];
    const service = new WorkflowControlService({
      connectedRuns: store,
      dispatchPhase,
      releaseQueueLease: (q) => {
        releasedLeases.push(q);
      }
    });

    const rev = store.get('run-ctrl-1')!.revision;
    const cancelChild = await service.executeCommand({
      runId: 'run-ctrl-1',
      commandId: 'cmd-cancel-child',
      expectedRevision: rev,
      operation: 'cancel',
      targetInvocationId: childInvocationId,
      now: 3000
    });

    expect(cancelChild.accepted).toBe(true);
    if (!cancelChild.accepted) return;

    const childAfter = cancelChild.run.invocations![childInvocationId]!;
    const rootAfter = cancelChild.run.invocations![rootInvocationId]!;
    expect(childAfter.status).toBe('canceled');
    // Parent matched `node-status == 'canceled'` and transitioned to `on-cancel`!
    expect(rootAfter.status).toBe('in-flight');
    expect(rootAfter.activeNodeId).toBe('on-cancel');
    expect(rootAfter.attemptsByNodeId['on-cancel']?.[0]?.status).toBe('in-flight');
    // Root is still in-flight, so queue lease is retained
    expect(releasedLeases).toHaveLength(0);
  });

  it('propagates cancellation to parent and releases queue lease when child is canceled and parent has no canceled edge', async () => {
    const { store, dispatchPhase, rootInvocationId, childInvocationId } =
      await setupActiveChildAtC2(rootWorkflowNoCancelEdge);

    const releasedLeases: string[] = [];
    const service = new WorkflowControlService({
      connectedRuns: store,
      dispatchPhase,
      releaseQueueLease: (q, r) => {
        releasedLeases.push(`${q}:${r}`);
      }
    });

    const rev = store.get('run-ctrl-1')!.revision;
    const cancelChild = await service.executeCommand({
      runId: 'run-ctrl-1',
      commandId: 'cmd-cancel-child-strict',
      expectedRevision: rev,
      operation: 'cancel',
      targetInvocationId: childInvocationId,
      now: 3100
    });

    expect(cancelChild.accepted).toBe(true);
    if (!cancelChild.accepted) return;

    expect(cancelChild.run.invocations![childInvocationId]!.status).toBe('canceled');
    expect(cancelChild.run.invocations![rootInvocationId]!.status).toBe('canceled');
    expect(releasedLeases).toEqual(['q-main:run-ctrl-1']);
  });

  it('refuses stale revisions, isolates fence loss without writing state, and caps commandReceipts at 64', async () => {
    const { store, dispatchPhase, childInvocationId } = await setupActiveChildAtC2();
    let fenceValid = true;
    const aborted: ActiveLeafAbortInput[] = [];

    const service = new WorkflowControlService({
      connectedRuns: store,
      dispatchPhase,
      verifyLeaseFence: () => fenceValid,
      abortActiveLeaf: (info) => {
        aborted.push(info);
      }
    });

    // Stale revision check
    const staleOut = await service.executeCommand({
      runId: 'run-ctrl-1',
      commandId: 'cmd-stale',
      expectedRevision: 1,
      operation: 'pause',
      targetInvocationId: childInvocationId,
      now: 4000
    });
    expect(staleOut).toMatchObject({
      accepted: false,
      refusalCode: 'stale-revision'
    });

    // Fence loss check: aborts active leaf locally, does not mutate persisted run
    fenceValid = false;
    const revBeforeFenceLoss = store.get('run-ctrl-1')!.revision;
    const fenceOut = await service.executeCommand({
      runId: 'run-ctrl-1',
      commandId: 'cmd-fence-lost',
      expectedRevision: revBeforeFenceLoss,
      operation: 'pause',
      targetInvocationId: childInvocationId,
      now: 4100
    });
    expect(fenceOut).toMatchObject({
      accepted: false,
      refusalCode: 'fence-lost'
    });
    expect(aborted).toHaveLength(1);
    expect(store.get('run-ctrl-1')!.revision).toBe(revBeforeFenceLoss);
    expect(store.get('run-ctrl-1')!.invocations![childInvocationId]!.status).toBe('in-flight');

    // Verify commandReceipts ring cap at MAX_COMMAND_RECEIPTS (64)
    fenceValid = true;
    for (let i = 0; i < 68; i += 1) {
      const current = store.get('run-ctrl-1')!;
      const op = i % 2 === 0 ? 'pause' : 'resume';
      const out = await service.executeCommand({
        runId: 'run-ctrl-1',
        commandId: `cmd-loop-${i}`,
        expectedRevision: current.revision,
        operation: op,
        targetInvocationId: childInvocationId,
        now: 5000 + i
      });
      expect(out.accepted).toBe(true);
    }
    const afterLoop = store.get('run-ctrl-1')!;
    expect(afterLoop.commandReceipts).toHaveLength(MAX_COMMAND_RECEIPTS);
    expect(afterLoop.commandReceipts?.[0]?.commandId).toBe('cmd-loop-4');
    expect(afterLoop.commandReceipts?.[MAX_COMMAND_RECEIPTS - 1]?.commandId).toBe('cmd-loop-67');
  });
});

describe('WorkflowControlService — US2: Scoped Retry (retry-phase vs retry-invocation) (FR-R5-F03-T04)', () => {
  it('retries only the failed leaf Phase via retry-phase while preserving prior attempts and completed upstream work', async () => {
    const { store, dispatchPhase, childInvocationId } = await setupActiveChildAtC2();

    // Fail phase c2 inside child invocation
    await completeComposableNodeAttempt(
      { connectedRuns: store, dispatchPhase },
      {
        run: store.get('run-ctrl-1')!,
        invocationId: childInvocationId,
        nodeId: 'c2',
        status: 'failed',
        completedAt: 2000,
        failureCode: 'phase-exit-nonzero'
      }
    );

    const failedRun = store.get('run-ctrl-1')!;
    expect(failedRun.invocations![childInvocationId]!.status).toBe('failed');

    const service = new WorkflowControlService({
      connectedRuns: store,
      dispatchPhase
    });

    const retryOut = await service.executeCommand({
      runId: 'run-ctrl-1',
      commandId: 'cmd-retry-phase-c2',
      expectedRevision: failedRun.revision,
      operation: 'retry-phase',
      targetInvocationId: childInvocationId,
      targetNodeId: 'c2',
      now: 2500
    });

    expect(retryOut.accepted).toBe(true);
    if (!retryOut.accepted) return;

    const childAfter = retryOut.run.invocations![childInvocationId]!;
    expect(childAfter.status).toBe('in-flight');
    // c1 was NOT re-run (still 1 completed attempt)
    expect(childAfter.attemptsByNodeId['c1']).toHaveLength(1);
    expect(childAfter.attemptsByNodeId['c1']?.[0]?.status).toBe('completed');
    // c2 has attempt 1 (failed) and attempt 2 (in-flight)
    expect(childAfter.attemptsByNodeId['c2']).toHaveLength(2);
    expect(childAfter.attemptsByNodeId['c2']?.[0]?.status).toBe('failed');
    expect(childAfter.attemptsByNodeId['c2']?.[1]?.status).toBe('in-flight');
    expect(childAfter.attemptsByNodeId['c2']?.[1]?.attemptIndex).toBe(2);
  });

  it('retries an entire child workflow invocation from startNodeIds[0] via retry-invocation while keeping prior child frame and sibling parent work intact', async () => {
    const { store, dispatchPhase, rootInvocationId, childInvocationId } =
      await setupActiveChildAtC2();

    // Fail phase c2 inside child invocation
    await completeComposableNodeAttempt(
      { connectedRuns: store, dispatchPhase },
      {
        run: store.get('run-ctrl-1')!,
        invocationId: childInvocationId,
        nodeId: 'c2',
        status: 'failed',
        completedAt: 2000,
        failureCode: 'phase-exit-nonzero'
      }
    );

    const failedRun = store.get('run-ctrl-1')!;
    const service = new WorkflowControlService({
      connectedRuns: store,
      dispatchPhase
    });

    const retryInvOut = await service.executeCommand({
      runId: 'run-ctrl-1',
      commandId: 'cmd-retry-child-inv',
      expectedRevision: failedRun.revision,
      operation: 'retry-invocation',
      targetInvocationId: childInvocationId,
      now: 2600
    });

    expect(retryInvOut.accepted).toBe(true);
    if (!retryInvOut.accepted) return;

    const newChildInvId = retryInvOut.receipt.spawnedInvocationId;
    expect(newChildInvId).toBeDefined();
    expect(newChildInvId).not.toBe(childInvocationId);

    // Prior child invocation frame is preserved untouched in history
    const oldChildFrame = retryInvOut.run.invocations![childInvocationId]!;
    expect(oldChildFrame.status).toBe('failed');
    expect(oldChildFrame.attemptsByNodeId['c1']).toHaveLength(1);
    expect(oldChildFrame.attemptsByNodeId['c2']).toHaveLength(1);

    // New child invocation frame starts fresh at startNodeIds[0] ('c1')
    const newChildFrame = retryInvOut.run.invocations![newChildInvId!]!;
    expect(newChildFrame.status).toBe('in-flight');
    expect(newChildFrame.activeNodeId).toBe('c1');
    expect(newChildFrame.attemptsByNodeId['c1']).toHaveLength(1);
    expect(newChildFrame.attemptsByNodeId['c1']?.[0]?.status).toBe('in-flight');
    expect(newChildFrame.attemptsByNodeId['c2']).toBeUndefined();

    // Parent sibling node 'prep' remains completed with 1 attempt, while 'call-child' has 2 attempts
    const rootFrame = retryInvOut.run.invocations![rootInvocationId]!;
    expect(rootFrame.status).toBe('in-flight');
    expect(rootFrame.attemptsByNodeId['prep']).toHaveLength(1);
    expect(rootFrame.attemptsByNodeId['prep']?.[0]?.status).toBe('completed');
    expect(rootFrame.attemptsByNodeId['call-child']).toHaveLength(2);
    expect(rootFrame.attemptsByNodeId['call-child']?.[0]?.status).toBe('failed');
    expect(rootFrame.attemptsByNodeId['call-child']?.[1]?.status).toBe('in-flight');
    expect(rootFrame.attemptsByNodeId['call-child']?.[1]?.childInvocationId).toBe(newChildInvId);
  });
});

describe('WorkflowControlService — a re-dispatch the queue refuses is a refusal, not a retry (FR-R5-F03-T04, T07)', () => {
  function refusingDispatch(reason: string, attemptedNodeIds: string[]) {
    return async (input: PhaseAttemptDispatchInput): Promise<PhaseAttemptDispatchResult> => {
      attemptedNodeIds.push(input.node.nodeId);
      return { outcome: 'rejected', reason };
    };
  }

  async function setupFailedChildLeaf() {
    const setup = await setupActiveChildAtC2();
    await completeComposableNodeAttempt(
      { connectedRuns: setup.store, dispatchPhase: setup.dispatchPhase },
      {
        run: setup.store.get('run-ctrl-1')!,
        invocationId: setup.childInvocationId,
        nodeId: 'c2',
        status: 'failed',
        completedAt: 2000,
        failureCode: 'phase-exit-nonzero'
      }
    );
    return { ...setup, failedRun: setup.store.get('run-ctrl-1')! };
  }

  it('refuses retry-phase without spending an attempt or committing anything', async () => {
    const { store, childInvocationId, failedRun } = await setupFailedChildLeaf();
    const attempted: string[] = [];
    const service = new WorkflowControlService({
      connectedRuns: store,
      dispatchPhase: refusingDispatch('queue-paused', attempted)
    });

    const out = await service.executeCommand({
      runId: 'run-ctrl-1',
      commandId: 'cmd-retry-phase-refused',
      expectedRevision: failedRun.revision,
      operation: 'retry-phase',
      targetInvocationId: childInvocationId,
      targetNodeId: 'c2',
      now: 2500
    });

    expect(attempted).toEqual(['c2']);
    expect(out.accepted).toBe(false);
    if (out.accepted) return;
    expect(out.refusalCode).toBe('invalid-state-for-operation');
    expect(out.reason).toContain('queue-paused');
    expect(out.currentRevision).toBe(failedRun.revision);
    expect(out.run).toBe(failedRun);
    // Nothing was written: the stored run is the same object, so no receipt, no new
    // attempt and no reactivated frame can have been committed.
    expect(store.get('run-ctrl-1')).toBe(failedRun);
  });

  it('refuses retry-invocation without a new child invocation or a spent call attempt', async () => {
    const { store, childInvocationId, failedRun } = await setupFailedChildLeaf();
    const attempted: string[] = [];
    const service = new WorkflowControlService({
      connectedRuns: store,
      dispatchPhase: refusingDispatch('queue-paused', attempted)
    });

    const out = await service.executeCommand({
      runId: 'run-ctrl-1',
      commandId: 'cmd-retry-invocation-refused',
      expectedRevision: failedRun.revision,
      operation: 'retry-invocation',
      targetInvocationId: childInvocationId,
      now: 2600
    });

    expect(attempted).toEqual(['c1']);
    expect(out.accepted).toBe(false);
    if (out.accepted) return;
    expect(out.refusalCode).toBe('invalid-state-for-operation');
    expect(out.reason).toContain('queue-paused');
    expect(store.get('run-ctrl-1')).toBe(failedRun);
  });

  it('refuses resume and leaves the invocation paused', async () => {
    const { store, dispatchPhase, childInvocationId } = await setupActiveChildAtC2();
    const pauser = new WorkflowControlService({ connectedRuns: store, dispatchPhase });
    const paused = await pauser.executeCommand({
      runId: 'run-ctrl-1',
      commandId: 'cmd-pause-before-refusal',
      expectedRevision: store.get('run-ctrl-1')!.revision,
      operation: 'pause',
      targetInvocationId: childInvocationId,
      now: 2000
    });
    expect(paused.accepted).toBe(true);
    const pausedRun = store.get('run-ctrl-1')!;
    const attempted: string[] = [];
    const resumer = new WorkflowControlService({
      connectedRuns: store,
      dispatchPhase: refusingDispatch('queue-paused', attempted)
    });

    const out = await resumer.executeCommand({
      runId: 'run-ctrl-1',
      commandId: 'cmd-resume-refused',
      expectedRevision: pausedRun.revision,
      operation: 'resume',
      targetInvocationId: childInvocationId,
      now: 2100
    });

    expect(attempted).toEqual(['c2']);
    expect(out.accepted).toBe(false);
    if (out.accepted) return;
    expect(out.refusalCode).toBe('invalid-state-for-operation');
    expect(store.get('run-ctrl-1')).toBe(pausedRun);
    expect(pausedRun.invocations![childInvocationId]!.status).toBe('paused');
  });

  it('refuses continue-handoff and leaves the handoff pending', async () => {
    const store = createInMemoryControlStore();
    const acceptingDispatch = async (): Promise<PhaseAttemptDispatchResult> => ({
      outcome: 'dispatched',
      queueItemId: 'qi-manual'
    });
    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-ctrl-2',
      workflow: manualHandoffWorkflow,
      effectiveWorkflows: [manualHandoffWorkflow],
      effectivePhases: phases,
      startedAt: 1000,
      queueId: 'q-main'
    });
    if (snap.outcome !== 'created') throw new Error('Failed snapshot');
    store.seed(snap.run);
    await dispatchComposableNode(
      { connectedRuns: store, dispatchPhase: acceptingDispatch },
      {
        run: store.get('run-ctrl-2')!,
        invocationId: snap.rootInvocationId,
        nodeId: 'first',
        startedAt: 1010
      }
    );
    const reached = await completeComposableNodeAttempt(
      { connectedRuns: store, dispatchPhase: acceptingDispatch },
      {
        run: store.get('run-ctrl-2')!,
        invocationId: snap.rootInvocationId,
        nodeId: 'first',
        status: 'completed',
        completedAt: 1020
      }
    );
    expect(reached.outcome).toBe('waiting-for-handoff');
    const waitingRun = store.get('run-ctrl-2')!;
    const attempted: string[] = [];
    const service = new WorkflowControlService({
      connectedRuns: store,
      dispatchPhase: refusingDispatch('queue-paused', attempted)
    });

    const out = await service.executeCommand({
      runId: 'run-ctrl-2',
      commandId: 'cmd-continue-refused',
      expectedRevision: waitingRun.revision,
      operation: 'continue-handoff',
      targetInvocationId: snap.rootInvocationId,
      targetNodeId: 'second',
      now: 1100
    });

    expect(attempted).toEqual(['second']);
    expect(out.accepted).toBe(false);
    if (out.accepted) return;
    expect(out.refusalCode).toBe('invalid-state-for-operation');
    expect(store.get('run-ctrl-2')).toBe(waitingRun);
    expect(waitingRun.invocations![snap.rootInvocationId]!.status).toBe('waiting-for-handoff');
  });
});
