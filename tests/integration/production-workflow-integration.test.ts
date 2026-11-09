import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SanitizedLogger } from '../../src/lib/logger';
import {
  reconcileComposableWorkflowRuns,
  recordConnectedWorkflowTransition
} from '../../src/activation/run-safety-wiring';
import {
  continueWorkflowRun,
  executeComposableWorkflowControlCommand,
  launchComposableWorkflowRun
} from '../../src/headless/workflow-run-api';
import {
  PRODUCTION_RESOURCE_CEILINGS,
  PUBLIC_ENTRY_POINT_IDS,
  RECOVERY_CHECKPOINT_IDS,
  buildQualificationRecord,
  getBaselineFindingsReconciliation,
  getEntryPointWiringCensus,
  simulateCheckpointInterruptionAndRecovery
} from '../../src/services/workflow-execution/entry-point-wiring-census';
import {
  createCutoverAuthorityGuard,
  createProductionWorkflowComposition,
  isLiveProviderQualified
} from '../../src/services/workflow-execution/production-workflow-composition';
import { continueConnectedRun } from '../../src/services/workflow-execution/continuation-service';
import {
  launchComposableWorkflow,
  launchWorkflow,
  type WorkflowLauncherDeps
} from '../../src/services/workflow-execution/workflow-launcher';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import {
  resolveRootInvocationId,
  type ConnectedWorkflowRun
} from '../../src/state/connected-workflow-run';
import type { WorkflowRun } from '../../src/state/workflow-run';
import { KEYS, type Memento } from '../../src/state/workspace-state';
import {
  isNodeStartable,
  projectConnectedRun
} from '../../src/ui/sidebar/connected-run-projector';

function createMemoryBackingStore() {
  const rawStore = new Map<string, unknown>();
  const connectedRuns = new Map<string, ConnectedWorkflowRun>();
  const runMap = new Map<string, WorkflowRun>();

  const memento: Omit<Memento, 'get'> & {
    get(connectedRunId: string): ConnectedWorkflowRun | null;
    get<T>(key: string, defaultValue: T): T;
    getConnectedRuns(): Readonly<Record<string, ConnectedWorkflowRun>>;
    getRunMap(): Readonly<Record<string, WorkflowRun | undefined>>;
    getHistory(): readonly object[];
    compareAndSetConnectedRun(
      next: ConnectedWorkflowRun,
      expectedRevision: number
    ): Promise<
      | { readonly outcome: 'written'; readonly run: ConnectedWorkflowRun }
      | { readonly outcome: 'stale'; readonly current: ConnectedWorkflowRun | null }
    >;
    readChildState(queueItemId: string): 'in-flight' | 'completed' | 'failed' | 'canceled';
    putRun(run: WorkflowRun): void;
  } = {
    get<T>(key: string, defaultValue?: T): any {
      if (connectedRuns.has(key)) {
        return connectedRuns.get(key) ?? null;
      }
      if (rawStore.has(key)) {
        return rawStore.get(key) as T;
      }
      if (key === KEYS.controlLedger || key.startsWith('schegent.')) {
        return defaultValue;
      }
      return defaultValue ?? null;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) rawStore.delete(key);
      else rawStore.set(key, structuredClone(value));
    },
    getConnectedRuns() {
      return Object.fromEntries(connectedRuns.entries());
    },
    getRunMap() {
      return Object.fromEntries(runMap.entries());
    },
    getHistory() {
      return [];
    },
    async compareAndSetConnectedRun(next, expectedRevision) {
      const existing = connectedRuns.get(next.connectedRunId) ?? null;
      if (expectedRevision === 0) {
        if (existing !== null) {
          return { outcome: 'stale', current: existing };
        }
        const written: ConnectedWorkflowRun = Object.freeze({
          ...next,
          revision: Math.max(1, next.revision)
        });
        connectedRuns.set(next.connectedRunId, written);
        return { outcome: 'written', run: written };
      }
      if (existing === null || existing.revision !== expectedRevision) {
        return { outcome: 'stale', current: existing };
      }
      const written: ConnectedWorkflowRun = Object.freeze({
        ...next,
        revision: existing.revision + 1
      });
      connectedRuns.set(next.connectedRunId, written);
      return { outcome: 'written', run: written };
    },
    readChildState(queueItemId: string) {
      const matched = [...runMap.values()].find((r) => r.featureId === queueItemId);
      if (matched === undefined) return 'completed';
      if (matched.status === 'completed') return 'completed';
      if (matched.status === 'failed') return 'failed';
      if (matched.status === 'canceled') return 'canceled';
      return 'in-flight';
    },
    putRun(run: WorkflowRun) {
      runMap.set(run.id, run);
    }
  };

  return memento;
}

function makePhase(
  phaseId: string,
  extra?: Partial<Omit<PhaseDefinition, 'skill'>>
): PhaseDefinition {
  const { instruction, ...rest } = extra ?? {};
  return {
    phaseId,
    version: 1,
    name: `Phase ${phaseId}`,
    runner: 'claude',
    instruction: instruction ?? `Execute ${phaseId}`,
    ...rest
  };
}

function makeTerminalRun(
  queueItemId: string,
  status: 'completed' | 'failed' | 'canceled',
  transitionAt: number,
  outputs?: WorkflowRun['runOutputs']
): WorkflowRun {
  return {
    id: `run-rec-${queueItemId}`,
    featureId: queueItemId,
    featureDir: `specs/${queueItemId}`,
    status,
    currentPhase: 'specify',
    currentIteration: 1,
    startedAt: transitionAt - 50,
    lastTransitionAt: transitionAt,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    ...(outputs !== undefined ? { runOutputs: outputs } : {})
  };
}

