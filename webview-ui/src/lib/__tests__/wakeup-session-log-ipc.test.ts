// Feature 031 T030 — readWakeupSessionLog helper behavior.
//
// Mirrors save-phases.test.ts and phase-log-ipc patterns. The helper is
// the SINGLE call site for `CMD_READ_WAKEUP_SESSION_LOG` (pinned by the
// lint regression at `tests/lint/no-inline-read-wakeup-session-log.test.ts`).
//
// Asserts:
//   - The helper validates `correlationId` shape (UUIDv4) BEFORE posting.
//     A malformed id resolves to
//     `{ status: 'rejected', reason: 'invalid-correlation-id' }`
//     WITHOUT ever invoking `postMessage` — defense in depth (the host
//     re-validates too, but the webview short-circuits to avoid a
//     pointless round-trip).
//   - On a valid UUIDv4 input, posts exactly one CMD_READ_WAKEUP_SESSION_LOG
//     envelope with shape `{ type, correlationId, payload: { correlationId } }`.
//     The wire `correlationId` (the request envelope id) is FRESH per call
//     and MUST be a UUIDv4 — DISTINCT from the body `correlationId`
//     (the invocation id being read).
//   - Resolves the success ack verbatim — the helper does NOT re-shape
//     the reader payload (the wire format is the public contract).
//   - Resolves the rejected ack verbatim with the reason carried through.
//   - Resolves `{ status: 'rejected', reason: 'timeout' }` after 5 seconds.
//   - Concurrent calls never cross-resolve mismatched correlation ids.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWakeupSessionLog } from '../wakeup-session-log-ipc';
import { CMD_READ_WAKEUP_SESSION_LOG } from '../messages';

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

const VALID_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_VALID_UUID = 'bbbbbbbb-cccc-4ddd-9eee-ffffffffffff';
const MALFORMED_UUID = 'NOT-A-UUID';

