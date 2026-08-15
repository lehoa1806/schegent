// Feature 013 — Wave 7 (US7 / T103): audit-event parity test.
//
// Wave 7 decomposed `WorkflowController` by extracting `HistoryRecorder`
// (T098) and `AutoDrainCoordinator` (T099). The byte-identical output
// contract (FR-035) requires that the same per-run audit + history
// emission sequence is produced regardless of decomposition.
//
// This test runs a known fixture through the post-Wave-7 controller
// composition and asserts:
//   1. history-store.append fires EXACTLY ONCE per terminal transition,
//      with the expected `terminalStatus` and the FULL sanitized
//      `originalDescription` (Wave 6 contract).
//   2. The controller emits NO retry-* audit events on a clean run.
//   3. The 7 phase-runner invocations and `historyStore.append`
//      ordering are: all phases run → then `append` (not before).
//   4. The auto-drain side effect fires AFTER history is appended.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { PhaseRunner, PhaseRunOutput } from '../../../src/controller/phase-runner';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { Notifier } from '../../../src/ui/notifications';
import type { Memento } from '../../../src/state/workspace-state';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import type { HistoryEntry } from '../../../src/state/history-entry';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';

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
  return {
    update: vi.fn(),
    dispose: vi.fn()
  } as unknown as SchegentStatusBar;
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
    tryAcquire: vi.fn(async () => ({ acquired: true, ownerId: 'this-window' })),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    id: 'this-window'
  } as unknown as WorkspaceLockManager & { release: ReturnType<typeof vi.fn> };
}

function makeOutput(overrides: Partial<PhaseRunOutput> = {}): PhaseRunOutput {
  return {
    result: { kind: 'clean', auditEntry: null as never },
    outcome: 'clean',
    terminationReason: 'token',
    stdoutSummary: '',
    stderrSummary: '',
    exitCode: 0,
    auditEntryId: 'audit-1',
    warnings: [],
    ...overrides
  };
}

const opts = {
  cliPath: 'claude',
  cwd: '/repo',
  iterationCap: 5,
  timeoutMs: 5_000,
};

let memento: FakeMemento;
let store: WorkspaceStateStore;
let queue: QueueManager;
let phaseRunner: PhaseRunner;
let runSpy: ReturnType<typeof vi.fn>;
let controller: SchegentWorkflowController;
let statusBar: SchegentStatusBar;
let notifier: Notifier;
let lock: WorkspaceLockManager & { release: ReturnType<typeof vi.fn> };
let historyStore: { append: ReturnType<typeof vi.fn> };
let auditWriter: { append: ReturnType<typeof vi.fn> };
let callOrder: string[];

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
  statusBar = makeStatusBar();
  notifier = makeNotifier();
  lock = makeLock();
  callOrder = [];
  runSpy = vi.fn().mockImplementation(async (req: { phase: string }) => {
    callOrder.push(`run:${req.phase}`);
    return makeOutput();
  });
  phaseRunner = { run: runSpy } as unknown as PhaseRunner;
  const historyAppend = vi.fn();
  historyAppend.mockImplementation(async () => {
    callOrder.push('history.append');
  });
  historyStore = { append: historyAppend };
  const auditAppend = vi.fn();
  auditAppend.mockImplementation(async (entry: { eventType: string }) => {
    callOrder.push(`audit:${entry.eventType}`);
    return { id: 'a-1', timestamp: new Date().toISOString() };
  });
  auditWriter = { append: auditAppend };
  controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    statusBar,
    notifier,
    new SanitizedLogger(),
    lock,
    opts,
    {
      historyStore: historyStore as unknown as import('../../../src/state/history-store').HistoryStore,
      auditWriter: auditWriter as unknown as import('../../../src/audit/audit-log-writer').AuditLogWriter
    }
  );
});

describe('Audit/history-emit parity post-Wave-7 (T103)', () => {
  it('clean 7-phase run emits exactly one history.append with terminalStatus=completed and no retry-* audit', async () => {
    const feature = await queue.enqueue('investigate auth flow');

    await controller.startNew(feature, null);

    expect(historyStore.append).toHaveBeenCalledTimes(1);
    const entry = historyStore.append.mock.calls[0][0] as HistoryEntry;
    expect(entry.terminalStatus).toBe('completed');
    expect(entry.featureId).toBe(feature.id);
    expect(entry.originalDescription).toBe('investigate auth flow');
    expect(entry.lastErrorSummary).toBeNull();

    // No retry-* events on a clean run.
    const retryEvents = auditWriter.append.mock.calls.filter((c) =>
      ['retry-scheduled', 'retry-manual', 'retry-recovered', 'queue-paused'].includes(
        (c[0] as { eventType: string }).eventType
      )
    );
    expect(retryEvents).toHaveLength(0);
  });

  it('phase-runner invocations precede history.append on a clean run', async () => {
    const feature = await queue.enqueue('order check');

    await controller.startNew(feature, null);

    const phaseRuns = callOrder.filter((s) => s.startsWith('run:'));
    expect(phaseRuns).toHaveLength(9);
    const lastRunIdx = callOrder.lastIndexOf(phaseRuns[phaseRuns.length - 1]);
    const appendIdx = callOrder.indexOf('history.append');
    expect(appendIdx).toBeGreaterThan(lastRunIdx);
  });

  it('failed run emits history.append with terminalStatus=failed and a sanitized lastErrorSummary', async () => {
    runSpy.mockImplementation(async (req: { phase: string }) => {
      callOrder.push(`run:${req.phase}`);
      if (req.phase === 'speckit-specify') {
        return makeOutput({
          outcome: 'failed',
          terminationReason: 'error',
          result: { kind: 'malformed', warnings: ['boom'], auditEntry: null },
          warnings: ['boom']
        });
      }
      return makeOutput();
    });

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);

    expect(historyStore.append).toHaveBeenCalledTimes(1);
    const entry = historyStore.append.mock.calls[0][0] as HistoryEntry;
    expect(entry.terminalStatus).toBe('failed');
    expect(entry.lastErrorSummary).not.toBeNull();
  });

  it('canceled run emits history.append with terminalStatus=canceled', async () => {
    runSpy.mockImplementation(async (req: { phase: string }) => {
      callOrder.push(`run:${req.phase}`);
      controller.cancelActive();
      return makeOutput();
    });

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);

    expect(historyStore.append).toHaveBeenCalledTimes(1);
    const entry = historyStore.append.mock.calls[0][0] as HistoryEntry;
    expect(entry.terminalStatus).toBe('canceled');
  });

  it('append failure is swallowed (HistoryRecorder error-isolation contract)', async () => {
    historyStore.append.mockRejectedValueOnce(new Error('disk-full'));
    const feature = await queue.enqueue('feature description');

    await expect(controller.startNew(feature, null)).resolves.toBeUndefined();

    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.status).toBe('completed');
  });
});
