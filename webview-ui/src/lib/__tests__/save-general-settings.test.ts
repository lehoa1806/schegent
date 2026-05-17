// Feature 012 T051 — saveGeneralSettings helper behavior.
//
// Asserts:
//   - Posts exactly one CMD_SAVE_GENERAL_SETTINGS envelope per call with shape
//     { type, correlationId, payload: { updates } }.
//   - Resolves `accepted` on a matching accepted ack.
//   - Resolves `rejected` with reason on a matching rejected ack.
//   - Resolves `{ status: 'rejected', reason: 'timeout' }` after 5 seconds.
//   - Two concurrent calls never cross-resolve mismatched correlation ids.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveGeneralSettings } from '../save-general-settings';
import { CMD_SAVE_GENERAL_SETTINGS } from '../messages';

type AckListener = (ack: { status: 'accepted' | 'rejected'; reason?: string }) => void;

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

function fireAck(id: string, status: 'accepted' | 'rejected', reason?: string): void {
  const fn = ackListeners.get(id);
  expect(fn, `no listener registered for ${id}`).toBeDefined();
  ackListeners.delete(id);
  fn!({ status, reason });
}

beforeEach(() => {
  ackListeners.clear();
  pendingSet.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Feature 012 T051 — saveGeneralSettings helper', () => {
  it('posts a single CMD_SAVE_GENERAL_SETTINGS envelope with { payload: { updates } }', async () => {
    const posted: unknown[] = [];
    const postMessage = (msg: unknown): void => {
      posted.push(msg);
    };
    const promise = saveGeneralSettings({ 'cli.path': '/usr/bin/claude' }, postMessage);
    expect(posted.length).toBe(1);
    const env = posted[0] as { type: string; correlationId: string; payload: { updates: unknown } };
    expect(env.type).toBe(CMD_SAVE_GENERAL_SETTINGS);
    expect(typeof env.correlationId).toBe('string');
    expect(env.correlationId.length).toBeGreaterThan(0);
    expect(env.payload).toEqual({ updates: { 'cli.path': '/usr/bin/claude' } });
    // Resolve to avoid an open promise leaking between tests.
    fireAck(env.correlationId, 'accepted');
    await promise;
  });

  it('resolves accepted when a matching accepted ack fires', async () => {
    const postMessage = vi.fn();
    const promise = saveGeneralSettings(
      { 'claude.autoCompactPctOverride': 70 },
      postMessage
    );
    const envelope = postMessage.mock.calls[0][0] as { correlationId: string };
    fireAck(envelope.correlationId, 'accepted');
    await expect(promise).resolves.toEqual({ status: 'accepted' });
  });

  it('resolves rejected with reason on a matching rejected ack', async () => {
    const postMessage = vi.fn();
    const promise = saveGeneralSettings(
      { 'claude.autoCompactPctOverride': 150 },
      postMessage
    );
    const envelope = postMessage.mock.calls[0][0] as { correlationId: string };
    fireAck(envelope.correlationId, 'rejected', 'out-of-range:1-100');
    await expect(promise).resolves.toEqual({
      status: 'rejected',
      reason: 'out-of-range:1-100'
    });
  });

  it('resolves { status: rejected, reason: timeout } after 5 seconds without ack', async () => {
    const postMessage = vi.fn();
    const promise = saveGeneralSettings({ 'cli.path': '/x' }, postMessage);
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'timeout' });
  });

  it('does NOT cross-resolve mismatched correlation ids when two saves are in flight', async () => {
    const postMessage = vi.fn();
    const p1 = saveGeneralSettings({ 'cli.path': '/a' }, postMessage);
    const p2 = saveGeneralSettings({ 'cli.path': '/b' }, postMessage);
    expect(postMessage).toHaveBeenCalledTimes(2);
    const env1 = postMessage.mock.calls[0][0] as { correlationId: string };
    const env2 = postMessage.mock.calls[1][0] as { correlationId: string };
    expect(env1.correlationId).not.toBe(env2.correlationId);

    // Resolve the SECOND save first. p1 must NOT resolve.
    fireAck(env2.correlationId, 'rejected', 'invalid-updates');
    await expect(p2).resolves.toEqual({ status: 'rejected', reason: 'invalid-updates' });
    // p1 is still pending. We can't easily prove "still pending" without
    // racing the event loop, so resolve p1 cleanly and confirm distinct.
    fireAck(env1.correlationId, 'accepted');
    await expect(p1).resolves.toEqual({ status: 'accepted' });
  });

  it('uses crypto-grade UUIDv4 correlation ids (RFC 4122 layout) when not injected', async () => {
    const postMessage = vi.fn();
    const promise = saveGeneralSettings({ 'cli.path': '/x' }, postMessage);
    const env = postMessage.mock.calls[0][0] as { correlationId: string };
    // 8-4-4-4-12 hex with version 4 and variant 8/9/a/b nibbles.
    expect(env.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    fireAck(env.correlationId, 'accepted');
    await promise;
  });
});
