import { describe, expect, it } from 'vitest';
import {
  createChildWorkflowInvocationFrame,
  createComposableWorkflowRunSnapshot,
  createNodeAttemptRecord
} from '../../../../src/services/workflow-execution/connected-run-factory';
import {
  DEFAULT_INVOCATION_CONTROL_MARKERS,
  recordNodeAttempt,
  upsertInvocationFrame,
  type ConnectedWorkflowRun,
  type InvocationInputEnvelope,
  type PendingHandoffRecord
} from '../../../../src/state/connected-workflow-run';
import {
  collectSubtreeInvocationIds,
  computeAllowedControlActions,
  evaluateControlTransition
} from '../../../../src/services/workflow-execution/workflow-control-transition-table';
import type { PhaseDefinition } from '../../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../../src/contracts/workflow-definitions';

const phases: readonly PhaseDefinition[] = [
  { phaseId: 'p1', name: 'Phase 1', version: 1, instruction: 'Do P1' },
  { phaseId: 'p2', name: 'Phase 2', version: 1, instruction: 'Do P2' }
];

const childWf: WorkflowDefinition = {
  workflowId: 'wf-child',
  name: 'Child Workflow',
  version: 1,
  startNodeIds: ['c1'],
  nodes: [
    { nodeId: 'c1', kind: 'phase', phaseId: 'p1' },
    { nodeId: 'c2', kind: 'phase', phaseId: 'p2' }
  ],
  connections: [{ from: { nodeId: 'c1' }, to: { kind: 'node', nodeId: 'c2' } }]
};

const rootWf: WorkflowDefinition = {
  workflowId: 'wf-root',
  name: 'Root Workflow',
  version: 1,
  startNodeIds: ['r1'],
  nodes: [
    { nodeId: 'r1', kind: 'workflow', workflowId: 'wf-child' },
    { nodeId: 'r2', kind: 'phase', phaseId: 'p2' }
  ],
  connections: [{ from: { nodeId: 'r1' }, to: { kind: 'node', nodeId: 'r2' } }]
};

function makeEnvelope(invocationId: string, targetNodeId: string): InvocationInputEnvelope {
  return Object.freeze({
    envelopeId: `${invocationId}:${targetNodeId}:env`,
    invocationId,
    targetNodeId,
    source: 'binding',
    inputsByPort: Object.freeze({}),
    localInputs: Object.freeze([]),
    outputTargetOverrides: Object.freeze([]),
    acceptedAt: 1000
  });
}

function buildNestedRun(): {
  run: ConnectedWorkflowRun;
  rootInvocationId: string;
  childInvocationId: string;
} {
  const created = createComposableWorkflowRunSnapshot({
    connectedRunId: 'run-1',
    workflow: rootWf,
    effectiveWorkflows: [rootWf, childWf],
    effectivePhases: phases,
    startedAt: 1000
  });
  if (created.outcome !== 'created') {
    throw new Error('Failed to create snapshot');
  }
  const rootFrame = created.run.invocations![created.rootInvocationId]!;
  const childFrame = createChildWorkflowInvocationFrame({
    parentFrame: rootFrame,
    callNodeId: 'r1',
    parentAttemptId: `${rootFrame.invocationId}:r1:attempt-1`,
    childWorkflow: childWf,
    boundInputs: {},
    startedAt: 1010
  });
  const parentAttempt = createNodeAttemptRecord({
    frame: rootFrame,
    nodeId: 'r1',
    nodeKind: 'workflow',
    targetDefinitionId: 'wf-child',
    inputEnvelope: makeEnvelope(rootFrame.invocationId, 'r1'),
    startedAt: 1010,
    childInvocationId: childFrame.invocationId
  });
  const childAttempt = createNodeAttemptRecord({
    frame: childFrame,
    nodeId: 'c1',
    nodeKind: 'phase',
    targetDefinitionId: 'p1',
    inputEnvelope: makeEnvelope(childFrame.invocationId, 'c1'),
    startedAt: 1020
  });
  let run = upsertInvocationFrame(created.run, recordNodeAttempt(rootFrame, parentAttempt));
  run = upsertInvocationFrame(run, recordNodeAttempt(childFrame, childAttempt));
  return {
    run,
    rootInvocationId: rootFrame.invocationId,
    childInvocationId: childFrame.invocationId
  };
}

