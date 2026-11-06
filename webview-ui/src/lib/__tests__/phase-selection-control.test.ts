// FR-R5-F19 (spec 278, T19.3, US3; tasks T030) — Disable and Enable answer the operator.
//
// Both controls used to post and walk away: `disablePhase` and `enablePhase` returned `void`, the
// host's refusal (a terminal Run, an untrusted workspace, a secondary window) cleared the pending
// flag and vanished, and the button looked as if it had worked. They now travel the path Pause,
// Resume, Restart and Skip already use: an intent in the ledger, one acknowledgement, one sentence.
//
// What is pinned here, one case each:
//   - the post is an intent (a ledger-minted identity and a registered listener), not a bare post;
//   - a refusal shows the sentence for its code, and `untrusted-workspace` reads as
//     `workspace-not-trusted` does;
//   - a wait that ran out shows the not-yet-known text, and a late success replaces it on the same
//     control;
//   - a repeat click while the first is unanswered issues no second post;
//   - an outcome for a control the selection has since left is dropped, and another control's text
//     is untouched.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CMD_DISABLE_PHASE, CMD_ENABLE_PHASE } from '../messages';

type Outcome = 'accepted' | 'no-op' | 'refused' | 'failed';
type AckListener = (ack: { status: 'accepted' | 'rejected'; reason?: string; outcome?: Outcome }) => void;

const ackListeners = new Map<string, AckListener>();
const posted: { type: string; payload?: unknown; correlationId: string }[] = [];
let nextId = 0;

vi.mock('../snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending(): void {},
    clearPending(): void {},
    onceAck(id: string, fn: AckListener): () => void {
      ackListeners.set(id, fn);
      return () => ackListeners.delete(id);
    }
  }
}));

vi.mock('../vscode-api', () => ({
  postCommand(
    type: string,
    payload?: unknown,
    opts?: { correlationId?: string }
  ): { correlationId: string } {
    const correlationId = opts?.correlationId ?? `bare${++nextId}`;
    posted.push({ type, payload, correlationId });
    return { correlationId };
  }
}));

const { createSelectionControlRunner } = await import('../phase-selection-control');
const { lifecycleRefusalText } = await import('../lifecycle-control-ipc');
const { disposeIntentLedger } = await import('../intent-ledger');

const QUEUE = 'queue-beta';
const PHASE_A = 'speckit-plan';
const PHASE_B = 'speckit-implement';
const TIMEOUT_MS = 5000;

function answerLast(status: 'accepted' | 'rejected', reason?: string, outcome?: Outcome): void {
  const entry = posted.at(-1);
  expect(entry, 'nothing was posted').toBeDefined();
  answerFor(entry?.correlationId ?? '', status, reason, outcome);
}

function answerFor(
  correlationId: string,
  status: 'accepted' | 'rejected',
  reason?: string,
  outcome?: Outcome
): void {
  const listener = ackListeners.get(correlationId);
  expect(listener, `no listener for ${correlationId}`).toBeDefined();
  ackListeners.delete(correlationId);
  listener?.({ status, reason, outcome });
}

interface Harness {
  readonly shown: Array<string | null>;
  readonly controller: AbortController;
  readonly request: (
    kind: 'disable' | 'enable',
    phaseId: string,
    isCurrent?: () => boolean
  ) => Promise<void>;
}

function harness(): Harness {
  const runner = createSelectionControlRunner();
  const shown: Array<string | null> = [];
  const controller = new AbortController();
  return {
    shown,
    controller,
    request: (kind, phaseId, isCurrent = () => true) =>
      runner.run({
        kind,
        phaseId,
        queueId: QUEUE,
        isCurrent,
        show: (message) => shown.push(message),
        signal: controller.signal
      })
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  disposeIntentLedger();
  ackListeners.clear();
  posted.length = 0;
  nextId = 0;
});

afterEach(() => {
  disposeIntentLedger();
  vi.useRealTimers();
});

describe('Disable and Enable are intents, not bare posts', () => {
  it.each([
    ['disable', CMD_DISABLE_PHASE],
    ['enable', CMD_ENABLE_PHASE]
  ] as const)('%s posts the addressed command under a ledger identity with a listener', async (kind, type) => {
    const h = harness();
    const done = h.request(kind, PHASE_A);

    expect(posted).toHaveLength(1);
    expect(posted.at(0)).toMatchObject({ type, payload: { queueId: QUEUE, phaseId: PHASE_A } });
    const identity = posted.at(0)?.correlationId ?? '';
    // A bare `postCommand` mints its own id (`bare1` in this mock) and registers no listener.
    expect(identity.startsWith('bare')).toBe(false);
    expect(ackListeners.has(identity)).toBe(true);

    answerLast('accepted', undefined, 'accepted');
    await done;
    expect(h.shown).toEqual([null]);
  });
});

