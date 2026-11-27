import { describe, expect, it, vi } from 'vitest';
import { runEnqueue, UnnamedQueueError, type EnqueueCommandArgs } from '../../../src/commands/enqueue';
import { runAuto } from '../../../src/commands/auto';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';

// FR-R3-002 (T287) — enqueue routes to the queue the caller named, and refuses
// a caller that named none.
//
// Seam 1 of FUNC-02: `runEnqueue` accepted an optional `queueId` and then wrote
// `queueId: DEFAULT_QUEUE_ID` unconditionally, so the queue Dashboard Start
// forwarded was dropped one layer below the surface that chose it.

vi.mock('vscode', () => ({
  window: { showInputBox: vi.fn(async () => undefined) }
}));

function makeCtx(over: { queueName?: string } = {}) {
  const scheduleOrEnqueue = vi.fn(
    async (req: { queueId?: string; description: string }) => {
      // Mirror the guarded service: the row lands on the queue it was given.
      inserted.push({ id: 'task-1', queueId: req.queueId ?? '(none)' });
      return { outcome: 'enqueued' as const, queueItemId: 'task-1' };
    }
  );
  const inserted: { id: string; queueId: string }[] = [];
  const audit = {
    append: vi.fn(
      async (_entry: { eventType: string; payload: Record<string, unknown> }) => undefined
    )
  };
  const logger = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    sanitize: (v: string) => v
  };
  const getQueue = vi.fn((queueId: string) => ({
    requests: inserted.filter((row) => row.queueId === queueId)
  }));
  const ctx = {
    guardedRunService: { scheduleOrEnqueue } as never,
    store: {
      getQueue,
      getQueueRegistry: () => ({
        entries: [
          { id: DEFAULT_QUEUE_ID, name: 'Default' },
          { id: 'queue-b', name: over.queueName ?? 'Release' }
        ]
      })
    } as never,
    audit: audit as never,
    logger: logger as never,
    via: 'dashboard-submit' as const,
    promptForInput: false
  };
  return { ctx, scheduleOrEnqueue, audit, logger, inserted, getQueue };
}

describe('runEnqueue — queue identity (FR-R3-002)', () => {
  it('enqueues to the queue the caller named', async () => {
    const h = makeCtx();
    const result = await runEnqueue(
      { description: 'ship the thing', queueId: 'queue-b' },
      h.ctx
    );
    expect(h.scheduleOrEnqueue).toHaveBeenCalledOnce();
    expect(h.scheduleOrEnqueue.mock.calls[0]![0]).toMatchObject({ queueId: 'queue-b' });
    expect(result?.queueId).toBe('queue-b');
    expect(result?.queueName).toBe('Release');
  });

  it('names the caller-supplied queue in the task-enqueued audit event', async () => {
    const h = makeCtx();
    await runEnqueue({ description: 'ship the thing', queueId: 'queue-b' }, h.ctx);
    expect(h.audit.append).toHaveBeenCalledOnce();
    const entry = h.audit.append.mock.calls[0]![0];
    expect(entry.eventType).toBe('task-enqueued');
    expect(entry.payload).toMatchObject({ taskId: 'task-1', queueId: 'queue-b' });
  });

  it('reads the inserted row back from the named queue, not from Default', async () => {
    // The read-back used an argument-less `getQueue()`. With the row on
    // `queue-b` that lookup found nothing and reported `queueId: null`, which
    // the Dashboard ack surfaces as a task with no queue.
    const h = makeCtx();
    await runEnqueue({ description: 'ship the thing', queueId: 'queue-b' }, h.ctx);
    expect(h.getQueue).toHaveBeenCalledExactlyOnceWith('queue-b');
  });

  it('refuses a caller that supplies no queueId', async () => {
    const h = makeCtx();
    await expect(
      runEnqueue({ description: 'ship the thing' } as unknown as EnqueueCommandArgs, h.ctx)
    ).rejects.toBeInstanceOf(UnnamedQueueError);
    expect(h.scheduleOrEnqueue).not.toHaveBeenCalled();
  });

  it('refuses a blank queueId rather than trimming it into Default', async () => {
    const h = makeCtx();
    await expect(
      runEnqueue({ description: 'ship the thing', queueId: '   ' }, h.ctx)
    ).rejects.toBeInstanceOf(UnnamedQueueError);
    expect(h.scheduleOrEnqueue).not.toHaveBeenCalled();
  });

  it('refuses with no args at all', async () => {
    const h = makeCtx();
    await expect(runEnqueue(undefined, h.ctx)).rejects.toBeInstanceOf(UnnamedQueueError);
    expect(h.scheduleOrEnqueue).not.toHaveBeenCalled();
  });

  it('carries the calling surface on the refusal', async () => {
    const h = makeCtx();
    const err = await runEnqueue(
      { description: 'x' } as unknown as EnqueueCommandArgs,
      h.ctx
    ).catch((e: unknown) => e as UnnamedQueueError);
    expect(err).toBeInstanceOf(UnnamedQueueError);
    expect((err as UnnamedQueueError).via).toBe('dashboard-submit');
    expect((err as UnnamedQueueError).message).toBe('enqueue-requires-queue-id');
  });

  it('still routes a Default-queue enqueue to Default (behaviour unchanged)', async () => {
    // The single-queue workspace is the common case and must be untouched:
    // this requirement removes implicit fallbacks, not the Default queue.
    const h = makeCtx();
    const result = await runEnqueue(
      { description: 'ship the thing', queueId: DEFAULT_QUEUE_ID },
      h.ctx
    );
    expect(h.scheduleOrEnqueue.mock.calls[0]![0]).toMatchObject({
      queueId: DEFAULT_QUEUE_ID
    });
    expect(result?.queueId).toBe(DEFAULT_QUEUE_ID);
  });
});

describe('runAuto — the Palette names Default explicitly (FR-R3-002)', () => {
  it('resolves the reserved default at its own boundary rather than passing an absence on', async () => {
    const h = makeCtx();
    // A description is supplied so the Palette's input box is skipped; the
    // subject here is the queue the Palette names, not its prompt.
    await runAuto({ description: 'ship the thing' }, {
      guardedRunService: h.ctx.guardedRunService,
      store: h.ctx.store,
      audit: h.ctx.audit,
      notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      logger: h.ctx.logger
    });
    expect(h.scheduleOrEnqueue).toHaveBeenCalledOnce();
    expect(h.scheduleOrEnqueue.mock.calls[0]![0]).toMatchObject({
      queueId: DEFAULT_QUEUE_ID
    });
    // The refusal path is never reached, so the operator sees no error.
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('honours a queue the caller did name', async () => {
    const h = makeCtx();
    await runAuto(
      { description: 'ship the thing', queueId: 'queue-b' },
      {
        guardedRunService: h.ctx.guardedRunService,
        store: h.ctx.store,
        audit: h.ctx.audit,
        notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
        logger: h.ctx.logger
      }
    );
    expect(h.scheduleOrEnqueue.mock.calls[0]![0]).toMatchObject({ queueId: 'queue-b' });
  });
});
