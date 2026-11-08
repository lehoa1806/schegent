import { describe, expect, it } from 'vitest';
import type { ExecutionFence } from '../../src/contracts/control-ledger';
import { ControlAttemptAdmissionService } from '../../src/services/workflow-execution/control-attempt-admission';
import { ControlLedgerStore } from '../../src/services/workflow-execution/control-ledger-store';
import { startPhaseNodeRun } from '../../src/services/workflow-execution/node-run-starter';
import type { Memento } from '../../src/state/workspace-state';

function createMemoryMemento(): Memento {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    update(key: string, value: unknown): Thenable<void> {
      if (value === undefined) map.delete(key);
      else map.set(key, JSON.parse(JSON.stringify(value)));
      return Promise.resolve();
    }
  };
}

describe('Control admission execution fence & primacy enforcement (FR-R5-F26 / SPEC-04 / Rule 4)', () => {
  it('rejects commitAttempt, recordSpawnIntent, and child spawn when primacyClaim, queueClaim, or rootGeneration is superseded', async () => {
    const m = createMemoryMemento();
    const ledgerStore = new ControlLedgerStore(m);

    let liveFence: ExecutionFence = {
      primacyClaim: 'window-A',
      queueClaim: 'lease-q1-gen1',
      rootGeneration: 1
    };

    const admission = new ControlAttemptAdmissionService({
      ledgerStore,
      verifyLiveFence: (fence) =>
        fence.primacyClaim === liveFence.primacyClaim &&
        fence.queueClaim === liveFence.queueClaim &&
        fence.rootGeneration === liveFence.rootGeneration
    });

    const staleWindowFence: ExecutionFence = { ...liveFence };

    await admission.prepareRootLink({
      ledgerRunId: 'ledger-primacy-1',
      connectedRunId: 'crun-primacy-1',
      rootWorkflowId: 'wf-1',
      queueId: 'q1',
      fence: staleWindowFence
    });
    await admission.activateRootLink({
      ledgerRunId: 'ledger-primacy-1',
      connectedRunId: 'crun-primacy-1',
      fence: staleWindowFence
    });

    // Window A prepares an attempt while still holding the fence
    const preparedByA = await admission.prepareAttempt({
      ledgerRunId: 'ledger-primacy-1',
      connectedRunId: 'crun-primacy-1',
      queueId: 'q1',
      frameKey: 'root',
      workflowId: 'wf-1',
      invocationId: 'crun-primacy-1:root',
      nodeId: 'n1',
      attemptId: 'att-1',
      backend: 'claude',
      fence: staleWindowFence
    });
    expect(preparedByA.ok).toBe(true);
    if (!preparedByA.ok) return;

    // Window B takes over primacy and advances rootGeneration to 2 via reconciliation
    liveFence = {
      primacyClaim: 'window-B',
      queueClaim: 'lease-q1-gen2',
      rootGeneration: 2
    };
    const takeover = await admission.reconcileControlRoot({
      ledgerRunId: 'ledger-primacy-1',
      connectedRun: null,
      newFence: liveFence
    });
    expect(takeover.ok).toBe(true);

    // Window A tries to commit its prepared token with the superseded fence -> rejected!
    const staleCommit = await admission.commitAttempt(preparedByA.token);
    expect(staleCommit.ok).toBe(false);
    if (!staleCommit.ok) {
      expect(staleCommit.code).toBe('stale-execution-fence');
    }
    expect(ledgerStore.getRoot('ledger-primacy-1')?.dispatchedAttempts).toBe(0);

    // Window B prepares and commits an attempt under the live fence
    const preparedByB = await admission.prepareAttempt({
      ledgerRunId: 'ledger-primacy-1',
      connectedRunId: 'crun-primacy-1',
      queueId: 'q1',
      frameKey: 'root',
      workflowId: 'wf-1',
      invocationId: 'crun-primacy-1:root',
      nodeId: 'n1',
      attemptId: 'att-b-1',
      backend: 'claude',
      fence: liveFence
    });
    expect(preparedByB.ok).toBe(true);
    if (!preparedByB.ok) return;

    const commitByB = await admission.commitAttempt(preparedByB.token);
    expect(commitByB.ok).toBe(true);

    // Now suppose Window B loses queue lease before startPhaseNodeRun spawns the child
    liveFence = {
      primacyClaim: 'window-C',
      queueClaim: 'lease-q1-gen3',
      rootGeneration: 3
    };

    let scheduleCalled = false;
    const spawnResult = await startPhaseNodeRun(
      {
        logger: { warn: () => undefined, sanitize: (s) => String(s) },
        recordControlSpawnIntent: async (req) => {
          const res = await admission.recordSpawnIntent(req);
          return res.ok ? { ok: true } : { ok: false, message: res.code };
        },
        guardedRun: {
          scheduleOrEnqueue: async () => {
            scheduleCalled = true;
            return {
              outcome: 'enqueued',
              requestId: 'q-item-1',
              startedImmediately: true
            };
          }
        }
      },
      {
        frozenClosure: {
          rootWorkflowId: 'wf-1',
          entryNodeId: 'n1',
          workflowsById: {},
          phasesById: {
            'phase-1': {
              phaseId: 'phase-1',
              name: 'Phase 1',
              version: 1,
              runner: 'claude',
              instruction: 'Do work'
            }
          },
          definitionDigestsById: {},
          closureMetrics: { maxDepth: 1, definitionCount: 2, expandedNodeCount: 1 }
        },
        phaseId: 'phase-1',
        request: {
          pipelineId: 'phase-1',
          inputs: [],
          supplemental: [],
          outputs: []
        },
        workspaceRoot: '/tmp/ws',
        queueId: 'q1',
        ledgerRunId: 'ledger-primacy-1',
        fence: preparedByB.token.fence,
        occurrence: {
          rootRunId: 'crun-primacy-1',
          invocationId: 'crun-primacy-1:root',
          parentInvocationId: null,
          nodePath: 'root/n1',
          attemptId: 'att-b-1',
          attemptIndex: 1
        }
      }
    );

    expect(spawnResult.outcome).toBe('rejected-queue');
    expect(scheduleCalled).toBe(false);
  });
});
