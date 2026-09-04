// BUG-002 (FR-012a, T082) — cmd-start-queue handler unit tests.
// The handler delegates to `schegent.startQueue` and acks what that command
// answered.
//
// FR-R3-154 (T1646) — this header used to end "and acks `accepted`. Error
// propagation is handled by the router's outer try/catch; the handler itself
// does not catch." Both halves have changed, and the fake below changed with
// them: `runStartQueueCommand` returns a `CommandOutcome` now, so a fake that
// resolves `undefined` no longer models the host command — it models the
// Workspace Trust gate declining to run it. The dispatch failure is converted
// in `execForOutcome` rather than left to the router, because the router's
// generic catch put the sanitized *error message* into the ACK reason, and the
// reason crosses to the webview.

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { handler as startQueueHandler } from '../../../../../src/ui/sidebar/commands/cmd-start-queue';
import { CMD_START_QUEUE } from '../../../../../src/contracts/sidebar-ipc';
import type { CommandAckMessage, StartQueueCommand } from '../../../../../src/contracts/sidebar-ipc';

function buildCtx(opts: {
  executeCommandRejects?: boolean;
  executeCommandError?: Error;
  // What `runStartQueueCommand` answered. An override rather than a
  // post-construction assignment, because `ctx.deps` is `readonly` — the
  // handler must not be able to swap its own dependencies, and a test that
  // reached in to reassign one would type-check only by widening that.
  result?: unknown;
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
    // What `runStartQueueCommand` returns for an accepted start.
    return opts.result ?? ({ outcome: 'accepted' } as const);
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
  } as any;
  return { ctx, acks, executeCommandSpy, warnings };
}

function makeCmd(): StartQueueCommand {
  return {
    type: CMD_START_QUEUE,
    correlationId: 'test-start-queue-1'
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
    // Asserted as the whole array rather than field-by-field off `acks[0]`.
    // The indexed form reads as an opaque TypeError when the handler posted
    // nothing — the failure mode these cases exist to catch — while this one
    // pins the arity in the same assertion and prints the ACK that did arrive.
    // It is also the form `mock.calls[0]` comparisons further down already use,
    // and the one `tests/lint/compiler-strictness-ratchet.test.ts` asks for.
    expect(acks).toEqual([
      expect.objectContaining({
        status: 'accepted',
        outcome: 'accepted',
        correlationId: 'test-start-queue-1'
      })
    ]);
  });

  it('converts a dispatch failure into a failed ack rather than propagating', async () => {
    // FR-R3-154 (T1646) — this case asserted the opposite: that the handler let
    // the error through for the router to ACK. It did, and the router ACKed
    // `rejected` with the sanitized error message as the reason. Converting it
    // here keeps the message in the log and sends a code, because the reason is
    // what crosses to the webview.
    const { ctx, acks, warnings } = buildCtx({
      executeCommandRejects: true,
      executeCommandError: new Error('no pending tasks in /Users/someone/ws')
    });
    await expect(startQueueHandler(ctx, makeCmd())).resolves.toBeUndefined();
    expect(acks).toEqual([
      expect.objectContaining({
        status: 'rejected',
        outcome: 'failed',
        reason: 'command-dispatch-failed'
      })
    ]);
    // The no-leak claim stated over the serialized ACK rather than over
    // `reason` alone: the code equality above would already fail if the reason
    // changed, so what is worth asserting separately is that the absolute path
    // reached no field of the message at all.
    expect(JSON.stringify(acks)).not.toContain('/Users/');
    expect(warnings.some((w) => w.includes('no pending tasks'))).toBe(true);
  });

  it('reports a refused start instead of accepting it', async () => {
    // The defect this route carried: `runStartQueueCommand` swallowed every
    // intent rejection, so the operator's chooser reported a start that the
    // horizon bound had refused.
    const { ctx, acks } = buildCtx({
      result: { outcome: 'refused', reason: 'rejected-horizon' }
    });
    await startQueueHandler(ctx, makeCmd());
    expect(acks).toEqual([
      expect.objectContaining({
        status: 'rejected',
        outcome: 'refused',
        reason: 'rejected-horizon'
      })
    ]);
  });

  it('does not ack before executeCommand resolves', async () => {
    let execResolved = false;
    const executeCommandSpy = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      execResolved = true;
      return { outcome: 'accepted' } as const;
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
    } as any);
    expect(executeCommandSpy.mock.calls[0]).toEqual([
      'schegent.startQueue',
      { queueId: 'queue-b', startIntent }
    ]);
  });
});
