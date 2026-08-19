// FR-R3-010 (T410/T411) — the history-evidence IPC helper.
//
// `resolveAuditPointer` is the module's only export and the single call site for
// `CMD_RESOLVE_AUDIT_POINTER`, so this block carries both jobs: the correlated-
// request contract every sibling helper shares (accept, reject-with-reason,
// malformed result, timeout, no cross-resolution), and the one projection rule
// specific to this module.
//
// That rule is the reason the file is worth testing rather than trusting. The
// host acks `evidence-expired`, `no-evidence-recorded`, and `unaddressable` as
// `accepted`, because each is a true answer about a Run whose evidence aged out,
// was never written, or was addressed by a pointer an older build minted. A
// helper that read the ack *status* alone would be correct on every one of them
// and still wrong, because it would hand the renderer a `failure` and the
// operator an error message for a question that was answered. Nothing else in
// the suite covers the difference — `HistorySection.test.ts` exercises the two
// outcomes the button branches on, not the projection underneath.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CMD_RESOLVE_AUDIT_POINTER } from '../messages';

type AckListener = (ack: {
  status: 'accepted' | 'rejected';
  reason?: string;
  result?: unknown;
}) => void;

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

import { resolveAuditPointer } from '../history-evidence-ipc';

/** A `resolved` result that satisfies `isValidResolveAuditPointerResponse`. */
function resolvedResult(runId: string, entryCount = 1) {
  return {
    outcome: 'resolved',
    runId,
    truncated: false,
    parseWarnings: 0,
    entries: Array.from({ length: entryCount }, (_unused, index) => ({
      id: `e-${index}`,
      timestamp: '2026-05-10T12:00:42.000Z',
      eventType: 'run-completed',
      phase: 'implement',
      iteration: 1,
      outcome: 'success'
    }))
  };
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

describe('resolveAuditPointer', () => {
  it('posts CMD_RESOLVE_AUDIT_POINTER with the runId and marks the id pending', async () => {
    const promise = resolveAuditPointer('r-1');

    expect(posted).toEqual([
      { type: CMD_RESOLVE_AUDIT_POINTER, payload: { runId: 'r-1' }, correlationId: 'c1' }
    ]);
    expect(pendingIds).toEqual(['c1']);

    ackListeners.get('c1')?.({ status: 'accepted', result: resolvedResult('r-1') });
    await expect(promise).resolves.toMatchObject({ outcome: 'resolved', runId: 'r-1' });
  });

  it('resolves with the host union unchanged on an accepted result', async () => {
    const promise = resolveAuditPointer('r-1');
    ackListeners.get('c1')?.({ status: 'accepted', result: resolvedResult('r-1', 3) });

    const result = await promise;
    expect(result).toEqual(resolvedResult('r-1', 3));
  });

  // The rule this module exists to hold. Each of these is acked `accepted` by the
  // host and must survive projection as itself, not as a failure.
  it.each([
    ['evidence-expired', { outcome: 'evidence-expired', runId: 'r-1' }],
    ['no-evidence-recorded', { outcome: 'no-evidence-recorded', runId: 'r-1' }],
    ['unaddressable', { outcome: 'unaddressable' }]
  ])('passes the "%s" outcome through rather than collapsing it to failure', async (
    outcome,
    result
  ) => {
    const promise = resolveAuditPointer('r-1');
    ackListeners.get('c1')?.({ status: 'accepted', result });

    await expect(promise).resolves.toEqual(result);
    await expect(promise).resolves.not.toMatchObject({ outcome: 'failure' });
    expect(outcome).toBe((result as { outcome: string }).outcome);
  });

  it('keeps a well-formed failure result, reason and all', async () => {
    const promise = resolveAuditPointer('r-1');
    ackListeners.get('c1')?.({
      status: 'rejected',
      result: { outcome: 'failure', reason: 'unknown-run' }
    });

    await expect(promise).resolves.toEqual({ outcome: 'failure', reason: 'unknown-run' });
  });

  it('projects a rejected ack with no usable result to internal-error', async () => {
    const promise = resolveAuditPointer('r-1');
    ackListeners.get('c1')?.({ status: 'rejected', reason: 'validation-failed' });

    await expect(promise).resolves.toEqual({ outcome: 'failure', reason: 'internal-error' });
  });

  // A malformed result is not a host answer, so it must not be forwarded as one.
  // `resolved` missing its required fields is the shape most likely to arrive
  // from a partially-updated host, which is exactly when forwarding it would
  // render an empty evidence list as a successful drill-down.
  it.each([
    ['an unrecognised outcome', { outcome: 'nonsense' }],
    ['resolved without its required fields', { outcome: 'resolved', runId: 'r-1' }],
    ['a failure with an unrecognised reason', { outcome: 'failure', reason: 'disk on fire' }],
    ['a non-object', 'not-an-object'],
    ['null', null],
    ['nothing at all', undefined]
  ])('projects %s to internal-error', async (_label, result) => {
    const promise = resolveAuditPointer('r-1');
    ackListeners.get('c1')?.({ status: 'accepted', result });

    await expect(promise).resolves.toEqual({ outcome: 'failure', reason: 'internal-error' });
  });

  it('resolves to internal-error when no ack arrives within the timeout', async () => {
    vi.useFakeTimers();
    const promise = resolveAuditPointer('r-1');

    await vi.advanceTimersByTimeAsync(5000);

    await expect(promise).resolves.toEqual({ outcome: 'failure', reason: 'internal-error' });
  });

  it('ignores a late ack that arrives after the timeout already settled it', async () => {
    vi.useFakeTimers();
    const promise = resolveAuditPointer('r-1');
    await vi.advanceTimersByTimeAsync(5000);

    ackListeners.get('c1')?.({ status: 'accepted', result: resolvedResult('r-1') });

    await expect(promise).resolves.toEqual({ outcome: 'failure', reason: 'internal-error' });
  });

  // The reason the post-and-correlate sequence runs synchronously inside the
  // promise executor: two drill-downs opened in the same tick each get their own
  // id, and neither settles on the other's ack.
  it('does not cross-resolve concurrent requests', async () => {
    const first = resolveAuditPointer('r-1');
    const second = resolveAuditPointer('r-2');

    expect(posted.map((entry) => entry.correlationId)).toEqual(['c1', 'c2']);

    ackListeners.get('c2')?.({ status: 'accepted', result: resolvedResult('r-2') });
    ackListeners.get('c1')?.({ status: 'accepted', result: { outcome: 'unaddressable' } });

    await expect(first).resolves.toEqual({ outcome: 'unaddressable' });
    await expect(second).resolves.toMatchObject({ outcome: 'resolved', runId: 'r-2' });
  });

  it('unsubscribes its one-shot listener once settled', async () => {
    const promise = resolveAuditPointer('r-1');
    ackListeners.get('c1')?.({ status: 'accepted', result: resolvedResult('r-1') });
    await promise;

    expect(ackListeners.has('c1')).toBe(false);
  });
});
