/**
 * FR-R8-04 (`04-06`) — Narrow, deterministic controlled-regression-vs-fix
 * reproducers for all six named Round 8 defects:
 * 1. Launch (`01-01`/`01-02`): 20-root live cap refusal + atomic parent+queue admission.
 * 2. Orphan cancellation (`01-04`): named `WorkflowLeafTarget` addressing exact task in queue.
 * 3. Missing spend (`02-01`): absent billable usage returns `unmeasurable` (never synthetic `0` `within`).
 * 4. Candidate fallback (`01-05`): public launch fallback selection + single return commit vs missing collaborator refusal.
 * 5. Lane freeze (`01-06`): failed candidate freeze retains `active` lane and records retryable failure instead of closing.
 * 6. Contradictory exit (`02-04`): `reconcileBridgeTurnOutcome` refuses `success` + nonzero exit (`contradictory-exit`) and silent zero exit (`missing-terminal-record`).
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopOwnershipFenceForStore } from '../../src/activation/workflow-ownership-fence';
import { recordConnectedWorkflowTransition } from '../../src/activation/run-safety-wiring';
import type { BackendAvailabilityAdapter } from '../../src/contracts/backend-availability';
import type { BackendRunnerKind } from '../../src/contracts/backend-kinds';
import { MAX_LIVE_CONTROL_ROOTS } from '../../src/contracts/control-ledger';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import type { WorkflowLeafTarget } from '../../src/contracts/workflow-leaf-target';
import type { PipelineCatalog } from '../../src/config/pipeline-config';
import { SanitizedLogger } from '../../src/lib/logger';
import { QueueManager } from '../../src/queue/queue-manager';
import {
  BRIDGE_RPC_ERROR_CODES,
  reconcileBridgeTurnOutcome,
  rpcCodeForBridgeErrorStatus
} from '../../src/services/acp-runtime/terminal-reconciliation';
import { createRunLaneCoordinator, type LaneService } from '../../src/services/execution-lanes';
import { GuardedRunService } from '../../src/services/guarded-run-service';
import { parseDocumentBytes } from '../../src/services/process-yaml/yaml-parser';
import { parseWorkflowPackage } from '../../src/services/process-yaml/workflow-document';
import { phaseDefinitionFromDocument } from '../../src/services/process-yaml/phase-yaml-mapper';
import { evaluateSpend } from '../../src/services/spend-bound';
import { SqliteApplicationStore } from '../../src/services/sqlite-store';
import {
  createProductionWorkflowComposition,
  registerProductionWorkflowComposition,
  unregisterProductionWorkflowComposition
} from '../../src/services/workflow-execution/production-workflow-composition';
import { createWorkflowLeafControlHooks } from '../../src/services/workflow-execution/workflow-leaf-control';
import { launchWorkflow } from '../../src/services/workflow-execution/workflow-launcher';
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
    adapterId: `${kind}-repro`,
    adapterVersion: 1,
    backend: kind,
    statusCheck: 'supported',
    resolveQuotaContext: () => ({
      version: 1,
      adapterId: `${kind}-repro`,
      adapterVersion: 1,
      quotaIds: [`${kind}/default`],
      identity: 'qualified',
      statusCheck: 'supported'
    })
  };
}

describe('FR-R8-04 (04-06) — controlled-regression-vs-fix reproducers for all 6 Round 8 defects', () => {
  const disposers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (disposers.length > 0) {
      const fn = disposers.pop();
      if (fn !== undefined) await fn();
    }
  });

  it('1. Launch (R1): enforces MAX_LIVE_CONTROL_ROOTS = 20 before queue admission and persists parent+queue atomically', async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'schegent-repro-r1-'));
    const dbPath = path.join(tmpRoot, 'state.db');
    const ownershipDir = path.join(tmpRoot, '.schegent', 'ownership');
    const sqlite = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    const memento = createSwitchableOperationalMemento(createMemoryMemento());
    memento.attachSqlite(sqlite, 'repro-r1');
    const store = new WorkspaceStateStore(memento);
    store.useOwnershipStorage(createDiskOwnershipFs({ workspaceRoot: tmpRoot, ownershipDir }), ownershipDir);
    await store.initialize();
    const lock = new WorkspaceLockManager(store, 'win-r1', { now: () => Date.now() }, noopScheduler);
    expect((await lock.tryAcquire()).acquired).toBe(true);
    store.bindPrimacyClaimSource(lock);
    const lease = new ExecutionLeaseManager(store, 'win-r1', { now: () => Date.now() }, noopScheduler);
    store.bindRunClaimSource(lease);
    const queue = new QueueManager(store);
    const logger = new SanitizedLogger();
    const guardedRun = new GuardedRunService({
      isWorkspaceTrusted: () => true,
      lock,
      queue,
      controller: { getCatalog: makeEmptyCatalog },
      logger,
      store,
      catalogProvider: makeEmptyCatalog
    });
    const composition = createProductionWorkflowComposition({
      store,
      workspaceRoot: tmpRoot,
      isWorkspaceTrusted: () => true,
      ...createDesktopOwnershipFenceForStore(store),
      requireLiveFenceVerifier: true
    });
    registerProductionWorkflowComposition(store, composition);
    disposers.push(async () => {
      unregisterProductionWorkflowComposition(store, composition);
      composition.dispose();
      await lock.release();
      memento.detachSqlite();
      sqlite.close();
      await removeTempRoot(tmpRoot);
    });

    const phaseA: PhaseDefinition = { phaseId: 'p-a', version: 1, name: 'A', runner: 'claude', instruction: 'Run A' };
    const wfA: WorkflowDefinition = {
      workflowId: 'wf-cap',
      version: 1,
      name: 'Cap WF',
      startNodeIds: ['n-a'],
      nodes: [{ nodeId: 'n-a', kind: 'phase', phaseId: 'p-a' }],
      connections: [{ from: { nodeId: 'n-a' }, to: { nodeId: '', kind: 'return' }, handoff: 'auto', priority: 0 }]
    };

    for (let i = 1; i <= MAX_LIVE_CONTROL_ROOTS; i += 1) {
      const res = await launchWorkflow(
        { connectedRuns: store, isChildSettled: () => false, productionComposition: composition, logger, guardedRun },
        {
          connectedRunId: `conn-root-${i}`,
          workflow: wfA,
          catalog: makeEmptyCatalog(),
          effectiveWorkflows: [wfA],
          effectivePhases: [phaseA],
          startNodeId: 'n-a',
          request: { pipelineId: 'p-a', inputs: [], supplemental: [], outputs: [] },
          workspaceRoot: tmpRoot,
          startedAt: 1_000 + i
        }
      );
      expect(res.outcome).toBe('started');
      expect(store.getConnectedRun(`conn-root-${i}`)).not.toBeNull();
      expect(composition.ledgerStore.getRoot(`conn-root-${i}`)).not.toBeNull();
    }

    const itemsAtCap = store.getQueue('default').requests.length;
    expect(itemsAtCap).toBe(MAX_LIVE_CONTROL_ROOTS);

    const overflow = await launchWorkflow(
      { connectedRuns: store, isChildSettled: () => false, productionComposition: composition, logger, guardedRun },
      {
        connectedRunId: 'conn-root-21',
        workflow: wfA,
        catalog: makeEmptyCatalog(),
        effectiveWorkflows: [wfA],
        effectivePhases: [phaseA],
        startNodeId: 'n-a',
        request: { pipelineId: 'p-a', inputs: [], supplemental: [], outputs: [] },
        workspaceRoot: tmpRoot,
        startedAt: 2_000
      }
    );
    expect(overflow.outcome).toBe('rejected-queue');
    if (overflow.outcome === 'rejected-queue') {
      expect(overflow.refusal?.category).toBe('budget-exceeded');
      expect(overflow.refusal?.reasonCode).toBe('control-root-limit-exceeded');
    }
    expect(store.getQueue('default').requests.length).toBe(itemsAtCap);
    expect(store.getConnectedRun('conn-root-21')).toBeNull();
  });

  it('2. Orphan cancellation (R2): named WorkflowLeafTarget cancels exact task in queue while sibling survives (controlled swapped IDs miss)', async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'schegent-repro-r2-'));
    const ownershipDir = path.join(tmpRoot, '.schegent', 'ownership');
    const store = new WorkspaceStateStore(createMemoryMemento());
    store.useOwnershipStorage(createDiskOwnershipFs({ workspaceRoot: tmpRoot, ownershipDir }), ownershipDir);
    await store.initialize();
    const lock = new WorkspaceLockManager(store, 'win-r2', { now: () => Date.now() }, noopScheduler);
    expect((await lock.tryAcquire()).acquired).toBe(true);
    store.bindPrimacyClaimSource(lock);
    const lease = new ExecutionLeaseManager(store, 'win-r2', { now: () => Date.now() }, noopScheduler);
    store.bindRunClaimSource(lease);
    disposers.push(async () => {
      await lock.release();
      await removeTempRoot(tmpRoot);
    });

    const activeTasks = new Map<string, Set<string>>([['queue-B', new Set(['task-A', 'task-sibling'])]]);
    const endLeaf = vi.fn(async (target: WorkflowLeafTarget) => {
      activeTasks.get(target.queueId)?.delete(target.taskId);
    });

    const hooks = createWorkflowLeafControlHooks({
      controller: {
        isDriving: () => false,
        drainQueuedWork: async () => undefined,
        cancelPendingRetry: () => undefined,
        cancelActive: () => undefined
      } as never,
      endLeaf,
      executionLease: lease,
      store,
      logger: new SanitizedLogger()
    });

    await endLeaf({ queueId: 'task-A', taskId: 'queue-B' });
    expect(activeTasks.get('queue-B')?.has('task-A')).toBe(true);

    expect(hooks.cancelOrphanedQueueItem).toBeDefined();
    await hooks.cancelOrphanedQueueItem!({ queueId: 'queue-B', taskId: 'task-A' });
    expect(endLeaf).toHaveBeenLastCalledWith({ queueId: 'queue-B', taskId: 'task-A' });
    expect(activeTasks.get('queue-B')?.has('task-A')).toBe(false);
    expect(activeTasks.get('queue-B')?.has('task-sibling')).toBe(true);
  });

  it('3. Missing spend (R3): absent billable tokens return unmeasurable (never within), contrasting with synthetic-zero regression', () => {
    const tokenCap = { limitUsd: null, limitTokens: 5_000 };

    const syntheticZero = evaluateSpend(
      {
        costUsd: undefined,
        totalTokens: 0,
        completeness: { kind: 'complete' },
        countedRowIds: new Set()
      },
      tokenCap,
      'tokens'
    );
    expect(syntheticZero.kind).toBe('within');

    const absentTokens = evaluateSpend(
      {
        costUsd: undefined,
        totalTokens: undefined,
        completeness: { kind: 'complete' },
        countedRowIds: new Set()
      },
      tokenCap,
      'tokens'
    );
    expect(absentTokens).toEqual({
      kind: 'unmeasurable',
      denomination: 'tokens',
      reason: 'value-absent'
    });

    const exceeded = evaluateSpend(
      {
        costUsd: undefined,
        totalTokens: 5_001,
        completeness: { kind: 'complete' },
        countedRowIds: new Set()
      },
      tokenCap,
      'tokens'
    );
    expect(exceeded.kind).toBe('exceeded');
  });

  it('4. Candidate fallback (R7): shipped example falls back from failed primary to second candidate; missing executor refuses', async () => {
    const yamlPath = path.resolve(
      __dirname,
      '..',
      '..',
      'examples',
      'workflow-control',
      '02-candidate-block-recovery.workflow.yaml'
    );
    const parsedTree = parseDocumentBytes(await fsp.readFile(yamlPath));
    expect(parsedTree.ok).toBe(true);
    if (!parsedTree.ok) return;
    const pkg = parseWorkflowPackage(parsedTree.node);
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    const workflows: WorkflowDefinition[] = [];
    const phases: PhaseDefinition[] = [];
    for (const r of pkg.resources) {
      if (!r.ok) continue;
      if (r.resourceKind === 'workflow') workflows.push(r.definition);
      if (r.resourceKind === 'phase') phases.push(phaseDefinitionFromDocument(r.document));
    }
    const rootWf = workflows.at(0)!;

    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'schegent-repro-r7-'));
    const ownershipDir = path.join(tmpRoot, '.schegent', 'ownership');
    const store = new WorkspaceStateStore(createMemoryMemento());
    store.useOwnershipStorage(createDiskOwnershipFs({ workspaceRoot: tmpRoot, ownershipDir }), ownershipDir);
    await store.initialize();
    const lock = new WorkspaceLockManager(store, 'win-r7', { now: () => Date.now() }, noopScheduler);
    expect((await lock.tryAcquire()).acquired).toBe(true);
    store.bindPrimacyClaimSource(lock);
    const lease = new ExecutionLeaseManager(store, 'win-r7', { now: () => Date.now() }, noopScheduler);
    store.bindRunClaimSource(lease);
    expect((await lease.tryAcquire('default')).acquired).toBe(true);
    const queue = new QueueManager(store);
    const logger = new SanitizedLogger();
    const guardedRun = new GuardedRunService({
      isWorkspaceTrusted: () => true,
      lock,
      queue,
      controller: { getCatalog: makeEmptyCatalog },
      logger,
      store,
      catalogProvider: makeEmptyCatalog
    });

    const composition = createProductionWorkflowComposition({
      store,
      workspaceRoot: tmpRoot,
      isWorkspaceTrusted: () => true,
      ...createDesktopOwnershipFenceForStore(store),
      requireLiveFenceVerifier: true,
      getAvailabilityAdapter: makeReadyAvailabilityAdapter,
      resolveCandidateSpec: ({ phase }) => ({
        upperBoundMicrousd: 500_000,
        upperBoundQuality: 'verified',
        quotaIds: [`${phase.runner ?? 'claude'}/default`]
      })
    });
    for (const kind of ['claude', 'codex', 'agy'] as const) {
      await composition.recordAvailabilityWakeup({
        quotaId: `${kind}/default`,
        backend: kind,
        ready: true,
        capacity: 2
      });
    }
    disposers.push(async () => {
      composition.dispose();
      await lease.releaseAll();
      await lock.release();
      await removeTempRoot(tmpRoot);
    });

    const brokenComp = createProductionWorkflowComposition({
      store,
      workspaceRoot: tmpRoot,
      collaboratorOverrides: { candidateBlockExecutor: false }
    });
    const refused = await launchWorkflow(
      { connectedRuns: store, isChildSettled: () => true, productionComposition: brokenComp, logger, guardedRun },
      {
        connectedRunId: 'conn-cand-broken',
        workflow: rootWf,
        catalog: makeEmptyCatalog(),
        effectiveWorkflows: workflows,
        effectivePhases: phases,
        startNodeId: 'cand-primary-claude',
        request: {
          pipelineId: 'phase-review-claude',
          inputs: [{ portId: 'review-prompt', type: 'text', value: 'review diff' }],
          supplemental: [],
          outputs: [{ portId: 'review-json', target: 'review.json' }]
        },
        workspaceRoot: tmpRoot,
        startedAt: 10_000
      }
    );
    expect(refused.outcome).toBe('rejected-queue');
    expect(store.getQueue('default').requests.length).toBe(0);
    brokenComp.dispose();

    const launched = await launchWorkflow(
      { connectedRuns: store, isChildSettled: () => true, productionComposition: composition, logger, guardedRun },
      {
        connectedRunId: 'conn-cand-ok',
        workflow: rootWf,
        catalog: makeEmptyCatalog(),
        effectiveWorkflows: workflows,
        effectivePhases: phases,
        startNodeId: 'cand-primary-claude',
        request: {
          pipelineId: 'phase-review-claude',
          inputs: [{ portId: 'review-prompt', type: 'text', value: 'review diff' }],
          supplemental: [],
          outputs: [{ portId: 'review-json', target: 'review.json' }]
        },
        workspaceRoot: tmpRoot,
        startedAt: 10_100
      }
    );
    expect(launched.outcome).toBe('started');
    if (launched.outcome !== 'started') return;

    await composition.recordAvailabilityWakeup({
      quotaId: 'claude/default',
      backend: 'claude',
      ready: false,
      capacity: 0,
      resetAtWallMs: 120_000
    });
    const failedPrimary: WorkflowRun = {
      id: `leaf-${launched.queueItemId}`,
      featureId: launched.queueItemId,
      featureDir: `specs/${launched.queueItemId}`,
      status: 'failed',
      currentPhase: 'phase-review-claude',
      currentIteration: 1,
      startedAt: 10_100,
      lastTransitionAt: 10_200,
      phasesCompleted: [],
      lastError: { code: 'rate-limit', message: 'rate limit', phase: 'phase-review-claude', iteration: 1, at: 10_200 },
      pendingRetryAt: null,
      pendingRetryCause: null,
      creditPause: null,
      delayedRetryCount: 0,
      manualPauseAt: null,
      manualPauseCause: null,
      phaseOverrides: [],
      phaseBreakpoints: [],
      resumeTargetPhaseId: null
    };
    await store.setRun('default', failedPrimary, store.runClaimFor('default')!);
    await recordConnectedWorkflowTransition(
      {
        store,
        getGuardedRun: () => guardedRun,
        logger,
        workspaceRoot: tmpRoot,
        productionComposition: composition
      },
      failedPrimary
    );

    const requestsAfterFallback = store.getQueue('default').requests;
    expect(requestsAfterFallback).toHaveLength(2);
    const fallbackTask = requestsAfterFallback.at(1);
    expect(fallbackTask).toBeDefined();
    expect(fallbackTask?.runPlan?.pipeline.phases.at(0)?.id).toBe('phase-review-codex-fast');
    expect(fallbackTask?.runPlan?.pipeline.phases.at(0)?.runner).toBe('codex');

    const runAfterFallback = store.getConnectedRun('conn-cand-ok')!;
    const fallbackAttemptId =
      Object.values(runAfterFallback.invocations ?? {})
        .flatMap((frame) => frame.attemptsByNodeId['cand-second-codex'] ?? [])
        .at(0)?.attemptId ?? 'att-fallback';
    await fsp.writeFile(
      path.join(tmpRoot, 'review.json'),
      JSON.stringify({ attemptId: fallbackAttemptId, done: true, approved: true }),
      'utf8'
    );
    const fallbackSuccess: WorkflowRun = {
      id: `leaf-${fallbackTask!.id}`,
      featureId: fallbackTask!.id,
      featureDir: `specs/${fallbackTask!.id}`,
      status: 'completed',
      currentPhase: 'phase-review-codex-fast',
      currentIteration: 1,
      startedAt: 10_300,
      lastTransitionAt: 10_400,
      phasesCompleted: [],
      lastError: null,
      pendingRetryAt: null,
      pendingRetryCause: null,
      creditPause: null,
      delayedRetryCount: 0,
      manualPauseAt: null,
      manualPauseCause: null,
      phaseOverrides: [],
      phaseBreakpoints: [],
      resumeTargetPhaseId: null,
      runOutputs: [{ name: 'review-json', status: 'resolved', reference: 'review.json' }]
    };
    await store.setRun('default', fallbackSuccess, store.runClaimFor('default')!);
    await recordConnectedWorkflowTransition(
      {
        store,
        getGuardedRun: () => guardedRun,
        logger,
        workspaceRoot: tmpRoot,
        productionComposition: composition
      },
      fallbackSuccess
    );

    const settledCandidateRoot = store.getConnectedRun('conn-cand-ok')!;
    const settledLedgerRoot = composition.ledgerStore.getRoot('conn-cand-ok');
    expect(settledLedgerRoot?.status).toBe('completed');
    expect(store.getQueue('default').requests).toHaveLength(2);
    const rootNodeFrames = Object.values(settledCandidateRoot.invocations ?? {}).filter(
      (frame) => frame.parentInvocationId === null
    );
    expect(rootNodeFrames.at(0)?.attemptsByNodeId['cand-second-codex']).toHaveLength(1);
    expect(rootNodeFrames.at(0)?.attemptsByNodeId['cand-third-agy']).toBeUndefined();
  });

  it('5. Lane freeze (R8): failed candidate freeze retains active lane with recorded failure instead of closing to completed', async () => {
    const completeLane = vi.fn();
    const recordFreezeFailure = vi.fn();
    let shouldFailFreeze = true;

    const laneView = {
      laneId: 'lane-r8',
      workspaceId: 'ws-r8',
      runId: 'run-r8',
      state: 'active' as const,
      rootPath: '/tmp/lane-r8'
    };
    const mockLaneService = {
      getLane: ({ laneId }: { readonly laneId: string }) =>
        laneId === 'lane-r8'
          ? { ok: true as const, value: laneView }
          : { ok: false as const, refusal: { reason: 'lane-not-found' as const } },
      listLanes: () => ({
        ok: true as const,
        value: { items: [laneView], nextCursor: null }
      }),
      freezeCandidate: vi.fn(async () =>
        shouldFailFreeze
          ? { ok: false as const, refusal: { reason: 'git-commit-failed', message: 'dirty index' } }
          : { ok: true as const, value: { commitSha: 'abc1234' } }
      ),
      recordFreezeFailure,
      completeLane,
      listRequests: () => ({
        ok: true as const,
        value: { items: [], nextCursor: null }
      })
    } as unknown as LaneService;

    const coordinator = createRunLaneCoordinator({
      getLaneService: () => mockLaneService,
      isLanesEnabled: () => true,
      primaryWorkspaceRoot: '/tmp/ws'
    });

    await coordinator.onRunTerminal({ runId: 'run-r8', laneId: 'lane-r8', status: 'completed' });
    expect(recordFreezeFailure).toHaveBeenCalledWith({ laneId: 'lane-r8', reason: 'git-commit-failed' });
    expect(completeLane).not.toHaveBeenCalled();

    shouldFailFreeze = false;
    await coordinator.onRunTerminal({ runId: 'run-r8', laneId: 'lane-r8', status: 'completed' });
    expect(completeLane).toHaveBeenCalledTimes(1);
  });

  it('6. Contradictory exit (R6): refuses success event paired with nonzero exit and zero exit without terminal event', () => {
    const contradictory = reconcileBridgeTurnOutcome({
      backend: 'codex',
      isNativeReview: false,
      isSecurityReview: false,
      cancelled: false,
      exit: { code: 1, signal: null, launchFailed: false },
      terminalEvents: [{ kind: 'success', stopReason: 'end_turn' }],
      streamErrorText: null,
      lineOverflowed: false,
      pendingBacklogOverflowed: false
    });
    expect(contradictory.outcome).toBe('error');
    if (contradictory.outcome === 'error') {
      expect(contradictory.status).toBe('contradictory-exit');
      expect(rpcCodeForBridgeErrorStatus(contradictory.status)).toBe(
        BRIDGE_RPC_ERROR_CODES.contradictoryExit
      );
    }

    const missingRecord = reconcileBridgeTurnOutcome({
      backend: 'claude',
      isNativeReview: false,
      isSecurityReview: false,
      cancelled: false,
      exit: { code: 0, signal: null, launchFailed: false },
      terminalEvents: [],
      streamErrorText: null,
      lineOverflowed: false,
      pendingBacklogOverflowed: false
    });
    expect(missingRecord.outcome).toBe('error');
    if (missingRecord.outcome === 'error') {
      expect(missingRecord.status).toBe('missing-terminal-record');
      expect(rpcCodeForBridgeErrorStatus(missingRecord.status)).toBe(
        BRIDGE_RPC_ERROR_CODES.missingTerminalRecord
      );
    }

    const clean = reconcileBridgeTurnOutcome({
      backend: 'codex',
      isNativeReview: false,
      isSecurityReview: false,
      cancelled: false,
      exit: { code: 0, signal: null, launchFailed: false },
      terminalEvents: [{ kind: 'success', stopReason: 'end_turn' }],
      streamErrorText: null,
      lineOverflowed: false,
      pendingBacklogOverflowed: false
    });
    expect(clean).toEqual({ outcome: 'completed', stopReason: 'end_turn' });
  });
});
