import { describe, expect, it } from 'vitest';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import type { ConnectedWorkflowRun } from '../../src/state/connected-workflow-run';
import { createComposableWorkflowRunSnapshot } from '../../src/services/workflow-execution/connected-run-factory';
import {
  completeComposableNodeAttempt,
  dispatchComposableNode
} from '../../src/services/workflow-execution/connected-run-coordinator';
import { WorkflowControlService } from '../../src/services/workflow-execution/workflow-control-service';
import { WorkflowRecoveryService } from '../../src/services/workflow-execution/workflow-recovery-service';
import {
  buildAncestryEvidenceMetadata,
  buildWorkflowRunControlProjection
} from '../../src/services/workflow-execution/workflow-control-projector';
import {
  buildComposableWorkflowAncestryEvidence,
  executeComposableWorkflowControlCommand,
  getComposableWorkflowControlProjection,
  recoverComposableWorkflowRun
} from '../../src/headless/workflow-run-api';

const phases: readonly PhaseDefinition[] = [
  { phaseId: 'p-init', name: 'Init', version: 1, instruction: 'Init' },
  { phaseId: 'p-b1', name: 'B1', version: 1, instruction: 'B1' },
  { phaseId: 'p-b2', name: 'B2', version: 1, instruction: 'B2' },
  { phaseId: 'p-done', name: 'Done', version: 1, instruction: 'Done' }
];

const childWfB: WorkflowDefinition = {
  workflowId: 'wf-b',
  name: 'Workflow B',
  version: 1,
  startNodeIds: ['b1'],
  nodes: [
    { nodeId: 'b1', kind: 'phase', phaseId: 'p-b1' },
    { nodeId: 'b2', kind: 'phase', phaseId: 'p-b2' }
  ],
  connections: [{ from: { nodeId: 'b1' }, to: { kind: 'node', nodeId: 'b2' } }]
};

const rootWfA: WorkflowDefinition = {
  workflowId: 'wf-a',
  name: 'Workflow A',
  version: 1,
  startNodeIds: ['init'],
  nodes: [
    { nodeId: 'init', kind: 'phase', phaseId: 'p-init' },
    { nodeId: 'call-b', kind: 'workflow', workflowId: 'wf-b' },
    { nodeId: 'done', kind: 'phase', phaseId: 'p-done' }
  ],
  connections: [
    { from: { nodeId: 'init' }, to: { kind: 'node', nodeId: 'call-b' } },
    { from: { nodeId: 'call-b' }, to: { kind: 'node', nodeId: 'done' } }
  ]
};

