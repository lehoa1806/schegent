// FR-R3-154 (T1646) — the operator's half of the mutation ACK.
//
// The host end is covered by `tests/unit/ui/sidebar/mutation-ack-truth.test.ts`
// (the ACK reports the command's real answer) and
// `tests/unit/commands/lifecycle-command-outcomes.test.ts` (each command
// returns one). Both pass with a webview that throws every ACK away, which is
// what these six dispatch sites did: `postCommand` hands back a
// `correlationId`, they dropped it, and `snapshotStore.applyAck` cleared the
// pending flag and discarded the message.
//
// So this file asserts the third link: that a refusal the host now sends
// becomes a sentence a caller can show. The negative control is the one that
// matters — a dispatcher that resolves `{ outcome: 'accepted' }` regardless
// (the shape before this change, and the shape a `void` return degrades to)
// fails the refusal, no-op and failure cases below.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CMD_PAUSE_PHASE } from '../messages';

type AckListener = (ack: {
  status: 'accepted' | 'rejected';
  reason?: string;
  result?: unknown;
  outcome?: 'accepted' | 'no-op' | 'refused' | 'failed';
}) => void;

const ackListeners = new Map<string, AckListener>();
const pendingSet = new Set<string>();
const posted: { type: string; payload?: unknown; correlationId: string }[] = [];
let nextId = 0;

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

vi.mock('../vscode-api', () => ({
  postCommand(type: string, payload?: unknown): { correlationId: string } {
    const correlationId = `c${++nextId}`;
    posted.push({ type, payload, correlationId });
    return { correlationId };
  }
}));

const { correlatedLifecycle, lifecycleMessage, lifecycleRefusalText } = await import(
  '../lifecycle-control-ipc'
);
const { postCommand } = await import('../vscode-api');

/** One dispatch through the helper, standing in for any of the six call sites. */
function dispatch(): Promise<
  Awaited<ReturnType<typeof correlatedLifecycle>>
> {
  return correlatedLifecycle(
    () => postCommand(CMD_PAUSE_PHASE, { queueId: 'q-beta' }).correlationId
  );
}

function fireAck(
  id: string,
  status: 'accepted' | 'rejected',
  reason?: string,
  outcome?: 'accepted' | 'no-op' | 'refused' | 'failed'
): void {
  const fn = ackListeners.get(id);
  expect(fn, `no listener registered for ${id}`).toBeDefined();
  ackListeners.delete(id);
  fn!({ status, reason, outcome });
}

