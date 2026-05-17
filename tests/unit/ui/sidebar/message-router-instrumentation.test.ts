import { describe, it, expect, beforeEach } from 'vitest';
import { MessageRouter, type RouterDeps } from '../../../../src/ui/sidebar/message-router';
import { SanitizedLogger, type LogSink } from '../../../../src/lib/logger';
import type { CommandAckMessage } from '../../../../src/ui/sidebar/messages';
import {
  CMD_OPEN_AUDIT_LOG,
  CMD_PAUSE_QUEUE,
  CMD_RETRY_QUEUE_ITEM,
  CMD_REMOVE_QUEUE_ITEM
} from '../../../../src/ui/sidebar/messages';

/**
 * Feature 019 BUG-001 (T044) — operator-action instrumentation surface in
 * `MessageRouter.dispatch()`. Verifies FR-021's two new call sites:
 *   - DEBUG `router: inbound` for every command (before the primary-host gate)
 *   - WARN `router: rejected by primary-host gate` on `MUTATING_COMMANDS`
 *     rejection (before the ack-post so it lands even if postAck throws)
 *
 * Feature 030 (US3, T046) — the create-queue command was the canonical
 * mutating command used here. With the single-queue migration the seven
 * multi-queue mutators were removed; this suite now uses CMD_PAUSE_QUEUE
 * as the representative mutating command (still a member of
 * `MUTATING_COMMANDS`). The create-named-queue entry in `makeQueueOps`
 * was dropped because the `RouterDeps['queueOps']` shape no longer
 * carries that surface.
 */

function makeSink(): LogSink & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    appendLine(line: string) {
      lines.push(line);
    }
  };
}

function makeQueueOps(): NonNullable<RouterDeps['queueOps']> {
  return {
    retry: async () => ({ ok: true }),
    moveUp: async () => ({ ok: true }),
    moveDown: async () => ({ ok: true }),
    clearCompleted: async () => ({ removed: 0 }),
    clearFailed: async () => ({ removed: 0 }),
    setPaused: async () => undefined,
    setQueuePausedState: async () => ({ ok: true, queueId: 'default' })
  };
}

function makeRouter(opts: { isPrimary?: () => boolean } = {}): {
  router: MessageRouter;
  sink: LogSink & { lines: string[] };
  logger: SanitizedLogger;
} {
  const sink = makeSink();
  const logger = new SanitizedLogger([sink]);
  const deps: RouterDeps = {
    executeCommand: (async () => undefined) as RouterDeps['executeCommand'],
    queueRemover: { remove: async () => true },
    queueOps: makeQueueOps(),
    isPrimary: opts.isPrimary ?? (() => true),
    isTrusted: () => true,
    logger
  };
  return { router: new MessageRouter(deps), sink, logger };
}

const ok = async (_msg: CommandAckMessage): Promise<boolean> => true;

function countLines(lines: readonly string[], substring: string): number {
  return lines.filter((line) => line.includes(substring)).length;
}

describe('MessageRouter — FR-021 inbound DEBUG instrumentation', () => {
  it('emits exactly one router: inbound DEBUG line per accepted dispatch', async () => {
    const { router, sink } = makeRouter();
    await router.dispatch(
      { type: CMD_OPEN_AUDIT_LOG, correlationId: 'c1', payload: undefined } as never,
      ok
    );
    const debugLines = sink.lines.filter((line) => line.includes('DEBUG'));
    expect(debugLines).toHaveLength(1);
    expect(debugLines[0]).toContain('router: inbound');
    expect(debugLines[0]).toContain('"type":"CMD_OPEN_AUDIT_LOG"');
    expect(debugLines[0]).toContain('"correlationId":"c1"');
  });

  it('emits the inbound DEBUG for every command type (sampled across mutating + non-mutating)', async () => {
    const { router, sink } = makeRouter();
    await router.dispatch(
      { type: CMD_OPEN_AUDIT_LOG, correlationId: 'a', payload: undefined } as never,
      ok
    );
    await router.dispatch(
      {
        type: CMD_PAUSE_QUEUE,
        correlationId: 'b',
        payload: { reason: null }
      } as never,
      ok
    );
    await router.dispatch(
      {
        type: CMD_REMOVE_QUEUE_ITEM,
        correlationId: 'c',
        payload: { id: 'task-1' }
      } as never,
      ok
    );
    const inboundLines = sink.lines.filter((line) =>
      line.includes('router: inbound')
    );
    expect(inboundLines).toHaveLength(3);
    expect(inboundLines[0]).toContain('"correlationId":"a"');
    expect(inboundLines[1]).toContain('"correlationId":"b"');
    expect(inboundLines[2]).toContain('"correlationId":"c"');
  });

  it('emits inbound DEBUG even when the command will be rejected by the primary-host gate', async () => {
    const { router, sink } = makeRouter({ isPrimary: () => false });
    await router.dispatch(
      {
        type: CMD_PAUSE_QUEUE,
        correlationId: 'sec1',
        payload: { reason: null }
      } as never,
      ok
    );
    const inboundLines = sink.lines.filter((line) =>
      line.includes('router: inbound')
    );
    expect(inboundLines).toHaveLength(1);
    expect(inboundLines[0]).toContain('DEBUG');
    expect(inboundLines[0]).toContain('"type":"CMD_PAUSE_QUEUE"');
  });
});

