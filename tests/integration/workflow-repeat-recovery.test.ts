import { describe, expect, it } from 'vitest';
import type { Memento } from '../../src/state/workspace-state';
import type { ExecutionFence } from '../../src/contracts/control-ledger';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import type { ConnectedWorkflowRun } from '../../src/state/connected-workflow-run';
import { createComposableWorkflowRunSnapshot } from '../../src/services/workflow-execution/connected-run-factory';
import {
  completeComposableNodeAttempt,
  dispatchComposableNode,
  type ComposableWorkflowCoordinatorDeps
} from '../../src/services/workflow-execution/connected-run-coordinator';
import {
  RepeatExecutor,
  buildRepeatFrameKey,
  type RepeatCrashPoint
} from '../../src/services/workflow-execution/repeat-executor';
import {
  ControlLedgerStore,
  lookupRecord
} from '../../src/services/workflow-execution/control-ledger-store';
import {
  WorkflowRecoveryService,
  type WorkflowRecoveryStore
} from '../../src/services/workflow-execution/workflow-recovery-service';
import { projectConnectedRun } from '../../src/ui/sidebar/connected-run-projector';
import { buildRepeatNodeProjection } from '../../src/services/workflow-execution/workflow-control-projector';
import { parseDocumentBytes } from '../../src/services/process-yaml/yaml-parser';
import {
  documentFromWorkflowDefinition,
  parseWorkflowPackage,
  serializeWorkflowDocument
} from '../../src/services/process-yaml/workflow-document';

function makeMemoryMemento(): Memento {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return map.has(key) ? (map.get(key) as T) : defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) map.delete(key);
      else map.set(key, structuredClone(value));
    }
  };
}

function makeFence(rootGeneration = 1): ExecutionFence {
  return {
    primacyClaim: 'primacy-1',
    queueClaim: 'queue-1',
    rootGeneration
  };
}

function makeInMemoryRunStore(initialRun: ConnectedWorkflowRun): {
  readonly store: WorkflowRecoveryStore;
  readonly currentRun: () => ConnectedWorkflowRun;
  readonly writeCurrentRun: (next: ConnectedWorkflowRun) => void;
} {
  let current = initialRun;
  const store: WorkflowRecoveryStore = {
    get(connectedRunId: string) {
      return current.connectedRunId === connectedRunId ? current : null;
    },
    list() {
      return [current];
    },
    async compareAndSetConnectedRun(next: ConnectedWorkflowRun, _expectedRevision: number) {
      current = { ...next, revision: current.revision + 1 };
      return { outcome: 'written' as const, run: current };
    }
  };
  return {
    store,
    currentRun: () => current,
    writeCurrentRun: (next) => {
      current = next;
    }
  };
}

const REVIEW_PHASE: PhaseDefinition = {
  phaseId: 'phase-review',
  name: 'Review Phase',
  version: 1,
  runner: 'claude',
  instruction: 'Review the draft and emit structured approval',
  resultContract: {
    version: 1,
    operator: 'structured-result',
    operatorVersion: 1,
    source: { kind: 'declared-output', outputKey: 'report' },
    fields: [
      { fieldId: 'approved', type: 'boolean', required: true, selector: ['approved'] },
      { fieldId: 'score', type: 'number', required: true, selector: ['score'] },
      { fieldId: 'nextFeedback', type: 'string', required: false, selector: ['nextFeedback'] }
    ],
    completion: {
      version: 1,
      kind: 'typed',
      test: {
        left: { source: 'result-field', fieldId: 'approved' },
        operator: 'equals',
        right: true
      }
    }
  }
};

