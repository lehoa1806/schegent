import { describe, expect, it } from 'vitest';
import type { PhaseDefinition } from '../../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../../src/contracts/workflow-definitions';
import type { ConnectedWorkflowRun } from '../../../../src/state/connected-workflow-run';
import { createComposableWorkflowRunSnapshot } from '../../../../src/services/workflow-execution/connected-run-factory';
import {
  completeComposableNodeAttempt,
  dispatchComposableNode
} from '../../../../src/services/workflow-execution/connected-run-coordinator';
import {
  buildAncestryEvidenceMetadata,
  buildWorkflowRunControlProjection
} from '../../../../src/services/workflow-execution/workflow-control-projector';

const phases: readonly PhaseDefinition[] = [
  { phaseId: 'p-verify', name: 'Verify', version: 1, instruction: 'Run verification' }
];

const sharedChildWorkflow: WorkflowDefinition = {
  workflowId: 'wf-shared-child',
  name: 'Shared Child',
  version: 1,
  startNodeIds: ['v1'],
  nodes: [{ nodeId: 'v1', kind: 'phase', phaseId: 'p-verify' }],
  connections: []
};

const rootCallingSameChildTwice: WorkflowDefinition = {
  workflowId: 'wf-root-twice',
  name: 'Root Calling Same Child Twice',
  version: 1,
  startNodeIds: ['call-a'],
  nodes: [
    { nodeId: 'call-a', kind: 'workflow', workflowId: 'wf-shared-child' },
    { nodeId: 'call-b', kind: 'workflow', workflowId: 'wf-shared-child' }
  ],
  connections: [{ from: { nodeId: 'call-a' }, to: { kind: 'node', nodeId: 'call-b' } }]
};

describe('workflow-control-projector — US4: Bounded Ancestry Evidence & Control Projections (FR-R5-F03-T08, T09)', () => {
  it('assigns distinct invocationId and nodePath when the same child workflow is invoked from two parent nodes (/call-a vs /call-b)', async () => {
    let currentRun: ConnectedWorkflowRun | null = null;
    let seq = 0;
    const writer = {
      async compareAndSetConnectedRun(next: ConnectedWorkflowRun) {
        currentRun = next;
        return { outcome: 'written' as const, run: next };
      }
    };
    const dispatchPhase = async () => {
      seq += 1;
      return { outcome: 'dispatched' as const, queueItemId: `qi-${seq}` };
    };

    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-proj-1',
      workflow: rootCallingSameChildTwice,
      effectiveWorkflows: [rootCallingSameChildTwice, sharedChildWorkflow],
      effectivePhases: phases,
      startedAt: 1000,
      queueId: 'q-proj'
    });
    if (snap.outcome !== 'created') throw new Error('Failed snapshot');
    currentRun = snap.run;

    // 1. Dispatch call-a -> spawns first child invocation
    await dispatchComposableNode(
      { connectedRuns: writer, dispatchPhase },
      {
        run: currentRun,
        invocationId: snap.rootInvocationId,
        nodeId: 'call-a',
        startedAt: 1010
      }
    );

    const childAId = Object.keys(currentRun.invocations ?? {}).find(
      (id) => id !== snap.rootInvocationId
    )!;
    const evidenceA = buildAncestryEvidenceMetadata(currentRun, childAId, 'v1');
    expect(evidenceA).toEqual({
      rootRunId: 'run-proj-1',
      invocationId: childAId,
      parentInvocationId: snap.rootInvocationId,
      nodePath: '/call-a/v1',
      attemptId: `${childAId}:v1:attempt-1`,
      attemptIndex: 1,
      queueId: 'q-proj'
    });

    // 2. Complete child A -> advances parent to call-b -> spawns second child invocation
    await completeComposableNodeAttempt(
      { connectedRuns: writer, dispatchPhase },
      {
        run: currentRun,
        invocationId: childAId,
        nodeId: 'v1',
        status: 'completed',
        completedAt: 1020
      }
    );

    const childBId = Object.keys(currentRun.invocations ?? {}).find(
      (id) => id !== snap.rootInvocationId && id !== childAId
    )!;
    expect(childBId).toBeDefined();
    expect(childBId).not.toBe(childAId);

    const evidenceB = buildAncestryEvidenceMetadata(currentRun, childBId, 'v1');
    expect(evidenceB).toEqual({
      rootRunId: 'run-proj-1',
      invocationId: childBId,
      parentInvocationId: snap.rootInvocationId,
      nodePath: '/call-b/v1',
      attemptId: `${childBId}:v1:attempt-1`,
      attemptIndex: 1,
      queueId: 'q-proj'
    });

    // 3. Projection exposes both child invocations with accurate statuses and legal actions
    const projection = buildWorkflowRunControlProjection(currentRun);
    expect(projection.runId).toBe('run-proj-1');
    expect(projection.queueId).toBe('q-proj');
    expect(projection.activeInvocationId).toBe(childBId);
    expect(projection.invocations[childAId]?.status).toBe('completed');
    expect(projection.invocations[childAId]?.nodePath).toBe('/call-a/v1');
    expect(projection.invocations[childBId]?.status).toBe('in-flight');
    expect(projection.invocations[childBId]?.nodePath).toBe('/call-b/v1');
    expect(projection.invocations[childBId]?.allowedActions).toEqual(['pause', 'cancel']);
  });
});
