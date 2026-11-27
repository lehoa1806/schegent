// FR-R6-F05 (T031) — the storage-details IPC helper.
//
// `requestStorageDetails` is the single call site for `CMD_READ_STORAGE_DETAILS`. A refusal acks
// `rejected` and still carries the host's `LifecycleResult`, so the helper must project by the
// result's validity, not the ack status: a well-formed refusal reaches the panel with its own code,
// and only a missing or malformed result, or a timeout, becomes `unavailable`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CMD_READ_STORAGE_DETAILS } from '../messages';

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

import { requestStorageDetails } from '../storage-details-ipc';

const UNAVAILABLE = { ok: false, refusal: { code: 'unavailable', message: 'storage details are unavailable' } };

function details(nextCursor: string | null = null) {
  return {
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
      page: { entries: [], nextCursor, coverage: 'complete' }
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

describe('requestStorageDetails', () => {
  it('posts an empty payload for the first page and marks the id pending', async () => {
    const promise = requestStorageDetails();
    expect(posted).toEqual([{ type: CMD_READ_STORAGE_DETAILS, payload: {}, correlationId: 'c1' }]);
    expect(pendingIds).toEqual(['c1']);
    deliver('c1', { status: 'accepted', result: details() });
    await expect(promise).resolves.toEqual(details());
  });

  it('posts the cursor for a later page', async () => {
    const promise = requestStorageDetails('abc');
    expect(posted.at(0)?.payload).toEqual({ cursor: 'abc' });
    deliver('c1', { status: 'accepted', result: details('next_1') });
    await expect(promise).resolves.toEqual(details('next_1'));
  });

  it('keeps a well-formed refusal from a rejected ack', async () => {
    const refusal = { ok: false, refusal: { code: 'invalid-input', message: 'cursor is malformed' } };
    const promise = requestStorageDetails('abc');
    deliver('c1', { status: 'rejected', reason: 'invalid-input', result: refusal });
    await expect(promise).resolves.toEqual(refusal);
  });

  it.each([
    ['no result', undefined],
    ['an unknown refusal code', { ok: false, refusal: { code: 'boom', message: 'x' } }],
    ['a page with no entries array', { ok: true, value: { ...details().value, page: { nextCursor: null } } }]
  ])('projects %s to unavailable', async (_label, result) => {
    const promise = requestStorageDetails();
    deliver('c1', { status: 'rejected', reason: 'internal-error', result });
    await expect(promise).resolves.toEqual(UNAVAILABLE);
  });

  it('resolves to unavailable when no ack arrives within the timeout', async () => {
    vi.useFakeTimers();
    const promise = requestStorageDetails();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toEqual(UNAVAILABLE);
    expect(ackListeners.size).toBe(0);
  });

  it('does not cross-resolve concurrent requests', async () => {
    const first = requestStorageDetails();
    const second = requestStorageDetails('abc');
    deliver('c2', { status: 'accepted', result: details('two') });
    deliver('c1', { status: 'accepted', result: details('one') });
    await expect(first).resolves.toEqual(details('one'));
    await expect(second).resolves.toEqual(details('two'));
  });
});
