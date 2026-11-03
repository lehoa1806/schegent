import { describe, expect, it, vi } from 'vitest';
import type { ContinueWorkflowResult } from '../../../../src/contracts/sidebar-ipc/workflow-run';
import { composeHandoffInputEnvelope } from '../../../../src/services/workflow-execution/continuation-composer';
import {
  continueConnectedRun,
  continueWaitingHandoff
} from '../../../../src/services/workflow-execution/continuation-service';
import {
  completeComposableNodeAttempt,
  dispatchComposableNode
} from '../../../../src/services/workflow-execution/connected-run-coordinator';
import { createComposableWorkflowRunSnapshot } from '../../../../src/services/workflow-execution/connected-run-factory';
import type { GuardedScheduleRequest } from '../../../../src/services/guarded-run-service';
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

describe('continueConnectedRun: a control that queues a leaf', () => {
  const QUEUE = 'q-of-the-run';
  const RUN_ID = 'crun-wake';

  const AUTO_WF: WorkflowDefinition = {
    workflowId: 'wf-auto',
    name: 'Auto',
    version: 1,
    startNodeIds: ['node-spec'],
    nodes: [{ nodeId: 'node-spec', kind: 'phase', phaseId: 'phase-spec' }],
    connections: []
  };

  async function openRun() {
    const created = createComposableWorkflowRunSnapshot({
      connectedRunId: RUN_ID,
      workflow: AUTO_WF,
      effectivePhases: [PHASE_SPEC],
      startedAt: 1000,
      queueId: QUEUE
    });
    if (created.outcome !== 'created') throw new Error('expected created');
    let current = created.run;
    const connectedRuns = {
      get: (id: string) => (id === RUN_ID ? current : null),
      compareAndSetConnectedRun: (next: ConnectedWorkflowRun, expectedRevision: number) => {
        if (current.revision !== expectedRevision) {
          return Promise.resolve({ outcome: 'stale' as const, current });
        }
        current = { ...next, revision: expectedRevision + 1 };
        return Promise.resolve({ outcome: 'written' as const, run: current });
      },
      readChildState: () => null
    };
    await dispatchComposableNode(
      {
        connectedRuns,
        dispatchPhase: () => Promise.resolve({ outcome: 'dispatched', queueItemId: 'row-1' })
      },
      { run: created.run, invocationId: created.rootInvocationId, nodeId: 'node-spec', startedAt: 1001 }
    );

    const admissions: GuardedScheduleRequest[] = [];
    const revisionsAtWake: number[] = [];
    const sequence: string[] = [];
    const wakeWorkflowQueue = vi.fn((_queueId: string) => {
      revisionsAtWake.push(current.revision);
      sequence.push('woken');
    });
    const retireWorkflowFailures = vi.fn(async (_run: ConnectedWorkflowRun) => {
      await Promise.resolve();
      sequence.push('retired');
    });
    const deps = {
      guardedRun: {
        scheduleOrEnqueue: (request: GuardedScheduleRequest) => {
          admissions.push(request);
          return Promise.resolve({
            outcome: 'enqueued' as const,
            queueItemId: `row-${String(admissions.length + 1)}`
          });
        }
      },
      logger: { warn: vi.fn(), sanitize: (text: string) => text },
      connectedRuns,
      projectRun: () => ({}) as never,
      isNodeStartable: () => false,
      wakeWorkflowQueue,
      retireWorkflowFailures
    };
    const failTheAttempt = async (): Promise<void> => {
      await completeComposableNodeAttempt(
        {
          connectedRuns,
          dispatchPhase: () => Promise.resolve({ outcome: 'rejected', reason: 'unused' })
        },
        {
          run: current,
          invocationId: created.rootInvocationId,
          nodeId: 'node-spec',
          status: 'failed',
          completedAt: 1500
        }
      );
    };
    const command = (
      operation: 'pause' | 'resume' | 'retry-phase' | 'retry-invocation',
      expectedRevision = current.revision
    ): Promise<ContinueWorkflowResult> =>
      continueConnectedRun(deps, {
        payload: {
          connectedRunId: RUN_ID,
          expectedRevision,
          nodeId: 'node-spec',
          invocationId: created.rootInvocationId,
          operation,
          request: { pipelineId: 'phase-spec', inputs: [], supplemental: [], outputs: [] }
        },
        workspaceRoot: '/workspace',
        startedAt: 2000
      });
    return {
      admissions,
      revisionsAtWake,
      wakeWorkflowQueue,
      retireWorkflowFailures,
      sequence,
      failTheAttempt,
      command,
      currentRevision: () => current.revision
    };
  }

  it('offers the queue its work once, after the command has committed', async () => {
    const h = await openRun();
    await h.command('pause');
    expect(h.wakeWorkflowQueue).not.toHaveBeenCalled();

    await expect(h.command('resume')).resolves.toMatchObject({ outcome: 'started' });

    expect(h.wakeWorkflowQueue).toHaveBeenCalledTimes(1);
    expect(h.wakeWorkflowQueue).toHaveBeenCalledWith(QUEUE);
    expect(h.revisionsAtWake).toEqual([h.currentRevision()]);
  });

  it('tells admission the new attempt continues a Workflow already on the queue', async () => {
    const h = await openRun();
    await h.command('pause');

    await h.command('resume');

    expect(h.admissions.map((request) => request.continuesWorkflow)).toEqual([true]);
  });

  it('offers nothing for a command that queued nothing', async () => {
    const h = await openRun();

    await expect(h.command('pause')).resolves.toMatchObject({ outcome: 'started' });

    expect(h.admissions).toEqual([]);
    expect(h.wakeWorkflowQueue).not.toHaveBeenCalled();
  });

  it('offers nothing for a refused command', async () => {
    const h = await openRun();
    await h.command('pause');

    const refused = await h.command('resume', h.currentRevision() + 7);

    expect(refused.outcome).not.toBe('started');
    expect(h.wakeWorkflowQueue).not.toHaveBeenCalled();
  });

  it.each(['retry-phase', 'retry-invocation'] as const)(
    '%s retires the failures it answers once it has committed, before offering the queue its work',
    async (operation) => {
      const h = await openRun();
      await h.failTheAttempt();

      await expect(h.command(operation)).resolves.toMatchObject({ outcome: 'started' });

      expect(h.retireWorkflowFailures).toHaveBeenCalledTimes(1);
      expect(h.retireWorkflowFailures.mock.calls.at(0)?.at(0)?.revision).toBe(h.currentRevision());
      expect(h.sequence).toEqual(['retired', 'woken']);
    }
  );

  it('retires nothing when the same Retry is replayed: a newer failure is not what it answered', async () => {
    const h = await openRun();
    await h.failTheAttempt();
    const revision = h.currentRevision();

    await expect(h.command('retry-phase', revision)).resolves.toMatchObject({ outcome: 'started' });
    await expect(h.command('retry-phase', revision)).resolves.toMatchObject({ outcome: 'started' });

    expect(h.retireWorkflowFailures).toHaveBeenCalledTimes(1);
  });

  it('retires nothing for a refused Retry, whose failed row still stands', async () => {
    const h = await openRun();
    await h.failTheAttempt();

    const refused = await h.command('retry-phase', h.currentRevision() + 7);

    expect(refused.outcome).not.toBe('started');
    expect(h.retireWorkflowFailures).not.toHaveBeenCalled();
  });

  it('retires nothing for a control that is not a Retry', async () => {
    const h = await openRun();

    await h.command('pause');
    await h.command('resume');

    expect(h.retireWorkflowFailures).not.toHaveBeenCalled();
  });
});

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
