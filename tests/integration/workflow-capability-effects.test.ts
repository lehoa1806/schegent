/**
 * FR-R8-04 (`04-01`) — Effect-observing acceptance suite connecting every
 * advertised workflow capability in `production-workflow-integration-matrix.md`
 * to real observable queue, SQLite store, control ledger, handoff, and operator
 * projection effects from supported public entry points.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDesktopOwnershipFenceForStore } from '../../src/activation/workflow-ownership-fence';
import { buildDurableHandoffSeam } from '../../src/activation/sqlite-cutover-helpers';
import { recordConnectedWorkflowTransition } from '../../src/activation/run-safety-wiring';
import type { BackendAvailabilityAdapter } from '../../src/contracts/backend-availability';
import type { BackendRunnerKind } from '../../src/contracts/backend-kinds';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import type { PipelineCatalog } from '../../src/config/pipeline-config';
import { launchComposableWorkflowRun } from '../../src/headless/workflow-run-api';
import { SanitizedLogger } from '../../src/lib/logger';
import { QueueManager } from '../../src/queue/queue-manager';
import {
  createArtifactLifecycleService,
  DENY_ALL_ACCESS_POLICY
} from '../../src/services/artifact-lifecycle';
import { GuardedRunService } from '../../src/services/guarded-run-service';
import {
  createPhaseHandoffCoordinator,
  createSqliteHandoffStore
} from '../../src/services/phase-context';
import { SqliteApplicationStore } from '../../src/services/sqlite-store';
import {
  createCutoverAuthorityGuard,
  createDesktopWorkflowComposition,
  createProductionWorkflowComposition,
  defaultCapabilityAssessment,
  registerProductionWorkflowComposition,
  unregisterProductionWorkflowComposition,
  type ProductionWorkflowComposition
} from '../../src/services/workflow-execution/production-workflow-composition';
import {
  launchWorkflow,
  type WorkflowLauncherDeps
} from '../../src/services/workflow-execution/workflow-launcher';
import { continueConnectedRun } from '../../src/services/workflow-execution/continuation-service';
import { isNodeStartable, projectConnectedRun } from '../../src/ui/sidebar/connected-run-projector';
import { resolveRootInvocationId } from '../../src/state/connected-workflow-run';
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

function makeTerminalRun(
  queueItemId: string,
  status: 'completed' | 'failed' | 'canceled',
  at: number,
  outputs?: WorkflowRun['runOutputs']
): WorkflowRun {
  return {
    id: `leaf-run-${queueItemId}`,
    featureId: queueItemId,
    featureDir: `specs/${queueItemId}`,
    status,
    currentPhase: 'exec',
    currentIteration: 1,
    startedAt: at - 50,
    lastTransitionAt: at,
    phasesCompleted: [],
    lastError:
      status === 'failed'
        ? { code: 'rate-limit', message: 'provider failure', phase: 'exec', iteration: 1, at }
        : null,
    pendingRetryAt: null,
    pendingRetryCause: null,
    creditPause: null,
    delayedRetryCount: 0,
    manualPauseAt: null,
    manualPauseCause: null,
    phaseOverrides: [],
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    ...(outputs !== undefined ? { runOutputs: outputs } : {})
  };
}

interface RealDesktopHarness {
  readonly tmpRoot: string;
  readonly workspaceRoot: string;
  readonly sqlite: SqliteApplicationStore;
  readonly store: WorkspaceStateStore;
  readonly lock: WorkspaceLockManager;
  readonly lease: ExecutionLeaseManager;
  readonly queue: QueueManager;
  readonly guardedRun: GuardedRunService;
  readonly composition: ProductionWorkflowComposition;
  readonly wakeups: Array<string | undefined>;
  readonly logger: SanitizedLogger;
  dispose(): Promise<void>;
}

async function createRealDesktopHarness(): Promise<RealDesktopHarness> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-r8-0401-'));
  const workspaceRoot = path.join(tmpRoot, 'workspace');
  const dbPath = path.join(tmpRoot, 'global', 'schegent-state.db');
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  const sqlite = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
  const memento = createSwitchableOperationalMemento(createMemoryMemento());
  memento.attachSqlite(sqlite, 'scope-0401');

  const logger = new SanitizedLogger();
  const ownershipDir = path.join(workspaceRoot, '.schegent', 'ownership');
  const store = new WorkspaceStateStore(memento);
  store.useOwnershipStorage(createDiskOwnershipFs({ workspaceRoot, ownershipDir }), ownershipDir);
  await store.initialize();
  const lock = new WorkspaceLockManager(store, 'win-primary', { now: () => Date.now() }, noopScheduler);
  const acquired = await lock.tryAcquire();
  if (!acquired.acquired) throw new Error('Failed to acquire workspace lock');
  store.bindPrimacyClaimSource(lock);
  const lease = new ExecutionLeaseManager(store, 'win-primary', { now: () => Date.now() }, noopScheduler);
  store.bindRunClaimSource(lease);
  const leaseAcquired = await lease.tryAcquire('default');
  if (!leaseAcquired.acquired) throw new Error('Failed to acquire default queue lease');
  const queue = new QueueManager(store);
  const guardedRun = new GuardedRunService({
    isWorkspaceTrusted: () => true,
    lock,
    queue,
    controller: { getCatalog: makeEmptyCatalog },
    logger,
    store,
    catalogProvider: makeEmptyCatalog
  });

  const artifactLifecycle = createArtifactLifecycleService({
    conn: sqlite.writerConnection,
    nowMs: () => Date.now(),
    fs: {
      stat: async () => null,
      unlink: async () => undefined,
      rmdirIfEmpty: async () => undefined
    } as never,
    probe: { probe: async () => ({ exists: false, sizeBytes: 0, mtimeMs: 0 }) } as never,
    byteReader: { readRange: async () => new Uint8Array() } as never,
    audit: { recordLifecycleMutation: () => undefined },
    scanRoots: [],
    accessPolicy: DENY_ALL_ACCESS_POLICY,
    resolveOwner: () => 'settled',
    workspaceRoot,
    workspaceId: 'scope-0401',
    pinnedRunIds: () => new Set()
  });

  const phaseHandoffCoordinator = createPhaseHandoffCoordinator({
    store: createSqliteHandoffStore(sqlite.writerConnection),
    primaryWorkspaceRoot: workspaceRoot,
    workspaceId: 'scope-0401',
    lifecycle: artifactLifecycle
  });
  const durableHandoffSeam = buildDurableHandoffSeam(artifactLifecycle, sqlite.writerConnection);
  const wakeups: Array<string | undefined> = [];

  const composition = createDesktopWorkflowComposition({
    store,
    workspaceRoot,
    isWorkspaceTrusted: () => true,
    ...createDesktopOwnershipFenceForStore(store),
    durableHandoffSeam,
    phaseHandoffCoordinator,
    cutoverAuthorityGuard: createCutoverAuthorityGuard({
      mode: 'post-cutover-strict',
      storeAuthority: 'sqlite-f04',
      runtimeAuthority: 'acp-f13'
    }),
    getAvailabilityAdapter: makeReadyAvailabilityAdapter,
    onScheduleQueueWakeup: (queueId) => {
      wakeups.push(queueId);
    },
    assessBackendCapability: (backendId, capability) =>
      capability === 'durable-handoff'
        ? Object.freeze({
            backendId,
            capability,
            status: 'verified' as const,
            source: 'fixture-adapter' as const,
            reasonCode: `capability-verified:${backendId}:durable-handoff`
          })
        : defaultCapabilityAssessment(backendId, capability)
  });
  registerProductionWorkflowComposition(store, composition);

  return {
    tmpRoot,
    workspaceRoot,
    sqlite,
    store,
    lock,
    lease,
    queue,
    guardedRun,
    composition,
    wakeups,
    logger,
    async dispose() {
      unregisterProductionWorkflowComposition(store, composition);
      composition.dispose();
      await lease.releaseAll();
      await lock.release();
      memento.detachSqlite();
      sqlite.close();
      await removeTempRoot(tmpRoot);
    }
  };
}

function makeLauncherDeps(
  harness: RealDesktopHarness,
  compOverride?: ProductionWorkflowComposition
): WorkflowLauncherDeps {
  const activeComp = compOverride ?? harness.composition;
  return {
    connectedRuns: harness.store,
    isChildSettled: (queueItemId) => {
      const found = harness.store.findRunByTask(queueItemId);
      const status = found?.run.status;
      return status === undefined || status === 'completed' || status === 'failed' || status === 'canceled';
    },
    productionComposition: activeComp,
    logger: harness.logger,
    guardedRun: harness.guardedRun
  };
}

describe('FR-R8-04 (04-01) — advertised workflow capabilities connected to real observed effects', () => {
  const disposers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (disposers.length > 0) {
      const fn = disposers.pop();
      if (fn !== undefined) await fn();
    }
  });

  it('freezes authored definitions at admission so mid-run catalog edits do not alter an in-flight run, while a fresh launch observes the edit', async () => {
    const h = await createRealDesktopHarness();
    disposers.push(() => h.dispose());

    const livePhases = new Map<string, PhaseDefinition>([
      ['p-step1', { phaseId: 'p-step1', version: 1, name: 'Step 1 v1', runner: 'claude', instruction: 'ORIGINAL_V1_STEP1' }],
      ['p-step2', { phaseId: 'p-step2', version: 1, name: 'Step 2 v1', runner: 'claude', instruction: 'ORIGINAL_V1_STEP2' }]
    ]);
    const liveWorkflows = new Map<string, WorkflowDefinition>([
      [
        'wf-two-step',
        {
          workflowId: 'wf-two-step',
          version: 1,
          name: 'Two-Step Workflow v1',
          startNodeIds: ['n1'],
          nodes: [
            { nodeId: 'n1', kind: 'phase', phaseId: 'p-step1' },
            { nodeId: 'n2', kind: 'phase', phaseId: 'p-step2' }
          ],
          connections: [
            { from: { nodeId: 'n1' }, to: { nodeId: 'n2', kind: 'node' }, handoff: 'auto', priority: 0 },
            { from: { nodeId: 'n2' }, to: { nodeId: '', kind: 'return' }, handoff: 'auto', priority: 0 }
          ]
        }
      ]
    ]);

    const launched = await launchWorkflow(makeLauncherDeps(h), {
      connectedRunId: 'conn-frozen-1',
      workflow: liveWorkflows.get('wf-two-step')!,
      catalog: makeEmptyCatalog(),
      effectiveWorkflows: [...liveWorkflows.values()],
      effectivePhases: [...livePhases.values()],
      startNodeId: 'n1',
      request: { pipelineId: 'p-step1', inputs: [], supplemental: [], outputs: [] },
      workspaceRoot: h.workspaceRoot,
      startedAt: 10_000
    });
    expect(launched.outcome).toBe('started');
    if (launched.outcome !== 'started') return;

    expect(h.queue.findById(launched.queueItemId)).not.toBeNull();
    expect(h.store.getConnectedRun('conn-frozen-1')).not.toBeNull();

    // Mutate the live catalog mid-run: change Step 2's instruction AND version
    livePhases.set('p-step2', {
      phaseId: 'p-step2',
      version: 2,
      name: 'Step 2 v2 (edited mid-run)',
      runner: 'codex',
      instruction: 'MUTATED_V2_STEP2'
    });
    liveWorkflows.set('wf-two-step', {
      ...liveWorkflows.get('wf-two-step')!,
      version: 2,
      name: 'Two-Step Workflow v2'
    });

    const step1Run = makeTerminalRun(launched.queueItemId, 'completed', 10_500);
    await h.store.setRun('default', step1Run, h.store.runClaimFor('default')!);
    await recordConnectedWorkflowTransition(
      {
        store: h.store,
        getGuardedRun: () => h.guardedRun,
        logger: h.logger,
        workspaceRoot: h.workspaceRoot,
        productionComposition: h.composition
      },
      step1Run
    );

    const afterStep1 = h.store.getConnectedRun('conn-frozen-1')!;
    const rootFrame = afterStep1.invocations?.[resolveRootInvocationId(afterStep1)];
    const step2Attempt = rootFrame?.attemptsByNodeId['n2']?.at(0);
    expect(step2Attempt).toBeDefined();
    const step2QueueId = step2Attempt?.queueItemId;
    expect(step2QueueId).toBeDefined();

    // Step 2 must have been queued with the ORIGINAL frozen v1 instruction, NOT the mid-run edit
    const step2Task = h.queue.findById(step2QueueId!);
    expect(step2Task).not.toBeNull();
    expect(step2Task?.runPlan?.pipeline.phases.at(0)?.instruction).toBe('ORIGINAL_V1_STEP2');
    expect(afterStep1.frozenClosure?.phasesById['p-step2']?.version).toBe(1);

    // A brand-new launch observes the mutated v2 catalog
    const secondLaunch = await launchWorkflow(makeLauncherDeps(h), {
      connectedRunId: 'conn-fresh-v2',
      workflow: liveWorkflows.get('wf-two-step')!,
      catalog: makeEmptyCatalog(),
      effectiveWorkflows: [...liveWorkflows.values()],
      effectivePhases: [...livePhases.values()],
      startNodeId: 'n1',
      request: { pipelineId: 'p-step1', inputs: [], supplemental: [], outputs: [] },
      workspaceRoot: h.workspaceRoot,
      startedAt: 11_000
    });
    expect(secondLaunch.outcome).toBe('started');
    const secondRun = h.store.getConnectedRun('conn-fresh-v2')!;
    expect(secondRun.frozenClosure?.phasesById['p-step2']?.instruction).toBe('MUTATED_V2_STEP2');
    expect(secondRun.frozenClosure?.phasesById['p-step2']?.version).toBe(2);
  });

  it('executes nested child Workflow + typed ResultOperator routing (rejecting invalid output and routing valid output)', async () => {
    const h = await createRealDesktopHarness();
    disposers.push(() => h.dispose());

    const checkPhase: PhaseDefinition = {
      phaseId: 'p-check',
      version: 1,
      name: 'Typed Check',
      runner: 'claude',
      instruction: 'Emit JSON verdict',
      resultContract: {
        version: 1,
        operator: 'structured-result',
        operatorVersion: 1,
        source: { kind: 'declared-output', outputKey: 'verdict-json' },
        fields: [
          {
            fieldId: 'verdict',
            type: 'string',
            required: true,
            selector: ['verdict']
          }
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
    };
    const afterPhase: PhaseDefinition = {
      phaseId: 'p-after',
      version: 1,
      name: 'After Child',
      runner: 'claude',
      instruction: 'Finish'
    };
    const childWf: WorkflowDefinition = {
      workflowId: 'wf-child',
      version: 1,
      name: 'Child Check Workflow',
      startNodeIds: ['child-check'],
      nodes: [{ nodeId: 'child-check', kind: 'phase', phaseId: 'p-check' }],
      connections: [
        { from: { nodeId: 'child-check' }, to: { nodeId: '', kind: 'return' }, handoff: 'auto', priority: 0 }
      ]
    };
    const parentWf: WorkflowDefinition = {
      workflowId: 'wf-parent',
      version: 1,
      name: 'Parent Nested Workflow',
      startNodeIds: ['call-child'],
      nodes: [
        { nodeId: 'call-child', kind: 'workflow', workflowId: 'wf-child' },
        { nodeId: 'finish', kind: 'phase', phaseId: 'p-after' }
      ],
      connections: [
        { from: { nodeId: 'call-child' }, to: { nodeId: 'finish', kind: 'node' }, handoff: 'auto', priority: 0 },
        { from: { nodeId: 'finish' }, to: { nodeId: '', kind: 'return' }, handoff: 'auto', priority: 0 }
      ]
    };

    const badPath = 'bad-verdict.json';
    await fs.writeFile(path.join(h.workspaceRoot, badPath), 'not valid json', 'utf8');
    const badEval = await h.composition.evaluateSettlementOutcome({
      attemptId: 'att-bad-json',
      workspaceRoot: h.workspaceRoot,
      status: 'completed',
      phase: checkPhase,
      runOutputs: [{ name: 'verdict-json', status: 'resolved', reference: badPath }]
    });
    expect(badEval.status).toBe('failed');
    expect(badEval.verdict).toBe('fail');
    expect(badEval.failureCode).toMatch(/^typed-result-/);

    const launched = await launchComposableWorkflowRun(makeLauncherDeps(h), {
      connectedRunId: 'conn-nested-1',
      request: {
        pipelineId: 'wf-parent',
        workflowId: 'wf-parent',
        entryNodeId: 'call-child',
        inputs: [],
        supplemental: [],
        outputs: []
      },
      workflowSource: {
        rootWorkflow: parentWf,
        workflows: [parentWf, childWf],
        phases: [checkPhase, afterPhase]
      },
      workspaceRoot: h.workspaceRoot,
      startedAt: 20_000
    });
    expect(launched.outcome).toBe('started');
    if (launched.outcome !== 'started') return;

    const afterLaunch = h.store.getConnectedRun('conn-nested-1')!;
    const childFrames = Object.values(afterLaunch.invocations ?? {}).filter(
      (f) => f.workflowId === 'wf-child'
    );
    expect(childFrames).toHaveLength(1);
    const childAttemptId = childFrames.at(0)?.attemptsByNodeId['child-check']?.at(0)?.attemptId ?? 'att-good';

    const goodPath = 'good-verdict.json';
    await fs.writeFile(
      path.join(h.workspaceRoot, goodPath),
      JSON.stringify({ attemptId: childAttemptId, verdict: 'pass' }),
      'utf8'
    );
    const childLeafRun = makeTerminalRun(launched.queueItemId, 'completed', 20_500, [
      { name: 'verdict-json', status: 'resolved', reference: goodPath }
    ]);
    await h.store.setRun('default', childLeafRun, h.store.runClaimFor('default')!);
    await recordConnectedWorkflowTransition(
      {
        store: h.store,
        getGuardedRun: () => h.guardedRun,
        logger: h.logger,
        workspaceRoot: h.workspaceRoot,
        productionComposition: h.composition
      },
      childLeafRun
    );

    const settled = h.store.getConnectedRun('conn-nested-1')!;
    const rootFrame = settled.invocations?.[resolveRootInvocationId(settled)];
    const finishAttempts = rootFrame?.attemptsByNodeId['finish'] ?? [];
    expect(finishAttempts).toHaveLength(1);
    const finishTaskId = finishAttempts.at(0)?.queueItemId;
    expect(finishTaskId).toBeDefined();
    expect(h.queue.findById(finishTaskId!)).not.toBeNull();
  });

  it('executes control-first ForEach root with frozen collection unaffected by mid-run edits, and enforces quota, strict-cost, cutover, missing-collaborator, and broken-dispatch refusals', async () => {
    const h = await createRealDesktopHarness();
    disposers.push(() => h.dispose());

    const collectionPath = 'batch.json';
    await fs.writeFile(
      path.join(h.workspaceRoot, collectionPath),
      JSON.stringify({ version: 1, items: [{ id: 'alpha' }, { id: 'beta' }] }),
      'utf8'
    );
    const itemPhase: PhaseDefinition = {
      phaseId: 'p-item',
      version: 1,
      name: 'Process Item',
      runner: 'claude',
      instruction: 'Process item'
    };
    const itemBodyWf: WorkflowDefinition = {
      workflowId: 'wf-item-body',
      version: 1,
      name: 'Item Body',
      inputs: [{ portId: 'item', label: 'Item', type: 'text', required: true }],
      startNodeIds: ['n-item'],
      nodes: [{ nodeId: 'n-item', kind: 'phase', phaseId: 'p-item' }],
      connections: [
        { from: { nodeId: 'n-item' }, to: { nodeId: '', kind: 'return' }, handoff: 'auto', priority: 0 }
      ]
    };
    const forEachWf: WorkflowDefinition = {
      workflowId: 'wf-foreach-root',
      version: 1,
      name: 'ForEach Root',
      startNodeIds: ['fe-node'],
      inputs: [{ portId: 'collection', label: 'Collection', type: 'local-file', required: true }],
      nodes: [
        {
          nodeId: 'fe-node',
          kind: 'workflow',
          workflowId: 'wf-item-body',
          control: {
            version: 1,
            kind: 'for-each',
            collection: { source: 'workflow-input', portId: 'collection' },
            itemInputPortId: 'item',
            maxItems: 10,
            onItemError: 'stop'
          }
        }
      ],
      connections: [
        { from: { nodeId: 'fe-node' }, to: { nodeId: '', kind: 'return' }, handoff: 'auto', priority: 0 }
      ]
    };

    const feLaunched = await launchComposableWorkflowRun(makeLauncherDeps(h), {
      connectedRunId: 'conn-fe-1',
      request: {
        pipelineId: 'wf-foreach-root',
        workflowId: 'wf-foreach-root',
        entryNodeId: 'fe-node',
        inputs: [{ portId: 'collection', type: 'local-file', value: collectionPath }],
        supplemental: [],
        outputs: []
      },
      workflowSource: {
        rootWorkflow: forEachWf,
        workflows: [forEachWf, itemBodyWf],
        phases: [itemPhase]
      },
      workspaceRoot: h.workspaceRoot,
      startedAt: 30_000
    });
    expect(feLaunched.outcome).toBe('started');
    if (feLaunched.outcome !== 'started') return;

    // Mutate collection on disk mid-run; frozen 2-item snapshot still drives item 2
    await fs.writeFile(
      path.join(h.workspaceRoot, collectionPath),
      JSON.stringify({ version: 1, items: [{ id: 'mutated-1' }, { id: 'mutated-2' }, { id: 'mutated-3' }] }),
      'utf8'
    );

    const item1Run = makeTerminalRun(feLaunched.queueItemId, 'completed', 30_200);
    await h.store.setRun('default', item1Run, h.store.runClaimFor('default')!);
    await recordConnectedWorkflowTransition(
      {
        store: h.store,
        getGuardedRun: () => h.guardedRun,
        logger: h.logger,
        workspaceRoot: h.workspaceRoot,
        productionComposition: h.composition
      },
      item1Run
    );

    const afterItem1 = h.store.getConnectedRun('conn-fe-1')!;
    const itemFrames = Object.values(afterItem1.invocations ?? {}).filter(
      (f) => f.workflowId === 'wf-item-body'
    );
    expect(itemFrames).toHaveLength(2);
    const secondItemQueueId = itemFrames.at(1)?.attemptsByNodeId['n-item']?.at(0)?.queueItemId;
    expect(secondItemQueueId).toBeDefined();
    expect(h.queue.findById(secondItemQueueId!)).not.toBeNull();

    // Quota availability wakeup records observation and schedules wakeup without direct spawn
    const wakeRes = await h.composition.recordAvailabilityWakeup({
      quotaId: 'claude/default',
      backend: 'claude',
      ready: true,
      capacity: 1,
      queueId: 'default'
    });
    expect(wakeRes.observationRecorded).toBe(true);
    expect(wakeRes.schedulerNotified).toBe(true);
    expect(wakeRes.spawnedDirectly).toBe(false);
    expect(h.wakeups).toContain('default');

    // Strict-cost enforcement refuses unqualified live pricing with 0 attempts consumed
    const strictCheck = h.composition.verifyPreAdmission({
      entryPointId: 'ui.launchWorkflow',
      rootExecutionId: 'conn-strict-usd',
      requiredCapabilities: [
        { backendId: 'codex', capability: 'strict-cost', requireLiveQualification: true }
      ],
      isWorkspaceTrusted: true,
      isFenceValid: true
    });
    expect(strictCheck.allowed).toBe(false);
    if (!strictCheck.allowed) {
      expect(strictCheck.refusal.category).toBe('unsupported-capability');
      expect(strictCheck.refusal.attemptsConsumed).toBe(0);
    }

    // Post-cutover authority guard allows sqlite-f04 + acp-f13 and refuses Memento or retired CLI fallback
    expect(h.composition.cutoverAuthorityGuard.verifyAuthority({ entryPointId: 'ui.launchWorkflow' }).allowed).toBe(true);
    const retiredCliGuard = createCutoverAuthorityGuard({
      mode: 'post-cutover-strict',
      storeAuthority: 'sqlite-f04',
      runtimeAuthority: 'cli-runner'
    });
    expect(retiredCliGuard.verifyAuthority({ entryPointId: 'ui.launchWorkflow' }).allowed).toBe(false);
    const retiredMementoGuard = createCutoverAuthorityGuard({
      mode: 'post-cutover-strict',
      storeAuthority: 'memento-bridged',
      runtimeAuthority: 'acp-f13'
    });
    expect(retiredMementoGuard.verifyAuthority({ entryPointId: 'ui.launchWorkflow' }).allowed).toBe(false);

    // Missing required collaborator fails acceptance with 0 new queue items
    const queueCountBefore = h.store.getQueue('default').requests.length;
    const missingForEachComp = createProductionWorkflowComposition({
      store: h.store,
      workspaceRoot: h.workspaceRoot,
      collaboratorOverrides: { forEachExecutor: false }
    });
    const refusedLaunch = await launchComposableWorkflowRun(makeLauncherDeps(h, missingForEachComp), {
      connectedRunId: 'conn-missing-foreach',
      request: {
        pipelineId: 'wf-foreach-root',
        workflowId: 'wf-foreach-root',
        entryNodeId: 'fe-node',
        inputs: [{ portId: 'collection', type: 'local-file', value: collectionPath }],
        supplemental: [],
        outputs: []
      },
      workflowSource: {
        rootWorkflow: forEachWf,
        workflows: [forEachWf, itemBodyWf],
        phases: [itemPhase]
      },
      workspaceRoot: h.workspaceRoot,
      startedAt: 31_000
    });
    expect(refusedLaunch.outcome).toBe('rejected-queue');
    if (refusedLaunch.outcome === 'rejected-queue') {
      expect(refusedLaunch.refusal?.category).toBe('missing-collaborator');
      expect(refusedLaunch.refusal?.attemptsConsumed).toBe(0);
    }
    expect(h.store.getQueue('default').requests.length).toBe(queueCountBefore);
    expect(h.store.getConnectedRun('conn-missing-foreach')).toBeNull();
    missingForEachComp.dispose();

    // Broken dispatch refuses cleanly and leaves zero orphaned parent or queue item
    const brokenDeps: WorkflowLauncherDeps = {
      ...makeLauncherDeps(h),
      guardedRun: {
        scheduleOrEnqueue: async () => ({ outcome: 'rejected-paused', detail: 'simulated-dispatch-refusal' })
      } as unknown as GuardedRunService
    };
    const brokenLaunch = await launchComposableWorkflowRun(brokenDeps, {
      connectedRunId: 'conn-broken-dispatch',
      request: {
        pipelineId: 'wf-foreach-root',
        workflowId: 'wf-foreach-root',
        entryNodeId: 'fe-node',
        inputs: [{ portId: 'collection', type: 'local-file', value: collectionPath }],
        supplemental: [],
        outputs: []
      },
      workflowSource: {
        rootWorkflow: forEachWf,
        workflows: [forEachWf, itemBodyWf],
        phases: [itemPhase]
      },
      workspaceRoot: h.workspaceRoot,
      startedAt: 32_000
    });
    expect(brokenLaunch.outcome).toBe('rejected-queue');
    expect(h.store.getQueue('default').requests.length).toBe(queueCountBefore);
    expect(h.store.getConnectedRun('conn-broken-dispatch')).toBeNull();
  });

  it('exercises Repeat iteration, candidate-block fallback, manual continueConnectedRun + phase handoff fail-closed refusal, and durableHandoffSeam qualification', async () => {
    const h = await createRealDesktopHarness();
    disposers.push(() => h.dispose());

    // 1. Scoped child-Workflow Repeat: advances from iteration 1 -> iteration 2 when score < 95, and refuses when repeatExecutor is absent
    const scorePhase: PhaseDefinition = {
      phaseId: 'p-score',
      version: 1,
      name: 'Score Phase',
      runner: 'claude',
      instruction: 'Emit score JSON',
      resultContract: {
        version: 1,
        operator: 'structured-result',
        operatorVersion: 1,
        source: { kind: 'declared-output', outputKey: 'score-json' },
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
    };
    const repeatBodyWf: WorkflowDefinition = {
      workflowId: 'wf-repeat-body',
      version: 1,
      name: 'Repeat Body',
      startNodeIds: ['score-node'],
      nodes: [{ nodeId: 'score-node', kind: 'phase', phaseId: 'p-score' }],
      decisionResults: {
        version: 1,
        fields: [
          { fieldId: 'verdict', type: 'string', required: true },
          { fieldId: 'score', type: 'number', required: true }
        ],
        bindings: [
          { fieldId: 'verdict', source: { kind: 'node-result', nodeId: 'score-node', fieldId: 'verdict' } },
          { fieldId: 'score', source: { kind: 'node-result', nodeId: 'score-node', fieldId: 'score' } }
        ]
      },
      connections: [{ from: { nodeId: 'score-node' }, to: { nodeId: '', kind: 'return' }, handoff: 'auto', priority: 0 }]
    };
    const repeatRootWf: WorkflowDefinition = {
      workflowId: 'wf-repeat-root',
      version: 1,
      name: 'Repeat Root',
      startNodeIds: ['repeat-node'],
      nodes: [
        {
          nodeId: 'repeat-node',
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
                left: { source: 'result-field', fieldId: 'score' },
                operator: 'equals',
                right: 95
              }
            },
            carry: []
          }
        }
      ],
      connections: [{ from: { nodeId: 'repeat-node' }, to: { nodeId: '', kind: 'return' }, handoff: 'auto', priority: 0 }]
    };

    const missingRepeatComp = createProductionWorkflowComposition({
      store: h.store,
      workspaceRoot: h.workspaceRoot,
      collaboratorOverrides: { repeatExecutor: false }
    });
    const refusedRepeat = await launchComposableWorkflowRun(makeLauncherDeps(h, missingRepeatComp), {
      connectedRunId: 'conn-repeat-refused',
      request: { pipelineId: 'wf-repeat-root', workflowId: 'wf-repeat-root', entryNodeId: 'repeat-node', inputs: [], supplemental: [], outputs: [] },
      workflowSource: { rootWorkflow: repeatRootWf, workflows: [repeatRootWf, repeatBodyWf], phases: [scorePhase] },
      workspaceRoot: h.workspaceRoot,
      startedAt: 40_000
    });
    expect(refusedRepeat.outcome).toBe('rejected-queue');
    if (refusedRepeat.outcome === 'rejected-queue') {
      expect(refusedRepeat.refusal?.category).toBe('missing-collaborator');
      expect(refusedRepeat.refusal?.attemptsConsumed).toBe(0);
    }
    expect(h.store.getQueue('default').requests).toHaveLength(0);
    missingRepeatComp.dispose();

    const repeatLaunch = await launchComposableWorkflowRun(makeLauncherDeps(h), {
      connectedRunId: 'conn-repeat-1',
      request: { pipelineId: 'wf-repeat-root', workflowId: 'wf-repeat-root', entryNodeId: 'repeat-node', inputs: [], supplemental: [], outputs: [] },
      workflowSource: { rootWorkflow: repeatRootWf, workflows: [repeatRootWf, repeatBodyWf], phases: [scorePhase] },
      workspaceRoot: h.workspaceRoot,
      startedAt: 40_100
    });
    expect(repeatLaunch.outcome).toBe('started');
    if (repeatLaunch.outcome !== 'started') return;

    const repeatRun1 = h.store.getConnectedRun('conn-repeat-1')!;
    const repeatBodyFrame1 = Object.values(repeatRun1.invocations ?? {}).find((f) => f.workflowId === 'wf-repeat-body');
    const iter1AttemptId = repeatBodyFrame1?.attemptsByNodeId['score-node']?.at(0)?.attemptId ?? 'att-r1';
    const scoreFile = 'repeat-score-1.json';
    await fs.writeFile(
      path.join(h.workspaceRoot, scoreFile),
      JSON.stringify({ attemptId: iter1AttemptId, verdict: 'pass', score: 50 }),
      'utf8'
    );
    const iter1Run = makeTerminalRun(repeatLaunch.queueItemId, 'completed', 40_200, [
      { name: 'score-json', status: 'resolved', reference: scoreFile }
    ]);
    await h.store.setRun('default', iter1Run, h.store.runClaimFor('default')!);
    await recordConnectedWorkflowTransition(
      { store: h.store, getGuardedRun: () => h.guardedRun, logger: h.logger, workspaceRoot: h.workspaceRoot, productionComposition: h.composition },
      iter1Run
    );
    const afterIter1 = h.store.getConnectedRun('conn-repeat-1')!;
    const repeatFrames = Object.values(afterIter1.invocations ?? {}).filter((f) => f.workflowId === 'wf-repeat-body');
    expect(repeatFrames).toHaveLength(2);
    const iter2QueueId = repeatFrames.at(1)?.attemptsByNodeId['score-node']?.at(0)?.queueItemId;
    expect(iter2QueueId).toBeDefined();
    expect(h.queue.findById(iter2QueueId!)).not.toBeNull();

    // 2. Candidate recovery block: primary failure falls back to second candidate; missing collaborator refuses
    const candPhasePrimary: PhaseDefinition = { phaseId: 'p-cand-claude', version: 1, name: 'Primary', runner: 'claude', instruction: 'Primary attempt' };
    const candPhaseFallback: PhaseDefinition = { phaseId: 'p-cand-codex', version: 1, name: 'Fallback', runner: 'codex', instruction: 'Fallback attempt' };
    const candWf: WorkflowDefinition = {
      workflowId: 'wf-cand-block',
      version: 1,
      name: 'Candidate Block',
      startNodeIds: ['cand-primary', 'cand-fallback'],
      nodes: [
        { nodeId: 'cand-primary', kind: 'phase', phaseId: 'p-cand-claude' },
        { nodeId: 'cand-fallback', kind: 'phase', phaseId: 'p-cand-codex' }
      ],
      control: {
        version: 1,
        kind: 'candidate-block',
        candidates: [
          { candidateId: 'c1', nodeId: 'cand-primary', priority: 1, maxAttempts: 1, allowUnverifiedTrial: false },
          { candidateId: 'c2', nodeId: 'cand-fallback', priority: 2, maxAttempts: 1, allowUnverifiedTrial: false }
        ],
        availabilityPolicy: 'first-ready',
        maxDispatches: 5,
        monitoringWindowMs: 60_000
      },
      connections: []
    };

    for (const kind of ['claude', 'codex'] as const) {
      await h.composition.recordAvailabilityWakeup({ quotaId: `${kind}/default`, backend: kind, ready: true, capacity: 2 });
    }
    const queueBeforeCand = h.store.getQueue('default').requests.length;
    const missingCandComp = createProductionWorkflowComposition({
      store: h.store,
      workspaceRoot: h.workspaceRoot,
      collaboratorOverrides: { candidateBlockExecutor: false }
    });
    const refusedCand = await launchWorkflow(makeLauncherDeps(h, missingCandComp), {
      connectedRunId: 'conn-cand-refused',
      workflow: candWf,
      catalog: makeEmptyCatalog(),
      effectiveWorkflows: [candWf],
      effectivePhases: [candPhasePrimary, candPhaseFallback],
      startNodeId: 'cand-primary',
      request: { pipelineId: 'p-cand-claude', inputs: [], supplemental: [], outputs: [] },
      workspaceRoot: h.workspaceRoot,
      startedAt: 41_000
    });
    expect(refusedCand.outcome).toBe('rejected-queue');
    if (refusedCand.outcome === 'rejected-queue') {
      expect(refusedCand.refusal?.category).toBe('missing-collaborator');
      expect(refusedCand.refusal?.attemptsConsumed).toBe(0);
    }
    expect(h.store.getQueue('default').requests).toHaveLength(queueBeforeCand);
    missingCandComp.dispose();

    const candLaunch = await launchWorkflow(makeLauncherDeps(h), {
      connectedRunId: 'conn-cand-live',
      workflow: candWf,
      catalog: makeEmptyCatalog(),
      effectiveWorkflows: [candWf],
      effectivePhases: [candPhasePrimary, candPhaseFallback],
      startNodeId: 'cand-primary',
      request: { pipelineId: 'p-cand-claude', inputs: [], supplemental: [], outputs: [] },
      workspaceRoot: h.workspaceRoot,
      startedAt: 41_100
    });
    expect(candLaunch.outcome).toBe('started');
    if (candLaunch.outcome !== 'started') return;

    await h.composition.recordAvailabilityWakeup({ quotaId: 'claude/default', backend: 'claude', ready: false, capacity: 0, resetAtWallMs: 90_000 });
    const candPrimaryFail = makeTerminalRun(candLaunch.queueItemId, 'failed', 41_200);
    await h.store.setRun('default', candPrimaryFail, h.store.runClaimFor('default')!);
    await recordConnectedWorkflowTransition(
      { store: h.store, getGuardedRun: () => h.guardedRun, logger: h.logger, workspaceRoot: h.workspaceRoot, productionComposition: h.composition },
      candPrimaryFail
    );
    const candRequests = h.store.getQueue('default').requests;
    expect(candRequests).toHaveLength(queueBeforeCand + 2);
    expect(candRequests.at(-1)?.runPlan?.pipeline.phases.at(0)?.id).toBe('p-cand-codex');
    expect(candRequests.at(-1)?.runPlan?.pipeline.phases.at(0)?.runner).toBe('codex');

    // 3. Manual continuation via continueConnectedRun + phaseHandoffCoordinator fail-closed refusal on absent/unapproved handoff
    const manualPhaseA: PhaseDefinition = { phaseId: 'p-man-a', version: 1, name: 'Manual A', runner: 'claude', instruction: 'Step A' };
    const manualPhaseB: PhaseDefinition = { phaseId: 'p-man-b', version: 1, name: 'Manual B', runner: 'claude', instruction: 'Step B' };
    const manualWf: WorkflowDefinition = {
      workflowId: 'wf-manual-handoff',
      version: 1,
      name: 'Manual Handoff WF',
      startNodeIds: ['man-a'],
      nodes: [
        { nodeId: 'man-a', kind: 'phase', phaseId: 'p-man-a' },
        { nodeId: 'man-b', kind: 'phase', phaseId: 'p-man-b' }
      ],
      connections: [
        { from: { nodeId: 'man-a' }, to: { nodeId: 'man-b', kind: 'node' }, handoff: 'manual', priority: 0 },
        { from: { nodeId: 'man-b' }, to: { nodeId: '', kind: 'return' }, handoff: 'auto', priority: 0 }
      ]
    };
    const manualLaunch = await launchWorkflow(makeLauncherDeps(h), {
      connectedRunId: 'conn-manual-1',
      workflow: manualWf,
      catalog: makeEmptyCatalog(),
      effectiveWorkflows: [manualWf],
      effectivePhases: [manualPhaseA, manualPhaseB],
      startNodeId: 'man-a',
      request: { pipelineId: 'p-man-a', inputs: [], supplemental: [], outputs: [] },
      workspaceRoot: h.workspaceRoot,
      startedAt: 42_000
    });
    expect(manualLaunch.outcome).toBe('started');
    if (manualLaunch.outcome !== 'started') return;
    const manualRunA = makeTerminalRun(manualLaunch.queueItemId, 'completed', 42_100);
    await h.store.setRun('default', manualRunA, h.store.runClaimFor('default')!);
    await recordConnectedWorkflowTransition(
      { store: h.store, getGuardedRun: () => h.guardedRun, logger: h.logger, workspaceRoot: h.workspaceRoot, productionComposition: h.composition },
      manualRunA
    );
    const manualBeforeContinue = h.store.getConnectedRun('conn-manual-1')!;
    const contRes = await continueConnectedRun(
      {
        connectedRuns: {
          get: (id) => h.store.getConnectedRun(id),
          compareAndSetConnectedRun: (next, rev) => h.store.compareAndSetConnectedRun(next, rev),
          readChildState: (qId) => {
            const st = h.store.findRunByTask(qId)?.run.status;
            return st === 'completed' || st === 'failed' || st === 'canceled' ? st : 'in-flight';
          }
        },
        guardedRun: h.guardedRun,
        logger: h.logger,
        productionComposition: h.composition,
        projectRun: projectConnectedRun,
        isNodeStartable
      },
      {
        payload: {
          connectedRunId: 'conn-manual-1',
          expectedRevision: manualBeforeContinue.revision,
          operation: 'continue-handoff',
          nodeId: 'man-b',
          request: { pipelineId: 'p-man-b', inputs: [], supplemental: [], outputs: [] }
        },
        workspaceRoot: h.workspaceRoot,
        startedAt: 42_200
      }
    );
    expect(contRes.outcome).toBe('started');

    const missingHandoffDelivery = await h.composition.phaseHandoffCoordinator!.planAndAuthorizeAttemptDelivery({
      runId: 'conn-manual-1',
      handoffId: 'handoff-does-not-exist',
      targetAttemptId: 'att-unapproved-1',
      targetNodePath: '/man-b',
      targetOccurrenceId: 'occ-1',
      targetInstructions: 'Consume unapproved handoff',
      backendId: 'claude'
    });
    expect(missingHandoffDelivery.ok).toBe(false);

    // 4. Durable artifact handover seam: qualified in desktop composition (verifying real SQLite artifact store) vs refused when absent
    expect(h.composition.durableHandoffSeam.status).toBe('qualified');
    const qualifiedEmptyHandover = h.composition.durableHandoffSeam.requestHandover({
      rootExecutionId: 'conn-manual-1',
      invocationId: 'inv-1',
      artifactIds: []
    });
    expect(qualifiedEmptyHandover).toEqual({ accepted: true });

    const missingArtifactHandover = h.composition.durableHandoffSeam.requestHandover({
      rootExecutionId: 'conn-manual-1',
      invocationId: 'inv-1',
      artifactIds: ['missing-artifact-id']
    });
    expect(missingArtifactHandover.accepted).toBe(false);
    expect(missingArtifactHandover.refusal).toMatchObject({
      category: 'missing-collaborator',
      reasonCode: 'durable-handoff-artifact-unavailable:not-found',
      attemptsConsumed: 0
    });

    const defaultComp = createProductionWorkflowComposition({ store: h.store, workspaceRoot: h.workspaceRoot });
    const unqualifiedHandover = defaultComp.durableHandoffSeam.requestHandover({
      rootExecutionId: 'conn-manual-1',
      invocationId: 'inv-1',
      artifactIds: []
    });
    expect(unqualifiedHandover.accepted).toBe(false);
    expect(unqualifiedHandover.refusal).toMatchObject({
      category: 'unsupported-capability',
      reasonCode: 'durable-handoff-not-qualified',
      attemptsConsumed: 0
    });
    defaultComp.dispose();
  });
});
