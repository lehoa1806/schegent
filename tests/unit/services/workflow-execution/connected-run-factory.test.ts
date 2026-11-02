import { describe, expect, it } from 'vitest';
import {
  createChildWorkflowInvocationFrame,
  createComposableWorkflowRunSnapshot,
  createNodeAttemptRecord
} from '../../../../src/services/workflow-execution/connected-run-factory';
import {
  recordNodeAttempt,
  upsertInvocationFrame
} from '../../../../src/state/connected-workflow-run';
import type { PhaseDefinition } from '../../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../../src/contracts/workflow-definitions';

describe('connected-run-factory — occurrence identity & hierarchical nodePath (FR-R5-F02 T04/T05)', () => {
  const phaseStep: PhaseDefinition = {
    phaseId: 'phase-step',
    name: 'Phase Step',
    version: 1,
    instruction: 'Execute step'
  };
  const sharedChildWorkflow: WorkflowDefinition = {
    workflowId: 'wf-shared-child',
    name: 'Shared Child Workflow',
    version: 1,
    nodes: [{ nodeId: 'inner', kind: 'phase', phaseId: 'phase-step' }],
    connections: [],
    startNodeIds: ['inner']
  };
  const rootWorkflow: WorkflowDefinition = {
    workflowId: 'wf-parent',
    name: 'Parent Workflow',
    version: 1,
    nodes: [
      { nodeId: 'call-a', kind: 'workflow', workflowId: 'wf-shared-child' },
      { nodeId: 'call-b', kind: 'workflow', workflowId: 'wf-shared-child' }
    ],
    connections: [{ from: { nodeId: 'call-a' }, to: { kind: 'node', nodeId: 'call-b' } }],
    startNodeIds: ['call-a']
  };

  it('creates root and child WorkflowInvocationFrames with distinct invocationId and nodePath values when calling the same child workflowId from two parent nodes', () => {
    const created = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-occ-1',
      workflow: rootWorkflow,
      effectiveWorkflows: [sharedChildWorkflow],
      effectivePhases: [phaseStep],
      startedAt: 1_700_000_000_000,
      queueId: 'queue-serial-1'
    });

    expect(created.outcome).toBe('created');
    if (created.outcome !== 'created') return;

    const rootFrame = created.run.invocations?.[created.rootInvocationId];
    expect(rootFrame).toBeDefined();
    if (!rootFrame) return;

    expect(rootFrame.rootRunId).toBe('run-occ-1');
    expect(rootFrame.parentInvocationId).toBeNull();
    expect(rootFrame.depth).toBe(0);
    expect(rootFrame.nodePath).toBe('/call-a');

    // Call child from `call-a`
    const attemptA = createNodeAttemptRecord({
      frame: rootFrame,
      nodeId: 'call-a',
      nodeKind: 'workflow',
      targetDefinitionId: 'wf-shared-child',
      inputEnvelope: {
        envelopeId: 'env-a',
        invocationId: rootFrame.invocationId,
        targetNodeId: 'call-a',
        source: 'launch',
        inputsByPort: {},
        localInputs: [],
        outputTargetOverrides: [],
        acceptedAt: 1_700_000_000_000
      },
      startedAt: 1_700_000_000_000
    });
    expect(attemptA.nodePath).toBe('/call-a');
    expect(attemptA.attemptIndex).toBe(1);

    const childFrameA = createChildWorkflowInvocationFrame({
      parentFrame: rootFrame,
      callNodeId: 'call-a',
      parentAttemptId: attemptA.attemptId,
      childWorkflow: sharedChildWorkflow,
      boundInputs: {},
      startedAt: 1_700_000_000_100
    });

    // Call same child workflowId from `call-b`
    const attemptB = createNodeAttemptRecord({
      frame: rootFrame,
      nodeId: 'call-b',
      nodeKind: 'workflow',
      targetDefinitionId: 'wf-shared-child',
      inputEnvelope: {
        envelopeId: 'env-b',
        invocationId: rootFrame.invocationId,
        targetNodeId: 'call-b',
        source: 'binding',
        inputsByPort: {},
        localInputs: [],
        outputTargetOverrides: [],
        acceptedAt: 1_700_000_000_200
      },
      startedAt: 1_700_000_000_200
    });
    expect(attemptB.nodePath).toBe('/call-b');
    expect(attemptB.attemptIndex).toBe(1);

    const childFrameB = createChildWorkflowInvocationFrame({
      parentFrame: rootFrame,
      callNodeId: 'call-b',
      parentAttemptId: attemptB.attemptId,
      childWorkflow: sharedChildWorkflow,
      boundInputs: {},
      startedAt: 1_700_000_000_300
    });

    expect(childFrameA.invocationId).not.toBe(childFrameB.invocationId);
    expect(childFrameA.parentInvocationId).toBe(rootFrame.invocationId);
    expect(childFrameB.parentInvocationId).toBe(rootFrame.invocationId);
    expect(childFrameA.nodePath).toBe('/call-a/inner');
    expect(childFrameB.nodePath).toBe('/call-b/inner');
    expect(childFrameA.entryNodeId).toBe('inner');
    expect(childFrameB.entryNodeId).toBe('inner');

    const innerAttemptA = createNodeAttemptRecord({
      frame: childFrameA,
      nodeId: 'inner',
      nodeKind: 'phase',
      targetDefinitionId: 'phase-step',
      inputEnvelope: {
        envelopeId: 'env-inner-a',
        invocationId: childFrameA.invocationId,
        targetNodeId: 'inner',
        source: 'binding',
        inputsByPort: {},
        localInputs: [],
        outputTargetOverrides: [],
        acceptedAt: 1_700_000_000_150
      },
      startedAt: 1_700_000_000_150
    });
    const innerAttemptB = createNodeAttemptRecord({
      frame: childFrameB,
      nodeId: 'inner',
      nodeKind: 'phase',
      targetDefinitionId: 'phase-step',
      inputEnvelope: {
        envelopeId: 'env-inner-b',
        invocationId: childFrameB.invocationId,
        targetNodeId: 'inner',
        source: 'binding',
        inputsByPort: {},
        localInputs: [],
        outputTargetOverrides: [],
        acceptedAt: 1_700_000_000_350
      },
      startedAt: 1_700_000_000_350
    });

    expect(innerAttemptA.nodePath).toBe('/call-a/inner');
    expect(innerAttemptB.nodePath).toBe('/call-b/inner');
    expect(innerAttemptA.attemptId).not.toBe(innerAttemptB.attemptId);

    // Retry progression on `inner` within `childFrameA` increments `attemptIndex`
    const updatedChildFrameA = recordNodeAttempt(childFrameA, innerAttemptA);
    const retryInnerAttemptA = createNodeAttemptRecord({
      frame: updatedChildFrameA,
      nodeId: 'inner',
      nodeKind: 'phase',
      targetDefinitionId: 'phase-step',
      inputEnvelope: innerAttemptA.inputEnvelope,
      startedAt: 1_700_000_000_180
    });
    expect(retryInnerAttemptA.attemptIndex).toBe(2);

    const updatedRun = upsertInvocationFrame(
      upsertInvocationFrame(created.run, updatedChildFrameA),
      childFrameB
    );
    expect(Object.keys(updatedRun.invocations ?? {})).toHaveLength(3);
  });
});

