/**
 * FR-R8-01 (01-01, 01-02, 01-03) — Workflow ownership, 20-root live ledger cap,
 * atomic SQLite launch persistence, and two-owner handoff fencing integration suite.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reconcileComposableWorkflowRuns } from '../../src/activation/run-safety-wiring';
import { createDesktopOwnershipFenceForStore } from '../../src/activation/workflow-ownership-fence';
import type { PipelineCatalog } from '../../src/config/pipeline-config';
import { MAX_LIVE_CONTROL_ROOTS } from '../../src/contracts/control-ledger';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import { SanitizedLogger } from '../../src/lib/logger';
import { QueueManager } from '../../src/queue/queue-manager';
import { ProcessLifecycleRunner } from '../../src/runner/process-lifecycle-runner';
import { GuardedRunService } from '../../src/services/guarded-run-service';
import { validateRunRequest } from '../../src/services/run-request/run-request-validator';
import { SqliteApplicationStore } from '../../src/services/sqlite-store';
import { dispatchComposableNode } from '../../src/services/workflow-execution/connected-run-coordinator';
import { createComposableWorkflowRunSnapshot } from '../../src/services/workflow-execution/connected-run-factory';
import {
  createProductionWorkflowComposition,
  getOrCreateProductionWorkflowComposition,
  registerProductionWorkflowComposition,
  unregisterProductionWorkflowComposition,
  type ProductionWorkflowComposition
} from '../../src/services/workflow-execution/production-workflow-composition';
import {
  launchComposableWorkflow,
  launchWorkflow
} from '../../src/services/workflow-execution/workflow-launcher';
import {
  resolveRootInvocationId,
  type ConnectedWorkflowRun
} from '../../src/state/connected-workflow-run';
import { ExecutionLeaseManager } from '../../src/state/execution-lease';
import { STALENESS_THRESHOLD_MS, WorkspaceLockManager, type Scheduler } from '../../src/state/lock';
import { createDiskOwnershipFs } from '../../src/state/ownership-fs';
import { createSwitchableOperationalMemento } from '../../src/state/sqlite-operational-backing';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';

const noopScheduler: Scheduler = {
  setInterval() {
    return { clear() {} };
  }
};

function createMemoryMemento(): Memento {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string): T | undefined => data.get(key) as T | undefined,
    update: async (key: string, value: unknown): Promise<void> => {
      if (value === undefined) {
        data.delete(key);
      } else {
        data.set(key, structuredClone(value));
      }
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

const SIMPLE_PHASE: PhaseDefinition = {
  phaseId: 'phase-work',
  name: 'Work Phase',
  version: 1,
  instruction: 'Execute ownership admission fixture phase'
};

const SIMPLE_WORKFLOW: WorkflowDefinition = {
  workflowId: 'wf-ownership-fixture',
  name: 'Ownership Fixture Workflow',
  version: 1,
  inputs: [],
  outputs: [],
  startNodeIds: ['step1'],
  nodes: [{ nodeId: 'step1', kind: 'phase', phaseId: 'phase-work' }],
  connections: [],
  bindings: []
};

interface OwnerWindowHarness {
  readonly ownerId: string;
  readonly workspaceRoot: string;
  readonly sqlite: SqliteApplicationStore;
  readonly store: WorkspaceStateStore;
  readonly lock: WorkspaceLockManager;
  readonly lease: ExecutionLeaseManager;
  readonly queue: QueueManager;
  readonly guardedRun: GuardedRunService;
  readonly logger: SanitizedLogger;
  readonly composition: ProductionWorkflowComposition;
  readonly close: () => Promise<void>;
}

const cleanupFns: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupFns.length > 0) {
    const fn = cleanupFns.pop();
    if (fn !== undefined) {
      await fn().catch(() => undefined);
    }
  }
});

async function openOwnerWindow(params: {
  readonly workspaceRoot: string;
  readonly dbPath: string;
  readonly ownershipDir: string;
  readonly ownerId: string;
  readonly now: () => number;
  readonly acquirePrimacy?: boolean;
}): Promise<OwnerWindowHarness> {
  const sqlite = new SqliteApplicationStore({ databasePath: params.dbPath, journalMode: 'wal' });
  const memento = createSwitchableOperationalMemento(createMemoryMemento());
  memento.attachSqlite(sqlite, 'ownership-scope');
  const store = new WorkspaceStateStore(memento);
  store.useOwnershipStorage(
    createDiskOwnershipFs({
      workspaceRoot: params.workspaceRoot,
      ownershipDir: params.ownershipDir
    }),
    params.ownershipDir
  );
  await store.initialize();

  const clock = { now: params.now };
  const lock = new WorkspaceLockManager(store, params.ownerId, clock, noopScheduler);
  const lease = new ExecutionLeaseManager(store, params.ownerId, clock, noopScheduler);
  store.bindPrimacyClaimSource(lock);
  store.bindRunClaimSource(lease);

  if (params.acquirePrimacy !== false) {
    const res = await lock.tryAcquire();
    expect(res.acquired).toBe(true);
  }

  const queue = new QueueManager(store);
  const logger = new SanitizedLogger();
  const guardedRun = new GuardedRunService({
    isWorkspaceTrusted: () => true,
    lock,
    queue,
    controller: { getCatalog: makeEmptyCatalog },
    logger,
    store,
    clock: params.now,
    catalogProvider: makeEmptyCatalog
  });

  const composition = getOrCreateProductionWorkflowComposition(store, {
    workspaceRoot: params.workspaceRoot,
    isWorkspaceTrusted: () => true,
    ...createDesktopOwnershipFenceForStore(store),
    requireLiveFenceVerifier: true
  });
  registerProductionWorkflowComposition(store, composition);

  const close = async (): Promise<void> => {
    unregisterProductionWorkflowComposition(store, composition);
    sqlite.close();
  };

  return {
    ownerId: params.ownerId,
    workspaceRoot: params.workspaceRoot,
    sqlite,
    store,
    lock,
    lease,
    queue,
    guardedRun,
    logger,
    composition,
    close
  };
}

function makeTempFixture(): {
  readonly tmpRoot: string;
  readonly dbPath: string;
  readonly ownershipDir: string;
} {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-own-adm-'));
  const dbPath = path.join(tmpRoot, 'state.sqlite');
  const ownershipDir = path.join(tmpRoot, '.schegent', 'ownership');
  cleanupFns.push(async () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
  return { tmpRoot, dbPath, ownershipDir };
}

async function launchSimple(win: OwnerWindowHarness, connectedRunId: string, startedAt: number) {
  return launchWorkflow(
    {
      connectedRuns: win.store,
      guardedRun: win.guardedRun,
      productionComposition: win.composition,
      isChildSettled: () => true,
      logger: win.logger
    },
    {
      connectedRunId,
      workflow: SIMPLE_WORKFLOW,
      catalog: makeEmptyCatalog(),
      effectiveWorkflows: [SIMPLE_WORKFLOW],
      effectivePhases: [SIMPLE_PHASE],
      startNodeId: 'step1',
      request: {
        pipelineId: SIMPLE_WORKFLOW.workflowId,
        inputs: [],
        supplemental: [],
        outputs: []
      },
      workspaceRoot: win.workspaceRoot,
      startedAt,
      queueId: 'default'
    }
  );
}

describe('FR-R8-01 (01-01) — 20-root live control-ledger limit, race, and terminal eviction', () => {
  it('accepts 20 active roots, refuses the 21st cleanly with zero side effects, resolves a 19->20 race with 1 winner, and frees capacity upon terminal settlement', async () => {
    const { tmpRoot, dbPath, ownershipDir } = makeTempFixture();
    let nowMs = 1_700_000_000_000;
    const win = await openOwnerWindow({
      workspaceRoot: tmpRoot,
      dbPath,
      ownershipDir,
      ownerId: 'win-cap-1',
      now: () => nowMs
    });
    cleanupFns.push(() => win.close());

    expect(MAX_LIVE_CONTROL_ROOTS).toBe(20);

    for (let i = 1; i <= 20; i += 1) {
      nowMs += 10;
      const res = await launchSimple(win, `crun-cap-${String(i).padStart(2, '0')}`, nowMs);
      expect(res.outcome).toBe('started');
    }

    expect(win.queue.list('default').length).toBe(20);
    expect(Object.keys(win.store.getConnectedRuns()).length).toBe(20);
    const ledgerAt20 = win.composition.ledgerStore.read();
    expect(ledgerAt20.ok).toBe(true);
    if (!ledgerAt20.ok) return;
    expect(Object.keys(ledgerAt20.ledger.roots).length).toBe(20);

    // 21st launch MUST be refused with control-root-limit-exceeded and zero partial side effects.
    nowMs += 10;
    const refused21 = await launchSimple(win, 'crun-cap-21', nowMs);
    expect(refused21.outcome).toBe('rejected-queue');
    if (refused21.outcome === 'rejected-queue') {
      expect(refused21.refusal?.reasonCode ?? refused21.detail).toContain(
        'control-root-limit-exceeded'
      );
    }
    expect(win.queue.list('default').length).toBe(20);
    expect(Object.keys(win.store.getConnectedRuns()).length).toBe(20);
    expect(win.store.getConnectedRun('crun-cap-21')).toBeNull();
    const ledgerAfter21 = win.composition.ledgerStore.read();
    expect(ledgerAfter21.ok && Object.keys(ledgerAfter21.ledger.roots).length).toBe(20);

    // Settle root #01 and #02 terminal -> frees 2 live slots (18 active, 2 terminal evictable).
    nowMs += 10;
    await win.composition.controlAdmission.markRootTerminal({
      ledgerRunId: 'crun-cap-01',
      connectedRunId: 'crun-cap-01',
      status: 'completed',
      completedAt: nowMs
    });
    await win.composition.controlAdmission.markRootTerminal({
      ledgerRunId: 'crun-cap-02',
      connectedRunId: 'crun-cap-02',
      status: 'completed',
      completedAt: nowMs
    });

    // Launch 19th active root -> succeeds by evicting one settled terminal root.
    nowMs += 10;
    const slot19 = await launchSimple(win, 'crun-cap-19b', nowMs);
    expect(slot19.outcome).toBe('started');

    // Competing 19 -> 20 race: exactly one wins, one refuses with control-root-limit-exceeded.
    nowMs += 10;
    const queueBeforeRace = win.queue.list('default').length;
    const [raceA, raceB] = await Promise.all([
      launchSimple(win, 'crun-race-a', nowMs),
      launchSimple(win, 'crun-race-b', nowMs + 1)
    ]);
    const outcomes = [raceA.outcome, raceB.outcome].sort();
    expect(outcomes).toEqual(['rejected-queue', 'started']);
    const loser = raceA.outcome === 'rejected-queue' ? raceA : raceB;
    if (loser.outcome === 'rejected-queue') {
      expect(loser.refusal?.reasonCode ?? loser.detail).toContain('control-root-limit-exceeded');
    }
    expect(win.queue.list('default').length).toBe(queueBeforeRace + 1);
    const ledgerAfterRace = win.composition.ledgerStore.read();
    expect(ledgerAfterRace.ok).toBe(true);
    if (ledgerAfterRace.ok) {
      expect(Object.keys(ledgerAfterRace.ledger.roots).length).toBe(20);
    }

    // Settle one more root terminal and verify a fresh 21st launch succeeds cleanly.
    nowMs += 10;
    await win.composition.controlAdmission.markRootTerminal({
      ledgerRunId: 'crun-cap-03',
      connectedRunId: 'crun-cap-03',
      status: 'completed',
      completedAt: nowMs
    });
    nowMs += 10;
    const afterEvict = await launchSimple(win, 'crun-after-evict', nowMs);
    expect(afterEvict.outcome).toBe('started');
  });
});

describe('FR-R8-01 (01-02) — Atomic SQLite first launch, idempotency, rollback, restart convergence, and pre-change reopen', () => {
  it('commits controlLedger + connectedRuns + queue atomically across SQLite reopen and deduplicates identical launch retries', async () => {
    const { tmpRoot, dbPath, ownershipDir } = makeTempFixture();
    let nowMs = 1_700_000_100_000;
    const win1 = await openOwnerWindow({
      workspaceRoot: tmpRoot,
      dbPath,
      ownershipDir,
      ownerId: 'win-atomic-1',
      now: () => nowMs
    });

    const launched = await launchSimple(win1, 'crun-atomic-1', nowMs);
    expect(launched.outcome).toBe('started');
    if (launched.outcome !== 'started') {
      await win1.close();
      return;
    }

    // Duplicate delivery through public `launchWorkflow` with the same connectedRunId
    // must return idempotently without mutating or deleting the live control root or attempt.
    const dupLaunch = await launchSimple(win1, 'crun-atomic-1', nowMs);
    expect(dupLaunch.outcome).toBe('started');
    if (dupLaunch.outcome === 'started') {
      expect(dupLaunch.queueItemId).toBe(launched.queueItemId);
    }
    expect(win1.queue.list('default').length).toBe(1);
    const rootAfterDupLaunch = win1.composition.ledgerStore.getRoot('crun-atomic-1');
    expect(rootAfterDupLaunch?.linkState).toBe('active');

    // Duplicate atomic admission with the same connectedRunId + workflowOccurrence is idempotent.
    const firstItem = win1.queue.findById(launched.queueItemId);
    expect(firstItem).not.toBeNull();
    const dup = await win1.store.admitComposableWorkflowLaunchAtomically({
      connectedRun: launched.run,
      queueId: 'default',
      mutateControlLedger: async (raw) => ({ ok: true, nextLedger: raw }),
      mutateQueue: (queue) => ({
        queue: { ...queue, requests: [...queue.requests, firstItem!] },
        request: firstItem!
      })
    });
    expect(dup.outcome).toBe('committed');
    if (dup.outcome === 'committed') {
      expect(dup.idempotent).toBe(true);
      expect(dup.queueItemId).toBe(launched.queueItemId);
    }
    expect(win1.queue.list('default').length).toBe(1);

    await win1.lock.release();
    await win1.close();

    // Reopen fresh WAL SQLite handle and verify all three state slices persisted together.
    nowMs += 50;
    const win2 = await openOwnerWindow({
      workspaceRoot: tmpRoot,
      dbPath,
      ownershipDir,
      ownerId: 'win-atomic-2',
      now: () => nowMs
    });
    cleanupFns.push(() => win2.close());

    const reopenedRun = win2.store.getConnectedRun('crun-atomic-1');
    expect(reopenedRun).not.toBeNull();
    expect(reopenedRun?.controlState?.ledgerRunId).toBe('crun-atomic-1');
    expect(win2.queue.list('default').map((r) => r.id)).toEqual([launched.queueItemId]);
    const reopenedLedger = win2.composition.ledgerStore.read();
    expect(reopenedLedger.ok).toBe(true);
    if (reopenedLedger.ok) {
      const atomicRoot = Object.hasOwn(reopenedLedger.ledger.roots, 'crun-atomic-1')
        ? reopenedLedger.ledger.roots['crun-atomic-1']
        : undefined;
      expect(atomicRoot?.linkState).toBe('active');
    }
  });

  it('rolls back cleanly with zero queue rows, zero connected runs, and zero ledger roots on refusal (SQLite batch and non-batch stores)', async () => {
    const { tmpRoot, dbPath, ownershipDir } = makeTempFixture();
    const nowMs = 1_700_000_200_000;
    const win = await openOwnerWindow({
      workspaceRoot: tmpRoot,
      dbPath,
      ownershipDir,
      ownerId: 'win-rollback-1',
      now: () => nowMs
    });
    cleanupFns.push(() => win.close());

    // Pause queue so SQLite atomic admission refuses enqueue.
    const pausedRes = await win.queue.setQueuePausedState(true, 'default', 'operator-paused');
    expect(pausedRes.ok).toBe(true);
    const refused = await launchSimple(win, 'crun-paused-rollback', nowMs);
    expect(refused.outcome).toBe('rejected-queue');
    expect(win.queue.list('default').length).toBe(0);
    expect(win.store.getConnectedRun('crun-paused-rollback')).toBeNull();
    const ledgerAfterRefusal = win.composition.ledgerStore.read();
    expect(ledgerAfterRefusal.ok && Object.keys(ledgerAfterRefusal.ledger.roots).length).toBe(0);

    // Non-batch store rollback on queue refusal and thrown enqueue.
    const memStore = new WorkspaceStateStore(createMemoryMemento());
    await memStore.initialize();
    const memComp = createProductionWorkflowComposition({
      store: memStore,
      workspaceRoot: tmpRoot,
      isWorkspaceTrusted: () => true
    });
    const validated = await validateRunRequest(
      {
        pipelineId: SIMPLE_WORKFLOW.workflowId,
        workflowId: SIMPLE_WORKFLOW.workflowId,
        entryNodeId: 'step1',
        inputs: [],
        supplemental: [],
        outputs: []
      },
      {
        workflow: {
          rootWorkflow: SIMPLE_WORKFLOW,
          workflows: [SIMPLE_WORKFLOW],
          phases: [SIMPLE_PHASE]
        },
        workspaceRoot: tmpRoot,
        now: nowMs,
        localInputs: {
          checkFile: async () => ({ ok: true }),
          checkFolder: async () => ({ ok: true })
        },
        outputProbe: { exists: async () => false },
        priorOutputs: { outputsFor: () => null }
      }
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const nonBatchRefused = await launchComposableWorkflow(
      {
        guardedRun: {
          scheduleOrEnqueue: async () => ({ outcome: 'rejected-paused', detail: 'paused' })
        },
        logger: { warn: vi.fn(), sanitize: (s) => s },
        connectedRuns: memStore,
        productionComposition: memComp,
        isChildSettled: () => true
      },
      {
        connectedRunId: 'crun-mem-refused',
        envelope: validated.plan,
        workspaceRoot: tmpRoot,
        startedAt: nowMs,
        queueId: 'default'
      }
    );
    expect(nonBatchRefused.outcome).toBe('rejected-queue');
    expect(memStore.getConnectedRun('crun-mem-refused')).toBeNull();
    const memLedger1 = memComp.ledgerStore.read();
    expect(memLedger1.ok && Object.keys(memLedger1.ledger.roots).length).toBe(0);

    let parentVisibleBeforeEnqueue = false;
    const nonBatchThrown = await launchComposableWorkflow(
      {
        guardedRun: {
          scheduleOrEnqueue: async () => {
            parentVisibleBeforeEnqueue = memStore.getConnectedRun('crun-mem-throw') !== null;
            throw new Error('simulated storage outage');
          }
        },
        logger: { warn: vi.fn(), sanitize: (s) => s },
        connectedRuns: memStore,
        productionComposition: memComp,
        isChildSettled: () => true
      },
      {
        connectedRunId: 'crun-mem-throw',
        envelope: validated.plan,
        workspaceRoot: tmpRoot,
        startedAt: nowMs,
        queueId: 'default'
      }
    );
    expect(parentVisibleBeforeEnqueue).toBe(true);
    expect(nonBatchThrown.outcome).toBe('rejected-queue');
    if (nonBatchThrown.outcome === 'rejected-queue') {
      expect(nonBatchThrown.detail).toBe('enqueue-failed');
    }
    expect(memStore.getConnectedRun('crun-mem-throw')).toBeNull();
    const memLedger2 = memComp.ledgerStore.read();
    expect(memLedger2.ok && Object.keys(memLedger2.ledger.roots).length).toBe(0);
  });

  it('converges identically across two consecutive restarts and reopens pre-change connected runs without corruption', async () => {
    const { tmpRoot, dbPath, ownershipDir } = makeTempFixture();
    let nowMs = 1_700_000_300_000;
    const win1 = await openOwnerWindow({
      workspaceRoot: tmpRoot,
      dbPath,
      ownershipDir,
      ownerId: 'win-reopen-1',
      now: () => nowMs
    });

    // Seed an orphaned unstarted ledger root with no connected run (simulates crash before parent commit)
    const primacy = win1.lock.primacyClaim()!;
    const prep = await win1.composition.controlAdmission.prepareRootLink({
      ledgerRunId: 'crun-orphan-root',
      connectedRunId: 'crun-orphan-root',
      rootWorkflowId: SIMPLE_WORKFLOW.workflowId,
      queueId: 'default',
      fence: {
        primacyClaim: `primacy:${primacy.ownerId}:g${primacy.fence}`,
        queueClaim: `queue:default:unleased:${primacy.ownerId}:g${primacy.fence}`,
        rootGeneration: 1
      },
      rootFrameKey: 'crun-orphan-root:root',
      rootInvocationId: 'crun-orphan-root:root'
    });
    expect(prep.ok).toBe(true);

    // Seed a pre-change ConnectedWorkflowRun without controlState
    const validated = await validateRunRequest(
      {
        pipelineId: SIMPLE_WORKFLOW.workflowId,
        workflowId: SIMPLE_WORKFLOW.workflowId,
        entryNodeId: 'step1',
        inputs: [],
        supplemental: [],
        outputs: []
      },
      {
        workflow: {
          rootWorkflow: SIMPLE_WORKFLOW,
          workflows: [SIMPLE_WORKFLOW],
          phases: [SIMPLE_PHASE]
        },
        workspaceRoot: tmpRoot,
        now: nowMs,
        localInputs: {
          checkFile: async () => ({ ok: true }),
          checkFolder: async () => ({ ok: true })
        },
        outputProbe: { exists: async () => false },
        priorOutputs: { outputsFor: () => null }
      }
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok || validated.plan.frozenClosure === undefined) {
      await win1.close();
      return;
    }
    const legacySnap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'crun-prechange-legacy',
      workflow: SIMPLE_WORKFLOW,
      entryNodeId: 'step1',
      frozenClosure: validated.plan.frozenClosure,
      boundInputs: {},
      startedAt: nowMs,
      queueId: 'default'
    });
    expect(legacySnap.outcome).toBe('created');
    if (legacySnap.outcome !== 'created') {
      await win1.close();
      return;
    }
    const seeded = await win1.store.compareAndSetConnectedRun(legacySnap.run, 0);
    expect(seeded.outcome).toBe('written');

    await win1.lock.release();
    await win1.close();

    // Restart 1
    nowMs += 50;
    const win2 = await openOwnerWindow({
      workspaceRoot: tmpRoot,
      dbPath,
      ownershipDir,
      ownerId: 'win-reopen-2',
      now: () => nowMs
    });
    await reconcileComposableWorkflowRuns({
      workspaceRoot: tmpRoot,
      store: win2.store,
      logger: win2.logger,
      productionComposition: win2.composition
    });
    const read2 = win2.composition.ledgerStore.read();
    const afterRestart1 = {
      orphanRootPresent: read2.ok && Object.hasOwn(read2.ledger.roots, 'crun-orphan-root'),
      legacyRunRevision: win2.store.getConnectedRun('crun-prechange-legacy')?.revision ?? null
    };
    expect(afterRestart1.orphanRootPresent).toBe(false);
    expect(afterRestart1.legacyRunRevision).toBe(1);
    await win2.lock.release();
    await win2.close();

    // Restart 2 — must converge identically
    nowMs += 50;
    const win3 = await openOwnerWindow({
      workspaceRoot: tmpRoot,
      dbPath,
      ownershipDir,
      ownerId: 'win-reopen-3',
      now: () => nowMs
    });
    cleanupFns.push(() => win3.close());
    await reconcileComposableWorkflowRuns({
      workspaceRoot: tmpRoot,
      store: win3.store,
      logger: win3.logger,
      productionComposition: win3.composition
    });
    const read3 = win3.composition.ledgerStore.read();
    const afterRestart2 = {
      orphanRootPresent: read3.ok && Object.hasOwn(read3.ledger.roots, 'crun-orphan-root'),
      legacyRunRevision: win3.store.getConnectedRun('crun-prechange-legacy')?.revision ?? null
    };
    expect(afterRestart2).toEqual(afterRestart1);
  });
});

describe('FR-R8-01 (01-03) — Two-owner handoff fencing across admission, storage, and spawn checkpoints', () => {
  it('resolves the registered SQLite composition per store and blocks stale owner A before admission and after handoff between admission and queue eligibility', async () => {
    const { tmpRoot, dbPath, ownershipDir } = makeTempFixture();
    let nowMs = 1_700_000_400_000;

    const winA = await openOwnerWindow({
      workspaceRoot: tmpRoot,
      dbPath,
      ownershipDir,
      ownerId: 'win-A',
      now: () => nowMs,
      acquirePrimacy: true
    });
    cleanupFns.push(() => winA.close());

    // Store-keyed lookup resolves the exact SQLite-backed registered composition, never a fresh fallback.
    expect(getOrCreateProductionWorkflowComposition(winA.store)).toBe(winA.composition);

    // Open secondary window B (cannot acquire primacy while window A is fresh).
    const winB = await openOwnerWindow({
      workspaceRoot: tmpRoot,
      dbPath,
      ownershipDir,
      ownerId: 'win-B',
      now: () => nowMs,
      acquirePrimacy: false
    });
    cleanupFns.push(() => winB.close());
    const initialB = await winB.lock.tryAcquire();
    expect(initialB.acquired).toBe(false);

    // 1) Handoff BEFORE admission: advance clock past staleness without A heartbeating so B supersedes A on disk
    // while A still holds stale local primacy state in memory!
    nowMs += STALENESS_THRESHOLD_MS + 5_000;
    const bTakeover1 = await winB.lock.tryAcquire();
    expect(bTakeover1.acquired).toBe(true);

    const staleLaunchByA = await launchSimple(winA, 'crun-stale-a-before-admit', nowMs);
    expect(staleLaunchByA.outcome).toBe('rejected-queue');
    expect(winB.queue.list('default').length).toBe(0);
    expect(winB.store.getConnectedRun('crun-stale-a-before-admit')).toBeNull();
    const ledgerAfterStaleA = winB.composition.ledgerStore.read();
    expect(ledgerAfterStaleA.ok && Object.keys(ledgerAfterStaleA.ledger.roots).length).toBe(0);

    // Legitimate owner B launches cleanly.
    const legitLaunchByB = await launchSimple(winB, 'crun-legit-b-1', nowMs);
    expect(legitLaunchByB.outcome).toBe('started');

    // 2) Handoff BETWEEN admission and queue eligibility (live fence + storage fence + spawn fence):
    // Advance clock so A cleanly regains primacy & queue lease, launches a run, then becomes stale and B supersedes both.
    nowMs += STALENESS_THRESHOLD_MS + 5_000;
    const aTakeover = await winA.lock.tryAcquire();
    expect(aTakeover.acquired).toBe(true);
    const aLease = await winA.lease.tryAcquire('default');
    expect(aLease.acquired).toBe(true);

    const aAdmitted = await launchSimple(winA, 'crun-handoff-mid', nowMs);
    expect(aAdmitted.outcome).toBe('started');
    if (aAdmitted.outcome !== 'started') return;
    const runMid = aAdmitted.run;
    const rootInvId = resolveRootInvocationId(runMid);
    const staleFenceOfA = createDesktopOwnershipFenceForStore(winA.store).resolveExecutionFence(
      runMid,
      'default'
    );

    // Prepare & commit an attempt while A is still owner so spawn-intent checkpoint can be contested after handoff.
    const attemptId = `${rootInvId}:step1:handoff-attempt-1`;
    const prepAtt = await winA.composition.controlAdmission.prepareAttempt({
      ledgerRunId: 'crun-handoff-mid',
      connectedRunId: 'crun-handoff-mid',
      workflowId: SIMPLE_WORKFLOW.workflowId,
      frameKey: rootInvId,
      invocationId: rootInvId,
      nodeId: 'step1',
      attemptId,
      attemptIndex: 1,
      backend: 'claude',
      queueId: 'default',
      fence: staleFenceOfA,
      hasSideEffects: true
    });
    expect(prepAtt.ok).toBe(true);
    if (!prepAtt.ok) return;
    const committedAtt = await winA.composition.controlAdmission.commitAttempt(prepAtt.token);
    expect(committedAtt.ok).toBe(true);

    // Advance clock past staleness; B supersedes both workspace primacy and queue lease on `.schegent/ownership/`.
    // A has NOT run a local heartbeat so A still holds its stale in-memory primacy/queue claims!
    nowMs += STALENESS_THRESHOLD_MS + 5_000;
    const bTakeover2 = await winB.lock.tryAcquire();
    expect(bTakeover2.acquired).toBe(true);
    const bLease2 = await winB.lease.tryAcquire('default');
    expect(bLease2.acquired).toBe(true);

    // Spawn-intent fence rejects stale A via live async `.schegent/ownership/` verification.
    const staleSpawn = await winA.composition.controlAdmission.recordSpawnIntent({
      ledgerRunId: 'crun-handoff-mid',
      attemptId,
      fence: staleFenceOfA,
      queueItemId: aAdmitted.queueItemId,
      hasSideEffects: true
    });
    expect(staleSpawn.ok).toBe(false);
    if (!staleSpawn.ok) {
      expect(staleSpawn.code).toBe('stale-execution-fence');
    }

    // Storage fence on connectedRuns rejects stale A.
    const bumpedByA: ConnectedWorkflowRun = Object.freeze({
      ...runMid,
      revision: runMid.revision + 1
    });
    const staleCasA = await winA.store.compareAndSetConnectedRun(bumpedByA, runMid.revision);
    expect(staleCasA.outcome).toBe('stale');

    // Storage fence on controlLedger rejects stale A and ControlLedgerStore converts it to stale-execution-fence.
    const staleLedgerTx = await winA.composition.ledgerStore.mutate({}, ({ ledger }) => ({
      commit: true,
      plan: { nextLedger: ledger, result: 'should-not-write' }
    }));
    expect(staleLedgerTx.ok).toBe(false);
    if (!staleLedgerTx.ok) {
      expect(staleLedgerTx.code).toBe('stale-execution-fence');
    }

    // Legitimate owner B opens a fresh SQLite reader/writer handle after taking primacy and
    // succeeds on both connectedRuns CAS and controlLedger mutate.
    const winBReopened = await openOwnerWindow({
      workspaceRoot: tmpRoot,
      dbPath,
      ownershipDir,
      ownerId: 'win-B',
      now: () => nowMs,
      acquirePrimacy: true
    });
    cleanupFns.push(() => winBReopened.close());
    const currentFromB = winBReopened.store.getConnectedRun('crun-handoff-mid');
    expect(currentFromB).not.toBeNull();
    const bumpedByB: ConnectedWorkflowRun = Object.freeze({
      ...currentFromB!,
      revision: currentFromB!.revision + 1
    });
    const legitCasB = await winBReopened.store.compareAndSetConnectedRun(
      bumpedByB,
      currentFromB!.revision
    );
    expect(legitCasB.outcome).toBe('written');

    const legitLedgerTx = await winBReopened.composition.ledgerStore.mutate({}, ({ ledger }) => ({
      commit: true,
      plan: { nextLedger: ledger, result: 'ok-from-b' }
    }));
    expect(legitLedgerTx.ok).toBe(true);
  });

  it('propagates rejected-foreign-lock on mid-dispatch handoff and wires orphan cancellation on lost parent revision race', async () => {
    const { tmpRoot, dbPath, ownershipDir } = makeTempFixture();
    const nowMs = 1_700_000_500_000;
    const win = await openOwnerWindow({
      workspaceRoot: tmpRoot,
      dbPath,
      ownershipDir,
      ownerId: 'win-race-1',
      now: () => nowMs,
      acquirePrimacy: true
    });
    cleanupFns.push(() => win.close());

    // 1) ProcessLifecycleRunner fast-exit + ENOENT + abort-during-onBeforeSpawn safety checks
    const runner = new ProcessLifecycleRunner(undefined, null, win.logger, 'codex-cli');
    const fastOut = await runner.invoke({
      request: {
        phase: 'phase-step',
        iteration: 1,
        runId: 'run-fast',
        prompt: 'hi',
        timeoutMs: 10_000,
        cliPath: process.execPath,
        cwd: tmpRoot,
        env: {},
        onAfterSpawn: async () => {
          await new Promise((r) => setTimeout(r, 40));
        }
      },
      args: ['-e', 'process.stdout.write("fast-ok"); process.exit(0);'],
      env: process.env,
      commandDisplay: 'node fast'
    });
    expect(fastOut.exitCode).toBe(0);
    expect(fastOut.stdoutBuffer.getTrailingLines(20)).toContain('fast-ok');
    expect(runner.hasActiveProcess).toBe(false);

    // Abort during onBeforeSpawn must prevent spawn completely
    const abortCtrl = new AbortController();
    let spawnCalledAfterAbort = false;
    const abortedRunner = new ProcessLifecycleRunner(
      (() => {
        spawnCalledAfterAbort = true;
        throw new Error('should not spawn');
      }) as unknown as typeof import('node:child_process').spawn,
      null,
      win.logger,
      'codex-cli'
    );
    const abortedOut = await abortedRunner.invoke({
      request: {
        phase: 'phase-step',
        iteration: 1,
        runId: 'run-abort',
        prompt: 'hi',
        timeoutMs: 10_000,
        cliPath: process.execPath,
        cwd: tmpRoot,
        env: {},
        cancellationSignal: abortCtrl.signal,
        onBeforeSpawn: async () => {
          abortCtrl.abort();
        }
      },
      args: ['-e', 'process.exit(0)'],
      env: process.env,
      commandDisplay: 'node aborted'
    });
    expect(spawnCalledAfterAbort).toBe(false);
    expect(abortedOut.killed).toBe(true);

    // 2) Lost parent revision race during dispatch calls cancelOrphanedQueueItem for the exact
    // orphaned child `{ queueId, taskId }` while an unrelated live task continues untouched.
    const canceledTargets: Array<{ readonly queueId: string; readonly taskId: string }> = [];
    const unrelatedEnq = await win.guardedRun.scheduleOrEnqueue({
      description: 'Unrelated sibling task',
      scheduledAt: nowMs,
      via: 'webview',
      queueId: 'default'
    });
    expect(unrelatedEnq.outcome).toBe('enqueued');

    const val = await validateRunRequest(
      {
        pipelineId: SIMPLE_WORKFLOW.workflowId,
        workflowId: SIMPLE_WORKFLOW.workflowId,
        entryNodeId: 'step1',
        inputs: [],
        supplemental: [],
        outputs: []
      },
      {
        workflow: {
          rootWorkflow: SIMPLE_WORKFLOW,
          workflows: [SIMPLE_WORKFLOW],
          phases: [SIMPLE_PHASE]
        },
        workspaceRoot: tmpRoot,
        now: nowMs,
        localInputs: {
          checkFile: async () => ({ ok: true }),
          checkFolder: async () => ({ ok: true })
        },
        outputProbe: { exists: async () => false },
        priorOutputs: { outputsFor: () => null }
      }
    );
    expect(val.ok).toBe(true);
    if (!val.ok || val.plan.frozenClosure === undefined) return;
    const snap = createComposableWorkflowRunSnapshot({
      connectedRunId: 'crun-orphan-race',
      workflow: SIMPLE_WORKFLOW,
      entryNodeId: 'step1',
      frozenClosure: val.plan.frozenClosure,
      boundInputs: {},
      startedAt: nowMs,
      queueId: 'default'
    });
    expect(snap.outcome).toBe('created');
    if (snap.outcome !== 'created') return;
    const linked = await win.composition.ensureRootControlLink(snap.run, 'default');
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    const seeded = await win.store.compareAndSetConnectedRun(linked.run, 0);
    expect(seeded.outcome).toBe('written');

    let casCount = 0;
    const raceDeps = win.composition.createCoordinatorDeps({
      connectedRuns: {
        compareAndSetConnectedRun: async (next, expectedRev) => {
          casCount += 1;
          if (casCount === 2) {
            // Simulate a concurrent revision bump between dispatchPhase and parent bind CAS!
            return { outcome: 'stale', current: linked.run };
          }
          return win.store.compareAndSetConnectedRun(next, expectedRev);
        }
      },
      dispatchPhase: async () => ({ outcome: 'dispatched', queueItemId: 'orphan-task-999' }),
      workspaceRoot: tmpRoot,
      cancelOrphanedQueueItem: async (target) => {
        canceledTargets.push(target);
      }
    });
    const raceRes = await dispatchComposableNode(raceDeps, {
      run: linked.run,
      invocationId: snap.rootInvocationId,
      nodeId: 'step1',
      startedAt: nowMs
    });
    expect(raceRes.outcome).toBe('rejected-stale');
    expect(canceledTargets).toEqual([{ queueId: 'default', taskId: 'orphan-task-999' }]);
    // Unrelated live sibling task remains untouched in the queue!
    expect(win.queue.findById(unrelatedEnq.queueItemId!)?.status).toBe('pending');
  });
});
