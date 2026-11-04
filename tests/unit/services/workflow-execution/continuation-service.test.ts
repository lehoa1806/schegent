import { describe, expect, it } from 'vitest';
import { composeHandoffInputEnvelope } from '../../../../src/services/workflow-execution/continuation-composer';
import { continueWaitingHandoff } from '../../../../src/services/workflow-execution/continuation-service';
import { createComposableWorkflowRunSnapshot } from '../../../../src/services/workflow-execution/connected-run-factory';
import {
  setPendingHandoff,
  upsertInvocationFrame,
  type ConnectedWorkflowRun,
  type PendingHandoffRecord
} from '../../../../src/state/connected-workflow-run';
import type { PhaseDefinition } from '../../../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../../../src/contracts/workflow-definitions';

const PHASE_SPEC: PhaseDefinition = {
  phaseId: 'phase-spec',
  name: 'Spec Phase',
  version: 1,
  instruction: 'Run specify'
};

const ROOT_WF: WorkflowDefinition = {
  workflowId: 'wf-root',
  name: 'Root Workflow',
  version: 1,
  inputs: [{ portId: 'featureDescription', label: 'Feature', type: 'text', required: true }],
  outputs: [{ portId: 'finalSpec', label: 'Final Spec', type: 'file-set', required: true }],
  startNodeIds: ['node-spec'],
  nodes: [
    {
      nodeId: 'node-spec',
      kind: 'phase',
      phaseId: 'phase-spec'
    },
    {
      nodeId: 'node-impl',
      kind: 'phase',
      phaseId: 'phase-spec'
    }
  ],
  connections: [
    {
      from: { nodeId: 'node-spec' },
      to: { kind: 'node', nodeId: 'node-impl' },
      handoff: 'manual',
      priority: 0
    }
  ],
  bindings: [
    {
      kind: 'input',
      nodeId: 'node-spec',
      inputKey: 'featureDescription',
      source: { from: 'workflow-input', portId: 'featureDescription' }
    },
    {
      kind: 'input',
      nodeId: 'node-impl',
      inputKey: 'featureDescription',
      source: { from: 'workflow-input', portId: 'featureDescription' }
    },
    {
      kind: 'output',
      portId: 'finalSpec',
      nodeId: 'node-impl',
      outputKey: 'specDir'
    }
  ]
};

describe('continuation-service — continueWaitingHandoff (FR-R5-F02)', () => {
  const HANDOFF_RECORD: PendingHandoffRecord = {
    invocationId: 'crun-1:root',
    fromNodeId: 'node-spec',
    fromAttemptId: 'crun-1:root:node-spec:attempt-1',
    connectionIndex: 0,
    target: { kind: 'node', nodeId: 'node-impl' },
    prefilledInputsByPort: {
      featureDescription: {
        portId: 'featureDescription',
        type: 'text',
        value: 'Initial'
      }
    },
    pausedAt: 1500
  };

  function buildWaitingRun(): ConnectedWorkflowRun {
    const created = createComposableWorkflowRunSnapshot({
      connectedRunId: 'crun-1',
      workflow: ROOT_WF,
      entryNodeId: 'node-spec',
      effectivePhases: [PHASE_SPEC],
      boundInputs: {
        featureDescription: {
          portId: 'featureDescription',
          type: 'text',
          value: 'Initial'
        }
      },
      startedAt: 1000
    });
    if (created.outcome !== 'created') throw new Error('expected created');
    let run = created.run;
    const rootFrame = run.invocations?.[created.rootInvocationId];
    if (rootFrame === undefined) throw new Error('missing root frame');
    run = upsertInvocationFrame(run, {
      ...rootFrame,
      status: 'waiting-for-handoff',
      pendingHandoff: HANDOFF_RECORD
    });
    run = setPendingHandoff(run, HANDOFF_RECORD);
    return run;
  }

  it('composes an immutable InvocationInputEnvelope with acceptedAt', () => {
    const env = composeHandoffInputEnvelope({
      envelopeId: 'env-1',
      handoff: HANDOFF_RECORD,
      targetNodeId: 'node-impl',
      request: {
        pipelineId: 'phase-spec',
        inputs: [{ portId: 'featureDescription', type: 'text', value: 'Updated' }],
        supplemental: [],
        outputs: []
      },
      acceptedAt: 2000
    });
    expect(Object.isFrozen(env)).toBe(true);
    expect(Object.isFrozen(env.inputsByPort)).toBe(true);
    expect(env.acceptedAt).toBe(2000);
    expect(env.inputsByPort.featureDescription?.value).toBe('Updated');
  });

  it('persists InvocationInputEnvelope and clears pendingHandoff without mutating FrozenWorkflowClosure', async () => {
    const run = buildWaitingRun();
    const closureBefore = run.frozenClosure;
    let stored: ConnectedWorkflowRun = run;

    const result = await continueWaitingHandoff(
      {
        connectedRuns: {
          compareAndSetConnectedRun: async (next, expectedRevision) => {
            if (stored.revision !== expectedRevision) {
              return { outcome: 'stale', current: stored };
            }
            stored = next;
            return { outcome: 'written', run: next };
          }
        }
      },
      {
        run,
        expectedRevision: run.revision,
        invocationId: 'crun-1:root',
        targetNodeId: 'node-impl',
        request: {
          pipelineId: 'phase-spec',
          inputs: [{ portId: 'featureDescription', type: 'text', value: 'Operator override' }],
          supplemental: [],
          outputs: []
        },
        acceptedAt: 2500,
        expectedInputs: [{ portId: 'featureDescription', label: 'Feature', type: 'text', required: true }]
      }
    );

    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.run.pendingHandoff).toBeNull();
    expect(result.run.inputEnvelopes).toHaveLength(1);
    expect(result.run.inputEnvelopes?.[0]?.acceptedAt).toBe(2500);
    expect(result.run.inputEnvelopes?.[0]?.inputsByPort.featureDescription?.value).toBe(
      'Operator override'
    );
    expect(result.run.invocations?.['crun-1:root']?.status).toBe('in-flight');
    expect(result.run.frozenClosure).toBe(closureBefore);
  });

  it('rejects missing required handoff inputs and mismatched handoff targets', async () => {
    const run = buildWaitingRun();
    const writer = {
      compareAndSetConnectedRun: async (next: ConnectedWorkflowRun) => ({
        outcome: 'written' as const,
        run: next
      })
    };

    const validationRes = await continueWaitingHandoff(
      { connectedRuns: writer },
      {
        run,
        expectedRevision: run.revision,
        invocationId: 'crun-1:root',
        targetNodeId: 'node-impl',
        request: {
          pipelineId: 'phase-spec',
          inputs: [{ portId: 'featureDescription', type: 'text', value: '   ' }],
          supplemental: [],
          outputs: []
        },
        acceptedAt: 2500,
        expectedInputs: [{ portId: 'featureDescription', label: 'Feature', type: 'text', required: true }]
      }
    );
    expect(validationRes.outcome).toBe('rejected-validation');

    const mismatchRes = await continueWaitingHandoff(
      { connectedRuns: writer },
      {
        run,
        expectedRevision: run.revision,
        invocationId: 'crun-1:root',
        targetNodeId: 'node-spec',
        request: {
          pipelineId: 'phase-spec',
          inputs: [{ portId: 'featureDescription', type: 'text', value: 'Valid' }],
          supplemental: [],
          outputs: []
        },
        acceptedAt: 2500
      }
    );
    expect(mismatchRes).toEqual({
      outcome: 'rejected-state',
      reason: 'handoff-mismatch',
      run
    });
  });
});