const CHILD_REVIEW_WORKFLOW: WorkflowDefinition = {
  workflowId: 'wf-child-review',
  name: 'Child Review Workflow',
  version: 1,
  inputs: [
    { portId: 'feedback', label: 'Feedback', type: 'text', required: true },
    { portId: 'attempt-note', label: 'Attempt Note', type: 'text', required: false }
  ],
  outputs: [
    {
      portId: 'review-report',
      label: 'Review Report',
      type: 'markdown',
      required: true
    }
  ],
  nodes: [
    {
      nodeId: 'node-review-phase',
      kind: 'phase',
      phaseId: 'phase-review'
    }
  ],
  connections: [],
  bindings: [
    {
      kind: 'input',
      nodeId: 'node-review-phase',
      inputKey: 'feedback',
      type: 'text',
      required: true,
      source: { from: 'workflow-input', portId: 'feedback' }
    },
    {
      kind: 'output',
      nodeId: 'node-review-phase',
      portId: 'review-report',
      outputKey: 'report',
      type: 'markdown'
    }
  ],
  startNodeIds: ['node-review-phase'],
  decisionResults: {
    version: 1,
    fields: [
      { fieldId: 'approved', type: 'boolean', required: true },
      { fieldId: 'score', type: 'number', required: true },
      { fieldId: 'nextFeedback', type: 'string', required: false }
    ],
    bindings: [
      { fieldId: 'approved', source: { kind: 'node-result', nodeId: 'node-review-phase', fieldId: 'approved' } },
      { fieldId: 'score', source: { kind: 'node-result', nodeId: 'node-review-phase', fieldId: 'score' } },
      { fieldId: 'nextFeedback', source: { kind: 'node-result', nodeId: 'node-review-phase', fieldId: 'nextFeedback' } }
    ]
  }
};

const PARENT_REPEAT_WORKFLOW: WorkflowDefinition = {
  workflowId: 'wf-parent-repeat',
  name: 'Parent Repeat Workflow',
  version: 1,
  inputs: [
    { portId: 'initial-feedback', label: 'Initial Feedback', type: 'text', required: true }
  ],
  outputs: [
    {
      portId: 'final-report',
      label: 'Final Report',
      type: 'markdown',
      required: true
    }
  ],
  nodes: [
    {
      nodeId: 'node-repeat-review',
      kind: 'workflow',
      workflowId: 'wf-child-review',
      control: {
        version: 1,
        kind: 'repeat',
        maxIterations: 3,
        until: {
          version: 1,
          kind: 'typed',
          test: {
            left: { source: 'result-field', fieldId: 'approved' },
            operator: 'equals',
            right: true
          }
        },
        carry: [
          { fieldId: 'nextFeedback', inputPortId: 'feedback' },
          { fieldId: 'score', inputPortId: 'attempt-note' }
        ],
        onExhausted: 'pause'
      }
    }
  ],
  connections: [],
  bindings: [
    {
      kind: 'input',
      nodeId: 'node-repeat-review',
      inputKey: 'feedback',
      type: 'text',
      required: true,
      source: { from: 'workflow-input', portId: 'initial-feedback' }
    },
    {
      kind: 'output',
      nodeId: 'node-repeat-review',
      portId: 'final-report',
      outputKey: 'review-report',
      type: 'markdown'
    }
  ],
  startNodeIds: ['node-repeat-review']
};

async function seedLedgerRoot(
  ledgerStore: ControlLedgerStore,
  rootRunId: string,
  _rootInvocationId: string,
  fence: ExecutionFence,
  nowWallMs: number
): Promise<void> {
  await ledgerStore.mutate({}, ({ ledger }) => ({
    commit: true,
    plan: {
      result: undefined,
      nextLedger: {
        ...ledger,
        roots: {
          ...ledger.roots,
          [rootRunId]: {
            version: 1,
            ledgerRunId: rootRunId,
            connectedRunId: rootRunId,
            rootWorkflowId: PARENT_REPEAT_WORKFLOW.workflowId,
            queueId: 'default',
            linkState: 'active',
            status: 'in-flight',
            fence,
            rootBudget: { version: 1, maxPhaseAttempts: 100 },
            dispatchedAttempts: 0,
            settledMicrousd: 0,
            reservedMicrousd: 0,
            framesByKey: {},
            attemptsById: {},
            notificationsById: {},
            decisionSummaries: [],
            createdAt: nowWallMs,
            updatedAt: nowWallMs
          }
        }
      }
    }
  }));
}

