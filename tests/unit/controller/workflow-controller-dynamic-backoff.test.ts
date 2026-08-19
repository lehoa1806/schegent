// Feature 027 — US1 / US2 / US3: dynamic-backoff, cause-widening, and
// audit-payload tests for the workflow controller's delayed-retry path.

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
  RATE_LIMIT_BACKOFF_MS,
  RETRY_BUFFER_MS,
  RETRY_FLOOR_MS,
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
  return { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
}
function makeNotifier(): Notifier {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;
}
function makeLock(): WorkspaceLockManager {
  return {
    release: vi.fn(async () => {}),
    tryAcquire: vi.fn(),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
}

function makeRateLimitedOutput(resetsAtMs: number | null | undefined, cause = 'rate-limit'): PhaseRunOutput {
  return {
    result: {
      kind: 'rate_limited',
      cause,
      auditEntry: null,
      ...(resetsAtMs === undefined ? {} : { resetsAtMs })
    },
    outcome: 'rate_limited',
    terminationReason: 'rate_limit',
    stdoutSummary: '',
    stderrSummary: 'over rate limit',
    exitCode: 1,
    auditEntryId: 'audit-rl',
    warnings: []
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
let runSpy: ReturnType<typeof vi.fn>;
let controller: SchegentWorkflowController;
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
  runSpy = vi.fn();
  const phaseRunner: PhaseRunner = { run: runSpy } as unknown as PhaseRunner;
  const auditAppend = vi.fn();
  auditAppend.mockImplementation(async (entry: Record<string, unknown>) => ({
    id: 'mock-audit-id',
    timestamp: new Date().toISOString(),
    ...entry
  }));
  auditWriter = { append: auditAppend };
  const pauseAndPoll = vi.fn();
  pauseAndPoll.mockImplementation(async () => {});
  watchdog = { pauseAndPoll, cancelPendingTimer: vi.fn() };
  controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    makeStatusBar(),
    makeNotifier(),
    new SanitizedLogger(),
    makeLock(),
    opts,
    {
      catalog: buildSpeckitCatalog(),
      auditWriter:
        auditWriter as unknown as import('../../../src/audit/audit-log-writer').AuditLogWriter,
      watchdog: watchdog as unknown as DelayedRetryWatchdog
    }
  );
});

describe('FR-009 — backoffForCause: dynamic path on future resetsAtMs', () => {
  it('schedules pendingRetryAt ≈ resetsAtMs + RETRY_BUFFER_MS when resetsAtMs is in the future', async () => {
    const future = Date.now() + 5 * 60 * 1000; // 5 minutes from now
    runSpy.mockImplementation(async () => makeRateLimitedOutput(future));
    const feature = await queue.enqueue('feature-A');
    await controller.startNew(feature, null);
    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.pendingRetryAt).not.toBeNull();
    expect(Math.abs(run.pendingRetryAt! - (future + RETRY_BUFFER_MS))).toBeLessThan(200);
  });
});

describe('FR-010 — backoffForCause: floor on past resetsAtMs', () => {
  it('applies the 60-second floor when resetsAtMs is in the past', async () => {
    const past = Date.now() - 10 * 60 * 1000; // 10 minutes ago
    const before = Date.now();
    runSpy.mockImplementation(async () => makeRateLimitedOutput(past));
    const feature = await queue.enqueue('feature-B');
    await controller.startNew(feature, null);
    const after = Date.now();
    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.pendingRetryAt).not.toBeNull();
    const offsetFromBefore = run.pendingRetryAt! - before;
    const offsetFromAfter = run.pendingRetryAt! - after;
    expect(offsetFromBefore).toBeGreaterThanOrEqual(RETRY_FLOOR_MS - 200);
    expect(offsetFromAfter).toBeLessThanOrEqual(RETRY_FLOOR_MS + 200);
  });
});

