import { describe, expect, it, vi } from 'vitest';
import {
  continueComposableWorkflowHandoff,
  launchComposableWorkflowRun
} from '../../src/headless/workflow-run-api';
import { validateRunRequest } from '../../src/services/run-request/run-request-validator';
import {
  completeComposableNodeAttempt,
  dispatchComposableNode
} from '../../src/services/workflow-execution/connected-run-coordinator';
import { continueWaitingHandoff } from '../../src/services/workflow-execution/continuation-service';
import { startPhaseNodeRun } from '../../src/services/workflow-execution/node-run-starter';
import { launchComposableWorkflow } from '../../src/services/workflow-execution/workflow-launcher';
import type { ConnectedWorkflowRun, WorkflowInvocationFrame } from '../../src/state/connected-workflow-run';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import type { ResolvedPortValue, RunRequest } from '../../src/contracts/run-request';
import type { WorkflowDefinition, WorkflowNode } from '../../src/contracts/workflow-definitions';

const PHASE_SPEC: PhaseDefinition = {
  phaseId: 'phase-spec',
  name: 'Spec Phase',
  version: 1,
  instruction: 'Run specify'
};

const PHASE_PLAN: PhaseDefinition = {
  phaseId: 'phase-plan',
  name: 'Plan Phase',
  version: 1,
  instruction: 'Run plan'
};

const CHILD_WF: WorkflowDefinition = {
  workflowId: 'wf-child',
  name: 'Child Workflow',
  version: 1,
  inputs: [{ portId: 'featureDescription', label: 'Feature', type: 'text', required: true }],
  outputs: [{ portId: 'childSpecDir', label: 'Child Spec Dir', type: 'file-set', required: true }],
  startNodeIds: ['child-spec'],
  nodes: [
    {
      nodeId: 'child-spec',
      kind: 'phase',
      phaseId: 'phase-spec'
    }
  ],
  connections: [
    {
      from: { nodeId: 'child-spec' },
      to: { nodeId: '', kind: 'return' },
      handoff: 'auto',
      priority: 0
    }
  ],
  bindings: [
    {
      kind: 'input',
      nodeId: 'child-spec',
      inputKey: 'featureDescription',
      type: 'text',
      source: { from: 'workflow-input', portId: 'featureDescription' }
    },
    {
      kind: 'output',
      portId: 'childSpecDir',
      nodeId: 'child-spec',
      outputKey: 'specDir',
      type: 'file-set'
    }
  ]
};

const ROOT_WF: WorkflowDefinition = {
  workflowId: 'wf-root',
  name: 'Root Workflow',
  version: 1,
  inputs: [{ portId: 'featureDescription', label: 'Feature', type: 'text', required: true }],
  outputs: [{ portId: 'finalPlan', label: 'Final Plan', type: 'markdown', required: true }],
  startNodeIds: ['node-child'],
  nodes: [
    {
      nodeId: 'node-child',
      kind: 'workflow',
      workflowId: 'wf-child'
    },
    {
      nodeId: 'node-plan',
      kind: 'phase',
      phaseId: 'phase-plan'
    }
  ],
  connections: [
    {
      from: { nodeId: 'node-child' },
      to: { kind: 'node', nodeId: 'node-plan' },
      handoff: 'manual',
      priority: 0
    }
  ],
  bindings: [
    {
      kind: 'input',
      nodeId: 'node-child',
      inputKey: 'featureDescription',
      type: 'text',
      source: { from: 'workflow-input', portId: 'featureDescription' }
    },
    {
      kind: 'input',
      nodeId: 'node-plan',
      inputKey: 'specDir',
      type: 'source',
      source: { from: 'node-output', nodeId: 'node-child', portId: 'childSpecDir' }
    },
    {
      kind: 'output',
      portId: 'finalPlan',
      nodeId: 'node-plan',
      outputKey: 'planFile',
      type: 'markdown'
    }
  ]
};