describe('workflow-control-transition-table (FR-R5-F03-T01)', () => {
  it('collects subtree invocation IDs in breadth-first order', () => {
    const { run, rootInvocationId, childInvocationId } = buildNestedRun();
    expect(collectSubtreeInvocationIds(run, rootInvocationId)).toEqual([
      rootInvocationId,
      childInvocationId
    ]);
    expect(collectSubtreeInvocationIds(run, childInvocationId)).toEqual([childInvocationId]);
  });

  it('allows pause and cancel on in-flight root or child, and refuses resume or retry-phase while in-flight', () => {
    const { run, rootInvocationId, childInvocationId } = buildNestedRun();
    expect(computeAllowedControlActions(run, rootInvocationId)).toEqual(['pause', 'cancel']);
    expect(computeAllowedControlActions(run, childInvocationId)).toEqual(['pause', 'cancel']);

    const resumeRefusal = evaluateControlTransition({
      run,
      operation: 'resume',
      targetInvocationId: childInvocationId
    });
    expect(resumeRefusal).toMatchObject({
      allowed: false,
      refusalCode: 'not-paused'
    });

    const retryPhaseRefusal = evaluateControlTransition({
      run,
      operation: 'retry-phase',
      targetInvocationId: childInvocationId
    });
    expect(retryPhaseRefusal).toMatchObject({
      allowed: false,
      refusalCode: 'invalid-state-for-operation'
    });
  });

  it('allows resume, cancel, and retry-phase when a child frame is paused on a phase attempt', () => {
    const { run, childInvocationId } = buildNestedRun();
    const childFrame = run.invocations![childInvocationId]!;
    const c1Attempt = childFrame.attemptsByNodeId['c1']![0]!;
    const pausedChild = {
      ...childFrame,
      status: 'paused' as const,
      controlMarkers: {
        ...DEFAULT_INVOCATION_CONTROL_MARKERS,
        manualPauseAt: 2000,
        manualPauseCause: 'operator-pause' as const
      },
      attemptsByNodeId: {
        ...childFrame.attemptsByNodeId,
        c1: [{ ...c1Attempt, status: 'paused' as const }]
      }
    };
    const pausedRun = upsertInvocationFrame(run, pausedChild);
    expect(computeAllowedControlActions(pausedRun, childInvocationId)).toEqual([
      'resume',
      'cancel',
      'retry-phase',
      'retry-invocation'
    ]);

    const doublePause = evaluateControlTransition({
      run: pausedRun,
      operation: 'pause',
      targetInvocationId: childInvocationId
    });
    expect(doublePause).toMatchObject({
      allowed: false,
      refusalCode: 'already-paused'
    });
  });

  it('allows retry-phase and retry-invocation when a child frame failed, and enforces retry & spend bounds', () => {
    const { run, childInvocationId } = buildNestedRun();
    const childFrame = run.invocations![childInvocationId]!;
    const c1Attempt = childFrame.attemptsByNodeId['c1']![0]!;
    const failedChild = {
      ...childFrame,
      status: 'failed' as const,
      completedAt: 2500,
      attemptsByNodeId: {
        ...childFrame.attemptsByNodeId,
        c1: [{ ...c1Attempt, status: 'failed' as const, completedAt: 2500 }]
      }
    };
    const failedRun = upsertInvocationFrame(run, failedChild);
    expect(computeAllowedControlActions(failedRun, childInvocationId)).toEqual([
      'retry-phase',
      'retry-invocation'
    ]);

    // Enforce maxPhaseAttempts bound
    const boundExceededChild = {
      ...failedChild,
      controlMarkers: {
        ...DEFAULT_INVOCATION_CONTROL_MARKERS,
        maxPhaseAttempts: 1
      }
    };
    const boundExceededRun = upsertInvocationFrame(failedRun, boundExceededChild);
    expect(
      evaluateControlTransition({
        run: boundExceededRun,
        operation: 'retry-phase',
        targetInvocationId: childInvocationId
      })
    ).toMatchObject({
      allowed: false,
      refusalCode: 'retry-bound-exceeded'
    });

    // Enforce spendBoundUsd
    const spendExceededChild = {
      ...failedChild,
      controlMarkers: {
        ...DEFAULT_INVOCATION_CONTROL_MARKERS,
        spendUsd: 10,
        spendBoundUsd: 10
      }
    };
    const spendExceededRun = upsertInvocationFrame(failedRun, spendExceededChild);
    expect(
      evaluateControlTransition({
        run: spendExceededRun,
        operation: 'retry-invocation',
        targetInvocationId: childInvocationId
      })
    ).toMatchObject({
      allowed: false,
      refusalCode: 'spend-bound-exceeded'
    });
  });

  it('allows continue-handoff, pause, and cancel when an invocation is waiting-for-handoff', () => {
    const { run, childInvocationId } = buildNestedRun();
    const childFrame = run.invocations![childInvocationId]!;
    const handoff: PendingHandoffRecord = {
      invocationId: childInvocationId,
      fromNodeId: 'c1',
      fromAttemptId: `${childInvocationId}:c1:attempt-1`,
      connectionIndex: 0,
      target: { kind: 'node', nodeId: 'c2' },
      prefilledInputsByPort: {},
      pausedAt: 3000
    };
    const waitingChild = {
      ...childFrame,
      status: 'waiting-for-handoff' as const,
      pendingHandoff: handoff
    };
    const waitingRun = upsertInvocationFrame(run, waitingChild);
    expect(computeAllowedControlActions(waitingRun, childInvocationId)).toEqual([
      'pause',
      'cancel',
      'continue-handoff'
    ]);
  });
});
