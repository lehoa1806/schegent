import { describe, expect, it } from 'vitest';
import { createComposableWorkflowRunSnapshot } from '../../../../src/services/workflow-execution/connected-run-factory';
import {
  completeComposableNodeAttempt,
  dispatchComposableNode
} from '../../../../src/services/workflow-execution/connected-run-coordinator';
import type { ConnectedWorkflowRun } from '../../../../src/state/connected-workflow-run';
import type { PhaseDefinition } from '../../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../../src/contracts/workflow-definitions';

const PHASE_SPEC: PhaseDefinition = {
  phaseId: 'phase-spec',
  name: 'Spec Phase',
  version: 1,
  instruction: 'Run specify'
};

const CHILD_WF: WorkflowDefinition = {
  workflowId: 'wf-child',
  name: 'Child Workflow',
  version: 1,
  inputs: [{ portId: 'featureDescription', label: 'Feature', type: 'text', required: true }],
  outputs: [{ portId: 'childSpec', label: 'Child Spec', type: 'file-set', required: true }],
  startNodeIds: ['child-entry', 'child-alt'],
  nodes: [
    {
      nodeId: 'child-entry',
      kind: 'phase',
      phaseId: 'phase-spec'
    },
    {
      nodeId: 'child-alt',
      kind: 'phase',
      phaseId: 'phase-spec'
    }
  ],
  connections: [
    {
      from: { nodeId: 'child-entry' },
      to: { nodeId: '', kind: 'return' },
      handoff: 'auto',
      priority: 0
    }
  ],
  bindings: [
    {
      kind: 'input',
      nodeId: 'child-entry',
      inputKey: 'featureDescription',
      source: { from: 'workflow-input', portId: 'featureDescription' }
    },
    {
      kind: 'output',
      portId: 'childSpec',
      nodeId: 'child-entry',
      outputKey: 'specDir'
    }
  ]
};

const ROOT_WF: WorkflowDefinition = {
  workflowId: 'wf-root',
  name: 'Root Workflow',
  version: 1,
  inputs: [{ portId: 'featureDescription', label: 'Feature', type: 'text', required: true }],
  outputs: [{ portId: 'finalSpec', label: 'Final Spec', type: 'file-set', required: true }],
  startNodeIds: ['node-call-child'],
  nodes: [
    {
      nodeId: 'node-call-child',
      kind: 'workflow',
      workflowId: 'wf-child'
    },
    {
      nodeId: 'node-after-child',
      kind: 'phase',
      phaseId: 'phase-spec'
    }
  ],
  connections: [
    {
      from: { nodeId: 'node-call-child' },
      to: { kind: 'node', nodeId: 'node-after-child' },
      handoff: 'auto',
      priority: 0
    }
  ],
  bindings: [
    {
      kind: 'input',
      nodeId: 'node-call-child',
      inputKey: 'featureDescription',
      source: { from: 'workflow-input', portId: 'featureDescription' }
    },
    {
      kind: 'input',
      nodeId: 'node-after-child',
      inputKey: 'featureDescription',
      source: { from: 'node-output', nodeId: 'node-call-child', portId: 'childSpec' }
    },
    {
      kind: 'output',
      portId: 'finalSpec',
      nodeId: 'node-after-child',
      outputKey: 'specDir'
    }
  ]
};

describe('connected-run-coordinator — composable nested Workflow call/return (FR-R5-F02)', () => {
  it('pushes child WorkflowInvocationFrame at startNodeIds[0], dispatches within the root queueId, and returns declared outputs to parent', async () => {
    const created = createComposableWorkflowRunSnapshot({
      connectedRunId: 'crun-1',
      workflow: ROOT_WF,
      entryNodeId: 'node-call-child',
      effectiveWorkflows: [ROOT_WF, CHILD_WF],
      effectivePhases: [PHASE_SPEC],
      boundInputs: {
        featureDescription: {
          portId: 'featureDescription',
          type: 'text',
          value: 'Nested feature'
        }
      },
      startedAt: 1000,
      queueId: 'q-serial-1'
    });
    expect(created.outcome).toBe('created');
    if (created.outcome !== 'created') return;

    let currentRun = created.run;
    const rootInvocationId = created.rootInvocationId;

    const dispatchedQueueIds: string[] = [];
    let qCounter = 0;
    const deps = {
      connectedRuns: {
        compareAndSetConnectedRun: async (next: ConnectedWorkflowRun, expectedRevision: number) => {
          if (currentRun.revision !== expectedRevision) {
            return { outcome: 'stale' as const, current: currentRun };
          }
          currentRun = next;
          return { outcome: 'written' as const, run: next };
        }
      },
      dispatchPhase: async (input: { readonly queueId: string }) => {
        dispatchedQueueIds.push(input.queueId);
        qCounter += 1;
        return { outcome: 'dispatched' as const, queueItemId: `qitem-${qCounter}` };
      }
    };

    // 1. Dispatch root entry node (`node-call-child`), which calls `wf-child` at `startNodeIds[0]` (`child-entry`)
    const step1 = await dispatchComposableNode(deps, {
      run: currentRun,
      invocationId: rootInvocationId,
      nodeId: 'node-call-child',
      startedAt: 1000
    });

    expect(step1.outcome).toBe('phase-dispatched');
    if (step1.outcome !== 'phase-dispatched') return;
    expect(step1.nodeId).toBe('child-entry');
    expect(dispatchedQueueIds).toEqual(['q-serial-1']);

    // 2. Complete `child-entry` in child frame -> returns to parent and auto-dispatches `node-after-child`
    const step2 = await completeComposableNodeAttempt(deps, {
      run: step1.run,
      invocationId: step1.invocationId,
      nodeId: 'child-entry',
      attemptIndex: 1,
      status: 'completed',
      completedAt: 2000,
      declaredOutputs: {
        specDir: { portId: 'specDir', type: 'file-set', value: 'specs/261-child' }
      }
    });

    expect(step2.outcome).toBe('phase-dispatched');
    if (step2.outcome !== 'phase-dispatched') return;
    expect(step2.invocationId).toBe(rootInvocationId);
    expect(step2.nodeId).toBe('node-after-child');
    expect(dispatchedQueueIds).toEqual(['q-serial-1', 'q-serial-1']);
    expect(step2.run.invocations?.[step1.invocationId]?.status).toBe('completed');
    expect(step2.run.invocations?.[step1.invocationId]?.resolvedOutputs.childSpec?.value).toBe(
      'specs/261-child'
    );

    // 3. Complete `node-after-child` (terminal sink) -> completes root workflow
    const step3 = await completeComposableNodeAttempt(deps, {
      run: step2.run,
      invocationId: rootInvocationId,
      nodeId: 'node-after-child',
      attemptIndex: 1,
      status: 'completed',
      completedAt: 3000,
      declaredOutputs: {
        specDir: { portId: 'specDir', type: 'file-set', value: 'specs/261-final' }
      }
    });

    expect(step3.outcome).toBe('workflow-completed');
    if (step3.outcome !== 'workflow-completed') return;
    expect(step3.outputs.finalSpec?.value).toBe('specs/261-final');
    expect(step3.run.invocations?.[rootInvocationId]?.status).toBe('completed');
  });
});
