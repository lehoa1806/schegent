// Feature 011 — US1 FR-009: manual override (Retry Phase Now).
//
// Covers: cancels timer, resets counter, unpauses queue only when the
// `pausedReason` matches `retry-cap-exhausted:<thisRunId>`, leaves
// unrelated queue pauses intact, emits `retry-manual` audit event,
// schedules resume on the next tick.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import type { DelayedRetryWatchdog } from '../../../src/controller/workflow-controller';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { PhaseRunner, PhaseRunOutput } from '../../../src/controller/phase-runner';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { Notifier } from '../../../src/ui/notifications';
import type { Memento } from '../../../src/state/workspace-state';
import type { WorkspaceLockManager } from '../../../src/state/lock';
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

function makeTransientOutput(): PhaseRunOutput {
  return {
    result: { kind: 'transient_error', exitCode: 1, auditEntry: null },
    outcome: 'transient_error',
    terminationReason: 'error',
    stdoutSummary: '',
    stderrSummary: 'cli aborted',
    exitCode: 1,
    auditEntryId: 'audit-tx',
    warnings: []
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
let auditWriter: { append: ReturnType<typeof vi.fn> };
let watchdog: {
  pauseAndPoll: ReturnType<typeof vi.fn>;
  cancelPendingTimer: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
  statusBar = makeStatusBar();
  notifier = makeNotifier();
  lock = makeLock();
  runSpy = vi.fn();
  phaseRunner = { run: runSpy } as unknown as PhaseRunner;
  const auditAppend = vi.fn();
  auditAppend.mockImplementation(async (entry: Record<string, unknown>) => ({
    id: 'mock-audit-id',
    timestamp: new Date().toISOString(),
    ...entry
  }));
  auditWriter = { append: auditAppend };
  const pauseAndPoll = vi.fn();
  pauseAndPoll.mockImplementation(async () => {});
  watchdog = {
    pauseAndPoll,
    cancelPendingTimer: vi.fn()
  };
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
      auditWriter: auditWriter as unknown as import('../../../src/audit/audit-log-writer').AuditLogWriter,
      watchdog: watchdog as unknown as DelayedRetryWatchdog
    }
  );
});

describe('retryPhaseNow — rejection guards', () => {
  it('rejects with no-active-run when no run exists', async () => {
    const result = await controller.retryPhaseNow();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-active-run');
  });

  it('rejects with not-pending-retry when run is not in pending retry state', async () => {
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);
    // This fixture used to stop at the completed Run above and assert
    // `not-pending-retry`. It reached that branch only because the target
    // resolver counted finished Runs, so a completed Run was handed to the
    // guard below; once the resolver started excluding them (feature 093
    // cumulative review) the call refused earlier, at `no-active-run` — see the
    // sibling case. The branch this test names belongs to an *operable* Run
    // with no armed retry, which is what is arranged here.
    await store.setRun(DEFAULT_QUEUE_ID, {
      ...store.getRun(DEFAULT_QUEUE_ID)!,
      status: 'paused',
      pendingRetryAt: null,
      pendingRetryCause: null
    });

    const result = await controller.retryPhaseNow();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-pending-retry');
  });

  it('rejects with no-active-run when only a finished run remains', async () => {
    runSpy.mockImplementation(async () => makeOutput());
    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);
    // A completed Run stays in the run record — only `clearAll` removes an
    // entry — so this is the state every queue sits in between Tasks. The
    // control has nothing to act on, and says so, rather than resolving the
    // finished Run and failing one guard deeper with a less accurate reason.
    expect(store.getRun(DEFAULT_QUEUE_ID)!.status).toBe('completed');

    const result = await controller.retryPhaseNow();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-active-run');
  });
});

describe('retryPhaseNow — happy path', () => {
  it('cancels the watchdog timer, resets counter, emits retry-manual audit', async () => {
    let calls = 0;
    runSpy.mockImplementation(async () => {
      calls++;
      if (calls === 1) return makeTransientOutput();
      return makeOutput();
    });
    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);
    const initialRun = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(initialRun.delayedRetryCount).toBe(1);
    expect(initialRun.pendingRetryAt).not.toBeNull();

    const result = await controller.retryPhaseNow();
    expect(result.ok).toBe(true);

    expect(watchdog.cancelPendingTimer).toHaveBeenCalledOnce();

    // Settled state (after setImmediate-driven resumeExisting) — count
    // resets to 0 and pendingRetry* clear.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 5));

    const settled = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(settled.delayedRetryCount).toBe(0);
    expect(settled.pendingRetryAt).toBeNull();
    expect(settled.pendingRetryCause).toBeNull();

    // retry-manual audit emitted with prevDelayedRetryCount=1.
    const manualCalls = auditWriter.append.mock.calls.filter(
      (c) => (c[0] as { eventType: string }).eventType === 'retry-manual'
    );
    expect(manualCalls.length).toBe(1);
    expect((manualCalls[0][0] as { payload: { prevDelayedRetryCount: number } }).payload.prevDelayedRetryCount).toBe(1);
  });
});

describe('retryPhaseNow — queue unpause gating (FR-009)', () => {
  it('unpauses the queue only when pausedReason matches retry-cap-exhausted:<thisRunId>', async () => {
    // Arrange a cap-exhausted state by running 5 transient_error failures.
    runSpy.mockImplementation(async () => makeTransientOutput());
    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);
    for (let i = 0; i < 4; i++) {
      await controller.resumeExisting(DEFAULT_QUEUE_ID);
    }
    const capRun = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(store.getQueue().pausedReason).toBe(`retry-cap-exhausted:${capRun.id}`);

    // To make retryPhaseNow accept, the run needs pendingRetryAt set.
    // Setting it manually here (the cap-exhausted state cleared it). This
    // matches the operator workflow: after cap pause, operator restarts
    // a single phase by re-arming pendingRetryAt or by calling
    // retryPhaseNow from a different code path. For this test we focus
    // on the queue-unpause logic: simulate the pre-pause state.
    await store.setRun(DEFAULT_QUEUE_ID, {
      ...capRun,
      delayedRetryCount: 4,
      pendingRetryAt: Date.now() + 60_000,
      pendingRetryCause: 'transient_error',
      status: 'paused'
    });

    runSpy.mockImplementation(async () => makeOutput());
    const result = await controller.retryPhaseNow();
    expect(result.ok).toBe(true);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 5));

    expect(store.getQueue().paused).toBe(false);
    expect(store.getQueue().pausedReason).toBeNull();
  });

  it('leaves unrelated queue pauses intact (different runId in pausedReason)', async () => {
    runSpy.mockImplementation(async () => makeTransientOutput());
    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);

    // Manually pause the queue with a reason that does not match this run.
    await queue.setQueuePausedState(
      true,
      undefined,
      'retry-cap-exhausted:some-other-run-id-9999',
      'retry-cap'
    );

    const result = await controller.retryPhaseNow();
    expect(result.ok).toBe(true);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 5));

    expect(store.getQueue().paused).toBe(true);
    expect(store.getQueue().pausedReason).toBe('retry-cap-exhausted:some-other-run-id-9999');
  });

  it('leaves unrelated queue pauses intact (different reason prefix)', async () => {
    runSpy.mockImplementation(async () => makeTransientOutput());
    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);

    await queue.setQueuePausedState(true, undefined, 'operator-paused', 'operator');

    const result = await controller.retryPhaseNow();
    expect(result.ok).toBe(true);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 5));

    expect(store.getQueue().paused).toBe(true);
    expect(store.getQueue().pausedReason).toBe('operator-paused');
  });
});
