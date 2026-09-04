// FR-R3-154 (T1646) — Pause, Resume and Restart return what the host answered.
//
// This file did not exist. `phase-control.ts` had seven `void`-returning
// one-liners, and a `void`-returning post is untestable in the only way that
// matters here: there is no return value to assert against, so a test can pin
// the command name and payload and nothing else. That is exactly the gap
// FR-R3-154 filed — `run-already-paused`, `run-not-paused` and `run-terminal`
// are refusals `decidePhaseControl` has always been able to answer, and no
// caller could observe any of them.
//
// The four `void` dispatchers that remain in that module (skip, disable,
// enable, removeTaskPhase) are outside this feature's scope: FR-R3-154's
// non-claims name the five lifecycle routes proven to return false acceptance,
// and those four are not among them. Their command-and-payload coverage stays
// in `tests/unit/ui/sidebar/queue-addressed-phase-controls.test.ts`.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CMD_PAUSE_PHASE, CMD_RESTART_PHASE, CMD_RESUME_PHASE } from '../messages';

type AckListener = (ack: {
  status: 'accepted' | 'rejected';
  reason?: string;
  outcome?: 'accepted' | 'no-op' | 'refused' | 'failed';
}) => void;

const ackListeners = new Map<string, AckListener>();
const posted: { type: string; payload?: unknown; correlationId: string }[] = [];
let nextId = 0;

vi.mock('../snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending(): void {},
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

const { pausePhase, restartPhase, resumePhase } = await import('../phase-control');

function answer(
  status: 'accepted' | 'rejected',
  reason?: string,
  outcome?: 'accepted' | 'no-op' | 'refused' | 'failed'
): void {
  const entry = posted[posted.length - 1];
  expect(entry, 'nothing was posted').toBeDefined();
  const fn = ackListeners.get(entry!.correlationId);
  expect(fn, `the correlation id was discarded: ${entry!.correlationId}`).toBeDefined();
  ackListeners.delete(entry!.correlationId);
  fn!({ status, reason, outcome });
}

const QUEUE = 'queue-beta';
const PHASE = 'speckit-plan';

beforeEach(() => {
  ackListeners.clear();
  posted.length = 0;
  nextId = 0;
});

describe('pausePhase', () => {
  it('posts the addressed command and resolves the acceptance', async () => {
    const promise = pausePhase(QUEUE);
    expect(posted[0]).toMatchObject({ type: CMD_PAUSE_PHASE, payload: { queueId: QUEUE } });
    answer('accepted', undefined, 'accepted');
    await expect(promise).resolves.toEqual({ outcome: 'accepted' });
  });

  it('resolves the refusal the host answered', async () => {
    const promise = pausePhase(QUEUE);
    answer('rejected', 'run-already-paused', 'refused');
    await expect(promise).resolves.toEqual({
      outcome: 'refused',
      message: 'This Run is already paused.'
    });
  });
});

describe('resumePhase', () => {
  it('omits the prompt field entirely when there is no prompt', async () => {
    const promise = resumePhase(QUEUE);
    // Byte-for-byte the pre-existing wire shape: the host's validator accepts
    // a payload without `prompt`, and sending `prompt: undefined` is a
    // different message.
    expect(posted[0]!.payload).toEqual({ queueId: QUEUE });
    answer('accepted', undefined, 'accepted');
    await promise;
  });

  it('carries the prompt when there is one, and resolves the refusal', async () => {
    const promise = resumePhase(QUEUE, 'continue with the revised plan');
    expect(posted[0]!.payload).toEqual({
      queueId: QUEUE,
      prompt: 'continue with the revised plan'
    });
    answer('rejected', 'run-not-paused', 'refused');
    await expect(promise).resolves.toEqual({
      outcome: 'refused',
      message: 'This Run is not paused, so there is nothing to resume.'
    });
  });
});

describe('restartPhase', () => {
  it('posts the phase alongside the queue and resolves the acceptance', async () => {
    const promise = restartPhase(PHASE, QUEUE);
    expect(posted[0]).toMatchObject({
      type: CMD_RESTART_PHASE,
      payload: { queueId: QUEUE, phaseId: PHASE }
    });
    answer('accepted', undefined, 'accepted');
    await expect(promise).resolves.toEqual({ outcome: 'accepted' });
  });

  it('resolves the terminal-Run refusal FR-R3-151 added', async () => {
    // `run-terminal` is the refusal `decidePhaseControl`'s 'restart' branch
    // answers for a completed or canceled Run. Before this change the control
    // reported success on a Run it could not possibly have restarted.
    const promise = restartPhase(PHASE, QUEUE);
    answer('rejected', 'run-terminal', 'refused');
    await expect(promise).resolves.toEqual({
      outcome: 'refused',
      message: 'This Run has already finished, so its phases can no longer be changed.'
    });
  });
});

describe('all three read their own answer', () => {
  it('does not resolve one control with another control ACK', async () => {
    const pause = pausePhase(QUEUE);
    const pauseId = posted[0]!.correlationId;
    const resume = resumePhase(QUEUE);
    const resumeId = posted[1]!.correlationId;
    expect(pauseId).not.toBe(resumeId);

    ackListeners.get(resumeId)!({ status: 'rejected', reason: 'run-not-paused', outcome: 'refused' });
    ackListeners.get(pauseId)!({ status: 'accepted', outcome: 'accepted' });

    await expect(pause).resolves.toEqual({ outcome: 'accepted' });
    expect((await resume).outcome).toBe('refused');
  });

  it('registers a listener for every dispatch', async () => {
    // The negative control for the whole file: a dispatcher that went back to
    // `postCommand(...)` and returned would leave nothing registered here, and
    // `answer()` above would report the discarded correlation id by name.
    const dispatches = [pausePhase(QUEUE), resumePhase(QUEUE), restartPhase(PHASE, QUEUE)];
    expect(posted).toHaveLength(3);
    expect(posted.map((p) => p.type)).toEqual([
      CMD_PAUSE_PHASE,
      CMD_RESUME_PHASE,
      CMD_RESTART_PHASE
    ]);
    for (const { correlationId, type } of posted) {
      expect(ackListeners.has(correlationId), `${type} discarded its correlation id`).toBe(true);
    }

    // Answered rather than abandoned: each unanswered dispatch holds a real
    // 5-second timer, and three of them outliving the case would keep the
    // worker alive past teardown for no assertion's benefit.
    for (const { correlationId } of posted) {
      ackListeners.get(correlationId)!({ status: 'accepted', outcome: 'accepted' });
    }
    expect(await Promise.all(dispatches)).toEqual([
      { outcome: 'accepted' },
      { outcome: 'accepted' },
      { outcome: 'accepted' }
    ]);
  });
});