describe('a refusal is shown on the control that was invoked', () => {
  it('shows the sentence for the code the host returned', async () => {
    const h = harness();
    const done = h.request('disable', PHASE_A);
    answerLast('rejected', 'run-terminal', 'refused');
    await done;

    expect(h.shown).toEqual(['This Run has already finished, so its phases can no longer be changed.']);
  });

  it('shows a rejection the host answered for Enable the same way', async () => {
    const h = harness();
    const done = h.request('enable', PHASE_A);
    answerLast('rejected', 'secondary-window-readonly', 'refused');
    await done;

    expect(h.shown).toEqual([lifecycleRefusalText('secondary-window-readonly')]);
    expect(h.shown.at(0)).not.toContain('secondary-window-readonly');
  });

  it('shows untrusted-workspace as the sentence workspace-not-trusted has', async () => {
    const h = harness();
    const done = h.request('disable', PHASE_A);
    answerLast('rejected', 'untrusted-workspace', 'refused');
    await done;

    const trusted = lifecycleRefusalText('workspace-not-trusted');
    expect(lifecycleRefusalText('untrusted-workspace')).toBe(trusted);
    expect(h.shown).toEqual([trusted]);
    expect(h.shown.at(0)).not.toContain('untrusted-workspace');
  });

  it('control: the two codes differ as strings, so the equality above is not vacuous', () => {
    expect('untrusted-workspace').not.toBe('workspace-not-trusted');
    expect(lifecycleRefusalText('run-terminal')).not.toBe(lifecycleRefusalText('workspace-not-trusted'));
  });
});

describe('a wait that runs out, and the answer that arrives after it', () => {
  it('shows the not-yet-known text at the timeout, then clears it on a late success', async () => {
    const h = harness();
    const done = h.request('disable', PHASE_A);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await done;
    expect(h.shown).toEqual([lifecycleRefusalText('timeout')]);

    answerFor(posted.at(0)?.correlationId ?? '', 'accepted', undefined, 'accepted');
    expect(h.shown).toEqual([lifecycleRefusalText('timeout'), null]);
  });

  it('shows a late refusal on the same control, replacing the interim text', async () => {
    const h = harness();
    const done = h.request('enable', PHASE_A);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await done;
    answerFor(posted.at(0)?.correlationId ?? '', 'rejected', 'run-terminal', 'refused');

    expect(h.shown.at(-1)).toBe(lifecycleRefusalText('run-terminal'));
  });

  it('shows nothing late once the control that owns the wait has unmounted', async () => {
    const h = harness();
    const done = h.request('disable', PHASE_A);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await done;
    h.controller.abort();

    ackListeners.get(posted.at(0)?.correlationId ?? '')?.({ status: 'accepted', outcome: 'accepted' });
    expect(h.shown).toEqual([lifecycleRefusalText('timeout')]);
  });
});

describe('a repeat click while the first is unanswered', () => {
  it('issues no second post, and the first answer is the only one shown', async () => {
    const h = harness();
    const first = h.request('disable', PHASE_A);
    const second = h.request('disable', PHASE_A);

    expect(posted).toHaveLength(1);
    await second;

    answerLast('rejected', 'run-terminal', 'refused');
    await first;
    expect(h.shown).toEqual([lifecycleRefusalText('run-terminal')]);
  });

  it('lets the next click through once the first has been answered', async () => {
    const h = harness();
    const first = h.request('disable', PHASE_A);
    answerLast('accepted', undefined, 'accepted');
    await first;

    const again = h.request('disable', PHASE_A);
    expect(posted).toHaveLength(2);
    answerLast('accepted', undefined, 'accepted');
    await again;
  });

  it('lets a retry through after a timeout, under the identity the first send had', async () => {
    const h = harness();
    const first = h.request('disable', PHASE_A);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await first;

    const retry = h.request('disable', PHASE_A);
    expect(posted).toHaveLength(2);
    expect(posted.at(1)?.correlationId).toBe(posted.at(0)?.correlationId);
    answerLast('accepted', undefined, 'accepted');
    await retry;
  });

  it('does not let one phase block another, or Disable block Enable', async () => {
    const h = harness();
    const a = h.request('disable', PHASE_A);
    const b = h.request('disable', PHASE_B);
    const c = h.request('enable', PHASE_A);

    expect(posted).toHaveLength(3);
    for (const entry of [...posted]) answerFor(entry.correlationId, 'accepted', undefined, 'accepted');
    await Promise.all([a, b, c]);
  });
});

describe('an outcome for a control the selection has left', () => {
  it('is dropped, and the control now selected keeps its own text', async () => {
    const h = harness();
    let selected = PHASE_A;
    const a = h.request('disable', PHASE_A, () => selected === PHASE_A);
    const aIdentity = posted.at(0)?.correlationId ?? '';

    selected = PHASE_B;
    const b = h.request('disable', PHASE_B, () => selected === PHASE_B);

    answerFor(aIdentity, 'rejected', 'run-terminal', 'refused');
    await a;
    expect(h.shown).toEqual([]);

    answerLast('rejected', 'run-not-paused', 'refused');
    await b;
    expect(h.shown).toEqual([lifecycleRefusalText('run-not-paused')]);
  });

  it('is dropped when it arrives late, after the interim text was shown', async () => {
    const h = harness();
    let selected = PHASE_A;
    const a = h.request('enable', PHASE_A, () => selected === PHASE_A);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await a;
    expect(h.shown).toEqual([lifecycleRefusalText('timeout')]);

    selected = PHASE_B;
    answerFor(posted.at(0)?.correlationId ?? '', 'rejected', 'run-terminal', 'refused');
    expect(h.shown).toEqual([lifecycleRefusalText('timeout')]);
  });
});
