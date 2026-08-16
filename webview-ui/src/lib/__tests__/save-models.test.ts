// Feature 096 (T023) — saveModelsImport helper behavior.
//
// Contract: specs/096-model-list-import-export/contracts/model-catalog-exchange.md §4
// — "structurally identical to savePipelines/saveWorkflows: UUIDv4 correlation,
// snapshotStore.markPending, one-shot onceAck, 5-second timeout." Kept apart
// from `saveModels`'s existing coverage in `save-catalog-command.test.ts`:
// that helper posts the manual add/remove shape (`{ models }`, no revision)
// and discards `ack.result`; this one posts the import-confirm shape
// (`{ models, expectedRevision, mutation }`) and needs the structured result a
// `stale-catalog` rejection carries back.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CMD_SAVE_MODELS } from '../messages';
import { saveModelsImport, type SaveModelsImportRequest } from '../save-models';

type AckListener = (ack: {
  status: 'accepted' | 'rejected';
  reason?: string;
  result?: unknown;
}) => void;

const ackListeners = new Map<string, AckListener>();
const pendingSet = new Set<string>();

vi.mock('../snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending(id: string): void {
      pendingSet.add(id);
    },
    onceAck(id: string, fn: AckListener): () => void {
      ackListeners.set(id, fn);
      return () => ackListeners.delete(id);
    }
  }
}));

function fireAck(
  id: string,
  status: 'accepted' | 'rejected',
  reason?: string,
  result?: unknown
): void {
  const fn = ackListeners.get(id);
  expect(fn, `no listener registered for ${id}`).toBeDefined();
  ackListeners.delete(id);
  fn!({ status, reason, result });
}

const SAMPLE_REQUEST: SaveModelsImportRequest = {
  models: { claude: ['custom-model-a'] },
  expectedRevision: 'a'.repeat(64),
  mutation: { kind: 'import-package' }
};

beforeEach(() => {
  ackListeners.clear();
  pendingSet.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Feature 096 T023 — saveModelsImport helper', () => {
  it('posts exactly one CMD_SAVE_MODELS envelope carrying the import request verbatim', async () => {
    const posted: unknown[] = [];
    const postMessage = (msg: unknown): void => {
      posted.push(msg);
    };
    const promise = saveModelsImport(SAMPLE_REQUEST, postMessage);

    expect(posted.length).toBe(1);
    const env = posted[0] as { type: string; correlationId: string; payload: unknown };
    expect(env.type).toBe(CMD_SAVE_MODELS);
    expect(typeof env.correlationId).toBe('string');
    expect(env.correlationId.length).toBeGreaterThan(0);
    // Deep equality, not a subset check: expectedRevision and mutation must
    // reach the host alongside the delta, or the revision gate cannot fire.
    expect(env.payload).toEqual(SAMPLE_REQUEST);

    fireAck(env.correlationId, 'accepted');
    await promise;
  });

  it('marks the correlation id pending so the snapshot store can gate the UI', async () => {
    const postMessage = vi.fn();
    const promise = saveModelsImport(SAMPLE_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    expect(pendingSet.has(env.correlationId)).toBe(true);
    fireAck(env.correlationId, 'accepted');
    await promise;
  });

  it('resolves accepted and preserves the { revision, mutation } ack result', async () => {
    const postMessage = vi.fn();
    const promise = saveModelsImport(SAMPLE_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    const result = { revision: 'b'.repeat(64), mutation: 'import-package' };
    fireAck(env.correlationId, 'accepted', undefined, result);
    await expect(promise).resolves.toEqual({ status: 'accepted', result });
  });

  it('resolves rejected with the reason from a matching rejected ack', async () => {
    const postMessage = vi.fn();
    const promise = saveModelsImport(SAMPLE_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    fireAck(env.correlationId, 'rejected', 'persistence-failed');
    await expect(promise).resolves.toEqual({
      status: 'rejected',
      reason: 'persistence-failed'
    });
  });

  it('preserves the currentRevision recovery detail from a stale-catalog rejection', async () => {
    const postMessage = vi.fn();
    const promise = saveModelsImport(SAMPLE_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    const result = { currentRevision: 'c'.repeat(64) };
    fireAck(env.correlationId, 'rejected', 'stale-catalog', result);
    await expect(promise).resolves.toEqual({
      status: 'rejected',
      reason: 'stale-catalog',
      result
    });
  });

  it('resolves { status: rejected, reason: timeout } after 5 seconds without an ack', async () => {
    const postMessage = vi.fn();
    const promise = saveModelsImport(SAMPLE_REQUEST, postMessage);
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'timeout' });
  });

  it('does NOT cross-resolve mismatched correlation ids when two saves are in flight', async () => {
    const postMessage = vi.fn();
    const p1 = saveModelsImport(SAMPLE_REQUEST, postMessage);
    const p2 = saveModelsImport(
      { ...SAMPLE_REQUEST, models: { codex: ['custom-model-b'] } },
      postMessage
    );
    expect(postMessage).toHaveBeenCalledTimes(2);
    const env1 = postMessage.mock.calls[0][0] as { correlationId: string };
    const env2 = postMessage.mock.calls[1][0] as { correlationId: string };
    expect(env1.correlationId).not.toBe(env2.correlationId);

    // Ack out of order — the second save must not settle the first.
    fireAck(env2.correlationId, 'rejected', 'stale-catalog');
    await expect(p2).resolves.toEqual({ status: 'rejected', reason: 'stale-catalog' });
    fireAck(env1.correlationId, 'accepted');
    await expect(p1).resolves.toEqual({ status: 'accepted' });
  });

  it('ignores a late ack after the timeout has already settled the promise', async () => {
    const postMessage = vi.fn();
    const promise = saveModelsImport(SAMPLE_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'timeout' });
    // The one-shot listener is unsubscribed on settle, so no listener remains
    // to deliver a stale accepted ack into a resolved promise.
    expect(ackListeners.has(env.correlationId)).toBe(false);
  });

  it('uses crypto-grade UUIDv4 correlation ids (RFC 4122 layout) when not injected', async () => {
    const postMessage = vi.fn();
    const promise = saveModelsImport(SAMPLE_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    expect(env.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    fireAck(env.correlationId, 'accepted');
    await promise;
  });
});