function makeInitialRun(nowWallMs: number): {
  readonly run: ConnectedWorkflowRun;
  readonly rootInvocationId: string;
} {
  const created = createComposableWorkflowRunSnapshot({
    connectedRunId: 'conn-repeat-1',
    queueId: 'default',
    workflow: PARENT_REPEAT_WORKFLOW,
    effectiveWorkflows: [PARENT_REPEAT_WORKFLOW, CHILD_REVIEW_WORKFLOW],
    effectivePhases: [REVIEW_PHASE],
    boundInputs: {
      'initial-feedback': {
        portId: 'initial-feedback',
        type: 'text',
        value: 'First draft feedback'
      }
    },
    startedAt: nowWallMs
  });
  if (created.outcome !== 'created') {
    throw new Error(`Failed to create composable workflow run: ${created.reason} - ${created.detail}`);
  }
  return { run: created.run, rootInvocationId: created.rootInvocationId };
}

describe('Workflow Repeat Integration & Recovery (FR-R5-F33 / SPEC-11)', () => {
  it('executes multi-pass Repeat loop through coordinator, carrying overrides into pass 2 and exporting only accepted pass outputs', async () => {
    let wallMs = 1_700_000_000_000;
    let queueCounter = 0;
    const clock = {
      nowWallMs: () => wallMs,
      nowMonotonicMs: () => wallMs,
      hostEpoch: 'epoch-1'
    };
    const ledgerStore = new ControlLedgerStore(makeMemoryMemento());
    const repeatExecutor = new RepeatExecutor({ ledgerStore, clock });
    const fence = makeFence(1);

    const init = makeInitialRun(wallMs);
    const runStore = makeInMemoryRunStore(init.run);
    const rootInvocationId = init.rootInvocationId;
    await seedLedgerRoot(ledgerStore, init.run.connectedRunId, rootInvocationId, fence, wallMs);

    const coordDeps: ComposableWorkflowCoordinatorDeps = {
      connectedRuns: runStore.store,
      dispatchPhase: async () => ({
        outcome: 'dispatched',
        queueItemId: `q-item-${++queueCounter}`
      }),
      repeatExecutor,
      resolveExecutionFence: () => fence
    };

    // Dispatch Repeat node -> initializes Repeat frame at pass 1 and dispatches child workflow entry phase
    const dispatchPass1 = await dispatchComposableNode(coordDeps, {
      run: runStore.currentRun(),
      invocationId: rootInvocationId,
      nodeId: 'node-repeat-review',
      startedAt: wallMs
    });
    expect(dispatchPass1.outcome).toBe('phase-dispatched');
    if (dispatchPass1.outcome !== 'phase-dispatched') return;

    const pass1ChildFrame = lookupRecord(dispatchPass1.run.invocations ?? {}, dispatchPass1.invocationId);
    expect(lookupRecord(pass1ChildFrame?.boundInputs ?? {}, 'feedback')?.value).toBe('First draft feedback');

    // Complete pass 1 leaf phase with approved=false, score=65, nextFeedback='Refine section 2'
    wallMs += 1_000;
    const completePass1 = await completeComposableNodeAttempt(coordDeps, {
      run: runStore.currentRun(),
      invocationId: dispatchPass1.invocationId,
      nodeId: 'node-review-phase',
      status: 'completed',
      completedAt: wallMs,
      declaredOutputs: {
        report: {
          portId: 'report',
          type: 'markdown',
          value: 'Pass 1 rejected report'
        }
      },
      decisionResults: {
        approved: false,
        score: 65,
        nextFeedback: 'Refine section 2'
      }
    });

    // Pass 1 evaluates Until=false and automatically advances + dispatches Pass 2
    expect(completePass1.outcome).toBe('phase-dispatched');
    if (completePass1.outcome !== 'phase-dispatched') return;
    const pass2ChildInvocationId = completePass1.invocationId;
    expect(pass2ChildInvocationId).not.toBe(dispatchPass1.invocationId);

    const pass2ChildFrame = lookupRecord(completePass1.run.invocations ?? {}, pass2ChildInvocationId);
    expect(lookupRecord(pass2ChildFrame?.boundInputs ?? {}, 'feedback')?.value).toBe('Refine section 2');
    expect(lookupRecord(pass2ChildFrame?.boundInputs ?? {}, 'attempt-note')?.value).toBe('65');

    // Verify Repeat projection during Pass 2 shows Pass 2 of 3 and 2 leaf attempts
    const loadedDuringPass2 = ledgerStore.read();
    const rootDuringPass2 = loadedDuringPass2.ok
      ? lookupRecord(loadedDuringPass2.ledger.roots, completePass1.run.connectedRunId)
      : undefined;
    const projDuringPass2 = projectConnectedRun(completePass1.run, () => null);
    const repeatNodeProjPass2 = buildRepeatNodeProjection(
      completePass1.run,
      'node-repeat-review',
      rootDuringPass2
    );
    expect(
      projDuringPass2.nodes.find((n) => n.nodeId === 'node-repeat-review')?.repeatProjection
    ).toBeDefined();
    expect(repeatNodeProjPass2).toBeDefined();
    expect(repeatNodeProjPass2?.currentPass).toBe(2);
    expect(repeatNodeProjPass2?.maxIterations).toBe(3);
    expect(repeatNodeProjPass2?.leafAttemptCount).toBe(2);
    expect(repeatNodeProjPass2?.conditionResult).toBe('false');
    expect(repeatNodeProjPass2?.carryValues).toEqual({
      nextFeedback: 'Refine section 2',
      score: 65
    });
    expect(repeatNodeProjPass2?.completedPasses).toHaveLength(1);
    expect(repeatNodeProjPass2?.completedPasses[0]?.iteration).toBe(1);

    // Complete Pass 2 leaf phase with approved=true, score=95
    wallMs += 1_000;
    const completePass2 = await completeComposableNodeAttempt(coordDeps, {
      run: runStore.currentRun(),
      invocationId: pass2ChildInvocationId,
      nodeId: 'node-review-phase',
      status: 'completed',
      completedAt: wallMs,
      declaredOutputs: {
        report: {
          portId: 'report',
          type: 'markdown',
          value: 'Pass 2 accepted final report'
        }
      },
      decisionResults: {
        approved: true,
        score: 95,
        nextFeedback: 'Approved'
      }
    });

    expect(completePass2.outcome).toBe('workflow-completed');
    if (completePass2.outcome !== 'workflow-completed') return;
    expect(lookupRecord(completePass2.outputs, 'final-report')?.value).toBe('Pass 2 accepted final report');

    const loadedFinal = ledgerStore.read();
    const rootFinal = loadedFinal.ok
      ? lookupRecord(loadedFinal.ledger.roots, completePass2.run.connectedRunId)
      : undefined;
    const repeatFrameKey = buildRepeatFrameKey(rootInvocationId, 'node-repeat-review');
    const repeatFrameFinal = lookupRecord(rootFinal?.framesByKey ?? {}, repeatFrameKey);
    expect(repeatFrameFinal?.status).toBe('completed');
    expect(repeatFrameFinal?.repeatState?.conditionResult).toBe('true');
    expect(repeatFrameFinal?.repeatState?.completedPasses).toHaveLength(2);
  });

  it('recovers across all 4 crash points without replaying completed passes', async () => {
    const crashPoints: readonly RepeatCrashPoint[] = [
      'before-child-return',
      'after-child-return-before-eval',
      'after-eval-before-advance',
      'after-advance-commit'
    ];

    for (const targetCrashPoint of crashPoints) {
      let wallMs = 1_700_000_000_000;
      let queueCounter = 0;
      const clock = {
        nowWallMs: () => wallMs,
        nowMonotonicMs: () => wallMs,
        hostEpoch: 'epoch-1'
      };
      const ledgerStore = new ControlLedgerStore(makeMemoryMemento());
      let shouldCrash = true;
      const repeatExecutor = new RepeatExecutor({
        ledgerStore,
        clock,
        crashHook: (point) => {
          if (shouldCrash && point === targetCrashPoint) {
            throw new Error(`simulated-crash:${point}`);
          }
        }
      });
      const fence = makeFence(1);

      const init = makeInitialRun(wallMs);
      const runStore = makeInMemoryRunStore(init.run);
      const rootInvocationId = init.rootInvocationId;
      await seedLedgerRoot(ledgerStore, init.run.connectedRunId, rootInvocationId, fence, wallMs);

      const coordDeps: ComposableWorkflowCoordinatorDeps = {
        connectedRuns: runStore.store,
        dispatchPhase: async () => ({
          outcome: 'dispatched',
          queueItemId: `q-${++queueCounter}`
        }),
        repeatExecutor,
        resolveExecutionFence: () => fence
      };

      const dispatchPass1 = await dispatchComposableNode(coordDeps, {
        run: runStore.currentRun(),
        invocationId: rootInvocationId,
        nodeId: 'node-repeat-review',
        startedAt: wallMs
      });
      expect(dispatchPass1.outcome).toBe('phase-dispatched');
      if (dispatchPass1.outcome !== 'phase-dispatched') continue;

      const pass1ChildInvocationId = dispatchPass1.invocationId;

      // Attempt completion crashes at targetCrashPoint
      wallMs += 1_000;
      await expect(
        completeComposableNodeAttempt(coordDeps, {
          run: runStore.currentRun(),
          invocationId: pass1ChildInvocationId,
          nodeId: 'node-review-phase',
          status: 'completed',
          completedAt: wallMs,
          declaredOutputs: {
            report: { portId: 'report', type: 'markdown', value: 'Pass 1 report' }
          },
          decisionResults: {
            approved: false,
            score: 70,
            nextFeedback: `Recovered after ${targetCrashPoint}`
          }
        })
      ).rejects.toThrow(`simulated-crash:${targetCrashPoint}`);

      // Disable crash hook on restart and reconcile through WorkflowRecoveryService
      shouldCrash = false;
      const recoveryExecutor = new RepeatExecutor({ ledgerStore, clock });
      const recoveryService = new WorkflowRecoveryService({
        connectedRuns: runStore.store,
        dispatchPhase: async () => ({
          outcome: 'dispatched',
          queueItemId: `q-rec-${++queueCounter}`
        }),
        checkDurableAttemptEvidence: () => ({
          completed: true,
          status: 'completed',
          completedAt: wallMs + 500,
          declaredOutputs: {
            report: { portId: 'report', type: 'markdown', value: 'Pass 1 report' }
          },
          decisionResults: {
            approved: false,
            score: 70,
            nextFeedback: `Recovered after ${targetCrashPoint}`
          }
        }),
        repeatExecutor: recoveryExecutor,
        resolveRecoveryFence: () => fence
      });

      const recResult = await recoveryService.reconcileRun(
        init.run.connectedRunId,
        wallMs + 1_000
      );
      expect(recResult).toBeDefined();

      // Verify Pass 1 is recorded in completedPasses once (never replayed) and Pass 2 is active
      const loaded = ledgerStore.read();
      const root = loaded.ok ? lookupRecord(loaded.ledger.roots, init.run.connectedRunId) : undefined;
      const repeatFrameKey = buildRepeatFrameKey(rootInvocationId, 'node-repeat-review');
      const repeatFrame = lookupRecord(root?.framesByKey ?? {}, repeatFrameKey);
      expect(repeatFrame?.repeatState?.currentPass).toBe(2);
      expect(repeatFrame?.repeatState?.completedPasses).toHaveLength(1);
      expect(repeatFrame?.repeatState?.completedPasses?.[0]?.iteration).toBe(1);
      expect(repeatFrame?.repeatState?.carryValues?.nextFeedback).toBe(
        `Recovered after ${targetCrashPoint}`
      );
    }
  });

  it('reconciles a crash where child frame already completed on disk before parent Repeat node advanced', async () => {
    const wallMs = 1_700_000_000_000;
    let queueCounter = 0;
    const clock = {
      nowWallMs: () => wallMs,
      nowMonotonicMs: () => wallMs,
      hostEpoch: 'epoch-1'
    };
    const ledgerStore = new ControlLedgerStore(makeMemoryMemento());
    const repeatExecutor = new RepeatExecutor({ ledgerStore, clock });
    const fence = makeFence(1);

    const init = makeInitialRun(wallMs);
    const runStore = makeInMemoryRunStore(init.run);
    const rootInvocationId = init.rootInvocationId;
    await seedLedgerRoot(ledgerStore, init.run.connectedRunId, rootInvocationId, fence, wallMs);

    const coordDeps: ComposableWorkflowCoordinatorDeps = {
      connectedRuns: runStore.store,
      dispatchPhase: async () => ({
        outcome: 'dispatched',
        queueItemId: `q-${++queueCounter}`
      }),
      repeatExecutor,
      resolveExecutionFence: () => fence
    };

    const dispatchPass1 = await dispatchComposableNode(coordDeps, {
      run: runStore.currentRun(),
      invocationId: rootInvocationId,
      nodeId: 'node-repeat-review',
      startedAt: wallMs
    });
    expect(dispatchPass1.outcome).toBe('phase-dispatched');
    if (dispatchPass1.outcome !== 'phase-dispatched') return;

    const pass1ChildId = dispatchPass1.invocationId;
    const currentRun = runStore.currentRun();
    const childFrame = currentRun.invocations![pass1ChildId]!;
    const leafAttempts = childFrame.attemptsByNodeId['node-review-phase'] ?? [];
    const settledLeafAttempts = leafAttempts.map((a) => ({
      ...a,
      status: 'completed' as const,
      completedAt: wallMs + 500,
      declaredOutputs: {
        report: {
          portId: 'report',
          type: 'markdown' as const,
          value: 'Accepted on pass 1'
        }
      }
    }));

    const completedChildFrame = {
      ...childFrame,
      status: 'completed' as const,
      completedAt: wallMs + 500,
      activeNodeId: null,
      attemptsByNodeId: {
        ...childFrame.attemptsByNodeId,
        'node-review-phase': settledLeafAttempts
      },
      resolvedOutputs: {
        'review-report': {
          portId: 'review-report',
          type: 'markdown' as const,
          value: 'Accepted on pass 1'
        }
      }
    };
    runStore.writeCurrentRun({
      ...currentRun,
      invocations: {
        ...currentRun.invocations,
        [pass1ChildId]: completedChildFrame
      }
    });

    // Record child pass decisionResults in ledger
    await ledgerStore.mutate({ expectedFence: fence }, ({ ledger }) => {
      const root = lookupRecord(ledger.roots, currentRun.connectedRunId)!;
      return {
        commit: true,
        plan: {
          result: undefined,
          nextLedger: {
            ...ledger,
            roots: {
              ...ledger.roots,
              [currentRun.connectedRunId]: {
                ...root,
                framesByKey: {
                  ...root.framesByKey,
                  [pass1ChildId]: {
                    frameKey: pass1ChildId,
                    parentFrameKey: rootInvocationId,
                    invocationId: pass1ChildId,
                    workflowId: CHILD_REVIEW_WORKFLOW.workflowId,
                    kind: 'child-workflow',
                    status: 'completed',
                    createdAt: wallMs,
                    updatedAt: wallMs + 500,
                    dispatchedCount: 1,
                    decisionResults: {
                      approved: true,
                      score: 100
                    }
                  }
                }
              }
            }
          }
        }
      };
    });

    const recoveryService = new WorkflowRecoveryService({
      connectedRuns: runStore.store,
      dispatchPhase: async () => ({
        outcome: 'dispatched',
        queueItemId: `q-${++queueCounter}`
      }),
      repeatExecutor,
      resolveRecoveryFence: () => fence
    });

    const reconciled = await recoveryService.reconcileRun(
      currentRun.connectedRunId,
      wallMs + 1_000
    );

    expect(reconciled?.disposition?.reasonCode).toBe('repeat-post-pass-reconciled');
    const rootFrame = reconciled?.run.invocations?.[rootInvocationId];
    expect(rootFrame?.status).toBe('completed');
    expect(rootFrame?.resolvedOutputs['final-report']?.value).toBe('Accepted on pass 1');
  });

  it('supports candidate-block body recovery inside a Repeat pass without resetting the Repeat pass counter', async () => {
    const wallMs = 1_700_000_000_000;
    const clock = {
      nowWallMs: () => wallMs,
      nowMonotonicMs: () => wallMs,
      hostEpoch: 'epoch-1'
    };
    const ledgerStore = new ControlLedgerStore(makeMemoryMemento());
    const repeatExecutor = new RepeatExecutor({ ledgerStore, clock });
    const fence = makeFence(1);

    const candidateChildWorkflow: WorkflowDefinition = {
      ...CHILD_REVIEW_WORKFLOW,
      control: {
        version: 1,
        kind: 'candidate-block',
        candidates: [
          { candidateId: 'cand-primary', nodeId: 'node-review-phase', priority: 1, maxAttempts: 2 }
        ]
      },
      decisionResults: {
        version: 1,
        fields: [
          { fieldId: 'approved', type: 'boolean', required: true },
          { fieldId: 'score', type: 'number', required: true }
        ],
        bindings: [
          { fieldId: 'approved', source: { kind: 'selected-candidate', fieldId: 'approved' } },
          { fieldId: 'score', source: { kind: 'selected-candidate', fieldId: 'score' } }
        ]
      }
    };

    const init = makeInitialRun(wallMs);
    const run = init.run;
    const rootInvocationId = init.rootInvocationId;
    await seedLedgerRoot(ledgerStore, run.connectedRunId, rootInvocationId, fence, wallMs);

    await repeatExecutor.initializeRepeatFrame({
      rootRunId: run.connectedRunId,
      parentInvocationId: rootInvocationId,
      workflowId: PARENT_REPEAT_WORKFLOW.workflowId,
      nodeId: 'node-repeat-review',
      control: {
        version: 1,
        kind: 'repeat',
        maxIterations: 3,
        until: {
          version: 1,
          kind: 'typed',
          test: {
            left: { source: 'result-field', fieldId: 'approved' },
            operator: 'equals',
            right: true
          }
        },
        carry: [],
        onExhausted: 'pause'
      },
      initialChildInvocationId: 'child-pass-1',
      initialBoundInputs: {},
      fence
    });

    // Pass 1 completes with approved=false -> advances to Pass 2
    const pass1Settle = await repeatExecutor.settleRepeatPass({
      rootRunId: run.connectedRunId,
      parentInvocationId: rootInvocationId,
      nodeId: 'node-repeat-review',
      childInvocationId: 'child-pass-1',
      passStatus: 'completed',
      control: {
        version: 1,
        kind: 'repeat',
        maxIterations: 3,
        until: {
          version: 1,
          kind: 'typed',
          test: {
            left: { source: 'result-field', fieldId: 'approved' },
            operator: 'equals',
            right: true
          }
        },
        carry: [],
        onExhausted: 'pause'
      },
      childWorkflow: candidateChildWorkflow,
      initialBoundInputs: {},
      decisionResults: { approved: false, score: 40 },
      allocateNextChildInvocationId: () => 'child-pass-2',
      fence
    });
    expect(pass1Settle.action.kind).toBe('advance-next-pass');

    // Inside Pass 2, candidate-block pauses waiting on availability; Repeat pass remains 2 and Pass 1 is not replayed
    const loadedDuringPause = ledgerStore.read();
    const rootDuringPause = loadedDuringPause.ok
      ? lookupRecord(loadedDuringPause.ledger.roots, run.connectedRunId)
      : undefined;
    const repeatFrameDuringPause = lookupRecord(
      rootDuringPause?.framesByKey ?? {},
      buildRepeatFrameKey(rootInvocationId, 'node-repeat-review')
    );
    expect(repeatFrameDuringPause?.repeatState?.currentPass).toBe(2);
    expect(repeatFrameDuringPause?.repeatState?.completedPasses).toHaveLength(1);

    // Candidate in Pass 2 wins and records decisionResults on its candidate attempt
    await ledgerStore.mutate({ expectedFence: fence }, ({ ledger }) => {
      const root = lookupRecord(ledger.roots, run.connectedRunId)!;
      return {
        commit: true,
        plan: {
          result: undefined,
          nextLedger: {
            ...ledger,
            roots: {
              ...ledger.roots,
              [run.connectedRunId]: {
                ...root,
                framesByKey: {
                  ...root.framesByKey,
                  'child-pass-2': {
                    frameKey: 'child-pass-2',
                    parentFrameKey: rootInvocationId,
                    invocationId: 'child-pass-2',
                    workflowId: candidateChildWorkflow.workflowId,
                    kind: 'candidate-block',
                    status: 'completed',
                    createdAt: wallMs,
                    updatedAt: wallMs,
                    dispatchedCount: 1,
                    selectedCandidateId: 'cand-primary'
                  }
                },
                attemptsById: {
                  ...root.attemptsById,
                  'att-cand-pass-2': {
                    attemptId: 'att-cand-pass-2',
                    ledgerRunId: run.connectedRunId,
                    connectedRunId: run.connectedRunId,
                    queueId: 'default',
                    frameKey: 'child-pass-2',
                    invocationId: 'child-pass-2',
                    nodeId: 'node-review-phase',
                    attemptIndex: 1,
                    candidateId: 'cand-primary',
                    backend: 'claude',
                    stage: 'settled',
                    terminalStatus: 'completed',
                    reservedMicrousd: 0,
                    committedAt: wallMs,
                    settledAt: wallMs,
                    fence,
                    decisionResults: { approved: true, score: 98 }
                  }
                }
              }
            }
          }
        }
      };
    });

    const pass2Settle = await repeatExecutor.settleRepeatPass({
      rootRunId: run.connectedRunId,
      parentInvocationId: rootInvocationId,
      nodeId: 'node-repeat-review',
      childInvocationId: 'child-pass-2',
      passStatus: 'completed',
      control: {
        version: 1,
        kind: 'repeat',
        maxIterations: 3,
        until: {
          version: 1,
          kind: 'typed',
          test: {
            left: { source: 'result-field', fieldId: 'approved' },
            operator: 'equals',
            right: true
          }
        },
        carry: [],
        onExhausted: 'pause'
      },
      childWorkflow: candidateChildWorkflow,
      initialBoundInputs: {},
      fence
    });
    expect(pass2Settle.action).toEqual({
      kind: 'accepted-return',
      iteration: 2,
      acceptedInvocationId: 'child-pass-2',
      exportedOutputs: {},
      decisionResults: { approved: true, score: 98 }
    });
  });

  it('round-trips RepeatControl through YAML export and import without loss', () => {
    const doc = documentFromWorkflowDefinition(PARENT_REPEAT_WORKFLOW, {
      workflows: [CHILD_REVIEW_WORKFLOW],
      phases: [REVIEW_PHASE]
    });
    const yamlText = serializeWorkflowDocument(doc);
    const parsedBytes = parseDocumentBytes(Buffer.from(yamlText, 'utf8'));
    expect(parsedBytes.ok).toBe(true);
    if (!parsedBytes.ok) return;
    const pkg = parseWorkflowPackage(parsedBytes.node);
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    const rootRes = pkg.resources.at(0);
    expect(rootRes?.ok).toBe(true);
    if (!rootRes?.ok || rootRes.resourceKind !== 'workflow') return;
    const repeatNode = rootRes.definition.nodes.find((n) => n.nodeId === 'node-repeat-review');
    expect(repeatNode?.control).toEqual(PARENT_REPEAT_WORKFLOW.nodes.at(0)?.control);
  });
});
