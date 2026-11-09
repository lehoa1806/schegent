// FR-R6-F05 (T030, contract surfaces-and-wiring.md §5) — the sidebar's storage-details handler.
//
// Read-only, so it takes no primacy, trust or confirmation gate. What it must guarantee: the reader's
// answer reaches the wire unchanged, a refusal acks `rejected` with its own code and still carries the
// result, a window with no reader answers `unavailable`, and a throwing reader is logged by code only.
import { describe, expect, it, vi } from 'vitest';
import { CMD_READ_STORAGE_DETAILS } from '../../../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ReadStorageDetailsCommand,
  ReadStorageDetailsResponse,
  StorageDetailsReader
} from '../../../../../src/contracts/sidebar-ipc';
import { handler } from '../../../../../src/ui/sidebar/commands/cmd-read-storage-details';

const DETAILS: ReadStorageDetailsResponse = {
  ok: true,
  value: {
    pressure: {
      perClass: [],
      totalBytes: 10,
      unclassifiedBytes: 0,
      policyRevision: 1,
      lastCompleteScanAtMs: null,
      latestPartialScanAtMs: null,
      coverage: 'complete',
      targetBytes: null,
      overTarget: false,
      admission: { behavior: 'admit' },
      scanFigures: null
    },
    page: { entries: [], nextCursor: null, coverage: 'complete' }
  }
} as unknown as ReadStorageDetailsResponse;

function buildCtx(reader?: StorageDetailsReader): {
  ctx: Parameters<typeof handler>[0];
  acks: CommandAckMessage[];
  warnings: unknown[][];
} {
  const acks: CommandAckMessage[] = [];
  const warnings: unknown[][] = [];
  const ctx = {
    deps: {
      logger: {
        info: vi.fn(),
        warn: (...args: unknown[]) => warnings.push(args),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      },
      ...(reader === undefined ? {} : { storageDetails: reader })
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'test-storage-details-1'
  } as unknown as Parameters<typeof handler>[0];
  return { ctx, acks, warnings };
}

function makeCmd(cursor?: string): ReadStorageDetailsCommand {
  return {
    type: CMD_READ_STORAGE_DETAILS,
    correlationId: 'test-storage-details-1',
    payload: cursor === undefined ? {} : { cursor }
  } as ReadStorageDetailsCommand;
}

function onlyAck(acks: CommandAckMessage[]): CommandAckMessage & { result?: unknown } {
  expect(acks).toHaveLength(1);
  const first = acks.at(0);
  if (first === undefined) throw new Error('no ack');
  return first as CommandAckMessage & { result?: unknown };
}

describe('cmd-read-storage-details', () => {
  it('acks the reader answer as accepted, unchanged, and passes the cursor through', async () => {
    const read = vi.fn<StorageDetailsReader['read']>(() => DETAILS);
    const { ctx, acks } = buildCtx({ read });
    await handler(ctx, makeCmd('page_2'));
    expect(read).toHaveBeenCalledWith('page_2');
    const ackMessage = onlyAck(acks);
    expect(ackMessage.status).toBe('accepted');
    expect(ackMessage.result).toEqual(DETAILS);
  });

  it('reads the first page when the payload carries no cursor', async () => {
    const read = vi.fn<StorageDetailsReader['read']>(() => DETAILS);
    const { ctx } = buildCtx({ read });
    await handler(ctx, makeCmd());
    expect(read).toHaveBeenCalledWith(undefined);
  });

  it('acks a refusal as rejected with its own code and the result attached', async () => {
    const refusal: ReadStorageDetailsResponse = {
      ok: false,
      refusal: { code: 'invalid-input', message: 'cursor is malformed' }
    };
    const { ctx, acks } = buildCtx({ read: () => refusal });
    await handler(ctx, makeCmd('stale'));
    const ackMessage = onlyAck(acks);
    expect(ackMessage.status).toBe('rejected');
    expect(ackMessage.reason).toBe('invalid-input');
    expect(ackMessage.result).toEqual(refusal);
  });

  it('answers unavailable when the window has no reader', async () => {
    const { ctx, acks } = buildCtx();
    await handler(ctx, makeCmd());
    const ackMessage = onlyAck(acks);
    expect(ackMessage.status).toBe('rejected');
    expect(ackMessage.reason).toBe('unavailable');
    expect((ackMessage.result as { ok: boolean }).ok).toBe(false);
  });

  it('logs a throwing reader by code only and answers unavailable', async () => {
    const secret = '/Users/someone/private/app.sqlite';
    const failure = Object.assign(new Error(`cannot open ${secret}`), { code: 'SQLITE_CANTOPEN' });
    const { ctx, acks, warnings } = buildCtx({
      read: () => {
        throw failure;
      }
    });
    await handler(ctx, makeCmd());
    const ackMessage = onlyAck(acks);
    expect(ackMessage.status).toBe('rejected');
    expect(ackMessage.reason).toBe('unavailable');
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain(secret);
    expect(JSON.stringify(ackMessage)).not.toContain(secret);
  });
});
