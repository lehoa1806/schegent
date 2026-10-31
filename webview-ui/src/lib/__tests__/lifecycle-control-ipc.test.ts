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
  // FR-R4-F05 (I4) — honours the identity the intent ledger supplies, as the real `postCommand` does.
  postCommand(
    type: string,
    payload?: unknown,
    opts?: { correlationId?: string }
  ): { correlationId: string } {
    const correlationId = opts?.correlationId ?? `c${++nextId}`;
    posted.push({ type, payload, correlationId });
    return { correlationId };
  }
}));

const { correlatedLifecycle, lifecycleMessage, lifecycleRefusalText, lifecycleWait } = await import(
  '../lifecycle-control-ipc'
);
const { postCommand } = await import('../vscode-api');
const { disposeIntentLedger } = await import('../intent-ledger');

/** One dispatch through the helper, standing in for any of the six call sites. */
function dispatch(queueId = 'q-beta'): Promise<
  Awaited<ReturnType<typeof correlatedLifecycle>>
> {
  return correlatedLifecycle(CMD_PAUSE_PHASE, { queueId }, (correlationId, payload) => {
    postCommand(CMD_PAUSE_PHASE, payload, { correlationId });
  });
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
  // The ledger is module state: an unsettled intent from one case would be reused by the next.
  disposeIntentLedger();
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

  // FR-R4-F05 (I5, O3; TA9) — this case used to expect `failed` and "Try again.". A timeout is
  // not a failure: the host may still run the command, so the result is `unknown`.
  it('resolves unknown, in words that say the outcome is not yet known, when no ACK arrives', async () => {
    const promise = dispatch();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toEqual({
      outcome: 'unknown',
      message:
        'The host has not answered yet. The change may still happen; this view will update when it does.'
    });
  });

  // FR-R4-F05 (I3; TA9) — this case used to assert that the listener was unsubscribed at the
  // timeout. It stays now, until the host answers, so a retry can reuse the identity.
  it('settles once at the timeout, and an ACK after it changes nothing and removes the listener', async () => {
    const promise = dispatch();
    const { correlationId } = posted[0]!;
    await vi.advanceTimersByTimeAsync(5000);
    const settled = await promise;
    expect(settled.outcome).toBe('unknown');
    expect(ackListeners.has(correlationId)).toBe(true);

    fireAck(correlationId, 'accepted', undefined, 'accepted');

    expect((await promise).outcome).toBe('unknown');
    expect(ackListeners.has(correlationId)).toBe(false);
  });

  it('does not cross-resolve two concurrent dispatches', async () => {
    const first = dispatch('q-beta');
    const second = dispatch('q-gamma');
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

  // FR-R4-F05 (T11, TA9) — this case used to pin the fallback `The host refused:
  // ${reason}`, which echoed whatever the host sent. The fallback is the shared boundary
  // text now: a code-shaped reason is named inside a fixed sentence, anything else is not shown.
  it('falls through visibly for a code it does not know, without echoing free text', () => {
    expect(lifecycleRefusalText('some-new-host-refusal')).toBe(
      'The host refused this action (`some-new-host-refusal`).'
    );
  });

  it('reports nothing for an acceptance', () => {
    expect(lifecycleMessage({ outcome: 'accepted' })).toBeNull();
  });
});

// FR-R4-F05 (T11; contract O, O1; data-model §5) — the lifecycle family's own map wins; the
// shared boundary text answers for what it lacks.
describe('lifecycleRefusalText — the shared boundary fallback (T11)', () => {
  it('maps untrusted-workspace, the router gate token, to the boundary sentence', () => {
    expect(lifecycleRefusalText('untrusted-workspace')).toBe(
      'The workspace is not trusted, so this action is unavailable.'
    );
  });

  it('keeps the family sentence for command-dispatch-failed, and never shows the bare code', () => {
    const text = lifecycleRefusalText('command-dispatch-failed');

    expect(text).toBe('The control could not be carried out. Check the log and try again.');
    expect(text).not.toContain('command-dispatch-failed');
  });

  it('never shows a free-text reason', () => {
    const freeText = 'write failed at /synthetic/home/user-252/secret.txt';

    expect(lifecycleRefusalText(freeText)).toBe('The host refused this action.');
    expect(lifecycleRefusalText(freeText)).not.toContain('user-252');
  });
});

// FR-R4-F05 (T17; contract I, I4 to I6; contract O, O3) — the lifecycle family sends through the
// intent ledger.
describe('correlatedLifecycle — retry identity (T17)', () => {
  it('posts the same correlation id and payload for a retry after a timeout, and answers it with the ACK', async () => {
    const first = dispatch('q-beta');
    await vi.advanceTimersByTimeAsync(5000);
    expect((await first).outcome).toBe('unknown');

    const retry = dispatch('q-beta');

    expect(posted).toHaveLength(2);
    expect(posted[1]!.correlationId).toBe(posted[0]!.correlationId);
    expect(posted[1]!.payload).toEqual(posted[0]!.payload);
    fireAck(posted[0]!.correlationId, 'accepted', undefined, 'accepted');
    await expect(retry).resolves.toEqual({ outcome: 'accepted' });
  });

  it('does not word a timeout as a failure', async () => {
    const promise = dispatch();
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result.outcome).not.toBe('failed');
    expect(lifecycleMessage(result)).not.toMatch(/try again|failed|nothing/i);
  });
});

