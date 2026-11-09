// FR-R6-F06 (T030) — the usage accounting IPC helper.
//
// `requestUsageAccounting` is the single call site for `CMD_READ_USAGE_ACCOUNTING`. A refusal acks
// `rejected` and still carries the host's `AccountingResult`, so the helper must project by the
// result's validity, not the ack status: a well-formed refusal reaches the caller with its own code,
// and only a missing or malformed result, or a timeout, becomes `store-unavailable`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CMD_READ_USAGE_ACCOUNTING } from '../messages';

type AckListener = (ack: { status: 'accepted' | 'rejected'; reason?: string; result?: unknown }) => void;

const ackListeners = new Map<string, AckListener>();
const pendingIds: string[] = [];
const posted: { type: string; payload?: unknown; correlationId: string }[] = [];
let nextId = 0;

vi.mock('../snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending(id: string): void {
      pendingIds.push(id);
    },
    onceAck(id: string, fn: AckListener): () => void {
      ackListeners.set(id, fn);
      return () => ackListeners.delete(id);
    }
  }
}));

vi.mock('../vscode-api', () => ({
  postCommand(type: string, payload?: unknown): { correlationId: string } {
    const correlationId = `c${++nextId}`;
    posted.push({ type, payload, correlationId });
    return { correlationId };
  }
}));

import { requestUsageAccounting } from '../usage-accounting-ipc';

const STORE_UNAVAILABLE = { ok: false, refusal: { code: 'store-unavailable' } };
const QUERY = { groupBy: ['backend'], from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z' };

function page(nextCursor?: string) {
  return {
    ok: true,
    value: {
      revision: 3,
      cutoffIngestSeq: 7,
      rows: [],
      gaps: [],
      unattributedCount: 0,
      ...(nextCursor === undefined ? {} : { nextCursor })
    }
  };
}

function deliver(id: string, ack: Parameters<AckListener>[0]): void {
  const listener = ackListeners.get(id);
  if (listener === undefined) throw new Error(`no listener for ${id}`);
  listener(ack);
}

beforeEach(() => {
  ackListeners.clear();
  pendingIds.length = 0;
  posted.length = 0;
  nextId = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('requestUsageAccounting', () => {
  it('posts the query and marks the id pending', async () => {
    const promise = requestUsageAccounting(QUERY);
    expect(posted).toEqual([{ type: CMD_READ_USAGE_ACCOUNTING, payload: { query: QUERY }, correlationId: 'c1' }]);
    expect(pendingIds).toEqual(['c1']);
    deliver('c1', { status: 'accepted', result: page('cur_2') });
    await expect(promise).resolves.toEqual(page('cur_2'));
  });

  it('keeps a well-formed refusal from a rejected ack', async () => {
    const refusal = { ok: false, refusal: { code: 'invalid-query', detail: 'limit' } };
    const promise = requestUsageAccounting({ ...QUERY, limit: 0 });
    deliver('c1', { status: 'rejected', reason: 'invalid-query', result: refusal });
    await expect(promise).resolves.toEqual(refusal);
  });

  it.each([
    ['no result', undefined],
    ['an unknown refusal code', { ok: false, refusal: { code: 'boom' } }],
    ['a page with no rows array', { ok: true, value: { ...page().value, rows: undefined } }],
    ['a negative revision', { ok: true, value: { ...page().value, revision: -1 } }],
    ['a numeric cursor', { ok: true, value: { ...page().value, nextCursor: 4 } }]
  ])('projects %s to store-unavailable', async (_label, result) => {
    const promise = requestUsageAccounting(QUERY);
    deliver('c1', { status: 'rejected', reason: 'store-error', result });
    await expect(promise).resolves.toEqual(STORE_UNAVAILABLE);
  });

  it('resolves to store-unavailable when no ack arrives within the timeout', async () => {
    vi.useFakeTimers();
    const promise = requestUsageAccounting(QUERY);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toEqual(STORE_UNAVAILABLE);
    expect(ackListeners.size).toBe(0);
  });

  it('does not cross-resolve concurrent requests', async () => {
    const first = requestUsageAccounting(QUERY);
    const second = requestUsageAccounting({ ...QUERY, limit: 5 });
    deliver('c2', { status: 'accepted', result: page('two') });
    deliver('c1', { status: 'accepted', result: page('one') });
    await expect(first).resolves.toEqual(page('one'));
    await expect(second).resolves.toEqual(page('two'));
  });
});
