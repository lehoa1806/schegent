// Feature 034 T005 — unit coverage for the deleteTask cleanup wiring.
// See specs/034-task-deletion-cleanup/contracts/session-cleanup.md
// §WorkflowController.deleteTask.
//
// Tests the five branches:
//   1. Non-null runId, cleanup succeeds → ok: true, sessionCleaned: true.
//   2. Null runId (pending task) → ok: true, sessionCleaned: false; no fs op.
//   3. Cleanup fails (fsRm throws) → ok: true, sessionCleaned: false; warn.
//   4. Unknown task id → ok: false; cleanup NOT invoked.
//   5. In-flight task — cancel runs before cleanup.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { PhaseRunner } from '../../../src/controller/phase-runner';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { Notifier } from '../../../src/ui/notifications';
import type { Memento } from '../../../src/state/workspace-state';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import type { SessionCleanupRunner } from '../../../src/controller/workflow-controller';

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

function makeStatusBar(): SchegentStatusBar {
  return { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
}
function makeNotifier(): Notifier {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as unknown as Notifier;
}
function makeLock(): WorkspaceLockManager & { release: ReturnType<typeof vi.fn> } {
  return {
    release: vi.fn(async () => {}),
    tryAcquire: vi.fn(),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    withLock: async function (this: { release(): Promise<void> }, _scope: string, fn: (session: { retain(): void }) => Promise<unknown>) {
      let retain = false;
      try {
        return await fn({ retain: () => { retain = true; } });
      } finally {
        if (!retain) await this.release().catch(() => undefined);
      }
    },
    id: 'this-window'
  } as unknown as WorkspaceLockManager & { release: ReturnType<typeof vi.fn> };
}

let tmpRoot: string;
let memento: FakeMemento;
let store: WorkspaceStateStore;
let queue: QueueManager;
let phaseRunner: PhaseRunner;
let lockManager: WorkspaceLockManager & { release: ReturnType<typeof vi.fn> };
let logger: SanitizedLogger;
// vi.spyOn(logger, 'warn') — `MockInstance<...>` from vitest.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let warnSpy: any;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-deleteTask-'));
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
  phaseRunner = { run: vi.fn() } as unknown as PhaseRunner;
  lockManager = makeLock();
  logger = new SanitizedLogger([]);
  warnSpy = vi.spyOn(logger, 'warn');
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

function makeController(
  sessionCleanup?: SessionCleanupRunner
): SchegentWorkflowController {
  return new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    makeStatusBar(),
    makeNotifier(),
    logger,
    lockManager,
    {
      cliPath: 'claude',
      cwd: tmpRoot,
      iterationCap: 5,
      timeoutMs: 5_000,
    },
    sessionCleanup ? { sessionCleanup } : {}
  );
}

async function seedTerminalTask(
  runId: string,
  description = 'feature description'
): Promise<{ taskId: string }> {
  const feature = await queue.enqueue(description);
  await queue.markInFlight(feature.id, runId);
  await queue.finish(feature.id, 'completed');
  return { taskId: feature.id };
}

async function seedSessionArtifacts(runId: string): Promise<{ sessionDir: string; rawFile: string }> {
  const sessionDir = path.join(tmpRoot, '.schegent', 'sessions', runId);
  const nested = path.join(sessionDir, 'diagnostics', 'p', 'q', 'iter-1');
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, 'stream.jsonl'), '{}\n', 'utf8');
  const rawFile = path.join(tmpRoot, '.schegent', 'sessions', `raw-${runId}.log`);
  await fs.writeFile(rawFile, 'transcript\n', 'utf8');
  return { sessionDir, rawFile };
}

