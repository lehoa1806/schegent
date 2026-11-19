import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCatalog } from '../../src/config/pipeline-config';
import type { PhaseRunner } from '../../src/controller/phase-runner';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { SanitizedLogger } from '../../src/lib/logger';
import { QueueManager } from '../../src/queue/queue-manager';
import { SqliteApplicationStore } from '../../src/services/sqlite-store';
import { ExecutionLeaseManager } from '../../src/state/execution-lease';
import type { WorkspaceLockManager } from '../../src/state/lock';
import { createSwitchableOperationalMemento } from '../../src/state/sqlite-operational-backing';
import { unfencedCommit } from '../../src/state/ownership-claim';
import type { WorkflowRun } from '../../src/state/workflow-run';
import {
  QueueMutationRejected,
  WorkspaceStateStore,
  type Memento
} from '../../src/state/workspace-state';
import type { Notifier } from '../../src/ui/notifications';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import {
  createHosts,
  ManualClock,
  ManualScheduler,
  SharedOwnershipFs
} from '../fixtures/state/ownership-harness';

const WORKER_SRC = resolve(__dirname, 'helpers', 'atomic-admission-crash-worker.ts');

function createMemoryMemento(): Memento {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    update(key: string, value: unknown): Thenable<void> {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
      return Promise.resolve();
    }
  };
}

function makeRun(featureId: string, runId: string): WorkflowRun {
  const now = 1_750_000_000_000;
  return {
    id: runId,
    featureId,
    featureDir: 'specs/315-run-transition-table',
    status: 'running',
    currentPhase: 'speckit-specify',
    currentIteration: 0,
    startedAt: now,
    lastTransitionAt: now,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    creditPause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    pipeline: {
      id: 'default-pipeline',
      name: 'Default',
      phases: [{ id: 'speckit-specify', name: 'Specify', instruction: 'Specify' }]
    }
  };
}

async function seedPendingTask(
  dbPath: string,
  scopeId: string
): Promise<{ readonly featureId: string }> {
  const sqliteStore = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
  try {
    const memento = createSwitchableOperationalMemento(createMemoryMemento());
    memento.attachSqlite(sqliteStore, scopeId, () => 1_750_000_000_000);
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    const queue = new QueueManager(store);
    const task = await queue.enqueue('Crash boundary test task');
    return { featureId: task.id };
  } finally {
    sqliteStore.close();
  }
}

async function reopenAndInspect(dbPath: string, scopeId: string) {
  const sqliteStore = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
  try {
    const memento = createSwitchableOperationalMemento(createMemoryMemento());
    memento.attachSqlite(sqliteStore, scopeId, () => 1_750_000_001_000);
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    const run = store.getRun(DEFAULT_QUEUE_ID);
    const queueState = store.getQueue(DEFAULT_QUEUE_ID);
    const runRows = sqliteStore.writerConnection.all<{ run_id: string; status: string }>(
      `SELECT run_id, status FROM runs`
    );
    return { run, queueState, runRows };
  } finally {
    sqliteStore.close();
  }
}

