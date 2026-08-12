// BUG-002 (FR-012a, T082) — cmd-start-queue handler unit tests.
// The handler delegates to `schegent.startQueue` via the `exec` helper
// and acks `accepted`. Error propagation is handled by the router's
// outer try/catch; the handler itself does not catch.

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { handler as startQueueHandler } from '../../../../../src/ui/sidebar/commands/cmd-start-queue';
import { CMD_START_QUEUE } from '../../../../../src/contracts/sidebar-ipc';
import type { CommandAckMessage, StartQueueCommand } from '../../../../../src/contracts/sidebar-ipc';

function buildCtx(opts: {
  executeCommandRejects?: boolean;
  executeCommandError?: Error;
} = {}): {
  ctx: Parameters<typeof startQueueHandler>[0];
  acks: CommandAckMessage[];
  executeCommandSpy: ReturnType<typeof vi.fn>;
  warnings: string[];
} {
  const acks: CommandAckMessage[] = [];
  const warnings: string[] = [];
  const logger = {
    info: vi.fn(),
    warn: (msg: string) => warnings.push(msg),
    error: vi.fn(),
    debug: vi.fn(),
    sanitize: (s: string) => s
  };
  const executeCommandSpy = vi.fn(async (..._args: unknown[]) => {
    if (opts.executeCommandRejects) {
      throw opts.executeCommandError ?? new Error('no pending tasks');
    }
  });
  const ctx = {
    deps: {
      executeCommand: executeCommandSpy,
      queueRemover: { remove: vi.fn() },
      logger,
      audit: { append: vi.fn() }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'test-start-queue-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { ctx, acks, executeCommandSpy, warnings };
}

function makeCmd(): StartQueueCommand {
  return {
    type: CMD_START_QUEUE,
    correlationId: 'test-start-queue-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cmd-start-queue handler (BUG-002, FR-012a, T082)', () => {
  it('calls executeCommand with "schegent.startQueue"', async () => {
    const { ctx, executeCommandSpy } = buildCtx();
    await startQueueHandler(ctx, makeCmd());
    expect(executeCommandSpy).toHaveBeenCalledTimes(1);
    // Feature 065 — handler threads an optional startIntent payload; when
    // the chooser is not in play the second arg is `undefined`.
    expect(executeCommandSpy).toHaveBeenCalledWith('schegent.startQueue', undefined);
  });

  it('posts ack("accepted") on success', async () => {
    const { ctx, acks } = buildCtx();
    await startQueueHandler(ctx, makeCmd());
    expect(acks).toHaveLength(1);
    expect(acks[0].status).toBe('accepted');
    expect(acks[0].correlationId).toBe('test-start-queue-1');
  });

  it('propagates errors from executeCommand (router catches)', async () => {
    const { ctx } = buildCtx({
      executeCommandRejects: true,
      executeCommandError: new Error('no pending tasks in queue')
    });
    // The handler does NOT try/catch — errors propagate to the router's
    // outer wrapper. This is by design: the router logs the error and
    // sends a rejected ack with the error message.
    await expect(startQueueHandler(ctx, makeCmd())).rejects.toThrow(
      'no pending tasks in queue'
    );
  });

  it('does not ack before executeCommand resolves', async () => {
    let execResolved = false;
    const executeCommandSpy = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      execResolved = true;
    });
    const acks: CommandAckMessage[] = [];
    const ctx = {
      deps: {
        executeCommand: executeCommandSpy,
        queueRemover: { remove: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), sanitize: (s: string) => s },
        audit: { append: vi.fn() }
      },
      postAck: async (msg: CommandAckMessage) => {
        // When postAck is called, exec should have already resolved
        expect(execResolved).toBe(true);
        acks.push(msg);
        return true;
      },
      correlationId: 'test-ordering'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await startQueueHandler(ctx, makeCmd());
    expect(acks).toHaveLength(1);
  });

  it('sends no payload at all when the command names neither queue nor intent', async () => {
    const { ctx, executeCommandSpy } = buildCtx();
    await startQueueHandler(ctx, makeCmd());
    // Feature 092 (T061, FR-034) — this pin used to read "does not send a
    // queueId payload (single-queue migration)" and encoded feature 030's
    // collapse to one queue. That collapse is what this feature reverses, so
    // the pin is re-aimed rather than deleted: an unaddressed start still
    // sends `undefined`, byte for byte the pre-092 wire shape, and the host
    // command is the single place that decides what that means.
    expect(executeCommandSpy.mock.calls[0]).toEqual(['schegent.startQueue', undefined]);
  });

  it('forwards the addressed queueId (feature 092, T061, FR-034)', async () => {
    const { ctx, executeCommandSpy } = buildCtx();
    await startQueueHandler(ctx, {
      type: CMD_START_QUEUE,
      correlationId: 'test-start-queue-1',
      payload: { queueId: 'queue-b' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(executeCommandSpy.mock.calls[0]).toEqual([
      'schegent.startQueue',
      { queueId: 'queue-b' }
    ]);
  });

  it('forwards queueId and startIntent together', async () => {
    const { ctx, executeCommandSpy } = buildCtx();
    const startIntent = { startMode: 'now', source: 'operator-restart' } as const;
    await startQueueHandler(ctx, {
      type: CMD_START_QUEUE,
      correlationId: 'test-start-queue-1',
      payload: { queueId: 'queue-b', startIntent }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(executeCommandSpy.mock.calls[0]).toEqual([
      'schegent.startQueue',
      { queueId: 'queue-b', startIntent }
    ]);
  });
});