describe('Feature 034 T005 — WorkflowController.deleteTask cleanup wiring', () => {
  it('non-null runId, cleanup succeeds → ok:true, sessionCleaned:true, artifacts gone', async () => {
    const runId = 'R1';
    const { taskId } = await seedTerminalTask(runId);
    const { sessionDir, rawFile } = await seedSessionArtifacts(runId);

    const controller = makeController();
    const result = await controller.deleteTask(taskId);

    expect(result.ok).toBe(true);
    expect(result.runId).toBe(runId);
    expect(result.sessionCleaned).toBe(true);
    await expect(fs.access(sessionDir)).rejects.toBeDefined();
    await expect(fs.access(rawFile)).rejects.toBeDefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('null runId (pending task) → ok:true, sessionCleaned:false, no fs syscall', async () => {
    const feature = await queue.enqueue('pending feature');
    // No markInFlight — runId stays null.
    expect(queue.findById(feature.id)?.runId).toBeNull();

    const cleanupSpy = vi.fn<
      (input: {
        workspaceRoot: string;
        runId: string;
        logger: SanitizedLogger;
      }) => Promise<boolean>
    >();
    const controller = makeController(cleanupSpy);
    const result = await controller.deleteTask(feature.id);

    expect(result.ok).toBe(true);
    expect(result.runId ?? null).toBeNull();
    expect(result.sessionCleaned).toBe(false);
    expect(cleanupSpy).not.toHaveBeenCalled();
  });

  it('cleanup throws (cleanup returns false) → ok:true, sessionCleaned:false, queue row gone', async () => {
    const runId = 'R2';
    const { taskId } = await seedTerminalTask(runId);
    await seedSessionArtifacts(runId);

    const cleanupSpy = vi.fn(async () => false);
    const controller = makeController(cleanupSpy);
    const result = await controller.deleteTask(taskId);

    expect(result.ok).toBe(true);
    expect(result.runId).toBe(runId);
    expect(result.sessionCleaned).toBe(false);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(cleanupSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: tmpRoot,
        runId,
        logger
      })
    );
    // Queue row removed despite cleanup failure.
    expect(queue.findById(taskId)).toBeNull();
  });

  it('unknown task id → ok:false; cleanup NOT invoked', async () => {
    const cleanupSpy = vi.fn(async () => true);
    const controller = makeController(cleanupSpy);
    const result = await controller.deleteTask('does-not-exist');

    expect(result.ok).toBe(false);
    expect(cleanupSpy).not.toHaveBeenCalled();
  });

  it('in-flight task — cancel runs BEFORE cleanup', async () => {
    const runId = 'R3';
    const feature = await queue.enqueue('in-flight feature');
    await queue.markInFlight(feature.id, runId);
    const now = Date.now();
    const run: WorkflowRun = {
      id: runId,
      featureId: feature.id,
      featureDir: 'specs/000',
      status: 'running',
      currentPhase: 'speckit-plan',
      currentIteration: 1,
      startedAt: now,
      lastTransitionAt: now,
      phasesCompleted: [],
      lastError: null,
      delayedRetryCount: 0,
      pendingRetryAt: null,
      pendingRetryCause: null,
      phaseOverrides: [],
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      resumeTargetPhaseId: null
    };
    await store.setRun(run);
    await seedSessionArtifacts(runId);

    // Order tracking: cancel → setRun(canceled) → lock.release → cleanup
    const order: string[] = [];
    const cleanupSpy = vi.fn(async () => {
      order.push('cleanup');
      return true;
    });

    const controller = makeController(cleanupSpy);
    const cancelSpy = vi
      .spyOn(controller, 'cancelActive')
      .mockImplementation(() => {
        order.push('cancel');
      });
    const origSetRun = store.setRun.bind(store);
    const setRunSpy = vi.spyOn(store, 'setRun').mockImplementation(async (r) => {
      if (r && r.status === 'canceled') order.push('setRun:canceled');
      return origSetRun(r);
    });
    lockManager.release.mockImplementation(async () => {
      order.push('lock.release');
    });

    const result = await controller.deleteTask(feature.id);

    expect(result.ok).toBe(true);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    // Cancel-setRun-release MUST precede the cleanup invocation.
    expect(order[0]).toBe('cancel');
    expect(order.indexOf('setRun:canceled')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('lock.release')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('cleanup')).toBeGreaterThan(order.indexOf('lock.release'));

    setRunSpy.mockRestore();
  });
});