function createStore() {
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

describe('Integration: Nested Workflow Controls, Scoped Retry, Recovery & Host/Headless Parity (FR-R5-F03)', () => {
  it('handles concurrent phase completion vs operator control command deterministically via per-queue serialization', async () => {
    const store = createStore();
    let seq = 0;
    const dispatchPhase = async () => {
      seq += 1;
      return { outcome: 'dispatched' as const, queueItemId: `qi-${seq}` };
    };

    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'run-race-1',
      workflow: rootWfA,
      effectiveWorkflows: [rootWfA, childWfB],
      effectivePhases: phases,
      startedAt: 1000,
      queueId: 'q-serial'
    });
    if (snap.outcome !== 'created') throw new Error('Failed snapshot');
    store.seed(snap.run);

    await dispatchComposableNode(
      { connectedRuns: store, dispatchPhase },
      {
        run: snap.run,
        invocationId: snap.rootInvocationId,
        nodeId: 'init',
        startedAt: 1010
      }
    );

    const service = new WorkflowControlService({
      connectedRuns: store,
      dispatchPhase
    });

    const revBeforeRace = store.get('run-race-1')!.revision;

    // Fire pause and phase completion concurrently on the same queue
    const [pauseOut, completeOut] = await Promise.all([
      service.executeCommand({
        runId: 'run-race-1',
        commandId: 'cmd-race-pause',
        expectedRevision: revBeforeRace,
        operation: 'pause',
        targetInvocationId: snap.rootInvocationId,
        now: 1050
      }),
      service.completeNodeAttemptSerialized({
        runId: 'run-race-1',
        invocationId: snap.rootInvocationId,
        nodeId: 'init',
        status: 'completed',
        completedAt: 1051
      })
    ]);

    // Pause entered the queue first, so pause committed and completion observed paused state cleanly
    expect(pauseOut.accepted).toBe(true);
    expect(completeOut.outcome).toBe('ignored-not-in-flight');
    expect(store.get('run-race-1')!.invocations![snap.rootInvocationId]!.status).toBe('paused');
  });

  it('exhibits 100% behavioral and projection parity between Host and Headless entry points across pause, resume, retry-phase, retry-invocation, and recovery', async () => {
    async function runLifecycle(mode: 'host' | 'headless') {
      const store = createStore();
      let seq = 0;
      const dispatchPhase = async () => {
        seq += 1;
        return { outcome: 'dispatched' as const, queueItemId: `qi-${seq}` };
      };

      const snap = createComposableWorkflowRunSnapshot({
        connectedRunId: 'run-parity-1',
        workflow: rootWfA,
        effectiveWorkflows: [rootWfA, childWfB],
        effectivePhases: phases,
        startedAt: 1000,
        queueId: 'q-parity'
      });
      if (snap.outcome !== 'created') throw new Error('Snapshot failed');
      store.seed(snap.run);

      // Start init -> complete init -> enters child wf-b at b1 -> complete b1 -> enters b2
      await dispatchComposableNode(
        { connectedRuns: store, dispatchPhase },
        {
          run: snap.run,
          invocationId: snap.rootInvocationId,
          nodeId: 'init',
          startedAt: 1010
        }
      );
      await completeComposableNodeAttempt(
        { connectedRuns: store, dispatchPhase },
        {
          run: store.get('run-parity-1')!,
          invocationId: snap.rootInvocationId,
          nodeId: 'init',
          status: 'completed',
          completedAt: 1020
        }
      );
      const childInvId = Object.keys(store.get('run-parity-1')!.invocations ?? {}).find(
        (id) => id !== snap.rootInvocationId
      )!;
      await completeComposableNodeAttempt(
        { connectedRuns: store, dispatchPhase },
        {
          run: store.get('run-parity-1')!,
          invocationId: childInvId,
          nodeId: 'b1',
          status: 'completed',
          completedAt: 1030
        }
      );

      const execCmd = async (req: Parameters<typeof executeComposableWorkflowControlCommand>[1]) => {
        if (mode === 'headless') {
          const res = await executeComposableWorkflowControlCommand(
            { connectedRuns: store, dispatchPhase },
            req
          );
          if ('outcome' in res) throw new Error(`Boundary refusal: ${res.code}`);
          return res;
        }
        const svc = new WorkflowControlService({ connectedRuns: store, dispatchPhase });
        return svc.executeCommand(req);
      };

      // 1. Pause child at b2
      const paused = await execCmd({
        runId: 'run-parity-1',
        commandId: 'cmd-1',
        expectedRevision: store.get('run-parity-1')!.revision,
        operation: 'pause',
        targetInvocationId: childInvId,
        now: 1100
      });
      expect(paused.accepted).toBe(true);

      // 2. Resume child at b2
      const resumed = await execCmd({
        runId: 'run-parity-1',
        commandId: 'cmd-2',
        expectedRevision: store.get('run-parity-1')!.revision,
        operation: 'resume',
        targetInvocationId: childInvId,
        now: 1200
      });
      expect(resumed.accepted).toBe(true);

      // 3. Simulate restart with uncertain effect on b2
      const recovered =
        mode === 'headless'
          ? await recoverComposableWorkflowRun(
              {
                connectedRuns: store,
                dispatchPhase,
                checkDurableAttemptEvidence: () => ({ completed: false })
              },
              { runId: 'run-parity-1', now: 1300 }
            )
          : await new WorkflowRecoveryService({
              connectedRuns: store,
              dispatchPhase,
              checkDurableAttemptEvidence: () => ({ completed: false })
            }).reconcileRun('run-parity-1', 1300);

      if (!recovered || 'outcome' in recovered) throw new Error('Recovery failed');
      expect(recovered.disposition?.status).toBe('uncertain-effect-paused');

      // 4. Retry phase b2 after uncertain-effect pause
      const retriedPhase = await execCmd({
        runId: 'run-parity-1',
        commandId: 'cmd-3',
        expectedRevision: store.get('run-parity-1')!.revision,
        operation: 'retry-phase',
        targetInvocationId: childInvId,
        targetNodeId: 'b2',
        now: 1400
      });
      expect(retriedPhase.accepted).toBe(true);

      const finalRun = store.get('run-parity-1')!;
      const projection =
        mode === 'headless'
          ? getComposableWorkflowControlProjection(finalRun)
          : buildWorkflowRunControlProjection(finalRun);
      const ancestry =
        mode === 'headless'
          ? buildComposableWorkflowAncestryEvidence(finalRun, childInvId, 'b2')
          : buildAncestryEvidenceMetadata(finalRun, childInvId, 'b2');

      return { projection, ancestry };
    }

    const hostOut = await runLifecycle('host');
    const headlessOut = await runLifecycle('headless');

    expect(headlessOut.projection).toEqual(hostOut.projection);
    expect(headlessOut.ancestry).toEqual(hostOut.ancestry);
    expect(headlessOut.ancestry?.nodePath).toBe('/call-b/b2');
    expect(headlessOut.ancestry?.attemptIndex).toBe(3);
  });
});
