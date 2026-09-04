// FR-R3-150 (T1620) — unit test for `runClearQueue`'s failure-mode toast
// translation, mirroring `clear-all.test.ts`'s T020 pattern.
//
// Code-review finding — the lock-contention and persistence-error toasts
// used to be `clear-all.ts`'s unaddressed, workspace-wide wording verbatim,
// even though `queueId` is known for the whole lifetime of `runClearQueue`
// (unlike `runClearAll`, which has no single queue to name). This file pins
// that both toasts now name the addressed queue.

import { describe, it, expect, vi } from 'vitest';
import { runClearQueue, type ClearQueueCtx } from '../../../src/commands/clear-queue';
import type { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import type { QueueManager, ClearQueueResult } from '../../../src/queue/queue-manager';
import type { ExecutionLeasePort } from '../../../src/services/auto-drain-coordinator';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import type { Notifier } from '../../../src/ui/notifications';
import { SanitizedLogger } from '../../../src/lib/logger';

function fakeController(driving = false): SchegentWorkflowController {
  return {
    cancelActive: vi.fn(),
    isDriving: () => driving
  } as unknown as SchegentWorkflowController;
}

function fakeQueue(result: ClearQueueResult | Error): QueueManager {
  return {
    clearQueue: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    })
  } as unknown as QueueManager;
}

function fakeExecutionLease(): ExecutionLeasePort & { release: ReturnType<typeof vi.fn> } {
  return {
    tryAcquire: vi.fn(async () => ({ acquired: true, ownerId: 'test' })),
    release: vi.fn(async () => undefined)
  } as unknown as ExecutionLeasePort & { release: ReturnType<typeof vi.fn> };
}

function fakeAudit(): AuditLogWriter & { append: ReturnType<typeof vi.fn> } {
  return { append: vi.fn(async () => undefined) } as unknown as AuditLogWriter & {
    append: ReturnType<typeof vi.fn>;
  };
}

function fakeNotifier(): Notifier & {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as unknown as Notifier & {
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

function fakeLock(hasPrimacyValue = true): WorkspaceLockManager & {
  hasPrimacy: ReturnType<typeof vi.fn>;
} {
  return {
    hasPrimacy: vi.fn(async () => hasPrimacyValue),
    release: vi.fn(async () => undefined)
  } as unknown as WorkspaceLockManager & { hasPrimacy: ReturnType<typeof vi.fn> };
}

function buildCtx(overrides: {
  controller?: SchegentWorkflowController;
  queue: QueueManager;
  lock?: WorkspaceLockManager;
}): ClearQueueCtx & {
  notifier: ReturnType<typeof fakeNotifier>;
  audit: ReturnType<typeof fakeAudit>;
  executionLease: ReturnType<typeof fakeExecutionLease>;
} {
  return {
    controller: overrides.controller ?? fakeController(false),
    queue: overrides.queue,
    executionLease: fakeExecutionLease(),
    audit: fakeAudit(),
    lock: overrides.lock ?? fakeLock(true),
    notifier: fakeNotifier(),
    logger: new SanitizedLogger()
  } as unknown as ClearQueueCtx & {
    notifier: ReturnType<typeof fakeNotifier>;
    audit: ReturnType<typeof fakeAudit>;
    executionLease: ReturnType<typeof fakeExecutionLease>;
  };
}

describe('runClearQueue — failure-mode toast translation names the queue', () => {
  it('lock contention: warns with the addressed queue named, no lease release, no audit', async () => {
    const queue = fakeQueue(new Error('unreachable — refused before any queue op'));
    const ctx = buildCtx({ queue, lock: fakeLock(false) });

    const result = await runClearQueue(ctx, 'queue-b');

    expect(result).toEqual({ ok: false, reason: 'not-primary' });
    expect(ctx.notifier.warn).toHaveBeenCalledTimes(1);
    // Asserted through the matcher rather than by indexing `mock.calls[0]`:
    // this form also pins the arity (one argument, the toast) and reads as a
    // named failure when `warn` was never called.
    expect(ctx.notifier.warn).toHaveBeenCalledWith(expect.stringContaining('queue-b'));
    expect(ctx.notifier.warn).not.toHaveBeenCalledWith(
      'Clean All could not start — another operation is in progress.'
    );
    expect(ctx.executionLease.release).not.toHaveBeenCalled();
    expect(ctx.audit.append).not.toHaveBeenCalled();
  });

  it('persistence error: errors with the addressed queue named, no audit', async () => {
    const queue = fakeQueue(new Error('disk full'));
    const ctx = buildCtx({ queue });

    const result = await runClearQueue(ctx, 'queue-b');

    expect(result).toEqual({ ok: false, reason: 'persistence-error' });
    expect(ctx.notifier.error).toHaveBeenCalledTimes(1);
    // Through the matcher, for the same reason as the lock-contention case
    // above: it pins the arity and names the failure when nothing was called.
    expect(ctx.notifier.error).toHaveBeenCalledWith(expect.stringContaining('queue-b'));
    expect(ctx.notifier.error).not.toHaveBeenCalledWith(
      'Clean All could not complete — workspace state could not be written.'
    );
    expect(ctx.audit.append).not.toHaveBeenCalled();
  });
});
