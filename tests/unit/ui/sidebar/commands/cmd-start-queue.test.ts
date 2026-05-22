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

  it('does not send a queueId payload (single-queue migration)', async () => {
    const { ctx, executeCommandSpy } = buildCtx();
    await startQueueHandler(ctx, makeCmd());
    // schegent.startQueue is called with no queueId payload — it always
    // operates on the unified default queue (feature 030). Feature 065
    // adds an optional `startIntent` second-arg; when absent the value
    // is `undefined`.
    expect(executeCommandSpy.mock.calls[0]).toEqual(['schegent.startQueue', undefined]);
  });
});
