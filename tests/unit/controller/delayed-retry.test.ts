// Feature 011 — US1 P1 MVP: delayed-retry resilience.
//
// Covers FR-002 (15-min backoff exact), FR-003 (60-min backoff exact),
// FR-004 (fatal-signature bypass), FR-006 (cap pauses queue with
// `retry-cap-exhausted:<runId>` format), FR-007 (counter resets to 0 on
// clean success).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
// Feature 098 (T080) — the controller no longer carries a compiled-in catalog,
// so a test that drives Phases supplies one. See the fixture header for why the
// ids here are the real Spec Kit ones.
import { buildSpeckitCatalog } from '../../fixtures/speckit-catalog-fixture';
import type { DelayedRetryWatchdog } from '../../../src/controller/workflow-controller';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { PhaseRunner, PhaseRunOutput } from '../../../src/controller/phase-runner';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { Notifier } from '../../../src/ui/notifications';
import type { Memento } from '../../../src/state/workspace-state';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import {
  DELAYED_RETRY_CAP,
  RATE_LIMIT_BACKOFF_MS,
  TRANSIENT_BACKOFF_MS
} from '../../../src/controller/retry-constants';
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
    stderrSummary: 'cli aborted unexpectedly',
    exitCode: 1,
    auditEntryId: 'audit-tx',
    warnings: []
  };
}

function makeRateLimitedOutput(): PhaseRunOutput {
  return {
    result: { kind: 'rate_limited', cause: 'rate-limit', auditEntry: null },
    outcome: 'rate_limited',
    terminationReason: 'rate_limit',
    stdoutSummary: '',
    stderrSummary: 'over rate limit',
    exitCode: 1,
    auditEntryId: 'audit-rl',
    warnings: []
  };
}

function makeFatalOutput(): PhaseRunOutput {
  return {
    result: { kind: 'malformed', warnings: ["error: unknown option"], auditEntry: null, fatalCause: "error: unknown option" },
    outcome: 'failed',
    terminationReason: 'error',
    stdoutSummary: '',
    stderrSummary: "error: unknown option",
    exitCode: 1,
    auditEntryId: 'audit-fatal',
    warnings: ["error: unknown option"]
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
      catalog: buildSpeckitCatalog(),
      auditWriter: auditWriter as unknown as import('../../../src/audit/audit-log-writer').AuditLogWriter,
      watchdog: watchdog as unknown as DelayedRetryWatchdog
    }
  );
});

describe('FR-002 — 15-min backoff on transient_error', () => {
  it('first transient_error schedules 15-min retry with delayedRetryCount=1', async () => {
    let calls = 0;
    runSpy.mockImplementation(async () => {
      calls++;
      if (calls === 1) return makeTransientOutput();
      return makeOutput();
    });

    const feature = await queue.enqueue('feature description');
    const beforeMs = Date.now();
    await controller.startNew(feature, null);
    const afterMs = Date.now();

    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.status).toBe('paused');
    expect(run.delayedRetryCount).toBe(1);
    expect(run.pendingRetryCause).toBe('transient_error');
    expect(run.pendingRetryAt).not.toBeNull();
    // Exact 15-min offset bounded by test wall-clock spread.
    const offset = run.pendingRetryAt! - beforeMs;
    expect(offset).toBeGreaterThanOrEqual(TRANSIENT_BACKOFF_MS - 50);
    expect(offset).toBeLessThanOrEqual(TRANSIENT_BACKOFF_MS + (afterMs - beforeMs));

    expect(watchdog.pauseAndPoll).toHaveBeenCalledWith(
      'transient_error',
      expect.objectContaining({
        durationOverrideMs: expect.any(Number),
        skipStatusCheck: true
      })
    );
    // `retry-coordinator.ts` arms the watchdog with `firesAt - now()`, i.e.
    // the backoff minus however long the intervening work took. Asserting
    // exact equality made this depend on that elapsed time rounding to 0ms,
    // which only holds on an idle host. Bound it the way the offset check
    // above is bounded instead.
    const transientArgs = watchdog.pauseAndPoll.mock.calls.at(-1)!;
    const transientOverride =
      (transientArgs[1] as { durationOverrideMs: number }).durationOverrideMs;
    expect(transientOverride).toBeLessThanOrEqual(TRANSIENT_BACKOFF_MS);
    expect(transientOverride).toBeGreaterThanOrEqual(
      TRANSIENT_BACKOFF_MS - (afterMs - beforeMs) - 50
    );

    expect(auditWriter.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'retry-scheduled',
        payload: expect.objectContaining({
          cause: 'transient_error',
          delayedRetryCount: 1
        })
      })
    );
  });
});