describe('FR-011 — backoffForCause: fallback to fixed 60-min on null resetsAtMs', () => {
  it('null resetsAtMs falls back to RATE_LIMIT_BACKOFF_MS', async () => {
    const before = Date.now();
    runSpy.mockImplementation(async () => makeRateLimitedOutput(null));
    const feature = await queue.enqueue('feature-C');
    await controller.startNew(feature, null);
    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.pendingRetryAt).not.toBeNull();
    const offset = run.pendingRetryAt! - before;
    expect(offset).toBeGreaterThanOrEqual(RATE_LIMIT_BACKOFF_MS - 200);
    expect(offset).toBeLessThan(RATE_LIMIT_BACKOFF_MS + 5000);
  });

  it('undefined resetsAtMs (variant omits field) also falls back to fixed 60-min', async () => {
    const before = Date.now();
    runSpy.mockImplementation(async () => makeRateLimitedOutput(undefined));
    const feature = await queue.enqueue('feature-D');
    await controller.startNew(feature, null);
    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    const offset = run.pendingRetryAt! - before;
    expect(offset).toBeGreaterThanOrEqual(RATE_LIMIT_BACKOFF_MS - 200);
    expect(offset).toBeLessThan(RATE_LIMIT_BACKOFF_MS + 5000);
  });
});

describe('FR-012 — transient_error ignores any resetsAtMs', () => {
  it('transient_error uses fixed TRANSIENT_BACKOFF_MS regardless of any resetsAtMs', async () => {
    const before = Date.now();
    runSpy.mockImplementation(async () => makeTransientOutput());
    const feature = await queue.enqueue('feature-E');
    await controller.startNew(feature, null);
    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    const offset = run.pendingRetryAt! - before;
    expect(offset).toBeGreaterThanOrEqual(TRANSIENT_BACKOFF_MS - 200);
    expect(offset).toBeLessThan(TRANSIENT_BACKOFF_MS + 5000);
  });
});

describe('FR-016 — toDelayedRetryCause widening (US2)', () => {
  it('maps "out-of-usage" cause to the rate_limit DelayedRetryCause', async () => {
    const future = Date.now() + 5 * 60 * 1000;
    runSpy.mockImplementation(async () => makeRateLimitedOutput(future, 'out-of-usage'));
    const feature = await queue.enqueue('feature-F');
    await controller.startNew(feature, null);
    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.pendingRetryCause).toBe('rate_limit');
  });

  it('maps "credits-exhausted" cause to rate_limit', async () => {
    runSpy.mockImplementation(async () => makeRateLimitedOutput(null, 'credits-exhausted'));
    const feature = await queue.enqueue('feature-G');
    await controller.startNew(feature, null);
    expect(store.getRun(DEFAULT_QUEUE_ID)!.pendingRetryCause).toBe('rate_limit');
  });

  it('maps "quota-exceeded" cause to rate_limit', async () => {
    runSpy.mockImplementation(async () => makeRateLimitedOutput(null, 'quota-exceeded'));
    const feature = await queue.enqueue('feature-H');
    await controller.startNew(feature, null);
    expect(store.getRun(DEFAULT_QUEUE_ID)!.pendingRetryCause).toBe('rate_limit');
  });

  it('maps "rate-limit" cause to rate_limit (existing parser cause string)', async () => {
    runSpy.mockImplementation(async () => makeRateLimitedOutput(null, 'rate-limit'));
    const feature = await queue.enqueue('feature-I');
    await controller.startNew(feature, null);
    expect(store.getRun(DEFAULT_QUEUE_ID)!.pendingRetryCause).toBe('rate_limit');
  });

  it('preserves transient_error → transient_error mapping (regression)', async () => {
    runSpy.mockImplementation(async () => makeTransientOutput());
    const feature = await queue.enqueue('feature-J');
    await controller.startNew(feature, null);
    expect(store.getRun(DEFAULT_QUEUE_ID)!.pendingRetryCause).toBe('transient_error');
  });
});

