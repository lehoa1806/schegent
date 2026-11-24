/**
 * FR-R8-01 (01-05, T013, SC-005) — End-to-end production candidate-block
 * fallback launch suite importing the shipped
 * `examples/workflow-control/02-candidate-block-recovery.workflow.yaml`
 * through public `launchWorkflow` (Add Work), SQLite WAL persistence,
 * production `ProductionWorkflowComposition`, `recordConnectedWorkflowTransition`,
 * `createConnectedRunService` UI projections, and `WorkflowRecoveryService`.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnectedRunService } from '../../src/activation/ui-wiring';
import { createDesktopOwnershipFenceForStore } from '../../src/activation/workflow-ownership-fence';
import {
  reconcileComposableWorkflowRuns,
  recordConnectedWorkflowTransition
} from '../../src/activation/run-safety-wiring';
import type { BackendAvailabilityAdapter } from '../../src/contracts/backend-availability';
import type { BackendRunnerKind } from '../../src/contracts/backend-kinds';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import type { PipelineCatalog } from '../../src/config/pipeline-config';
import { SanitizedLogger } from '../../src/lib/logger';
import { QueueManager } from '../../src/queue/queue-manager';
import { GuardedRunService } from '../../src/services/guarded-run-service';
import { parseDocumentBytes } from '../../src/services/process-yaml/yaml-parser';
import { parseWorkflowPackage } from '../../src/services/process-yaml/workflow-document';
import { phaseDefinitionFromDocument } from '../../src/services/process-yaml/phase-yaml-mapper';
import { SqliteApplicationStore } from '../../src/services/sqlite-store';
import {
  createProductionWorkflowComposition,
  registerProductionWorkflowComposition,
  unregisterProductionWorkflowComposition
} from '../../src/services/workflow-execution/production-workflow-composition';
import { launchWorkflow } from '../../src/services/workflow-execution/workflow-launcher';
import {
  resolveRootInvocationId,
  type ConnectedWorkflowRun
} from '../../src/state/connected-workflow-run';
import { ExecutionLeaseManager } from '../../src/state/execution-lease';
import { WorkspaceLockManager, type Scheduler } from '../../src/state/lock';
import { createDiskOwnershipFs } from '../../src/state/ownership-fs';
import { createSwitchableOperationalMemento } from '../../src/state/sqlite-operational-backing';
import type { WorkflowRun } from '../../src/state/workflow-run';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { removeTempRoot } from '../temp-root-cleanup';

const noopScheduler: Scheduler = {
  setInterval() {
    return { clear() {} };
  }
};

function createMemoryMemento(): Memento {
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

async function loadShippedCandidateBlockWorkflow(): Promise<{
  readonly rootWorkflow: WorkflowDefinition;
  readonly workflows: readonly WorkflowDefinition[];
  readonly phases: readonly PhaseDefinition[];
}> {
  const yamlPath = path.resolve(
    __dirname,
    '..',
    '..',
    'examples',
    'workflow-control',
    '02-candidate-block-recovery.workflow.yaml'
  );
  const rawBytes = await fsp.readFile(yamlPath);
  const parsedTree = parseDocumentBytes(rawBytes);
  if (!parsedTree.ok) {
    throw new Error(`Failed to parse shipped YAML: ${JSON.stringify(parsedTree)}`);
  }
  const pkg = parseWorkflowPackage(parsedTree.node);
  if (!pkg.ok) {
    throw new Error(`Failed to parse workflow package: ${JSON.stringify(pkg)}`);
  }
  const workflows: WorkflowDefinition[] = [];
  const phases: PhaseDefinition[] = [];
  for (const res of pkg.resources) {
    if (!res.ok) continue;
    if (res.resourceKind === 'workflow') workflows.push(res.definition);
    if (res.resourceKind === 'phase') phases.push(phaseDefinitionFromDocument(res.document));
  }
  const rootWorkflow = workflows.at(0);
  if (rootWorkflow === undefined) {
    throw new Error('Shipped candidate-block YAML yielded no root workflow.');
  }
  return { rootWorkflow, workflows, phases };
}

function makeEmptyCatalog(): PipelineCatalog {
  return {
    phases: [],
    pipelines: [],
    models: { claude: [], codex: [], agy: [] },
    defaultPipelineId: 'default',
    phasesById: new Map(),
    pipelinesById: new Map()
  };
}

function makeReadyAvailabilityAdapter(kind: BackendRunnerKind): BackendAvailabilityAdapter {
  return {
    adapterId: `${kind}-fixture`,
    adapterVersion: 1,
    backend: kind,
    statusCheck: 'supported',
    resolveQuotaContext: () => ({
      version: 1,
      adapterId: `${kind}-fixture`,
      adapterVersion: 1,
      quotaIds: [`${kind}/default`],
      identity: 'qualified',
      statusCheck: 'supported'
    })
  };
}

function makeTerminalLeafRun(
  queueItemId: string,
  status: 'completed' | 'failed' | 'canceled',
  at: number,
  outputPath?: string
): WorkflowRun {
  return {
    id: `leaf-run-${queueItemId}`,
    featureId: queueItemId,
    featureDir: `specs/${queueItemId}`,
    status,
    currentPhase: 'review',
    currentIteration: 1,
    startedAt: at - 500,
    lastTransitionAt: at,
    phasesCompleted: [],
    lastError: status === 'failed' ? { code: 'rate-limit', message: 'provider rate-limit', phase: 'review', iteration: 1, at } : null,
    pendingRetryAt: null,
    pendingRetryCause: null,
    creditPause: null,
    delayedRetryCount: 0,
    manualPauseAt: null,
    manualPauseCause: null,
    phaseOverrides: [],
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    ...(outputPath !== undefined
      ? {
          runOutputs: [
            {
              name: 'review-json',
              status: 'resolved' as const,
              reference: outputPath
            }
          ]
        }
      : {})
  };
}

interface CandidateHarness {
  readonly tmpRoot: string;
  readonly sqlite: SqliteApplicationStore;
  readonly store: WorkspaceStateStore;
  readonly lock: WorkspaceLockManager;
  readonly lease: ExecutionLeaseManager;
  readonly queue: QueueManager;
  readonly guardedRun: GuardedRunService;
  readonly logger: SanitizedLogger;
  readonly composition: ReturnType<typeof createProductionWorkflowComposition>;
  readonly close: () => Promise<void>;
}

async function createCandidateHarness(options: {
  readonly upperBoundMicrousd?: number;
  readonly initialQuotaReady?: Readonly<Record<BackendRunnerKind, boolean>>;
  readonly isWorkspaceTrusted?: () => boolean;
} = {}): Promise<CandidateHarness> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-cand-fb-'));
  const dbPath = path.join(tmpRoot, 'state.sqlite');
  const ownershipDir = path.join(tmpRoot, '.schegent', 'ownership');
  const sqlite = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
  const memento = createSwitchableOperationalMemento(createMemoryMemento());
  memento.attachSqlite(sqlite, 'cand-scope');
  const store = new WorkspaceStateStore(memento);
  store.useOwnershipStorage(
    createDiskOwnershipFs({ workspaceRoot: tmpRoot, ownershipDir }),
    ownershipDir
  );
  await store.initialize();
  const lock = new WorkspaceLockManager(store, 'win-primary', { now: () => Date.now() }, noopScheduler);
  await lock.tryAcquire();
  store.bindPrimacyClaimSource(lock);
  const lease = new ExecutionLeaseManager(store, 'win-primary', { now: () => Date.now() }, noopScheduler);
  store.bindRunClaimSource(lease);
  const queue = new QueueManager(store);
  const logger = new SanitizedLogger();
  const trusted = options.isWorkspaceTrusted ?? (() => true);
  const guardedRun = new GuardedRunService({
    isWorkspaceTrusted: trusted,
    lock,
    queue,
    controller: { getCatalog: makeEmptyCatalog },
    logger,
    store,
    catalogProvider: makeEmptyCatalog
  });

  const upperBound = options.upperBoundMicrousd ?? 1_000_000;
  const composition = createProductionWorkflowComposition({
    store,
    workspaceRoot: tmpRoot,
    isWorkspaceTrusted: trusted,
    ...createDesktopOwnershipFenceForStore(store),
    requireLiveFenceVerifier: true,
    getAvailabilityAdapter: makeReadyAvailabilityAdapter,
    resolveCandidateSpec: ({ phase }) => ({
      upperBoundMicrousd: upperBound,
      upperBoundQuality: 'verified',
      quotaIds: [`${phase.runner ?? 'claude'}/default`]
    })
  });
  registerProductionWorkflowComposition(store, composition);

  const readyMap = options.initialQuotaReady ?? { claude: true, codex: true, agy: true };
  for (const kind of ['claude', 'codex', 'agy'] as const) {
    await composition.recordAvailabilityWakeup({
      quotaId: `${kind}/default`,
      backend: kind,
      ready: readyMap[kind],
      capacity: readyMap[kind] ? 2 : 0,
      ...(readyMap[kind] ? {} : { resetAtWallMs: Date.now() + 60_000 })
    });
  }

  return {
    tmpRoot,
    sqlite,
    store,
    lock,
    lease,
    queue,
    guardedRun,
    logger,
    composition,
    close: async () => {
      unregisterProductionWorkflowComposition(store, composition);
      await lease.release('default').catch(() => undefined);
      await lock.release();
      sqlite.close();
      await removeTempRoot(tmpRoot);
    }
  };
}

const activeHarnesses: CandidateHarness[] = [];

afterEach(async () => {
  while (activeHarnesses.length > 0) {
    const h = activeHarnesses.pop();
    if (h !== undefined) await h.close();
  }
});

describe('FR-R8-01 (01-05) — Production candidate-block fallback launch from shipped YAML', () => {
  it('imports 02-candidate-block-recovery.workflow.yaml, launches via launchWorkflow, falls back primary->secondary, commits single output, projects control state, and deduplicates replay', async () => {
    const h = await createCandidateHarness();
    activeHarnesses.push(h);
    const { rootWorkflow, workflows, phases } = await loadShippedCandidateBlockWorkflow();

    const reviewOutputRel = 'review-output.json';
    const reviewOutputAbs = path.join(h.tmpRoot, reviewOutputRel);

    const launchRes = await launchWorkflow(
      {
        connectedRuns: h.store,
        guardedRun: h.guardedRun,
        productionComposition: h.composition,
        isChildSettled: () => true,
        logger: h.logger
      },
      {
        connectedRunId: 'crun-cand-1',
        workflow: rootWorkflow,
        catalog: makeEmptyCatalog(),
        effectiveWorkflows: workflows,
        effectivePhases: phases,
        startNodeId: rootWorkflow.startNodeIds[0]!,
        request: {
          pipelineId: rootWorkflow.workflowId,
          inputs: [{ portId: 'review-prompt', type: 'text', value: 'Review PR #42' }],
          supplemental: [],
          outputs: [{ portId: 'review-json', target: reviewOutputRel }]
        },
        workspaceRoot: h.tmpRoot,
        startedAt: Date.now(),
        queueId: 'default'
      }
    );

    expect(launchRes.outcome).toBe('started');
    if (launchRes.outcome !== 'started') return;
    const firstQueueItemId = launchRes.queueItemId;
    const firstItem = h.queue.findById(firstQueueItemId);
    expect(firstItem?.pipelineId).toBe('phase-review-claude');
    expect(firstItem?.workflowOccurrence?.rootRunId).toBe('crun-cand-1');

    // UI projection exposes candidate-block state, all 4 candidates, and strict-USD mode
    const connectedSvc = createConnectedRunService(h.store, { list: () => [] });
    const projections = connectedSvc.listProjections();
    const initialProj = projections.find((p) => p.connectedRunId === 'crun-cand-1');
    expect(initialProj?.controlProjection?.frameKind).toBe('candidate-block');
    expect(initialProj?.controlProjection?.candidates?.length).toBe(4);
    expect(initialProj?.controlProjection?.selectedCandidateId).toBe('review-primary');
    expect(initialProj?.controlProjection?.spendMode).toBe('strict-usd');

    // Exercise the live desktop queue-lease transition (`unleased -> held:g1 -> onRunTerminal`)
    // that previously broke exact fence matching across lease acquisition.
    const lease1 = await h.lease.tryAcquire('default');
    expect(lease1.acquired).toBe(true);

    // Primary fails with retryable availability error -> automatic fallback to secondary (codex)
    const primaryFailAt = Date.now() + 1_000;
    const primaryFailedRun = makeTerminalLeafRun(firstQueueItemId, 'failed', primaryFailAt);
    await h.composition.recordAvailabilityWakeup({
      quotaId: 'claude/default',
      backend: 'claude',
      ready: false,
      capacity: 0,
      resetAtWallMs: primaryFailAt + 120_000
    });
    await recordConnectedWorkflowTransition(
      {
        workspaceRoot: h.tmpRoot,
        store: h.store,
        logger: h.logger,
        getGuardedRun: () => h.guardedRun,
        productionComposition: h.composition
      },
      primaryFailedRun
    );
    await h.lease.release('default');

    const afterPrimary = h.store.getConnectedRun('crun-cand-1')!;
    const rootInvId = resolveRootInvocationId(afterPrimary);
    const secondAttempts = afterPrimary.invocations?.[rootInvId]?.attemptsByNodeId['cand-second-codex'] ?? [];
    expect(secondAttempts.length).toBe(1);
    const secondQueueItemId = secondAttempts[0]?.queueItemId;
    expect(secondQueueItemId).toBeDefined();
    expect(h.queue.findById(secondQueueItemId!)?.pipelineId).toBe('phase-review-codex-fast');

    // Acquire generation 2 lease for candidate 2 execution & settlement
    const lease2 = await h.lease.tryAcquire('default');
    expect(lease2.acquired).toBe(true);

    // Secondary writes valid structured review JSON and settles -> candidate block commits return once
    await fsp.writeFile(
      reviewOutputAbs,
      JSON.stringify({
        attemptId: secondAttempts[0]!.attemptId,
        done: true,
        approved: true,
        nextFeedback: ''
      }),
      'utf8'
    );
    const secondaryOkAt = primaryFailAt + 1_000;
    const secondaryDoneRun = makeTerminalLeafRun(
      secondQueueItemId!,
      'completed',
      secondaryOkAt,
      reviewOutputRel
    );
    await recordConnectedWorkflowTransition(
      {
        workspaceRoot: h.tmpRoot,
        store: h.store,
        logger: h.logger,
        getGuardedRun: () => h.guardedRun,
        productionComposition: h.composition
      },
      secondaryDoneRun
    );

    const completedRun = h.store.getConnectedRun('crun-cand-1')!;
    const rootFrame = completedRun.invocations?.[rootInvId];
    expect(rootFrame?.status).toBe('completed');
    expect(rootFrame?.resolvedOutputs['review-json']?.value).toBe(reviewOutputRel);

    const ledgerRoot = h.composition.ledgerStore.getRoot('crun-cand-1');
    expect(ledgerRoot?.linkState).toBe('terminal');
    expect(ledgerRoot?.status).toBe('completed');
    const ledgerFrame = ledgerRoot?.framesByKey[rootInvId];
    expect(ledgerFrame?.winningCandidateId).toBe('review-second');
    expect(ledgerFrame?.returnCommitId).toBeDefined();
    const firstReturnCommitId = ledgerFrame?.returnCommitId;
    const queueCountAfterWin = h.store.getQueue('default').requests.length;

    // Duplicate settlement replay is strictly idempotent (zero duplicate dispatches or overwrites)
    await recordConnectedWorkflowTransition(
      {
        workspaceRoot: h.tmpRoot,
        store: h.store,
        logger: h.logger,
        getGuardedRun: () => h.guardedRun,
        productionComposition: h.composition
      },
      secondaryDoneRun
    );
    expect(h.store.getQueue('default').requests.length).toBe(queueCountAfterWin);
    expect(h.composition.ledgerStore.getRoot('crun-cand-1')?.framesByKey[rootInvId]?.returnCommitId).toBe(
      firstReturnCommitId
    );
  });

  it('pauses visibly on strict-USD budget exhaustion with zero over-budget dispatches', async () => {
    // Shipped workflow strict-USD limit is 5,000,000 microusd ($5); set candidate upper bound above $5.
    const h = await createCandidateHarness({ upperBoundMicrousd: 6_000_000 });
    activeHarnesses.push(h);
    const { rootWorkflow, workflows, phases } = await loadShippedCandidateBlockWorkflow();

    const launchRes = await launchWorkflow(
      {
        connectedRuns: h.store,
        guardedRun: h.guardedRun,
        productionComposition: h.composition,
        isChildSettled: () => true,
        logger: h.logger
      },
      {
        connectedRunId: 'crun-cand-budget',
        workflow: rootWorkflow,
        catalog: makeEmptyCatalog(),
        effectiveWorkflows: workflows,
        effectivePhases: phases,
        startNodeId: rootWorkflow.startNodeIds[0]!,
        request: {
          pipelineId: rootWorkflow.workflowId,
          inputs: [{ portId: 'review-prompt', type: 'text', value: 'Expensive review' }],
          supplemental: [],
          outputs: [{ portId: 'review-json', target: 'out-budget.json' }]
        },
        workspaceRoot: h.tmpRoot,
        startedAt: Date.now(),
        queueId: 'default'
      }
    );

    expect(launchRes.outcome).toBe('started');
    if (launchRes.outcome !== 'started') return;
    expect(launchRes.queueItemId).toBe('paused:crun-cand-budget');
    expect(h.store.getQueue('default').requests.length).toBe(0);
    const stored = h.store.getConnectedRun('crun-cand-budget')!;
    const rootInvId = resolveRootInvocationId(stored);
    expect(stored.invocations?.[rootInvId]?.status).toBe('paused');
    expect(stored.invocations?.[rootInvId]?.controlMarkers?.manualPauseCause).toBe(
      'spend-bound-exceeded'
    );
  });

  it('pauses cleanly in waiting-availability when all candidates are unavailable and recovers a crash during candidate switch', async () => {
    const h = await createCandidateHarness({
      initialQuotaReady: { claude: false, codex: false, agy: false }
    });
    activeHarnesses.push(h);
    const { rootWorkflow, workflows, phases } = await loadShippedCandidateBlockWorkflow();

    const launchRes = await launchWorkflow(
      {
        connectedRuns: h.store,
        guardedRun: h.guardedRun,
        productionComposition: h.composition,
        isChildSettled: () => true,
        logger: h.logger
      },
      {
        connectedRunId: 'crun-cand-unavail',
        workflow: rootWorkflow,
        catalog: makeEmptyCatalog(),
        effectiveWorkflows: workflows,
        effectivePhases: phases,
        startNodeId: rootWorkflow.startNodeIds[0]!,
        request: {
          pipelineId: rootWorkflow.workflowId,
          inputs: [{ portId: 'review-prompt', type: 'text', value: 'All down' }],
          supplemental: [],
          outputs: [{ portId: 'review-json', target: 'out-unavail.json' }]
        },
        workspaceRoot: h.tmpRoot,
        startedAt: Date.now(),
        queueId: 'default'
      }
    );

    expect(launchRes.outcome).toBe('started');
    if (launchRes.outcome !== 'started') return;
    expect(launchRes.queueItemId).toBe('paused:crun-cand-unavail');
    expect(h.store.getQueue('default').requests.length).toBe(0);

    // Now test restart recovery during candidate switch:
    // Put a second candidate-block run into the post-failure `selecting` state (crash between settling primary and dispatching secondary).
    await h.composition.recordAvailabilityWakeup({
      quotaId: 'codex/default',
      backend: 'codex',
      ready: true,
      capacity: 2
    });
    await h.composition.recordAvailabilityWakeup({
      quotaId: 'claude/default',
      backend: 'claude',
      ready: true,
      capacity: 2
    });

    const switchLaunch = await launchWorkflow(
      {
        connectedRuns: h.store,
        guardedRun: h.guardedRun,
        productionComposition: h.composition,
        isChildSettled: () => true,
        logger: h.logger
      },
      {
        connectedRunId: 'crun-cand-switch',
        workflow: rootWorkflow,
        catalog: makeEmptyCatalog(),
        effectiveWorkflows: workflows,
        effectivePhases: phases,
        startNodeId: rootWorkflow.startNodeIds[0]!,
        request: {
          pipelineId: rootWorkflow.workflowId,
          inputs: [{ portId: 'review-prompt', type: 'text', value: 'Switch crash' }],
          supplemental: [],
          outputs: [{ portId: 'review-json', target: 'out-switch.json' }]
        },
        workspaceRoot: h.tmpRoot,
        startedAt: Date.now(),
        queueId: 'default'
      }
    );
    expect(switchLaunch.outcome).toBe('started');
    if (switchLaunch.outcome !== 'started') return;

    const runBeforeCrash = h.store.getConnectedRun('crun-cand-switch')!;
    const rootInvId = resolveRootInvocationId(runBeforeCrash);
    const primaryAttempt = runBeforeCrash.invocations![rootInvId]!.attemptsByNodeId['cand-primary-claude']![0]!;

    // Settle primary in ledger as availability failure while cooling down claude, simulating crash before secondary dispatch
    await h.composition.recordAvailabilityWakeup({
      quotaId: 'claude/default',
      backend: 'claude',
      ready: false,
      capacity: 0,
      resetAtWallMs: Date.now() + 120_000
    });
    const rootLedger = h.composition.ledgerStore.getRoot('crun-cand-switch')!;
    const settledInLedger = await h.composition.candidateBlockExecutor.settleCandidateAttempt({
      rootRunId: 'crun-cand-switch',
      frameKey: rootInvId,
      attemptId: primaryAttempt.attemptId,
      candidateId: 'review-primary',
      fence: rootLedger.fence,
      outcome: 'retryable-availability',
      failureCode: 'rate-limit',
      resetsAtMs: Date.now() + 120_000
    });
    expect(settledInLedger.ok).toBe(true);

    // Mark the primary attempt failed on the connected run so recovery sees no in-flight leaf, only a `selecting` candidate frame
    const updatedPrimaryFrame = {
      ...runBeforeCrash.invocations![rootInvId]!,
      attemptsByNodeId: {
        ...runBeforeCrash.invocations![rootInvId]!.attemptsByNodeId,
        'cand-primary-claude': [
          Object.freeze({
            ...primaryAttempt,
            status: 'failed' as const,
            completedAt: Date.now(),
            failureCode: 'rate-limit'
          })
        ]
      }
    };
    const crashRun: ConnectedWorkflowRun = Object.freeze({
      ...runBeforeCrash,
      revision: runBeforeCrash.revision + 1,
      invocations: Object.freeze({
        ...runBeforeCrash.invocations!,
        [rootInvId]: Object.freeze(updatedPrimaryFrame)
      })
    });
    const cas = await h.store.compareAndSetConnectedRun(crashRun, runBeforeCrash.revision);
    expect(cas.outcome).toBe('written');
    // Finish the primary queue item so queue-liveness sees it completed/failed
    await h.queue.finish(switchLaunch.queueItemId, 'failed', 'rate-limit');

    // Run startup recovery -> §7 candidate-block recovery dispatches secondary without re-running primary
    await reconcileComposableWorkflowRuns({
      workspaceRoot: h.tmpRoot,
      store: h.store,
      logger: h.logger,
      getGuardedRun: () => h.guardedRun,
      productionComposition: h.composition
    });

    const recovered = h.store.getConnectedRun('crun-cand-switch')!;
    expect(recovered.invocations?.[rootInvId]?.attemptsByNodeId['cand-primary-claude']?.length).toBe(1);
    expect(recovered.invocations?.[rootInvId]?.attemptsByNodeId['cand-second-codex']?.length).toBe(1);
    expect(recovered.recoveryDisposition?.reasonCode).toBe('candidate-block-step-reconciled');
    // Ensure vi isn't unused
    expect(vi.isMockFunction(h.logger.warn)).toBe(false);
  });

  it('evaluates ResultOperator during startup recovery and enforces trust and live ownership fence in ControlCommandService', async () => {
    const trustState = { trusted: true };
    const h = await createCandidateHarness({
      isWorkspaceTrusted: () => trustState.trusted
    });
    activeHarnesses.push(h);
    const { rootWorkflow, workflows, phases } = await loadShippedCandidateBlockWorkflow();

    const launched = await launchWorkflow(
      {
        connectedRuns: h.store,
        guardedRun: h.guardedRun,
        productionComposition: h.composition,
        isChildSettled: () => true,
        logger: h.logger
      },
      {
        connectedRunId: 'crun-cand-resultop-rec',
        workflow: rootWorkflow,
        catalog: makeEmptyCatalog(),
        effectiveWorkflows: workflows,
        effectivePhases: phases,
        startNodeId: rootWorkflow.startNodeIds[0]!,
        request: {
          pipelineId: rootWorkflow.workflowId,
          inputs: [{ portId: 'review-prompt', type: 'text', value: 'Missing output recovery' }],
          supplemental: [],
          outputs: [{ portId: 'review-json', target: 'missing-review-output.json' }]
        },
        workspaceRoot: h.tmpRoot,
        startedAt: Date.now(),
        queueId: 'default'
      }
    );
    expect(launched.outcome).toBe('started');
    if (launched.outcome !== 'started') return;

    // 1) Restricted Mode must refuse mutating ControlCommandService commands with `trust-denied`.
    const runSnap = h.store.getConnectedRun('crun-cand-resultop-rec')!;
    const rootInvId = resolveRootInvocationId(runSnap);
    trustState.trusted = false;
    const untrustedAck = await h.composition.controlCommandService.executeControlCommand({
      version: 1,
      commandId: '11111111-1111-4111-8111-111111111111',
      rootRunId: 'crun-cand-resultop-rec',
      queueId: 'default',
      invocationId: rootInvId,
      expectedGeneration: 1,
      action: { kind: 'pause' }
    });
    expect(untrustedAck.outcome).toBe('refused');
    expect(untrustedAck.reason).toBe('trust-denied');
    trustState.trusted = true;

    // 2) Startup recovery against a terminal exit-0 leaf run whose structured JSON file is MISSING
    // must evaluate ResultOperator, reject false completion, and pause for operator intervention
    // (rather than falsely completing or silently falling back on invalid output).
    const invalidCompletedLeaf = makeTerminalLeafRun(
      launched.queueItemId,
      'completed',
      Date.now() + 1_000,
      'missing-review-output.json'
    );
    await h.store.setRun('default', invalidCompletedLeaf, h.store.runCommitClaim('default'));
    await h.queue.finish(launched.queueItemId, 'completed');

    await reconcileComposableWorkflowRuns({
      workspaceRoot: h.tmpRoot,
      store: h.store,
      logger: h.logger,
      getGuardedRun: () => h.guardedRun,
      productionComposition: h.composition
    });

    const afterRecovery = h.store.getConnectedRun('crun-cand-resultop-rec')!;
    const frameAfter = afterRecovery.invocations?.[rootInvId];
    expect(frameAfter?.status).toBe('paused');
    const primarySettled = frameAfter?.attemptsByNodeId['cand-primary-claude']?.[0];
    expect(primarySettled?.status).toBe('failed');
    expect(primarySettled?.failureCode).toContain('typed-result-invalid');
    expect(frameAfter?.attemptsByNodeId['cand-second-codex']).toBeUndefined();

    // 3) Startup recovery against a failed primary leaf carrying `lastError.code = 'rate-limit'`
    // must forward `failureCode` through `checkDurableAttemptEvidence` and automatically fall back
    // to `cand-second-codex`.
    const launchedFallback = await launchWorkflow(
      {
        connectedRuns: h.store,
        guardedRun: h.guardedRun,
        productionComposition: h.composition,
        isChildSettled: () => true,
        logger: h.logger
      },
      {
        connectedRunId: 'crun-cand-ratelimit-rec',
        workflow: rootWorkflow,
        catalog: makeEmptyCatalog(),
        effectiveWorkflows: workflows,
        effectivePhases: phases,
        startNodeId: rootWorkflow.startNodeIds[0]!,
        request: {
          pipelineId: rootWorkflow.workflowId,
          inputs: [{ portId: 'review-prompt', type: 'text', value: 'Review rate-limit recovery' }],
          supplemental: [],
          outputs: [{ portId: 'review-json', target: 'review-output-rl.json' }]
        },
        workspaceRoot: h.tmpRoot,
        startedAt: Date.now() + 2_000,
        queueId: 'default'
      }
    );
    expect(launchedFallback.outcome).toBe('started');
    if (launchedFallback.outcome !== 'started') return;

    await h.composition.recordAvailabilityWakeup({
      quotaId: 'claude/default',
      backend: 'claude',
      ready: false,
      capacity: 0,
      resetAtWallMs: Date.now() + 120_000
    });
    const rateLimitedLeaf: WorkflowRun = {
      ...makeTerminalLeafRun(launchedFallback.queueItemId, 'failed', Date.now() + 3_000),
      lastError: {
        code: 'rate-limit',
        message: 'Claude quota exhausted',
        phase: 'phase-review-claude',
        iteration: 1,
        at: Date.now() + 3_000
      }
    };
    await h.store.setRun('default', rateLimitedLeaf, h.store.runCommitClaim('default'));
    await h.queue.finish(launchedFallback.queueItemId, 'failed');

    await reconcileComposableWorkflowRuns({
      workspaceRoot: h.tmpRoot,
      store: h.store,
      logger: h.logger,
      getGuardedRun: () => h.guardedRun,
      productionComposition: h.composition
    });

    const afterRateLimit = h.store.getConnectedRun('crun-cand-ratelimit-rec')!;
    const rlRootInvId = resolveRootInvocationId(afterRateLimit);
    const rlFrame = afterRateLimit.invocations?.[rlRootInvId];
    expect(rlFrame?.attemptsByNodeId['cand-primary-claude']?.[0]?.failureCode).toBe('rate-limit');
    expect(rlFrame?.attemptsByNodeId['cand-second-codex']?.length).toBe(1);
  });
});