describe('MessageRouter — FR-021 secondary-host rejection WARN', () => {
  it('emits exactly one rejected-by-primary-host-gate WARN and a rejected ack', async () => {
    const { router, sink } = makeRouter({ isPrimary: () => false });
    const acks: CommandAckMessage[] = [];
    await router.dispatch(
      {
        type: CMD_PAUSE_QUEUE,
        correlationId: 'sec-pause',
        payload: { reason: null }
      } as never,
      async (msg) => {
        acks.push(msg);
        return true;
      }
    );
    const warnLines = sink.lines.filter(
      (line) => line.includes('WARN') && line.includes('router: rejected by primary-host gate')
    );
    expect(warnLines).toHaveLength(1);
    expect(warnLines[0]).toContain('"type":"CMD_PAUSE_QUEUE"');
    expect(warnLines[0]).toContain('"correlationId":"sec-pause"');
    expect(acks).toHaveLength(1);
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('secondary-window-readonly');
  });

  it('does not emit the secondary-rejection WARN for non-mutating commands', async () => {
    const { router, sink } = makeRouter({ isPrimary: () => false });
    await router.dispatch(
      { type: CMD_OPEN_AUDIT_LOG, correlationId: 'r-non', payload: undefined } as never,
      ok
    );
    const warnLines = sink.lines.filter((line) =>
      line.includes('router: rejected by primary-host gate')
    );
    expect(warnLines).toHaveLength(0);
  });

  it('does not emit the secondary-rejection WARN when the window IS the primary host', async () => {
    const { router, sink } = makeRouter({ isPrimary: () => true });
    await router.dispatch(
      {
        type: CMD_PAUSE_QUEUE,
        correlationId: 'p1',
        payload: { reason: null }
      } as never,
      ok
    );
    expect(
      countLines(sink.lines, 'router: rejected by primary-host gate')
    ).toBe(0);
  });

  it('lands the WARN even when the subsequent ack-post throws', async () => {
    const { router, sink } = makeRouter({ isPrimary: () => false });
    const throwingAck = async (): Promise<boolean> => {
      throw new Error('post-ack-failed');
    };
    await router.dispatch(
      {
        type: CMD_RETRY_QUEUE_ITEM,
        correlationId: 'throw1',
        payload: { id: 'task-x' }
      } as never,
      throwingAck
    );
    const rejectedWarn = sink.lines.find((line) =>
      line.includes('router: rejected by primary-host gate')
    );
    expect(rejectedWarn).toBeDefined();
    expect(rejectedWarn).toContain('"type":"CMD_RETRY_QUEUE_ITEM"');
    expect(rejectedWarn).toContain('"correlationId":"throw1"');
  });
});

describe('MessageRouter — FR-021 redaction continues to govern', () => {
  let router: MessageRouter;
  let sink: LogSink & { lines: string[] };

  beforeEach(() => {
    const built = makeRouter({ isPrimary: () => false });
    router = built.router;
    sink = built.sink;
  });

  it('redacts secrets if they leak into the correlationId field', async () => {
    await router.dispatch(
      {
        type: CMD_PAUSE_QUEUE,
        correlationId: 'Bearer abcdefghijklmnopqrst',
        payload: { reason: null }
      } as never,
      ok
    );
    const allLines = sink.lines.join('\n');
    expect(allLines).toContain('[REDACTED]');
    expect(allLines).not.toContain('abcdefghijklmnopqrst');
  });
});