describe('FR-013 — retry-scheduled audit payload carries resetsAtMs (US3)', () => {
  it('payload carries the finite resetsAtMs for future-epoch dynamic path', async () => {
    const future = Date.now() + 5 * 60 * 1000;
    runSpy.mockImplementation(async () => makeRateLimitedOutput(future));
    const feature = await queue.enqueue('feature-K');
    await controller.startNew(feature, null);
    const calls = auditWriter.append.mock.calls.find(
      (c) => (c[0] as { eventType: string }).eventType === 'retry-scheduled'
    );
    expect(calls).toBeDefined();
    const payload = (calls![0] as { payload: { resetsAtMs?: number | null } }).payload;
    expect(payload.resetsAtMs).toBe(future);
  });

  it('payload carries null resetsAtMs explicitly on fallback path', async () => {
    runSpy.mockImplementation(async () => makeRateLimitedOutput(null));
    const feature = await queue.enqueue('feature-L');
    await controller.startNew(feature, null);
    const calls = auditWriter.append.mock.calls.find(
      (c) => (c[0] as { eventType: string }).eventType === 'retry-scheduled'
    );
    const payload = (calls![0] as { payload: { resetsAtMs?: number | null } }).payload;
    expect(payload.resetsAtMs).toBeNull();
  });

  it('payload carries the past resetsAtMs verbatim (not clamped) for floor-applied case', async () => {
    const past = Date.now() - 10 * 60 * 1000;
    runSpy.mockImplementation(async () => makeRateLimitedOutput(past));
    const feature = await queue.enqueue('feature-M');
    await controller.startNew(feature, null);
    const calls = auditWriter.append.mock.calls.find(
      (c) => (c[0] as { eventType: string }).eventType === 'retry-scheduled'
    );
    const payload = (calls![0] as { payload: { resetsAtMs?: number | null } }).payload;
    expect(payload.resetsAtMs).toBe(past);
  });

  it('transient_error payload carries null resetsAtMs', async () => {
    runSpy.mockImplementation(async () => makeTransientOutput());
    const feature = await queue.enqueue('feature-N');
    await controller.startNew(feature, null);
    const calls = auditWriter.append.mock.calls.find(
      (c) => (c[0] as { eventType: string }).eventType === 'retry-scheduled'
    );
    const payload = (calls![0] as { payload: { resetsAtMs?: number | null } }).payload;
    expect(payload.resetsAtMs).toBeNull();
  });

  it('buffer is derivable from scheduledAt - resetsAtMs (≈ RETRY_BUFFER_MS for future epoch)', async () => {
    const future = Date.now() + 5 * 60 * 1000;
    runSpy.mockImplementation(async () => makeRateLimitedOutput(future));
    const feature = await queue.enqueue('feature-O');
    await controller.startNew(feature, null);
    const calls = auditWriter.append.mock.calls.find(
      (c) => (c[0] as { eventType: string }).eventType === 'retry-scheduled'
    );
    const payload = (calls![0] as { payload: { scheduledAt: number; resetsAtMs: number | null } }).payload;
    expect(payload.resetsAtMs).toBe(future);
    expect(Math.abs((payload.scheduledAt - (payload.resetsAtMs as number)) - RETRY_BUFFER_MS)).toBeLessThan(200);
  });

  it('past resetsAtMs case shows floor application (scheduledAt - resetsAtMs > RETRY_BUFFER_MS)', async () => {
    const past = Date.now() - 10 * 60 * 1000;
    runSpy.mockImplementation(async () => makeRateLimitedOutput(past));
    const feature = await queue.enqueue('feature-P');
    await controller.startNew(feature, null);
    const calls = auditWriter.append.mock.calls.find(
      (c) => (c[0] as { eventType: string }).eventType === 'retry-scheduled'
    );
    const payload = (calls![0] as { payload: { scheduledAt: number; resetsAtMs: number | null } }).payload;
    expect(payload.scheduledAt - (payload.resetsAtMs as number)).toBeGreaterThan(RETRY_BUFFER_MS);
  });
});