describe('FR-003 — 60-min backoff on rate_limited', () => {
  it('first rate_limited schedules 60-min retry with delayedRetryCount=1', async () => {
    let calls = 0;
    runSpy.mockImplementation(async () => {
      calls++;
      if (calls === 1) return makeRateLimitedOutput();
      return makeOutput();
    });

    const feature = await queue.enqueue('feature description');
    const beforeMs = Date.now();
    await controller.startNew(feature, null);
    const afterMs = Date.now();

    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.status).toBe('paused');
    expect(run.delayedRetryCount).toBe(1);
    expect(run.pendingRetryCause).toBe('rate_limit');
    expect(run.pendingRetryAt).not.toBeNull();
    const offset = run.pendingRetryAt! - beforeMs;
    expect(offset).toBeGreaterThanOrEqual(RATE_LIMIT_BACKOFF_MS - 50);

    expect(watchdog.pauseAndPoll).toHaveBeenCalledWith(
      'rate_limit',
      expect.objectContaining({
        durationOverrideMs: expect.any(Number),
        skipStatusCheck: true
      })
    );
    // Same wall-clock dependency as the transient case above: the armed
    // duration is `firesAt - now()`, not the constant itself.
    const rateLimitArgs = watchdog.pauseAndPoll.mock.calls.at(-1)!;
    const rateLimitOverride =
      (rateLimitArgs[1] as { durationOverrideMs: number }).durationOverrideMs;
    expect(rateLimitOverride).toBeLessThanOrEqual(RATE_LIMIT_BACKOFF_MS);
    expect(rateLimitOverride).toBeGreaterThanOrEqual(
      RATE_LIMIT_BACKOFF_MS - (afterMs - beforeMs) - 50
    );
  });
});

describe('FR-004 — fatal-signature bypass', () => {
  it('fatal output fails the run immediately without scheduling delayed retry', async () => {
    let calls = 0;
    runSpy.mockImplementation(async () => {
      calls++;
      if (calls === 1) return makeFatalOutput();
      return makeOutput();
    });

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);

    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.status).toBe('failed');
    expect(run.delayedRetryCount).toBe(0);
    expect(run.pendingRetryAt).toBeNull();
    expect(run.pendingRetryCause).toBeNull();
    expect(watchdog.pauseAndPoll).not.toHaveBeenCalled();
    // No retry-scheduled audit should have been emitted; only phase-end/failure.
    for (const call of auditWriter.append.mock.calls) {
      expect((call[0] as { eventType: string }).eventType).not.toBe('retry-scheduled');
    }
  });
});

describe('FR-006 — cap exhaustion pauses the queue', () => {
  it('the 5th consecutive transient_error pauses queue with retry-cap-exhausted:<runId>', async () => {
    // Pre-arm a run with delayedRetryCount=4 (we are about to hit the 5th
    // failure). Simulate this by orchestrating: first invocation arms the
    // count to 4 via direct setRun, then start phase invocation.
    runSpy.mockImplementation(async () => makeTransientOutput());
    const feature = await queue.enqueue('feature description');

    // We can't easily pre-state in this setup; instead chain 5 attempts via
    // resumeExisting (since startNew handles only the first invocation
    // before halting). Per delayed-retry contract the watchdog would have
    // re-armed and called controller.resumeExisting(DEFAULT_QUEUE_ID) to drive each retry.
    await controller.startNew(feature, null);
    expect(store.getRun(DEFAULT_QUEUE_ID)!.delayedRetryCount).toBe(1);

    // Resume 4 more times to reach the cap.
    for (let i = 0; i < 4; i++) {
      await controller.resumeExisting(DEFAULT_QUEUE_ID);
    }

    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.delayedRetryCount).toBe(DELAYED_RETRY_CAP);
    expect(run.status).toBe('paused');
    expect(run.pendingRetryAt).toBeNull(); // cap-exhausted state clears the timer
    expect(run.pendingRetryCause).toBeNull();

    const queueState = store.getQueue(DEFAULT_QUEUE_ID);
    expect(queueState.queueLifecycle).toBe('operator-paused');
    expect(queueState.pausedReason).toBe(`retry-cap-exhausted:${run.id}`);

    // Audit event must record the queue-paused event with delayedRetryCount=5.
    const queuePausedCalls = auditWriter.append.mock.calls.filter(
      (c) => (c[0] as { eventType: string }).eventType === 'queue-paused'
    );
    expect(queuePausedCalls.length).toBe(1);
    expect((queuePausedCalls[0][0] as { payload: { delayedRetryCount: number; reason: string } }).payload.delayedRetryCount).toBe(DELAYED_RETRY_CAP);
    expect((queuePausedCalls[0][0] as { payload: { reason: string } }).payload.reason).toBe('retry-cap-exhausted');
  });
});

describe('FR-007 — counter resets to 0 on clean success', () => {
  it('clean outcome after one delayed retry resets count and emits retry-recovered', async () => {
    let calls = 0;
    runSpy.mockImplementation(async () => {
      calls++;
      if (calls === 1) return makeTransientOutput();
      return makeOutput(); // second specify call succeeds; subsequent phases also succeed
    });

    const feature = await queue.enqueue('feature description');
    await controller.startNew(feature, null);
    expect(store.getRun(DEFAULT_QUEUE_ID)!.delayedRetryCount).toBe(1);

    await controller.resumeExisting(DEFAULT_QUEUE_ID);

    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.delayedRetryCount).toBe(0);
    expect(run.pendingRetryAt).toBeNull();
    expect(run.pendingRetryCause).toBeNull();

    const recoveredCalls = auditWriter.append.mock.calls.filter(
      (c) => (c[0] as { eventType: string }).eventType === 'retry-recovered'
    );
    expect(recoveredCalls.length).toBe(1);
    expect((recoveredCalls[0][0] as { payload: { priorDelayedRetryCount: number } }).payload.priorDelayedRetryCount).toBe(1);
  });
});