beforeEach(() => {
  ackListeners.clear();
  pendingSet.clear();
  posted.length = 0;
  nextId = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('correlatedLifecycle — the ACK reaches the caller', () => {
  it('registers the correlation id the post returned', async () => {
    const promise = dispatch();
    const { correlationId, type } = posted[0]!;
    expect(type).toBe(CMD_PAUSE_PHASE);
    // The assertion the old dispatchers could not have passed: the id is
    // registered for an answer, not discarded on the next line.
    expect(pendingSet.has(correlationId)).toBe(true);
    expect(ackListeners.has(correlationId)).toBe(true);

    fireAck(correlationId, 'accepted', undefined, 'accepted');
    await expect(promise).resolves.toEqual({ outcome: 'accepted' });
  });

  it('reads a refusal as a refusal, with the reason rendered as a sentence', async () => {
    const promise = dispatch();
    fireAck(posted[0]!.correlationId, 'rejected', 'run-already-paused', 'refused');
    const result = await promise;
    expect(result.outcome).toBe('refused');
    expect(lifecycleMessage(result)).toBe('This Run is already paused.');
  });

  it('keeps a no-op distinct from a refusal', async () => {
    // The distinction the host draws and this layer must not collapse: nothing
    // was rejected, the queue was already in the requested state.
    const promise = dispatch();
    fireAck(posted[0]!.correlationId, 'rejected', 'start-intent-no-change', 'no-op');
    const result = await promise;
    expect(result.outcome).toBe('no-op');
    expect(lifecycleMessage(result)).toBe('The queue was already set that way, so nothing changed.');
  });

  it('reads a failure as a failure', async () => {
    const promise = dispatch();
    fireAck(posted[0]!.correlationId, 'rejected', 'pause-phase-failed', 'failed');
    const result = await promise;
    expect(result.outcome).toBe('failed');
    expect(lifecycleMessage(result)).toBe('Pausing the phase failed. Check the log and try again.');
  });

  it('reads an ACK with no outcome field as a plain refusal', async () => {
    // `outcome` is additive and optional on the wire. An ACK from a command
    // outside the five, or from a host build that predates the field, must
    // still be reported — as a refusal, which is what `status` already said.
    const promise = dispatch();
    fireAck(posted[0]!.correlationId, 'rejected', 'secondary-window-readonly');
    const result = await promise;
    expect(result.outcome).toBe('refused');
    expect(lifecycleMessage(result)).toBe(
      'This window is not the primary one, so it cannot change the Run.'
    );
  });

  it('substitutes a generic reason when the host names none', async () => {
    const promise = dispatch();
    fireAck(posted[0]!.correlationId, 'rejected');
    await expect(promise).resolves.toEqual({
      outcome: 'refused',
      message: 'The host refused the operation.'
    });
  });

  it('fails with a timeout sentence when no ACK arrives', async () => {
    const promise = dispatch();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toEqual({
      outcome: 'failed',
      message: 'The host did not answer. Try again.'
    });
  });

  it('ignores an ACK that arrives after the timeout', async () => {
    const promise = dispatch();
    const { correlationId } = posted[0]!;
    await vi.advanceTimersByTimeAsync(5000);
    const settled = await promise;
    expect(settled.outcome).toBe('failed');
    // The one-shot listener was unsubscribed by `finalise`, so there is nothing
    // left to fire — a late ack cannot resolve an already-settled promise.
    expect(ackListeners.has(correlationId)).toBe(false);
  });

  it('does not cross-resolve two concurrent dispatches', async () => {
    const first = dispatch();
    const second = dispatch();
    const [a, b] = posted;
    expect(a!.correlationId).not.toBe(b!.correlationId);

    fireAck(b!.correlationId, 'rejected', 'run-not-paused', 'refused');
    fireAck(a!.correlationId, 'accepted', undefined, 'accepted');

    await expect(first).resolves.toEqual({ outcome: 'accepted' });
    expect((await second).outcome).toBe('refused');
  });
});

describe('lifecycleRefusalText — one sentence per reason the host emits', () => {
  it('never returns the bare code for a reason the host can answer', () => {
    // Derived from the emitting sites named in the module header. The
    // provenance of each key is enforced separately by
    // `tests/lint/lifecycle-refusal-vocabulary.test.ts`, which reads the host
    // source; this case only pins that none of them falls through to the raw
    // code, which is the shape the operator cannot act on.
    const EMITTED = [
      'ambiguous-run-target',
      'no-run-in-flight',
      'run-already-paused',
      'run-not-paused',
      'run-terminal',
      'phase-not-active',
      // FR-R4-F20 (T7.5) — Skip's own refusals joined the table: the failed-Run refusal, the unknown
      // Phase the classifier answers for Skip, and the route's answer when no `phaseOps` is wired.
      'run-failed',
      'phase-id-not-in-pipeline-snapshot',
      'phase-ops-unavailable',
      'no-active-run',
      'not-pending-retry',
      'already-retrying',
      'not-primary-window',
      'rejected-horizon',
      'rejected-untrusted',
      'start-intent-no-change',
      'workspace-not-trusted',
      'command-dispatch-failed',
      'command-result-unrecognized',
      'operation-rejected',
      'secondary-window-readonly',
      'pause-phase-failed',
      'resume-phase-failed',
      'restart-phase-failed',
      'retry-phase-now-failed',
      'start-queue-failed',
      'timeout'
    ];
    for (const reason of EMITTED) {
      const text = lifecycleRefusalText(reason);
      expect(text, `no sentence for ${reason}`).not.toContain(reason);
      expect(text, `not a sentence: ${reason}`).toMatch(/^[A-Z].*[.]$/);
    }
  });

  it('falls through visibly for a code it does not know', () => {
    expect(lifecycleRefusalText('some-new-host-refusal')).toBe(
      'The host refused: some-new-host-refusal'
    );
  });

  it('reports nothing for an acceptance', () => {
    expect(lifecycleMessage({ outcome: 'accepted' })).toBeNull();
  });
});