describe('FR-R7-01 — Atomic Run admission crash boundaries & negative control (SC-003)', () => {
  let suiteDir: string;
  let workerCjs: string;

  beforeAll(() => {
    suiteDir = mkdtempSync(join(tmpdir(), 'schegent-atomic-admission-'));
    workerCjs = join(suiteDir, 'atomic-admission-crash-worker.cjs');
    buildSync({
      entryPoints: [WORKER_SRC],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['node:sqlite'],
      outfile: workerCjs
    });
  });

  afterAll(() => {
    rmSync(suiteDir, { recursive: true, force: true });
  });

  function runCrashWorker(
    dbPath: string,
    scopeId: string,
    mode: 'before-begin' | 'mid-tx' | 'after-commit' | 'negative-control-split-writes',
    featureId: string,
    runId: string
  ) {
    const res = spawnSync(
      process.execPath,
      [workerCjs, dbPath, scopeId, mode, featureId, runId],
      { encoding: 'utf8', timeout: 15_000 }
    );
    expect(res.signal, `expected SIGKILL for ${mode}; stderr=${res.stderr}`).toBe('SIGKILL');
  }

  it('agrees on restart when killed BEFORE BEGIN IMMEDIATE (neither Run nor Task mark persisted)', async () => {
    const dbPath = join(suiteDir, 'before-begin.sqlite');
    const scopeId = 'scope-before-begin';
    const { featureId } = await seedPendingTask(dbPath, scopeId);

    runCrashWorker(dbPath, scopeId, 'before-begin', featureId, 'run-before-begin');

    const after = await reopenAndInspect(dbPath, scopeId);
    expect(after.run).toBeNull();
    expect(after.runRows).toEqual([]);
    expect(after.queueState.inFlightId).toBeNull();
    expect(after.queueState.requests.find((r) => r.id === featureId)?.status).toBe('pending');
  });

  it('agrees on restart when killed MID-TRANSACTION after KEYS.run write and before COMMIT (rolled back cleanly)', async () => {
    const dbPath = join(suiteDir, 'mid-tx.sqlite');
    const scopeId = 'scope-mid-tx';
    const { featureId } = await seedPendingTask(dbPath, scopeId);

    runCrashWorker(dbPath, scopeId, 'mid-tx', featureId, 'run-mid-tx');

    const after = await reopenAndInspect(dbPath, scopeId);
    expect(after.run).toBeNull();
    expect(after.runRows).toEqual([]);
    expect(after.queueState.inFlightId).toBeNull();
    expect(after.queueState.requests.find((r) => r.id === featureId)?.status).toBe('pending');
  });

  it('agrees on restart when killed AFTER COMMIT before post-commit notifications (both Run and Task persisted)', async () => {
    const dbPath = join(suiteDir, 'after-commit.sqlite');
    const scopeId = 'scope-after-commit';
    const { featureId } = await seedPendingTask(dbPath, scopeId);

    runCrashWorker(dbPath, scopeId, 'after-commit', featureId, 'run-after-commit');

    const after = await reopenAndInspect(dbPath, scopeId);
    expect(after.run?.id).toBe('run-after-commit');
    expect(after.run?.status).toBe('running');
    expect(after.runRows).toEqual([{ run_id: 'run-after-commit', status: 'running' }]);
    expect(after.queueState.inFlightId).toBe(featureId);
    const task = after.queueState.requests.find((r) => r.id === featureId);
    expect(task?.status).toBe('in-flight');
    expect(task?.runId).toBe('run-after-commit');
  });

  it('negative control: splitting admission back into two commits leaves a persisted Run disagreeing with a pending Task on crash', async () => {
    const dbPath = join(suiteDir, 'split-control.sqlite');
    const scopeId = 'scope-split-control';
    const { featureId } = await seedPendingTask(dbPath, scopeId);

    runCrashWorker(dbPath, scopeId, 'negative-control-split-writes', featureId, 'run-split');

    const after = await reopenAndInspect(dbPath, scopeId);
    // Disagreement proven: Run exists as 'running' while Task is still 'pending' with inFlightId null.
    expect(after.run?.id).toBe('run-split');
    expect(after.run?.status).toBe('running');
    expect(after.queueState.inFlightId).toBeNull();
    expect(after.queueState.requests.find((r) => r.id === featureId)?.status).toBe('pending');
  });

  it('refuses atomic admission when the queue already holds a live Run or Task transition is ineligible, leaving both keys untouched', async () => {
    const dbPath = join(suiteDir, 'refusals.sqlite');
    const scopeId = 'scope-refusals';
    const sqliteStore = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    try {
      const memento = createSwitchableOperationalMemento(createMemoryMemento());
      memento.attachSqlite(sqliteStore, scopeId, () => 1_750_000_000_000);
      const store = new WorkspaceStateStore(memento);
      await store.initialize();
      const queue = new QueueManager(store);
      const first = await queue.enqueue('First task');
      const second = await queue.enqueue('Second task');

      // Admit first cleanly.
      await queue.admitRun(first.id, makeRun(first.id, 'run-first'));
      expect(store.getRun(DEFAULT_QUEUE_ID)?.id).toBe('run-first');
      expect(store.getQueue(DEFAULT_QUEUE_ID).inFlightId).toBe(first.id);

      // Attempting to admit second while first's Run is non-terminal must refuse and leave both keys intact.
      let caught: unknown;
      try {
        await queue.admitRun(second.id, makeRun(second.id, 'run-second'));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(QueueMutationRejected);
      expect((caught as QueueMutationRejected).reason).toBe('in-flight-ownership-conflict');
      expect(store.getRun(DEFAULT_QUEUE_ID)?.id).toBe('run-first');
      expect(store.getQueue(DEFAULT_QUEUE_ID).inFlightId).toBe(first.id);
      expect(store.getQueue(DEFAULT_QUEUE_ID).requests.find((r) => r.id === second.id)?.status).toBe(
        'pending'
      );

      // Even after first Run completes, admitting a nonexistent task refuses task-not-found and leaves Run untouched.
      await store.setRun(
        DEFAULT_QUEUE_ID,
        { ...makeRun(first.id, 'run-first'), status: 'completed' },
        unfencedCommit('test-fixture')
      );
      await expect(
        queue.admitRun('missing-task-id', makeRun('missing-task-id', 'run-missing'))
      ).rejects.toMatchObject({ reason: 'task-not-found' });
      expect(store.getRun(DEFAULT_QUEUE_ID)?.id).toBe('run-first');
    } finally {
      sqliteStore.close();
    }
  });

  it('stamps writtenAtFence on fenced admission, refuses superseded/lost fences atomically, and emits task-execution-started only post-commit', async () => {
    const fs = new SharedOwnershipFs();
    const hosts = await createHosts(2, fs);
    const clock = new ManualClock();
    const scheduler = new ManualScheduler();

    const hostA = hosts[0]!;
    const hostB = hosts[1]!;
    const leaseA = new ExecutionLeaseManager(hostA.store, 'window-a', clock, scheduler);
    const leaseB = new ExecutionLeaseManager(hostB.store, 'window-b', clock, scheduler);
    hostA.store.bindRunClaimSource(leaseA);

    const auditEvents: Array<{ readonly eventType: string; readonly payload: Record<string, unknown> }> = [];
    const queueA = new QueueManager(hostA.store);
    queueA.setLifecycleAuditHook({
      append: async (entry) => {
        auditEvents.push({ eventType: entry.eventType, payload: entry.payload });
      }
    });

    expect((await leaseA.tryAcquire(DEFAULT_QUEUE_ID)).acquired).toBe(true);
    const first = await queueA.enqueue('Fenced task 1');
    const second = await queueA.enqueue('Fenced task 2');

    // Valid fenced admission stamps writtenAtFence and emits task-execution-started post-commit.
    await queueA.admitRun(first.id, makeRun(first.id, 'run-fenced-1'));
    expect(hostA.store.getRun(DEFAULT_QUEUE_ID)?.writtenAtFence).toBeDefined();
    expect(auditEvents).toEqual([
      {
        eventType: 'task-execution-started',
        payload: expect.objectContaining({ taskId: first.id, runId: 'run-fenced-1' })
      }
    ]);

    // Settle run-fenced-1 so the queue slot is terminal, then supersede window-a's lease from window-b.
    await hostA.store.setRun(
      DEFAULT_QUEUE_ID,
      { ...makeRun(first.id, 'run-fenced-1'), status: 'completed' },
      leaseA.claimFor(DEFAULT_QUEUE_ID)!
    );
    clock.advance(10 * 60 * 1000);
    expect((await leaseB.tryAcquire(DEFAULT_QUEUE_ID)).acquired).toBe(true);

    // Attempting admitRun with superseded fence refuses atomically and emits NO audit event.
    await expect(
      queueA.admitRun(second.id, makeRun(second.id, 'run-fenced-2'))
    ).rejects.toMatchObject({ reason: 'fence-superseded' });
    expect(hostA.store.getRun(DEFAULT_QUEUE_ID)?.id).toBe('run-fenced-1');
    expect(hostA.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('completed');
    expect(hostA.store.getQueue(DEFAULT_QUEUE_ID).inFlightId).toBe(first.id);
    expect(hostA.store.getQueue(DEFAULT_QUEUE_ID).requests.find((r) => r.id === second.id)?.status).toBe(
      'pending'
    );
    expect(auditEvents).toHaveLength(1);
  });

  it('keeps an active paused Run, its execution lease, and the pending Task intact when admitNew hits in-flight-ownership-conflict (SEC-315-01)', async () => {
    const store = new WorkspaceStateStore(createMemoryMemento());
    await store.initialize();
    const queue = new QueueManager(store);
    const releaseSpy = vi.fn().mockResolvedValue(undefined);
    const auditAppend = vi.fn().mockResolvedValue(undefined);
    const catalog = buildCatalog(
      [{ id: 'speckit-specify', name: 'Specify', instruction: 'Specify', runner: 'claude' }],
      [{ id: 'p1', name: 'P1', phases: ['speckit-specify'] }],
      { claude: [], codex: [], agy: [] },
      'p1'
    );
    const phaseRunner = {
      run: vi.fn(),
      evictStagnationTracker: vi.fn()
    } as unknown as PhaseRunner;
    const statusBar = { update: vi.fn(), show: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
    const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;
    const lock = {
      tryAcquire: vi.fn().mockResolvedValue({ acquired: true }),
      release: vi.fn().mockResolvedValue(undefined),
      isHeldByCurrentWindow: vi.fn().mockReturnValue(true)
    } as unknown as WorkspaceLockManager;

    const controller = new SchegentWorkflowController(
      phaseRunner,
      store,
      queue,
      statusBar,
      notifier,
      new SanitizedLogger(),
      lock,
      { cliPath: 'claude', cwd: suiteDir, iterationCap: 3, timeoutMs: 5_000 },
      {
        catalog,
        auditWriter: { append: auditAppend },
        executionLease: {
          tryAcquire: vi.fn().mockResolvedValue({ acquired: true }),
          release: releaseSpy,
          claimFor: () => null
        }
      }
    );

    const task1 = await queue.enqueue('Paused active task');
    const task2 = await queue.enqueue('Pending second task');
    await queue.admitRun(task1.id, makeRun(task1.id, 'run-active-1'));
    await store.updateRun(
      DEFAULT_QUEUE_ID,
      {
        runId: 'run-active-1',
        allowedStatuses: ['running'],
        label: 'pause',
        patch: () => ({
          status: 'paused',
          manualPauseAt: 1_750_000_005_000,
          manualPauseCause: 'operator-paused'
        })
      },
      unfencedCommit('test-fixture')
    );

    auditAppend.mockClear();
    const admission = await controller.admitNew(task2, null);
    await admission.completed;

    // Active paused Run, its queue lease, and pending task2 MUST all remain untouched,
    // with zero spurious terminal intents or task-execution-ended audit writes.
    expect(store.getRun(DEFAULT_QUEUE_ID)?.id).toBe('run-active-1');
    expect(store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('paused');
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(store.getQueue(DEFAULT_QUEUE_ID).inFlightId).toBe(task1.id);
    expect(store.getQueue(DEFAULT_QUEUE_ID).requests.find((r) => r.id === task2.id)?.status).toBe(
      'pending'
    );
    expect(store.getTerminalTransitionIntents()).toEqual({});
    expect(auditAppend).not.toHaveBeenCalled();
  });
});