beforeEach(() => {
  ackListeners.clear();
  pendingSet.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Feature 031 T030 — readWakeupSessionLog helper', () => {
  it('posts a single CMD_READ_WAKEUP_SESSION_LOG envelope with payload.correlationId on a valid UUIDv4', async () => {
    const posted: unknown[] = [];
    const postMessage = (msg: unknown): void => {
      posted.push(msg);
    };
    const promise = readWakeupSessionLog(VALID_UUID, postMessage);
    expect(posted.length).toBe(1);
    const env = posted[0] as {
      type: string;
      correlationId: string;
      payload: { correlationId: string };
    };
    expect(env.type).toBe(CMD_READ_WAKEUP_SESSION_LOG);
    expect(typeof env.correlationId).toBe('string');
    expect(env.correlationId.length).toBeGreaterThan(0);
    // The envelope's `correlationId` (the request id) is DISTINCT from the
    // body `correlationId` (the invocation id under read).
    expect(env.correlationId).not.toBe(VALID_UUID);
    expect(env.payload).toEqual({ correlationId: VALID_UUID });
    fireAck(env.correlationId, 'accepted', undefined, {
      status: 'success',
      correlationId: VALID_UUID,
      capturedAtMs: 1716000000000,
      trigger: 'scheduled',
      model: 'runner-default',
      outcome: 'succeeded',
      body: 'OUT: hello\n',
      bodyTruncated: false,
      fullBlockBytesOnDisk: 11
    });
    await promise;
  });

  it('short-circuits to invalid-correlation-id WITHOUT posting when the id is malformed', async () => {
    const postMessage = vi.fn();
    const promise = readWakeupSessionLog(MALFORMED_UUID, postMessage);
    await expect(promise).resolves.toEqual({
      status: 'rejected',
      reason: 'invalid-correlation-id'
    });
    expect(postMessage).not.toHaveBeenCalled();
    expect(ackListeners.size).toBe(0);
    expect(pendingSet.size).toBe(0);
  });

  it('resolves the success ack payload verbatim (no re-shaping)', async () => {
    const postMessage = vi.fn();
    const promise = readWakeupSessionLog(VALID_UUID, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    const payload = {
      status: 'success',
      correlationId: VALID_UUID,
      capturedAtMs: 1716000000000,
      trigger: 'manual',
      model: 'claude-sonnet-4-6',
      outcome: 'succeeded',
      body: 'OUT: trace line\nERR: warning line\n',
      bodyTruncated: true,
      fullBlockBytesOnDisk: 65536
    };
    fireAck(env.correlationId, 'accepted', undefined, payload);
    await expect(promise).resolves.toEqual(payload);
  });

  it('resolves the rejected ack payload verbatim with reason carried through', async () => {
    const postMessage = vi.fn();
    const promise = readWakeupSessionLog(VALID_UUID, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    fireAck(env.correlationId, 'rejected', 'unknown-correlation-id', {
      status: 'rejected',
      reason: 'unknown-correlation-id'
    });
    await expect(promise).resolves.toEqual({
      status: 'rejected',
      reason: 'unknown-correlation-id'
    });
  });

  it('resolves session-log-unavailable when the host returns it', async () => {
    const postMessage = vi.fn();
    const promise = readWakeupSessionLog(VALID_UUID, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    fireAck(env.correlationId, 'rejected', 'session-log-unavailable', {
      status: 'rejected',
      reason: 'session-log-unavailable'
    });
    await expect(promise).resolves.toEqual({
      status: 'rejected',
      reason: 'session-log-unavailable'
    });
  });

  it('resolves { status: rejected, reason: timeout } after 5 seconds without ack', async () => {
    const postMessage = vi.fn();
    const promise = readWakeupSessionLog(VALID_UUID, postMessage);
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({
      status: 'rejected',
      reason: 'timeout'
    });
  });

  it('uses crypto-grade UUIDv4 request ids (RFC 4122 layout) when not injected', async () => {
    const postMessage = vi.fn();
    const promise = readWakeupSessionLog(VALID_UUID, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    expect(env.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    fireAck(env.correlationId, 'rejected', 'unknown-correlation-id', {
      status: 'rejected',
      reason: 'unknown-correlation-id'
    });
    await promise;
  });

  it('does NOT cross-resolve mismatched correlation ids when two reads are in flight', async () => {
    const postMessage = vi.fn();
    const p1 = readWakeupSessionLog(VALID_UUID, postMessage);
    const p2 = readWakeupSessionLog(OTHER_VALID_UUID, postMessage);
    expect(postMessage).toHaveBeenCalledTimes(2);
    const env1 = postMessage.mock.calls[0][0] as {
      correlationId: string;
      payload: { correlationId: string };
    };
    const env2 = postMessage.mock.calls[1][0] as {
      correlationId: string;
      payload: { correlationId: string };
    };
    expect(env1.correlationId).not.toBe(env2.correlationId);
    expect(env1.payload.correlationId).toBe(VALID_UUID);
    expect(env2.payload.correlationId).toBe(OTHER_VALID_UUID);

    // Ack the SECOND read first; the first must remain unresolved.
    fireAck(env2.correlationId, 'rejected', 'session-log-unavailable', {
      status: 'rejected',
      reason: 'session-log-unavailable'
    });
    await expect(p2).resolves.toEqual({
      status: 'rejected',
      reason: 'session-log-unavailable'
    });
    fireAck(env1.correlationId, 'accepted', undefined, {
      status: 'success',
      correlationId: VALID_UUID,
      capturedAtMs: 1716000000000,
      trigger: 'scheduled',
      model: 'runner-default',
      outcome: 'succeeded',
      body: 'OUT: ok\n',
      bodyTruncated: false,
      fullBlockBytesOnDisk: 8
    });
    await expect(p1).resolves.toMatchObject({
      status: 'success',
      correlationId: VALID_UUID
    });
  });

  it('rejects each canonical-shape violation client-side', async () => {
    // Wrong length, missing hyphens, wrong version nibble, wrong variant
    // nibble, uppercase hex. All MUST short-circuit without posting.
    const badIds = [
      '',
      'short',
      // length 35 (missing one char)
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'.slice(1),
      // no hyphens
      'aaaaaaaabbbb4ccc8dddeeeeeeeeeeee',
      // version nibble = 3 (should be 4)
      'aaaaaaaa-bbbb-3ccc-8ddd-eeeeeeeeeeee',
      // variant nibble = 7 (should be in 8-b)
      'aaaaaaaa-bbbb-4ccc-7ddd-eeeeeeeeeeee',
      // uppercase hex is NOT canonical RFC 4122 — must reject
      'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'
    ];
    for (const id of badIds) {
      const postMessage = vi.fn();
      const result = await readWakeupSessionLog(id, postMessage);
      expect(result, `id ${JSON.stringify(id)} should be rejected`).toEqual({
        status: 'rejected',
        reason: 'invalid-correlation-id'
      });
      expect(postMessage).not.toHaveBeenCalled();
    }
  });
});