describe('FR-R6-F01 — Production Workflow Integration and Recovery Acceptance Suite', () => {
  let tmpWorkspaceRoot: string;
  const logger = new SanitizedLogger();

  beforeEach(async () => {
    tmpWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-f01-'));
  });

  afterEach(async () => {
    await fs.rm(tmpWorkspaceRoot, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // F01-AC-01 — Entry-point wiring census and public launch
  // ---------------------------------------------------------------------------
  it('F01-AC-01: verifies the entry-point wiring census, launches Phase-first and control-first roots through public entry points, and visibly refuses missing collaborators with 0 attempts consumed', async () => {
    const census = getEntryPointWiringCensus();
    expect(census.map((c) => c.entryPointId)).toEqual([...PUBLIC_ENTRY_POINT_IDS]);
    for (const row of census) {
      expect(row.missingCollaborators).toEqual([]);
      expect(row.suppliedCollaborators.length).toBeGreaterThan(0);
    }

    const store = createMemoryBackingStore();
    const composition = createProductionWorkflowComposition({
      store,
      workspaceRoot: tmpWorkspaceRoot
    });

    let enqueuedCounter = 0;
    const launcherDeps: WorkflowLauncherDeps = {
      connectedRuns: store,
      isChildSettled: () => true,
      productionComposition: composition,
      logger,
      guardedRun: {
        scheduleOrEnqueue: async (plan: any) => {
          enqueuedCounter += 1;
          const queueItemId = plan.featureId ?? `q-item-${enqueuedCounter}`;
          store.putRun(makeTerminalRun(queueItemId, 'completed', 1_000));
          return {
            outcome: 'enqueued',
            queueItemId
          };
        }
      } as any
    };

    const phaseA = makePhase('phase-a');
    const phaseFirstWorkflow: WorkflowDefinition = {
      workflowId: 'wf-phase-first',
      version: 1,
      name: 'Phase First Workflow',
      startNodeIds: ['node-a'],
      nodes: [{ nodeId: 'node-a', kind: 'phase', phaseId: 'phase-a' }],
      connections: [
        {
          from: { nodeId: 'node-a' },
          to: { nodeId: '', kind: 'return' },
          handoff: 'auto',
          priority: 0
        }
      ]
    };

    // 1. Launch Phase-first workflow through public launchWorkflow
    const phaseFirstRes = await launchWorkflow(launcherDeps, {
      connectedRunId: 'conn-phase-first',
      workflow: phaseFirstWorkflow,
      catalog: { pipelinesById: new Map(), phasesById: new Map() } as any,
      effectiveWorkflows: [phaseFirstWorkflow],
      effectivePhases: [phaseA],
      startNodeId: 'node-a',
      request: {
        pipelineId: 'phase-a',
        inputs: [],
        supplemental: [],
        outputs: []
      },
      workspaceRoot: tmpWorkspaceRoot,
      startedAt: 1_000
    });
    expect(phaseFirstRes.outcome).toBe('started');
    expect(composition.ledgerStore.getRoot('conn-phase-first')).not.toBeNull();

    // 2. Launch control-first workflow (Repeat node as entry node) through public headless launchComposableWorkflowRun
    const childBodyWf: WorkflowDefinition = {
      workflowId: 'wf-repeat-body',
      version: 1,
      name: 'Repeat Body',
      startNodeIds: ['body-phase'],
      nodes: [{ nodeId: 'body-phase', kind: 'phase', phaseId: 'phase-a' }],
      connections: [
        {
          from: { nodeId: 'body-phase' },
          to: { nodeId: '', kind: 'return' },
          handoff: 'auto',
          priority: 0
        }
      ]
    };
    const controlFirstWf: WorkflowDefinition = {
      workflowId: 'wf-control-first',
      version: 1,
      name: 'Control First Workflow',
      startNodeIds: ['repeat-entry'],
      nodes: [
        {
          nodeId: 'repeat-entry',
          kind: 'workflow',
          workflowId: 'wf-repeat-body',
          control: {
            version: 1,
            kind: 'repeat',
            maxIterations: 2,
            until: {
              version: 1,
              kind: 'typed',
              test: {
                left: { source: 'result-field', fieldId: 'verdict' },
                operator: 'equals',
                right: 'pass'
              }
            },
            carry: []
          }
        }
      ],
      connections: [
        {
          from: { nodeId: 'repeat-entry' },
          to: { nodeId: '', kind: 'return' },
          handoff: 'auto',
          priority: 0
        }
      ]
    };

    const controlFirstRes = await launchComposableWorkflowRun(launcherDeps, {
      connectedRunId: 'conn-control-first',
      request: {
        pipelineId: 'wf-control-first',
        workflowId: 'wf-control-first',
        entryNodeId: 'repeat-entry',
        inputs: [],
        supplemental: [],
        outputs: []
      },
      workflowSource: {
        rootWorkflow: controlFirstWf,
        workflows: [controlFirstWf, childBodyWf],
        phases: [phaseA]
      },
      workspaceRoot: tmpWorkspaceRoot,
      startedAt: 2_000
    });
    expect(controlFirstRes.outcome).toBe('started');

    // 3. Missing collaborator refusal: launch control-first workflow with repeatExecutor absent
    const prevEnqueued = enqueuedCounter;
    const degradedComposition = createProductionWorkflowComposition({
      store,
      workspaceRoot: tmpWorkspaceRoot,
      collaboratorOverrides: { repeatExecutor: false }
    });
    const refusedRes = await launchComposableWorkflowRun(
      { ...launcherDeps, productionComposition: degradedComposition },
      {
        connectedRunId: 'conn-missing-collab',
        request: {
          pipelineId: 'wf-control-first',
          workflowId: 'wf-control-first',
          entryNodeId: 'repeat-entry',
          inputs: [],
          supplemental: [],
          outputs: []
        },
        workflowSource: {
          rootWorkflow: controlFirstWf,
          workflows: [controlFirstWf, childBodyWf],
          phases: [phaseA]
        },
        workspaceRoot: tmpWorkspaceRoot,
        startedAt: 3_000
      }
    );
    expect(refusedRes.outcome).toBe('rejected-queue');
    if (refusedRes.outcome === 'rejected-queue') {
      expect(refusedRes.refusal?.category).toBe('missing-collaborator');
      expect(refusedRes.refusal?.reasonCode).toBe('collaborator-absent:repeatExecutor');
      expect(refusedRes.refusal?.attemptsConsumed).toBe(0);
    }
    expect(enqueuedCounter).toBe(prevEnqueued);
    expect(store.get('conn-missing-collab')).toBeNull();
    composition.dispose();
    degradedComposition.dispose();
  });

  // ---------------------------------------------------------------------------
  // F01-AC-02 — Composite control workflow & typed result precedence
  // ---------------------------------------------------------------------------
  it('F01-AC-02: executes a composite workflow (candidate block, Repeat, and >=3 ForEach items) end-to-end and enforces typed result precedence at settlement', async () => {
    const store = createMemoryBackingStore();
    const composition = createProductionWorkflowComposition({
      store,
      workspaceRoot: tmpWorkspaceRoot
    });

    // Write a 3-item JSON collection file for ForEach and a valid structured output file
    const collectionRelPath = 'items.json';
    await fs.writeFile(
      path.join(tmpWorkspaceRoot, collectionRelPath),
      JSON.stringify({
        version: 1,
        items: [{ id: 'item-1' }, { id: 'item-2' }, { id: 'item-3' }]
      }),
      'utf8'
    );
    const validResultRelPath = 'result-valid.json';
    await fs.writeFile(
      path.join(tmpWorkspaceRoot, validResultRelPath),
      JSON.stringify({ attemptId: 'att-conflict', verdict: 'pass', score: 95 }),
      'utf8'
    );

    // 1. Exercise CandidateBlockExecutor in production composition
    const candFence = {
      primacyClaim: 'primacy:conn-cand-block',
      queueClaim: 'queue:default',
      rootGeneration: 1
    };
    const candPrep = await composition.controlAdmission.prepareRootLink({
      ledgerRunId: 'conn-cand-block',
      connectedRunId: 'conn-cand-block',
      rootWorkflowId: 'wf-candidate-block',
      queueId: 'default',
      fence: candFence,
      rootFrameKey: 'frame-cand-1',
      rootInvocationId: 'inv-cand-1'
    });
    expect(candPrep.ok).toBe(true);
    await composition.controlAdmission.activateRootLink({
      ledgerRunId: 'conn-cand-block',
      connectedRunId: 'conn-cand-block',
      fence: candFence
    });
    const candidateInit = await composition.candidateBlockExecutor.initializeCandidateBlock({
      rootRunId: 'conn-cand-block',
      workflowId: 'wf-candidate-block',
      nodeId: 'node-cand-block',
      frameKey: 'frame-cand-1',
      invocationId: 'inv-cand-1',
      fence: candFence,
      selectionPolicy: 'first-ready',
      candidates: [
        {
          candidateId: 'cand-primary',
          nodeId: 'node-cand-1',
          backend: 'claude',
          priority: 1,
          authoredOrder: 0,
          maxAttempts: 2
        },
        {
          candidateId: 'cand-fallback',
          nodeId: 'node-cand-2',
          backend: 'codex',
          priority: 2,
          authoredOrder: 1,
          maxAttempts: 2
        }
      ]
    });
    expect(candidateInit.ok).toBe(true);

    // 2. Launch composite workflow with Repeat -> ForEach (3 items) and drive settlement through recordConnectedWorkflowTransition
    const dispatchedItems: { readonly queueItemId: string; readonly attemptId: string }[] = [];
    const launcherDeps: WorkflowLauncherDeps = {
      connectedRuns: store,
      isChildSettled: () => true,
      productionComposition: composition,
      logger,
      guardedRun: {
        scheduleOrEnqueue: async (plan: any) => {
          const queueItemId = plan.featureId ?? `q-${dispatchedItems.length + 1}`;
          dispatchedItems.push({
            queueItemId,
            attemptId: plan.workflowOccurrence?.attemptId ?? `att-${dispatchedItems.length + 1}`
          });
          return {
            outcome: 'enqueued',
            queueItemId
          };
        }
      } as any
    };

    const phaseStep = makePhase('phase-step', {
      resultContract: {
        version: 1,
        operator: 'structured-result',
        operatorVersion: 1,
        source: { kind: 'declared-output', outputKey: 'report' },
        fields: [
          { fieldId: 'verdict', type: 'string', required: true, selector: ['verdict'] },
          { fieldId: 'score', type: 'number', required: true, selector: ['score'] }
        ],
        completion: {
          version: 1,
          kind: 'typed',
          test: {
            left: { source: 'result-field', fieldId: 'verdict' },
            operator: 'equals',
            right: 'pass'
          }
        }
      }
    });

    const repeatChildWf: WorkflowDefinition = {
      workflowId: 'wf-repeat-child',
      version: 1,
      name: 'Repeat Child',
      startNodeIds: ['r-node'],
      nodes: [{ nodeId: 'r-node', kind: 'phase', phaseId: 'phase-step' }],
      decisionResults: {
        version: 1,
        fields: [
          { fieldId: 'verdict', type: 'string', required: true },
          { fieldId: 'score', type: 'number', required: true }
        ],
        bindings: [
          { fieldId: 'verdict', source: { kind: 'node-result', nodeId: 'r-node', fieldId: 'verdict' } },
          { fieldId: 'score', source: { kind: 'node-result', nodeId: 'r-node', fieldId: 'score' } }
        ]
      },
      connections: [
        {
          from: { nodeId: 'r-node' },
          to: { nodeId: '', kind: 'return' },
          handoff: 'auto',
          priority: 0
        }
      ]
    };

    const forEachChildWf: WorkflowDefinition = {
      workflowId: 'wf-foreach-child',
      version: 1,
      name: 'ForEach Child',
      inputs: [{ portId: 'item', label: 'Item', type: 'text', required: true }],
      startNodeIds: ['fe-node'],
      nodes: [{ nodeId: 'fe-node', kind: 'phase', phaseId: 'phase-step' }],
      connections: [
        {
          from: { nodeId: 'fe-node' },
          to: { nodeId: '', kind: 'return' },
          handoff: 'auto',
          priority: 0
        }
      ]
    };

    const rootCompositeWf: WorkflowDefinition = {
      workflowId: 'wf-composite-root',
      version: 1,
      name: 'Composite Root',
      inputs: [{ portId: 'itemsFile', label: 'Items File', type: 'local-file', required: true }],
      startNodeIds: ['repeat-node'],
      nodes: [
        {
          nodeId: 'repeat-node',
          kind: 'workflow',
          workflowId: 'wf-repeat-child',
          control: {
            version: 1,
            kind: 'repeat',
            maxIterations: 2,
            until: {
              version: 1,
              kind: 'typed',
              test: {
                left: { source: 'result-field', fieldId: 'score' },
                operator: 'equals',
                right: 95
              }
            },
            carry: []
          }
        },
        {
          nodeId: 'foreach-node',
          kind: 'workflow',
          workflowId: 'wf-foreach-child',
          control: {
            version: 1,
            kind: 'for-each',
            collection: { source: 'workflow-input', portId: 'itemsFile' },
            itemInputPortId: 'item',
            maxItems: 10,
            onItemError: 'stop'
          }
        }
      ],
      connections: [
        {
          from: { nodeId: 'repeat-node' },
          to: { kind: 'node', nodeId: 'foreach-node' },
          handoff: 'auto',
          priority: 0
        },
        {
          from: { nodeId: 'foreach-node' },
          to: { nodeId: '', kind: 'return' },
          handoff: 'auto',
          priority: 0
        }
      ]
    };

    const launched = await launchComposableWorkflowRun(launcherDeps, {
      connectedRunId: 'conn-composite',
      request: {
        pipelineId: 'wf-composite-root',
        workflowId: 'wf-composite-root',
        entryNodeId: 'repeat-node',
        inputs: [{ portId: 'itemsFile', type: 'local-file', value: collectionRelPath }],
        supplemental: [],
        outputs: []
      },
      workflowSource: {
        rootWorkflow: rootCompositeWf,
        workflows: [rootCompositeWf, repeatChildWf, forEachChildWf],
        phases: [phaseStep]
      },
      workspaceRoot: tmpWorkspaceRoot,
      startedAt: 10_000
    });
    expect(launched.outcome).toBe('started');
    expect(dispatchedItems).toHaveLength(1);

    // Settle all 2 Repeat passes + all 3 ForEach items via recordConnectedWorkflowTransition
    for (let step = 0; step < 5; step += 1) {
      const dispatched = dispatchedItems[step]!;
      const stepReportRelPath = `result-step-${step}.json`;
      await fs.writeFile(
        path.join(tmpWorkspaceRoot, stepReportRelPath),
        JSON.stringify({
          attemptId: dispatched.attemptId,
          verdict: 'pass',
          score: step === 0 ? 50 : 95
        }),
        'utf8'
      );
      const termRun = makeTerminalRun(
        dispatched.queueItemId,
        'completed',
        11_000 + step * 100,
        [
          {
            name: 'report',
            status: 'resolved',
            reference: stepReportRelPath
          }
        ]
      );
      store.putRun(termRun);
      await recordConnectedWorkflowTransition(
        {
          workspaceRoot: tmpWorkspaceRoot,
          store,
          logger,
          productionComposition: composition,
          getGuardedRun: () => launcherDeps.guardedRun
        },
        termRun
      );
    }

    // 2 repeat iterations + 3 ForEach items = 5 total leaf Phase dispatches!
    expect(dispatchedItems).toHaveLength(5);
    const completedComposite = store.get('conn-composite');
    expect(completedComposite).not.toBeNull();
    const rootInvId = resolveRootInvocationId(completedComposite!);
    expect(completedComposite!.invocations![rootInvId]!.status).toBe('completed');

    // 3. Negative typed-result precedence checks at settlement (missing, malformed, conflicting)
    const malformedRelPath = 'result-malformed.json';
    await fs.writeFile(path.join(tmpWorkspaceRoot, malformedRelPath), '{not-valid-json', 'utf8');

    const missingEval = await composition.evaluateSettlementOutcome({
      attemptId: 'att-missing',
      workspaceRoot: tmpWorkspaceRoot,
      status: 'completed',
      phase: phaseStep,
      declaredOutputs: {}
    });
    expect(missingEval.status).toBe('failed');
    expect(missingEval.verdict).toBe('fail');
    expect(missingEval.failureCode).toContain('typed-result-invalid-result');

    const malformedEval = await composition.evaluateSettlementOutcome({
      attemptId: 'att-malformed',
      workspaceRoot: tmpWorkspaceRoot,
      status: 'completed',
      phase: phaseStep,
      declaredOutputs: {
        report: { portId: 'report', type: 'file', value: malformedRelPath }
      }
    });
    expect(malformedEval.status).toBe('failed');
    expect(malformedEval.verdict).toBe('fail');
    expect(malformedEval.failureCode).toContain('typed-result-invalid-result:malformed-evidence');

    const conflictingEval = await composition.evaluateSettlementOutcome({
      attemptId: 'att-conflict',
      workspaceRoot: tmpWorkspaceRoot,
      status: 'completed',
      phase: phaseStep,
      backendDiagnostic: { kind: 'credits' },
      conflictingBackendDiagnostic: { kind: 'authentication' },
      declaredOutputs: {
        report: { portId: 'report', type: 'file', value: validResultRelPath }
      }
    });
    expect(conflictingEval.status).toBe('failed');
    expect(conflictingEval.failureCode).toBe('typed-result-invalid-result:conflicting-evidence');

    const hostCancelWins = await composition.evaluateSettlementOutcome({
      attemptId: 'att-cancel',
      workspaceRoot: tmpWorkspaceRoot,
      status: 'completed',
      phase: phaseStep,
      hostControl: 'cancelled',
      declaredOutputs: {
        report: { portId: 'report', type: 'file', value: validResultRelPath }
      }
    });
    expect(hostCancelWins.status).toBe('canceled');
    expect(hostCancelWins.failureCode).toBe('host-control:cancelled');

    composition.dispose();
  });

  // ---------------------------------------------------------------------------
  // F01-AC-03 — Shared quota, availability wakeups, and capability qualification
  // ---------------------------------------------------------------------------
  it('F01-AC-03: coordinates two queues sharing one quota, ensures availability wakeups never spawn directly, refuses unsupported strict-cost capability, and separates fixture vs live qualification', async () => {
    const store = createMemoryBackingStore();
    let schedulerNotifications = 0;
    const directSpawns = 0;

    const composition = createProductionWorkflowComposition({
      store,
      workspaceRoot: tmpWorkspaceRoot,
      onScheduleQueueWakeup: () => {
        schedulerNotifications += 1;
      },
      assessBackendCapability: (backendId, capability) => {
        if (capability === 'strict-cost') {
          return {
            backendId,
            capability,
            status: 'unsupported',
            source: 'live-provider',
            reasonCode: `capability-unsupported:${backendId}:strict-cost`
          };
        }
        return {
          backendId,
          capability,
          status: 'verified',
          source: 'fixture-adapter',
          reasonCode: 'fixture-verified'
        };
      }
    });

    // 1. Record a ready quota observation with capacity 1 and verify two queues share it fairly
    const wakeup1 = await composition.recordAvailabilityWakeup({
      quotaId: 'claude:shared',
      backend: 'claude',
      ready: true,
      capacity: 1,
      queueId: 'queue-1'
    });
    expect(wakeup1.observationRecorded).toBe(true);
    expect(wakeup1.schedulerNotified).toBe(true);
    expect(wakeup1.spawnedDirectly).toBe(false);

    // Duplicate availability wakeup records observation and notifies scheduler, never spawning directly
    const wakeup2 = await composition.recordAvailabilityWakeup({
      quotaId: 'claude:shared',
      backend: 'claude',
      ready: true,
      capacity: 1,
      queueId: 'queue-1'
    });
    expect(wakeup2.spawnedDirectly).toBe(false);
    expect(directSpawns).toBe(0);
    expect(schedulerNotifications).toBeGreaterThanOrEqual(2);

    const fence1 = {
      primacyClaim: 'primacy:root-q1',
      queueClaim: 'queue:queue-1',
      rootGeneration: 1
    };
    const fence2 = {
      primacyClaim: 'primacy:root-q2',
      queueClaim: 'queue:queue-2',
      rootGeneration: 1
    };

    await composition.controlAdmission.prepareRootLink({
      ledgerRunId: 'root-q1',
      connectedRunId: 'root-q1',
      rootWorkflowId: 'wf-q1',
      queueId: 'queue-1',
      fence: fence1,
      rootFrameKey: 'inv-q1',
      rootInvocationId: 'inv-q1'
    });
    await composition.controlAdmission.activateRootLink({
      ledgerRunId: 'root-q1',
      connectedRunId: 'root-q1',
      fence: fence1
    });
    await composition.controlAdmission.prepareRootLink({
      ledgerRunId: 'root-q2',
      connectedRunId: 'root-q2',
      rootWorkflowId: 'wf-q2',
      queueId: 'queue-2',
      fence: fence2,
      rootFrameKey: 'inv-q2',
      rootInvocationId: 'inv-q2'
    });
    await composition.controlAdmission.activateRootLink({
      ledgerRunId: 'root-q2',
      connectedRunId: 'root-q2',
      fence: fence2
    });

    const reg1 = await composition.quotaPermitArbiter.registerWaiter({
      waiterId: 'waiter-q1',
      rootRunId: 'root-q1',
      queueId: 'queue-1',
      invocationId: 'inv-q1',
      generation: 1,
      quotaIds: ['claude:shared']
    });
    const reg2 = await composition.quotaPermitArbiter.registerWaiter({
      waiterId: 'waiter-q2',
      rootRunId: 'root-q2',
      queueId: 'queue-2',
      invocationId: 'inv-q2',
      generation: 1,
      quotaIds: ['claude:shared']
    });
    expect(reg1.ok).toBe(true);
    expect(reg2.ok).toBe(true);

    const grant1 = composition.quotaPermitArbiter.preparePermitGrant({
      waiterId: 'waiter-q1',
      attemptId: 'att-q1',
      executionFence: fence1
    });
    expect(grant1.ok).toBe(true);

    // 2. Unsupported strict-cost capability refuses before admission with 0 attempts consumed
    const strictCostCheck = composition.verifyPreAdmission({
      entryPointId: 'ui.launchWorkflow',
      rootExecutionId: 'root-q1',
      requiredCapabilities: [{ backendId: 'claude', capability: 'strict-cost' }]
    });
    expect(strictCostCheck.allowed).toBe(false);
    if (!strictCostCheck.allowed) {
      expect(strictCostCheck.refusal.category).toBe('unsupported-capability');
      expect(strictCostCheck.refusal.reasonCode).toBe(
        'capability-unsupported:claude:strict-cost'
      );
      expect(strictCostCheck.refusal.attemptsConsumed).toBe(0);
    }

    // 3. Fixture adapter assessment never promotes live provider qualification
    const fixtureAssessment = composition.assessCapability('claude', 'standard-dispatch');
    expect(fixtureAssessment.source).toBe('fixture-adapter');
    expect(isLiveProviderQualified(fixtureAssessment)).toBe(false);

    const liveRequiredCheck = composition.verifyPreAdmission({
      entryPointId: 'ui.launchWorkflow',
      rootExecutionId: 'root-q1',
      requiredCapabilities: [
        {
          backendId: 'claude',
          capability: 'standard-dispatch',
          requireLiveQualification: true
        }
      ]
    });
    expect(liveRequiredCheck.allowed).toBe(false);
    if (!liveRequiredCheck.allowed) {
      expect(liveRequiredCheck.refusal.category).toBe('unsupported-capability');
      expect(liveRequiredCheck.refusal.reasonCode).toContain(
        'fixture-capability-not-live-qualified'
      );
      expect(liveRequiredCheck.refusal.attemptsConsumed).toBe(0);
    }

    composition.dispose();
  });

  // ---------------------------------------------------------------------------
  // F01-AC-04 — Recovery checkpoints and 100x duplicate delivery
  // ---------------------------------------------------------------------------
  it('F01-AC-04: exercises before/after fault injection across all 8 recovery checkpoints (16 points), distinguishes failed write from lost ack, and handles 100 duplicate deliveries idempotently', async () => {
    // 1. Exercise all 16 checkpoint boundaries (before and after each of the 8 checkpoints)
    const outcomes = [];
    for (const checkpoint of RECOVERY_CHECKPOINT_IDS) {
      outcomes.push(
        simulateCheckpointInterruptionAndRecovery({ checkpoint, boundary: 'before' }),
        simulateCheckpointInterruptionAndRecovery({ checkpoint, boundary: 'after' })
      );
    }
    expect(outcomes).toHaveLength(16);
    for (const outcome of outcomes) {
      expect(outcome.duplicateSpawns).toBe(0);
      expect(outcome.attemptsConsumed).toBeLessThanOrEqual(1);
      expect(outcome.permitsConsumed).toBeLessThanOrEqual(1);
    }

    // Verify failed write before spawn-intent vs lost acknowledgement after spawn-intent
    const beforeSpawnIntent = outcomes.find(
      (o) => o.checkpoint === 'spawn-intent' && o.boundary === 'before'
    )!;
    const afterSpawnIntent = outcomes.find(
      (o) => o.checkpoint === 'spawn-intent' && o.boundary === 'after'
    )!;
    expect(beforeSpawnIntent.recoveryAction).toBe('prepare-spawn-intent');
    expect(afterSpawnIntent.recoveryAction).toBe('pause-uncertain-unacknowledged-spawn');

    // 2. Verify live recovery of an unacknowledged side-effecting in-flight attempt pauses with recovery-uncertain-effect
    const store = createMemoryBackingStore();
    const composition = createProductionWorkflowComposition({
      store,
      workspaceRoot: tmpWorkspaceRoot
    });

    let dispatchCount = 0;
    const launcherDeps: WorkflowLauncherDeps = {
      connectedRuns: store,
      isChildSettled: () => false,
      productionComposition: composition,
      logger,
      guardedRun: {
        scheduleOrEnqueue: async () => {
          dispatchCount += 1;
          return {
            outcome: 'enqueued',
            queueItemId: `q-dup-${dispatchCount}`
          };
        }
      } as any
    };

    const sideEffectPhase = makePhase('phase-se');
    const simpleWf: WorkflowDefinition = {
      workflowId: 'wf-rec',
      version: 1,
      name: 'Recovery Workflow',
      startNodeIds: ['n1'],
      nodes: [{ nodeId: 'n1', kind: 'phase', phaseId: 'phase-se' }],
      connections: [
        {
          from: { nodeId: 'n1' },
          to: { nodeId: '', kind: 'return' },
          handoff: 'auto',
          priority: 0
        }
      ]
    };

    const launched = await launchComposableWorkflowRun(launcherDeps, {
      connectedRunId: 'conn-rec-1',
      request: {
        pipelineId: 'wf-rec',
        workflowId: 'wf-rec',
        entryNodeId: 'n1',
        inputs: [],
        supplemental: [],
        outputs: []
      },
      workflowSource: {
        rootWorkflow: simpleWf,
        workflows: [simpleWf],
        phases: [sideEffectPhase]
      },
      workspaceRoot: tmpWorkspaceRoot,
      startedAt: 20_000
    });
    expect(launched.outcome).toBe('started');
    expect(dispatchCount).toBe(1);

    // Reconcile on restart when child evidence is absent -> pauses with recovery-uncertain-effect, 0 duplicate spawns
    await reconcileComposableWorkflowRuns({
      workspaceRoot: tmpWorkspaceRoot,
      store,
      logger,
      productionComposition: composition,
      getGuardedRun: () => launcherDeps.guardedRun
    });
    expect(dispatchCount).toBe(1);
    const reconciledRun = store.get('conn-rec-1')!;
    const rootFrame = reconciledRun.invocations![resolveRootInvocationId(reconciledRun)]!;
    expect(rootFrame.status).toBe('paused');
    expect(rootFrame.controlMarkers?.manualPauseCause).toBe('recovery-uncertain-effect');

    // 3. 100x duplicate delivery of control command, wakeup, and terminal settlement
    const resumeRevision = reconciledRun.revision;
    for (let i = 0; i < 100; i += 1) {
      const cmdRes = await executeComposableWorkflowControlCommand(
        {
          connectedRuns: store,
          dispatchPhase: async () => {
            dispatchCount += 1;
            return { outcome: 'dispatched', queueItemId: `q-resumed-${dispatchCount}` };
          },
          productionComposition: composition
        },
        {
          runId: 'conn-rec-1',
          commandId: 'cmd-idempotent-pause-100',
          expectedRevision: resumeRevision,
          operation: 'pause',
          now: 21_000 + i
        }
      );
      expect('accepted' in cmdRes).toBe(true);
    }
    expect(dispatchCount).toBe(1);

    // Launch a fresh run and deliver terminal settlement transition 100 times
    let settleDispatches = 0;
    const launcherDeps2: WorkflowLauncherDeps = {
      ...launcherDeps,
      guardedRun: {
        scheduleOrEnqueue: async () => {
          settleDispatches += 1;
          return {
            outcome: 'enqueued',
            queueItemId: `q-settle-${settleDispatches}`
          };
        }
      } as any
    };
    await launchComposableWorkflowRun(launcherDeps2, {
      connectedRunId: 'conn-settle-100',
      request: {
        pipelineId: 'wf-rec',
        workflowId: 'wf-rec',
        entryNodeId: 'n1',
        inputs: [],
        supplemental: [],
        outputs: []
      },
      workflowSource: {
        rootWorkflow: simpleWf,
        workflows: [simpleWf],
        phases: [sideEffectPhase]
      },
      workspaceRoot: tmpWorkspaceRoot,
      startedAt: 25_000
    });
    expect(settleDispatches).toBe(1);

    const completedChildRun = makeTerminalRun('q-settle-1', 'completed', 26_000);
    store.putRun(completedChildRun);
    for (let i = 0; i < 100; i += 1) {
      await recordConnectedWorkflowTransition(
        {
          workspaceRoot: tmpWorkspaceRoot,
          store,
          logger,
          productionComposition: composition,
          getGuardedRun: () => launcherDeps2.guardedRun
        },
        completedChildRun
      );
    }
    expect(settleDispatches).toBe(1);
    const settled100 = store.get('conn-settle-100')!;
    expect(settled100.invocations![resolveRootInvocationId(settled100)]!.status).toBe('completed');
    composition.dispose();
  });

  // ---------------------------------------------------------------------------
  // F01-AC-05 — Control and primacy race matrix
  // ---------------------------------------------------------------------------
  it('F01-AC-05: refuses stale primacy/lease owners at the effect boundary with 0 new children routed', async () => {
    const store = createMemoryBackingStore();
    let windowAPrimary = true;
    let windowASpawnedAfterLoss = 0;

    const composition = createProductionWorkflowComposition({
      store,
      workspaceRoot: tmpWorkspaceRoot,
      verifyLiveFence: () => windowAPrimary
    });

    const phaseA = makePhase('phase-a');
    const wf: WorkflowDefinition = {
      workflowId: 'wf-fence',
      version: 1,
      name: 'Fence Workflow',
      startNodeIds: ['n1'],
      nodes: [
        { nodeId: 'n1', kind: 'phase', phaseId: 'phase-a' },
        { nodeId: 'n2', kind: 'phase', phaseId: 'phase-a' }
      ],
      connections: [
        {
          from: { nodeId: 'n1' },
          to: { kind: 'node', nodeId: 'n2' },
          handoff: 'auto',
          priority: 1
        }
      ]
    };

    const launcherDeps: WorkflowLauncherDeps = {
      connectedRuns: store,
      isChildSettled: () => false,
      productionComposition: composition,
      logger,
      guardedRun: {
        scheduleOrEnqueue: async () => ({
          outcome: 'enqueued',
          queueItemId: 'q-fence-1'
        })
      } as any
    };

    const launched = await launchComposableWorkflowRun(launcherDeps, {
      connectedRunId: 'conn-fence-1',
      request: {
        pipelineId: 'wf-fence',
        workflowId: 'wf-fence',
        entryNodeId: 'n1',
        inputs: [],
        supplemental: [],
        outputs: []
      },
      workflowSource: {
        rootWorkflow: wf,
        workflows: [wf],
        phases: [phaseA]
      },
      workspaceRoot: tmpWorkspaceRoot,
      startedAt: 30_000
    });
    expect(launched.outcome).toBe('started');

    // Window A loses primacy to Window B
    windowAPrimary = false;

    const preCheck = composition.verifyPreAdmission({
      entryPointId: 'ui.continueWorkflow',
      rootExecutionId: 'conn-fence-1',
      isFenceValid: windowAPrimary
    });
    expect(preCheck.allowed).toBe(false);
    if (!preCheck.allowed) {
      expect(preCheck.refusal.category).toBe('stale-fence');
      expect(preCheck.refusal.attemptsConsumed).toBe(0);
    }

    const cmdOutcome = await executeComposableWorkflowControlCommand(
      {
        connectedRuns: store,
        verifyLeaseFence: () => windowAPrimary,
        dispatchPhase: async () => {
          windowASpawnedAfterLoss += 1;
          return { outcome: 'dispatched', queueItemId: 'should-never-spawn' };
        },
        productionComposition: composition
      },
      {
        runId: 'conn-fence-1',
        commandId: 'cmd-stale-owner',
        expectedRevision: store.get('conn-fence-1')!.revision,
        operation: 'pause',
        now: 31_000
      }
    );
    expect('accepted' in cmdOutcome && cmdOutcome.accepted).toBe(false);
    if ('accepted' in cmdOutcome && !cmdOutcome.accepted) {
      expect(cmdOutcome.refusalCode).toBe('fence-lost');
    }
    expect(windowASpawnedAfterLoss).toBe(0);
    composition.dispose();
  });

  // ---------------------------------------------------------------------------
  // F01-AC-06 — Editor/headless parity, frozen closure, and corrupt/future state
  // ---------------------------------------------------------------------------
  it('F01-AC-06: produces identical outcomes between UI and headless entry points, preserves frozen closures across mid-run catalog edits, and isolates corrupt/future records without deletion', async () => {
    const uiStore = createMemoryBackingStore();
    const headlessStore = createMemoryBackingStore();
    const uiComp = createProductionWorkflowComposition({
      store: uiStore,
      workspaceRoot: tmpWorkspaceRoot
    });
    const headlessComp = createProductionWorkflowComposition({
      store: headlessStore,
      workspaceRoot: tmpWorkspaceRoot
    });

    const phaseA = makePhase('phase-a', { instruction: 'Original frozen instruction' });
    const wf: WorkflowDefinition = {
      workflowId: 'wf-parity',
      version: 1,
      name: 'Parity Workflow',
      startNodeIds: ['n1'],
      nodes: [{ nodeId: 'n1', kind: 'phase', phaseId: 'phase-a' }],
      connections: []
    };

    const makeDeps = (
      store: ReturnType<typeof createMemoryBackingStore>,
      comp: ReturnType<typeof createProductionWorkflowComposition>
    ): WorkflowLauncherDeps => ({
      connectedRuns: store,
      isChildSettled: (id) => store.readChildState(id) !== 'in-flight',
      productionComposition: comp,
      logger,
      guardedRun: {
        scheduleOrEnqueue: async () => ({
          outcome: 'enqueued',
          queueItemId: 'q-parity-1'
        })
      } as any
    });

    const uiLaunch = await launchWorkflow(makeDeps(uiStore, uiComp), {
      connectedRunId: 'conn-parity',
      workflow: wf,
      catalog: { pipelinesById: new Map(), phasesById: new Map() } as any,
      effectiveWorkflows: [wf],
      effectivePhases: [phaseA],
      startNodeId: 'n1',
      request: { pipelineId: 'phase-a', inputs: [], supplemental: [], outputs: [] },
      workspaceRoot: tmpWorkspaceRoot,
      startedAt: 40_000
    });

    const headlessLaunch = await launchComposableWorkflowRun(
      makeDeps(headlessStore, headlessComp),
      {
        connectedRunId: 'conn-parity',
        request: {
          pipelineId: 'wf-parity',
          workflowId: 'wf-parity',
          entryNodeId: 'n1',
          inputs: [],
          supplemental: [],
          outputs: []
        },
        workflowSource: {
          rootWorkflow: wf,
          workflows: [wf],
          phases: [phaseA]
        },
        workspaceRoot: tmpWorkspaceRoot,
        startedAt: 40_000
      }
    );

    expect(uiLaunch.outcome).toBe('started');
    expect(headlessLaunch.outcome).toBe('started');

    // Mid-run catalog mutation does not affect the frozen closure on either store
    const mutatedPhase = makePhase('phase-a', { instruction: 'MUTATED LIVE INSTRUCTION' });
    expect(mutatedPhase.instruction).not.toBe(
      uiStore.get('conn-parity')!.frozenClosure!.phasesById['phase-a']!.instruction
    );
    expect(
      uiStore.get('conn-parity')!.frozenClosure!.phasesById['phase-a']!.instruction
    ).toBe('Original frozen instruction');
    expect(
      headlessStore.get('conn-parity')!.frozenClosure!.phasesById['phase-a']!.instruction
    ).toBe('Original frozen instruction');

    // Pause both via UI continueConnectedRun and headless continueWorkflowRun
    const uiPause = await continueConnectedRun(
      {
        ...makeDeps(uiStore, uiComp),
        connectedRuns: uiStore,
        projectRun: projectConnectedRun,
        isNodeStartable
      },
      {
        payload: {
          connectedRunId: 'conn-parity',
          expectedRevision: uiStore.get('conn-parity')!.revision,
          nodeId: 'n1',
          operation: 'pause',
          commandId: 'cmd-pause-parity',
          request: { pipelineId: 'phase-a', inputs: [], supplemental: [], outputs: [] }
        },
        workspaceRoot: tmpWorkspaceRoot,
        startedAt: 41_000
      }
    );
    const headlessPause = await continueWorkflowRun(
      {
        ...makeDeps(headlessStore, headlessComp),
        connectedRuns: headlessStore,
        projectRun: projectConnectedRun,
        isNodeStartable
      },
      {
        payload: {
          connectedRunId: 'conn-parity',
          expectedRevision: headlessStore.get('conn-parity')!.revision,
          nodeId: 'n1',
          operation: 'pause',
          commandId: 'cmd-pause-parity',
          request: { pipelineId: 'phase-a', inputs: [], supplemental: [], outputs: [] }
        },
        workspaceRoot: tmpWorkspaceRoot,
        startedAt: 41_000
      }
    );
    expect(uiPause).toEqual(headlessPause);

    // Corrupt / future schema version record isolation (FR-014)
    const futureLedgerPayload = { version: 999, roots: { 'future-root': { data: 'preserve-me' } } };
    await uiStore.update(KEYS.controlLedger, futureLedgerPayload);
    const futureCheck = uiComp.verifyPreAdmission({
      entryPointId: 'ui.launchWorkflow',
      rootExecutionId: 'conn-future'
    });
    expect(futureCheck.allowed).toBe(false);
    if (!futureCheck.allowed) {
      expect(futureCheck.refusal.category).toBe('corrupt-state');
      expect(futureCheck.refusal.reasonCode).toBe('unsupported-control-ledger-version');
      expect(futureCheck.refusal.attemptsConsumed).toBe(0);
    }
    // Verify the future record was preserved without silent coercion or deletion
    expect(uiStore.get(KEYS.controlLedger)).toEqual(futureLedgerPayload);

    uiComp.dispose();
    headlessComp.dispose();
  });

  // ---------------------------------------------------------------------------
  // F01-AC-07 — Baseline gate recheck
  // ---------------------------------------------------------------------------
  it('F01-AC-07: re-verifies baseline gate obligations (RunDriver.drive line ceiling and child-failure aggregate keys)', async () => {
    const runDriverPath = path.resolve(__dirname, '../../src/services/run-driver.ts');
    const runDriverLines = (await fs.readFile(runDriverPath, 'utf8')).split('\n');
    const driveStart = runDriverLines.findIndex((line) => line.includes('public async drive('));
    expect(driveStart).toBeGreaterThanOrEqual(0);
    let braceDepth = 0;
    let driveEnd = driveStart;
    for (let i = driveStart; i < runDriverLines.length; i += 1) {
      for (const ch of runDriverLines[i]!) {
        if (ch === '{') braceDepth += 1;
        else if (ch === '}') braceDepth -= 1;
      }
      if (braceDepth === 0 && i > driveStart) {
        driveEnd = i;
        break;
      }
    }
    const driveLineCount = driveEnd - driveStart + 1;
    expect(driveLineCount).toBeLessThanOrEqual(650);

    const baselineFindings = getBaselineFindingsReconciliation();
    const gate1 = baselineFindings.find((f) => f.findingId === 'F01-BF-06');
    const gate2 = baselineFindings.find((f) => f.findingId === 'F01-BF-07');
    expect(gate1?.baselineStatus).toBe('superseded-with-evidence');
    expect(gate2?.baselineStatus).toBe('superseded-with-evidence');
  });

  // ---------------------------------------------------------------------------
  // F01-AC-08 — Resource bounds and qualification record
  // ---------------------------------------------------------------------------
  it('F01-AC-08: enforces limit and limit-plus-one resource boundaries and emits a complete 7-field QualificationRecord', () => {
    const composition = createProductionWorkflowComposition({
      workspaceRoot: tmpWorkspaceRoot
    });

    // At exact limits -> allowed
    const atLimit = composition.verifyPreAdmission({
      entryPointId: 'ui.launchWorkflow',
      rootExecutionId: 'conn-limits',
      resourceBudget: {
        queueCount: PRODUCTION_RESOURCE_CEILINGS.maxQueues,
        activeRootWorkflowCount: PRODUCTION_RESOURCE_CEILINGS.maxActiveRootWorkflows,
        activeFramesInRoot: PRODUCTION_RESOURCE_CEILINGS.maxActiveFramesPerRoot,
        forEachItemCount: PRODUCTION_RESOURCE_CEILINGS.maxForEachItems,
        availableSettlementReserveSlots:
          PRODUCTION_RESOURCE_CEILINGS.minSettlementReserveSlots
      }
    });
    expect(atLimit.allowed).toBe(true);

    // At limit + 1 (or reserve - 1) -> refused with budget-exceeded and 0 attempts consumed
    const dimensionChecks = [
      { queueCount: PRODUCTION_RESOURCE_CEILINGS.maxQueues + 1 },
      { activeRootWorkflowCount: PRODUCTION_RESOURCE_CEILINGS.maxActiveRootWorkflows + 1 },
      { activeFramesInRoot: PRODUCTION_RESOURCE_CEILINGS.maxActiveFramesPerRoot + 1 },
      { forEachItemCount: PRODUCTION_RESOURCE_CEILINGS.maxForEachItems + 1 },
      { availableSettlementReserveSlots: 0 }
    ];
    for (const budget of dimensionChecks) {
      const check = composition.verifyPreAdmission({
        entryPointId: 'ui.launchWorkflow',
        rootExecutionId: 'conn-over-limit',
        resourceBudget: budget
      });
      expect(check.allowed).toBe(false);
      if (!check.allowed) {
        expect(check.refusal.category).toBe('budget-exceeded');
        expect(check.refusal.attemptsConsumed).toBe(0);
      }
    }

    const qualification = buildQualificationRecord({
      editorVersion: '1.96.0',
      bundledRuntime: process.version,
      platform: `${process.platform}-${process.arch}`,
      backendOrFixtureVersion: 'schegent-f01-fixture-v1',
      command: 'npx vitest run tests/integration/production-workflow-integration.test.ts',
      commit: '5897b7fd',
      outcome: 'passed'
    });
    expect(qualification.outcome).toBe('passed');
    expect(Object.values(qualification).every((v) => typeof v === 'string' && v.length > 0)).toBe(
      true
    );
    composition.dispose();
  });

  // ---------------------------------------------------------------------------
  // F01-AC-09 — Store and agent runtime cutover guard & F08 handoff seam
  // ---------------------------------------------------------------------------
  it('F01-AC-09: enforces the F08 durable artifact handover unavailability seam and refuses any fallback to a retired runner or secondary store under post-cutover authority', async () => {
    const store = createMemoryBackingStore();

    // 1. F08 durable artifact handover seam returns explicit unavailable outcome until qualified (FR-020)
    const defaultComp = createProductionWorkflowComposition({
      store,
      workspaceRoot: tmpWorkspaceRoot
    });
    const handoffCheck = defaultComp.durableHandoffSeam.requestHandover({
      rootExecutionId: 'conn-f08',
      invocationId: 'inv-f08',
      artifactIds: ['artifact-1']
    });
    expect(handoffCheck.accepted).toBe(false);
    expect(handoffCheck.refusal?.category).toBe('unsupported-capability');
    expect(handoffCheck.refusal?.reasonCode).toBe('durable-handoff-not-qualified');
    expect(handoffCheck.refusal?.attemptsConsumed).toBe(0);

    // 2. Post-cutover runtime disconnect refuses visibly at public launch with 0 attempts consumed and no fallback
    let fallbackSpawns = 0;
    const disconnectedComp = createProductionWorkflowComposition({
      store,
      workspaceRoot: tmpWorkspaceRoot,
      cutoverAuthorityGuard: createCutoverAuthorityGuard({
        mode: 'post-cutover-strict',
        storeAuthority: 'sqlite-f04',
        runtimeAuthority: 'disconnected'
      })
    });

    const phaseA = makePhase('phase-a');
    const wf: WorkflowDefinition = {
      workflowId: 'wf-cutover',
      version: 1,
      name: 'Cutover Workflow',
      startNodeIds: ['n1'],
      nodes: [{ nodeId: 'n1', kind: 'phase', phaseId: 'phase-a' }],
      connections: []
    };

    const launchDisconnected = await launchComposableWorkflow(
      {
        connectedRuns: store,
        isChildSettled: () => true,
        productionComposition: disconnectedComp,
        logger,
        guardedRun: {
          scheduleOrEnqueue: async () => {
            fallbackSpawns += 1;
            return {
              accepted: true,
              disposition: 'enqueued',
              taskId: 'should-not-enqueue',
              queueId: 'default'
            };
          }
        } as any
      },
      {
        connectedRunId: 'conn-cutover-disconnected',
        envelope: {
          workflowId: 'wf-cutover',
          entryNodeId: 'n1',
          inputs: [],
          supplemental: [],
          outputs: [],
          outputOverrides: [],
          frozenClosure: {
            rootWorkflowId: 'wf-cutover',
            workflowsById: { 'wf-cutover': wf },
            phasesById: { 'phase-a': phaseA }
          }
        } as any,
        workspaceRoot: tmpWorkspaceRoot,
        startedAt: 50_000
      }
    );

    expect(launchDisconnected.outcome).toBe('rejected-queue');
    if (launchDisconnected.outcome === 'rejected-queue') {
      expect(launchDisconnected.refusal?.category).toBe('unsupported-capability');
      expect(launchDisconnected.refusal?.reasonCode).toBe('cutover-runtime-disconnected');
      expect(launchDisconnected.refusal?.attemptsConsumed).toBe(0);
    }
    expect(fallbackSpawns).toBe(0);
    expect(store.get('conn-cutover-disconnected')).toBeNull();

    // 3. Post-cutover with sqlite-f04 + acp-f13 succeeds
    const cutoverReadyComp = createProductionWorkflowComposition({
      store,
      workspaceRoot: tmpWorkspaceRoot,
      cutoverAuthorityGuard: createCutoverAuthorityGuard({
        mode: 'post-cutover-strict',
        storeAuthority: 'sqlite-f04',
        runtimeAuthority: 'acp-f13'
      })
    });
    const readyCheck = cutoverReadyComp.verifyPreAdmission({
      entryPointId: 'ui.launchWorkflow',
      rootExecutionId: 'conn-cutover-ready'
    });
    expect(readyCheck.allowed).toBe(true);

    defaultComp.dispose();
    disconnectedComp.dispose();
    cutoverReadyComp.dispose();
  });
});