// FR-R4-F05 (T17, T148 follow-up; contract O, O4; FR-024) — a surface that showed the interim "not yet
// known" text is told the host's answer once, through the same text path as an on-time ack, and an
// unmounted surface is told nothing.
describe('correlatedLifecycle — late outcome and abort (O4)', () => {
  const dispatchWith = (wait: Parameters<typeof correlatedLifecycle>[3]) =>
    correlatedLifecycle(CMD_PAUSE_PHASE, { queueId: 'q-beta' }, (correlationId, payload) => {
      postCommand(CMD_PAUSE_PHASE, payload, { correlationId });
    }, wait);

  it('gives a wait that timed out the late outcome once, as a lifecycle result, and leaves its own result unknown', async () => {
    const onLateOutcome = vi.fn();
    const promise = dispatchWith({ onLateOutcome });
    await vi.advanceTimersByTimeAsync(5000);
    expect((await promise).outcome).toBe('unknown');
    expect(onLateOutcome).not.toHaveBeenCalled();

    fireAck(posted[0]!.correlationId, 'rejected', 'run-already-paused', 'refused');

    expect(onLateOutcome).toHaveBeenCalledTimes(1);
    expect(onLateOutcome).toHaveBeenCalledWith({
      outcome: 'refused',
      message: lifecycleRefusalText('run-already-paused')
    });
  });

  it('never calls it for a wait that got its answer in time', async () => {
    const onLateOutcome = vi.fn();
    const promise = dispatchWith({ onLateOutcome });

    fireAck(posted[0]!.correlationId, 'accepted', undefined, 'accepted');
    await promise;
    await vi.advanceTimersByTimeAsync(5000);

    expect(onLateOutcome).not.toHaveBeenCalled();
  });

  it('calls nothing once the signal has aborted, however late the host answers', async () => {
    const onLateOutcome = vi.fn();
    const controller = new AbortController();
    const promise = dispatchWith({ signal: controller.signal, onLateOutcome });
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    controller.abort();
    fireAck(posted[0]!.correlationId, 'accepted', undefined, 'accepted');

    expect(onLateOutcome).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lifecycleWait shows a late refusal as its sentence and a late acceptance as no text', async () => {
    const shown: (string | null)[] = [];
    const controller = new AbortController();
    const promise = dispatchWith(lifecycleWait(controller.signal, (message) => shown.push(message)));
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    fireAck(posted[0]!.correlationId, 'rejected', 'run-not-paused', 'refused');
    expect(shown).toEqual([lifecycleRefusalText('run-not-paused')]);

    const second = dispatchWith(lifecycleWait(controller.signal, (message) => shown.push(message)));
    await vi.advanceTimersByTimeAsync(5000);
    await second;
    fireAck(posted[1]!.correlationId, 'accepted', undefined, 'accepted');
    expect(shown).toEqual([lifecycleRefusalText('run-not-paused'), null]);
  });

  it('lifecycleWait shows nothing after the signal aborts', async () => {
    const shown: (string | null)[] = [];
    const controller = new AbortController();
    const promise = dispatchWith(lifecycleWait(controller.signal, (message) => shown.push(message)));
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    controller.abort();
    fireAck(posted[0]!.correlationId, 'rejected', 'run-not-paused', 'refused');

    expect(shown).toEqual([]);
  });
});
