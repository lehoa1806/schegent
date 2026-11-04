import { describe, expect, it, vi } from 'vitest';
import { validateRunRequest } from '../../../../src/services/run-request/run-request-validator';
import { launchComposableWorkflow } from '../../../../src/services/workflow-execution/workflow-launcher';
import type { ConnectedWorkflowRun } from '../../../../src/state/connected-workflow-run';
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
    }
  ],
  connections: [],
  bindings: [
    {
      kind: 'input',
      nodeId: 'node-spec',
      inputKey: 'featureDescription',
      type: 'text',
      source: { from: 'workflow-input', portId: 'featureDescription' }
    },
    {
      kind: 'output',
      portId: 'finalSpec',
      nodeId: 'node-spec',
      outputKey: 'specDir',
      type: 'file-set'
    }
  ]
};

describe('workflow-launcher — launchComposableWorkflow & lease release (FR-R5-F02)', () => {
  async function buildValidatedEnvelope(instructions?: string) {
    const res = await validateRunRequest(
      {
        pipelineId: 'wf-root',
        workflowId: 'wf-root',
        entryNodeId: 'node-spec',
        inputs: [{ portId: 'featureDescription', type: 'text', value: 'Build composable launcher' }],
        supplemental: [],
        outputs: [{ portId: 'finalSpec', target: 'specs/261' }],
        ...(instructions === undefined ? {} : { instructions })
      },
      {
        workflow: {
          rootWorkflow: ROOT_WF,
          workflows: [ROOT_WF],
          phases: [PHASE_SPEC]
        },
        workspaceRoot: '/tmp/ws',
        now: 1000,
        localInputs: {
          checkFile: async () => ({ ok: true }),
          checkFolder: async () => ({ ok: true })
        },
        outputProbe: {
          exists: async () => false
        },
        priorOutputs: {
          outputsFor: () => null
        }
      }
    );
    if (!res.ok) throw new Error('expected valid envelope');
    return res.plan;
  }

  it('launches a composable Workflow, binds root queueId, and does not release lease on success', async () => {
    const envelope = await buildValidatedEnvelope();
    const releaseRootLease = vi.fn();
    let persistedRun: ConnectedWorkflowRun | null = null;
    const enqueuedQueues: Array<string | null | undefined> = [];

    const result = await launchComposableWorkflow(
      {
        guardedRun: {
          scheduleOrEnqueue: async (req) => {
            enqueuedQueues.push(req.queueId);
            return {
              outcome: 'enqueued',
              queueItemId: 'qitem-root-1'
            };
          }
        },
        logger: { warn: vi.fn(), sanitize: (s) => s },
        connectedRuns: {
          compareAndSetConnectedRun: async (next) => {
            persistedRun = next;
            return { outcome: 'written', run: next };
          }
        },
        isChildSettled: () => true
      },
      {
        connectedRunId: 'crun-100',
        envelope,
        workspaceRoot: '/tmp/ws',
        startedAt: 1000,
        queueId: 'q-main',
        releaseRootLease
      }
    );

    expect(result.outcome).toBe('started');
    expect(enqueuedQueues).toEqual(['q-main']);
    const saved = persistedRun as ConnectedWorkflowRun | null;
    expect(saved?.queueId).toBe('q-main');
    expect(releaseRootLease).not.toHaveBeenCalled();
  });

  it('releases root queue/lock lease in finally when initial start or queue admission fails', async () => {
    const envelope = await buildValidatedEnvelope();
    const releaseRootLease = vi.fn();

    const result = await launchComposableWorkflow(
      {
        guardedRun: {
          scheduleOrEnqueue: async () => ({
            outcome: 'rejected-paused',
            detail: 'queue paused'
          })
        },
        logger: { warn: vi.fn(), sanitize: (s) => s },
        connectedRuns: {
          compareAndSetConnectedRun: async (next) => ({ outcome: 'written', run: next })
        },
        isChildSettled: () => true
      },
      {
        connectedRunId: 'crun-fail-1',
        envelope,
        workspaceRoot: '/tmp/ws',
        startedAt: 1000,
        queueId: 'q-main',
        releaseRootLease
      }
    );

    expect(result.outcome).toBe('rejected-queue');
    expect(releaseRootLease).toHaveBeenCalledTimes(1);
    expect(releaseRootLease).toHaveBeenCalledWith('q-main', 'crun-fail-1');
  });

  it('carries the operator instructions into the entry Phase run plan', async () => {
    const envelope = await buildValidatedEnvelope('Keep the change small');
    const plannedInstructions: Array<string | undefined> = [];

    const result = await launchComposableWorkflow(
      {
        guardedRun: {
          scheduleOrEnqueue: async (req) => {
            plannedInstructions.push(req.runPlan?.instructions);
            return { outcome: 'enqueued', queueItemId: 'qitem-instructions-1' };
          }
        },
        logger: { warn: vi.fn(), sanitize: (s) => s },
        connectedRuns: {
          compareAndSetConnectedRun: async (next) => ({ outcome: 'written', run: next })
        },
        isChildSettled: () => true
      },
      {
        connectedRunId: 'crun-instructions-1',
        envelope,
        workspaceRoot: '/tmp/ws',
        startedAt: 1000,
        queueId: 'q-main'
      }
    );

    expect(result.outcome).toBe('started');
    expect(plannedInstructions).toEqual(['Keep the change small']);
  });

  it('tells the entry Phase a root target under the key its output binding reads', async () => {
    const envelope = await buildValidatedEnvelope();
    const plannedOutputs: Array<ReadonlyArray<readonly [string, string]> | undefined> = [];

    const result = await launchComposableWorkflow(
      {
        guardedRun: {
          scheduleOrEnqueue: async (req) => {
            plannedOutputs.push(req.runPlan?.outputs.map((o) => [o.portId, o.target]));
            return { outcome: 'enqueued', queueItemId: 'qitem-output-1' };
          }
        },
        logger: { warn: vi.fn(), sanitize: (s) => s },
        connectedRuns: {
          compareAndSetConnectedRun: async (next) => ({ outcome: 'written', run: next })
        },
        isChildSettled: () => true
      },
      {
        connectedRunId: 'crun-output-1',
        envelope,
        workspaceRoot: '/tmp/ws',
        startedAt: 1000,
        queueId: 'q-main'
      }
    );

    expect(result.outcome).toBe('started');
    expect(plannedOutputs).toEqual([[['specDir', 'specs/261']]]);
  });

  it('persists no connected run when the queue refuses the entry Phase', async () => {
    const envelope = await buildValidatedEnvelope();
    const compareAndSetConnectedRun = vi.fn(async (next: ConnectedWorkflowRun) => ({
      outcome: 'written' as const,
      run: next
    }));

    const result = await launchComposableWorkflow(
      {
        guardedRun: {
          scheduleOrEnqueue: async () => ({
            outcome: 'rejected-paused',
            detail: 'queue paused'
          })
        },
        logger: { warn: vi.fn(), sanitize: (s) => s },
        connectedRuns: { compareAndSetConnectedRun },
        isChildSettled: () => true
      },
      {
        connectedRunId: 'crun-refused-1',
        envelope,
        workspaceRoot: '/tmp/ws',
        startedAt: 1000,
        queueId: 'q-main'
      }
    );

    // A launch the queue refused never started: a stored failed root would list in the
    // Runs surface as a run nothing can finish, cancel or retry.
    expect(result.outcome).toBe('rejected-queue');
    expect(compareAndSetConnectedRun).not.toHaveBeenCalled();
  });
});