async function executeFullScenario(mode: 'host' | 'headless') {
  const mutableWorkflows: WorkflowDefinition[] = [ROOT_WF, CHILD_WF];
  const workflowSource = {
    rootWorkflow: ROOT_WF,
    workflows: mutableWorkflows,
    phases: [PHASE_SPEC, PHASE_PLAN]
  };

  let currentRun: ConnectedWorkflowRun | null = null;
  const readCurrentRun = (): ConnectedWorkflowRun | null => currentRun;
  let qCount = 0;
  const queueTrace: Array<{
    queueItemId: string;
    queueId: string | null | undefined;
    description: string;
  }> = [];

  const launcherDeps = {
    guardedRun: {
      scheduleOrEnqueue: async (req: {
        readonly description: string;
        readonly queueId?: string | null;
      }) => {
        qCount += 1;
        const queueItemId = `qitem-${qCount}`;
        queueTrace.push({ queueItemId, queueId: req.queueId, description: req.description });
        return {
          outcome: 'enqueued' as const,
          queueItemId
        };
      }
    },
    logger: { warn: vi.fn(), sanitize: (s: string) => s },
    connectedRuns: {
      compareAndSetConnectedRun: async (next: ConnectedWorkflowRun, expectedRevision: number) => {
        if ((currentRun?.revision ?? 0) !== expectedRevision) {
          return { outcome: 'stale' as const, current: currentRun };
        }
        currentRun = next;
        return { outcome: 'written' as const, run: next };
      }
    },
    isChildSettled: () => true
  };

  const coordinatorDeps = {
    connectedRuns: launcherDeps.connectedRuns,
    dispatchPhase: async (phaseInput: {
      readonly run: ConnectedWorkflowRun;
      readonly frame: WorkflowInvocationFrame;
      readonly node: WorkflowNode;
      readonly phase: PhaseDefinition;
      readonly boundInputs: Readonly<Record<string, ResolvedPortValue>>;
      readonly attemptId: string;
      readonly attemptIndex: number;
      readonly queueId: string;
      readonly startedAt: number;
    }) => {
      if (phaseInput.run.frozenClosure === undefined) {
        return { outcome: 'rejected' as const, reason: 'missing-closure' };
      }
      const phaseRequest: RunRequest = {
        pipelineId: phaseInput.phase.phaseId,
        inputs: Object.values(phaseInput.boundInputs).map((portVal) => ({
          portId: portVal.portId,
          type: portVal.type as RunRequest['inputs'][number]['type'],
          value: portVal.value
        })),
        supplemental: [],
        outputs: []
      };
      const started = await startPhaseNodeRun(launcherDeps, {
        frozenClosure: phaseInput.run.frozenClosure,
        phaseId: phaseInput.phase.phaseId,
        request: phaseRequest,
        workspaceRoot: '/tmp/ws',
        description: phaseInput.node.label ?? phaseInput.phase.name,
        queueId: phaseInput.queueId,
        occurrence: {
          rootRunId: phaseInput.run.connectedRunId,
          invocationId: phaseInput.frame.invocationId,
          parentInvocationId: phaseInput.frame.parentInvocationId,
          nodePath: `${phaseInput.frame.nodePath}/${phaseInput.node.nodeId}`,
          attemptId: phaseInput.attemptId,
          attemptIndex: phaseInput.attemptIndex
        }
      });
      if (started.outcome !== 'enqueued') {
        return { outcome: 'rejected' as const, reason: started.outcome };
      }
      return { outcome: 'dispatched' as const, queueItemId: started.queueItemId };
    }
  };

  const launchRequest = {
    pipelineId: 'wf-root',
    workflowId: 'wf-root',
    entryNodeId: 'node-child',
    inputs: [{ portId: 'featureDescription', type: 'text' as const, value: 'End-to-end parity feature' }],
    supplemental: [],
    outputs: [{ portId: 'finalPlan', target: 'specs/261/plan.md' }]
  };

  // Step 1: Launch root workflow (enters `node-child` -> `wf-child` -> `child-spec`)
  if (mode === 'host') {
    const validated = await validateRunRequest(launchRequest, {
      workflow: workflowSource,
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
    });
    if (!validated.ok) throw new Error('expected valid');
    const launched = await launchComposableWorkflow(launcherDeps, {
      connectedRunId: 'crun-parity',
      envelope: validated.plan,
      workspaceRoot: '/tmp/ws',
      startedAt: 1000,
      queueId: 'q-serial'
    });
    expect(launched.outcome).toBe('started');
  } else {
    const launched = await launchComposableWorkflowRun(launcherDeps, {
      connectedRunId: 'crun-parity',
      request: launchRequest,
      workflowSource,
      workspaceRoot: '/tmp/ws',
      startedAt: 1000,
      queueId: 'q-serial'
    });
    expect(launched.outcome).toBe('started');
  }

  // Mutate live catalog after launch to prove mid-run catalog edits never affect frozen execution
  mutableWorkflows[1] = {
    ...CHILD_WF,
    name: 'MUTATED LIVE WORKFLOW'
  };

  const runAfterLaunch = readCurrentRun();
  if (runAfterLaunch === null) throw new Error('expected run after launch');
  const childInvocationId = Object.keys(runAfterLaunch.invocations ?? {}).find(
    (id) => id !== 'crun-parity:root'
  );
  if (childInvocationId === undefined) throw new Error('expected child invocation');

  // Step 2: Complete `child-spec` -> child returns `{ childSpecDir: 'specs/261' }` -> parent pauses on manual handoff before `node-plan`
  const afterChild = await completeComposableNodeAttempt(coordinatorDeps, {
    run: runAfterLaunch,
    invocationId: childInvocationId,
    nodeId: 'child-spec',
    attemptIndex: 1,
    status: 'completed',
    completedAt: 2000,
    declaredOutputs: {
      specDir: { portId: 'specDir', type: 'file-set', value: 'specs/261' }
    }
  });
  expect(afterChild.outcome).toBe('waiting-for-handoff');

  const waitingRun = readCurrentRun();
  if (waitingRun === null) throw new Error('expected waiting run');

  const handoffRequest: RunRequest = {
    pipelineId: 'phase-plan',
    inputs: [{ portId: 'specDir', type: 'source', value: 'specs/261-override' }],
    supplemental: [],
    outputs: []
  };

  // Step 3: Operator continues waiting handoff with override `{ specDir: 'specs/261-override' }`
  if (mode === 'host') {
    const accepted = await continueWaitingHandoff(
      { connectedRuns: launcherDeps.connectedRuns },
      {
        run: waitingRun,
        expectedRevision: waitingRun.revision,
        invocationId: 'crun-parity:root',
        targetNodeId: 'node-plan',
        request: handoffRequest,
        acceptedAt: 2500
      }
    );
    expect(accepted.outcome).toBe('accepted');
    if (accepted.outcome !== 'accepted') throw new Error('expected accepted');
    const dispatched = await dispatchComposableNode(coordinatorDeps, {
      run: accepted.run,
      invocationId: 'crun-parity:root',
      nodeId: 'node-plan',
      startedAt: 2500
    });
    expect(dispatched.outcome).toBe('phase-dispatched');
  } else {
    const resumed = await continueComposableWorkflowHandoff(coordinatorDeps, {
      run: waitingRun,
      expectedRevision: waitingRun.revision,
      invocationId: 'crun-parity:root',
      targetNodeId: 'node-plan',
      request: handoffRequest,
      acceptedAt: 2500,
      workspaceRoot: '/tmp/ws'
    });
    expect(resumed.outcome).toBe('phase-dispatched');
  }

  const resumedRun = readCurrentRun();
  if (resumedRun === null) throw new Error('expected resumed run');

  // Step 4: Complete `node-plan` -> root workflow completes
  const completed = await completeComposableNodeAttempt(coordinatorDeps, {
    run: resumedRun,
    invocationId: 'crun-parity:root',
    nodeId: 'node-plan',
    attemptIndex: 1,
    status: 'completed',
    completedAt: 3000,
    declaredOutputs: {
      planFile: { portId: 'planFile', type: 'file', value: 'specs/261-override/plan.md' }
    }
  });
  expect(completed.outcome).toBe('workflow-completed');
  if (completed.outcome !== 'workflow-completed') throw new Error('expected completed');

  return {
    finalRun: completed.run,
    outputs: completed.outputs,
    queueTrace
  };
}

describe('integration — frozen composable Workflow execution & host/headless parity (FR-R5-F02)', () => {
  it('produces identical execution traces, frozen closure isolation, and single root queueId claims across host and headless entry points', async () => {
    const hostResult = await executeFullScenario('host');
    const headlessResult = await executeFullScenario('headless');

    expect(hostResult.outputs.finalPlan?.value).toBe('specs/261-override/plan.md');
    expect(headlessResult.outputs).toEqual(hostResult.outputs);
    expect(headlessResult.queueTrace).toEqual(hostResult.queueTrace);
    expect(hostResult.queueTrace.map((q) => q.queueId)).toEqual(['q-serial', 'q-serial']);
    expect(hostResult.finalRun.frozenClosure?.workflowsById['wf-child']?.name).toBe(
      'Child Workflow'
    );
    expect(hostResult.finalRun.inputEnvelopes).toEqual(headlessResult.finalRun.inputEnvelopes);
    expect(hostResult.finalRun.invocations).toEqual(headlessResult.finalRun.invocations);
  });
});
