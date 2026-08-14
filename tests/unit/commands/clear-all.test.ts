// Feature 063 — T020 unit test for `runClearAll` orchestrator. Pins the
// three operator-visible toast messages required by
// specs/063-clean-all-confirmations/contracts/cmd-clear-all.md
// §"Failure modes":
//
//   1. Lock contention (this window is not primary): warn with
//      `CLEAN_ALL_LOCK_CONTENTION_TOAST`, no audit, no state writes.
//   2. Persistence error (`QueueManager.clearAll()` throws):
//      `CLEAN_ALL_PERSISTENCE_ERROR_TOAST` and no audit append.
//   3. Runner no-ack within the 2s window (`runnerAcked: false` with
//      `inflightAborted: true`): warn with
//      `CLEAN_ALL_RUNNER_STILL_PENDING_TOAST`. The state is still
//      cleared and one `queue-cleared-all` audit event still fires.
//
// Also covers the audit happy path: when state actually changes, exactly
// one `queue-cleared-all` event is emitted with the structured payload
// matching `QueueClearedAllPayload`.
//
// Mocks `QueueManager.clearAll()` directly so the orchestrator wiring is
// the unit under test, not the queue implementation (covered by T019).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runClearAll, type ClearAllCtx } from '../../../src/commands/clear-all';
import type { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import type { QueueManager, CleanAllResult } from '../../../src/queue/queue-manager';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { WorkspaceStateStore } from '../../../src/state/workspace-state';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import type { Notifier } from '../../../src/ui/notifications';
import { SanitizedLogger } from '../../../src/lib/logger';

const CLEAN_ALL_LOCK_CONTENTION_TOAST =
  'Clean All could not start — another operation is in progress.';
const CLEAN_ALL_PERSISTENCE_ERROR_TOAST =
  'Clean All could not complete — workspace state could not be written.';
const CLEAN_ALL_RUNNER_STILL_PENDING_TOAST =
  'Clean All completed; runner cancellation is still pending.';

function fakeRunningController(running = false): SchegentWorkflowController {
  return {
    get running() {
      return running;
    },
    cancelActive: vi.fn()
  } as unknown as SchegentWorkflowController;
}

function fakeQueue(result: CleanAllResult | Error): QueueManager {
  return {
    clearAll: vi.fn(async (probe?: () => Promise<boolean>) => {
      if (result instanceof Error) throw result;
      if (result.inflightAborted && probe) {
        try {
          (result as { runnerAcked: boolean }).runnerAcked = await probe();
        } catch {
          (result as { runnerAcked: boolean }).runnerAcked = false;
        }
      }
      return result;
    })
  } as unknown as QueueManager;
}

function fakeAudit(): AuditLogWriter & { append: ReturnType<typeof vi.fn> } {
  return { append: vi.fn(async () => undefined) } as unknown as AuditLogWriter & {
    append: ReturnType<typeof vi.fn>;
  };
}

function fakeNotifier(): Notifier & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as unknown as Notifier & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

function fakeLock(isHeldValue = true): WorkspaceLockManager & {
  isHeld: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  return {
    isHeld: vi.fn(() => isHeldValue),
    release: vi.fn(async () => undefined)
  } as unknown as WorkspaceLockManager & {
    isHeld: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
}

function fakeStore(): WorkspaceStateStore {
  return {} as unknown as WorkspaceStateStore;
}

function buildCtx(overrides: {
  controller?: SchegentWorkflowController;
  queue: QueueManager;
  lock?: WorkspaceLockManager;
  audit?: AuditLogWriter;
  notifier?: Notifier;
}): ClearAllCtx & {
  notifier: ReturnType<typeof fakeNotifier>;
  audit: ReturnType<typeof fakeAudit>;
  lock: ReturnType<typeof fakeLock>;
} {
  const notifier = (overrides.notifier as ReturnType<typeof fakeNotifier>) ?? fakeNotifier();
  const audit = (overrides.audit as ReturnType<typeof fakeAudit>) ?? fakeAudit();
  const lock = (overrides.lock as ReturnType<typeof fakeLock>) ?? fakeLock(true);
  return {
    controller: overrides.controller ?? fakeRunningController(false),
    store: fakeStore(),
    queue: overrides.queue,
    audit,
    lock,
    notifier,
    logger: new SanitizedLogger()
  } as unknown as ClearAllCtx & {
    notifier: ReturnType<typeof fakeNotifier>;
    audit: ReturnType<typeof fakeAudit>;
    lock: ReturnType<typeof fakeLock>;
  };
}

const ACTIVE_RESULT: CleanAllResult = {
  removed: { pending: 2, completed: 1, failed: 1, canceled: 0 },
  inflightAborted: true,
  runnerAcked: false,
  pauseCleared: true,
  pauseSource: 'operator',
  activeRunCleared: true,
  watchdogCleared: false,
  wasNoop: false
};

const NOOP_RESULT: CleanAllResult = {
  removed: { pending: 0, completed: 0, failed: 0, canceled: 0 },
  inflightAborted: false,
  runnerAcked: false,
  pauseCleared: false,
  pauseSource: null,
  activeRunCleared: false,
  watchdogCleared: false,
  wasNoop: true
};

describe('runClearAll — failure-mode translation (T020)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('lock contention: warns with CLEAN_ALL_LOCK_CONTENTION_TOAST and emits no audit', async () => {
    const queue = fakeQueue(ACTIVE_RESULT);
    const ctx = buildCtx({ queue, lock: fakeLock(false) });
    const result = await runClearAll(ctx);

    expect(result).toEqual({ ok: false, reason: 'not-primary' });
    expect(ctx.notifier.warn).toHaveBeenCalledWith(CLEAN_ALL_LOCK_CONTENTION_TOAST);
    expect(ctx.audit.append).not.toHaveBeenCalled();
    expect((queue as unknown as { clearAll: ReturnType<typeof vi.fn> }).clearAll).not.toHaveBeenCalled();
  });

  it('persistence error: warns with CLEAN_ALL_PERSISTENCE_ERROR_TOAST and emits no audit', async () => {
    const queue = fakeQueue(new Error('disk full'));
    const ctx = buildCtx({ queue });
    const result = await runClearAll(ctx);

    expect(result).toEqual({ ok: false, reason: 'persistence-error' });
    expect(ctx.notifier.error).toHaveBeenCalledWith(CLEAN_ALL_PERSISTENCE_ERROR_TOAST);
    expect(ctx.audit.append).not.toHaveBeenCalled();
  });

  it('runner no-ack: warns with CLEAN_ALL_RUNNER_STILL_PENDING_TOAST AND still emits one audit', async () => {
    // Build a controller that keeps `running === true` for the entire
    // 2s probe window — the probe times out and returns false.
    const controller = fakeRunningController(true);
    const queue = fakeQueue({ ...ACTIVE_RESULT, runnerAcked: false });
    const ctx = buildCtx({ controller, queue });

    const startedAt = Date.now();
    const result = await runClearAll(ctx);
    const elapsed = Date.now() - startedAt;

    expect(result).toEqual({ ok: true });
    expect(ctx.notifier.warn).toHaveBeenCalledWith(CLEAN_ALL_RUNNER_STILL_PENDING_TOAST);
    expect(ctx.audit.append).toHaveBeenCalledTimes(1);
    const auditCall = ctx.audit.append.mock.calls[0][0];
    expect(auditCall.eventType).toBe('queue-cleared-all');
    expect(auditCall.payload.runnerState).toBe('timed-out');
    // Probe budget is 2s; allow some slack on slow CI but assert it actually
    // waited at least 1.5s (the probe polls until the deadline).
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
    // Feature 093 (T068b, FR-028) — no ack, no release. Still true, for a
    // different reason: `runClearAll` releases primacy on no path at all now.
    expect(ctx.lock.release).not.toHaveBeenCalled();
  });

  // Feature 093 (T068b, FR-028) — this asserted `release` was called exactly
  // once. Window primacy is acquired at activation and released at disposal;
  // Clean All is neither. The old release stopped the heartbeat and nulled the
  // record, and only `tryAcquire()` restores either, so one Clean All left the
  // window non-primary for the rest of the session — including for its own
  // `isHeld()` guard on the next Clean All. The ack still matters, and is still
  // asserted: it decides the toast and the audited `runnerState`.
  it('runner acks: keeps primacy and does not emit the runner-pending toast', async () => {
    // Controller flips `running` to false promptly — the probe resolves true.
    const flipping = (() => {
      let running = true;
      return {
        get running() {
          return running;
        },
        cancelActive: () => {
          running = false;
        }
      } as unknown as SchegentWorkflowController;
    })();
    const queue = fakeQueue({ ...ACTIVE_RESULT, runnerAcked: false });
    const ctx = buildCtx({ controller: flipping, queue });

    const result = await runClearAll(ctx);

    expect(result).toEqual({ ok: true });
    expect(ctx.notifier.warn).not.toHaveBeenCalled();
    expect(ctx.lock.release).not.toHaveBeenCalled();
    const auditCall = ctx.audit.append.mock.calls[0][0];
    expect(auditCall.payload.runnerState).toBe('acked');
  });

  it('no-op result: no toast, no audit, no lock release', async () => {
    const queue = fakeQueue(NOOP_RESULT);
    const ctx = buildCtx({ queue });
    const result = await runClearAll(ctx);

    expect(result).toEqual({ ok: true });
    expect(ctx.notifier.warn).not.toHaveBeenCalled();
    expect(ctx.notifier.info).not.toHaveBeenCalled();
    expect(ctx.notifier.error).not.toHaveBeenCalled();
    expect(ctx.audit.append).not.toHaveBeenCalled();
    expect(ctx.lock.release).not.toHaveBeenCalled();
  });

  it('audit payload mirrors the CleanAllResult shape', async () => {
    const flipping = (() => {
      let running = true;
      return {
        get running() {
          return running;
        },
        cancelActive: () => {
          running = false;
        }
      } as unknown as SchegentWorkflowController;
    })();
    const queue = fakeQueue({
      removed: { pending: 5, completed: 0, failed: 2, canceled: 1 },
      inflightAborted: true,
      runnerAcked: false,
      pauseCleared: true,
      pauseSource: 'cascade',
      activeRunCleared: true,
      watchdogCleared: true,
      wasNoop: false
    });
    const ctx = buildCtx({ controller: flipping, queue });

    await runClearAll(ctx);

    expect(ctx.audit.append).toHaveBeenCalledTimes(1);
    const entry = ctx.audit.append.mock.calls[0][0];
    expect(entry.runId).toBe('queue:default');
    expect(entry.phase).toBe('queue');
    expect(entry.iteration).toBe(0);
    expect(entry.eventType).toBe('queue-cleared-all');
    expect(entry.outcome).toBe('info');
    expect(entry.payload).toEqual({
      removedPending: 5,
      removedInFlight: 1,
      pauseStateCleared: true,
      runnerState: 'acked',
      watchdogBackoffCleared: true
    });
  });

  it('audit append throwing does not break the operation', async () => {
    const queue = fakeQueue({ ...NOOP_RESULT, wasNoop: false, removed: { pending: 1, completed: 0, failed: 0, canceled: 0 } });
    const audit = fakeAudit();
    audit.append.mockRejectedValueOnce(new Error('disk full'));
    const ctx = buildCtx({ queue, audit });
    const result = await runClearAll(ctx);

    expect(result).toEqual({ ok: true });
    expect(audit.append).toHaveBeenCalledTimes(1);
  });
});
