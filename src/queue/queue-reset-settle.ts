// The two rules a Clean All applies to one queue's record, in one place:
// which fields it settles, and what counts as state worth resetting.
//
// FR-R3-150 (T1619c). `QueueManager` has two reset methods — `clearQueue` for
// the addressed queue and `clearAll` for every queue — and after FR-009a they
// agree on both rules. Sharing them here is deliberately NOT the
// "compose `clearAll` over `clearQueue`" refactor that tasks.md T1619b
// rejected: the two methods differ in ways a shared *method* has to re-add as
// parameters (one workspace-wide runner-ack probe versus one per queue,
// registry-refusal semantics, the workspace-wide watchdog reset FR-007 keeps
// out of the queue-scoped path). What they do not differ in is the per-queue
// field write, and that is what these two pure functions hold.
//
// Pure on purpose. Neither function writes, so each method still issues its
// own single `updateQueue` — which is what keeps `clearQueue`'s tested
// one-write invariant intact. T1619b's option (c) failed precisely because it
// was framed as a shared *writer* over a partial field set.

import type { QueueState } from './feature-request';
import type { QueueLifecycle } from '../contracts/snapshot-vocabulary';
import type { QueuePauseSource } from './queue-registry';

/**
 * Who releases an `operator-paused` queue's pause.
 *
 * - `'release-pause'` — this write does. `clearQueue` uses it: it is the whole
 *   of the reset for its queue, so the pause fields settle with everything
 *   else in its single write.
 * - `'defer-pause-release'` — a later step does. `clearAll` uses it because
 *   its pause-clear step calls `setQueuePausedState(false, …)`, which also
 *   clears `pauseSource`, resumes the queue's matching Run, and records the
 *   mutation — and its already-not-paused early return would swallow all
 *   three if this write settled the lifecycle first. That step then derives
 *   `active-empty` from the queue this write has already emptied, so both
 *   modes settle at the same lifecycle.
 */
export type PauseReleaseMode = 'release-pause' | 'defer-pause-release';

/** The fields a reset writes. Every one of them, so a caller cannot settle a
 *  subset by accident. */
export interface QueueResetFields {
  readonly requests: never[];
  readonly inFlightId: null;
  readonly pausedReason: null;
  readonly pauseSource: QueuePauseSource;
  readonly queueLifecycle: QueueLifecycle;
  readonly scheduledStartAt: null;
  readonly scheduledStartSource: null;
  readonly updatedAt: number;
}

/**
 * The settled shape for `queue`, to spread over it inside an `updateQueue`
 * mapper.
 *
 * Both schedule fields leave in the same write as the lifecycle, never a write
 * earlier: an armed `scheduledStartAt` only ever sits on an `idle-pending`
 * queue, so clearing the field alone would persist the pairing inverted
 * (AGENTS rules 31-33 / data-model.md hold at every persisted state, not only
 * the final one).
 *
 * `queueLifecycle` is a literal rather than `withRefreshedLifecycle`, which
 * returns held lifecycles (`operator-paused`, `idle-pending`) untouched by
 * design — a reset has to *release* the hold, which is the opposite job.
 */
export function queueResetFields(
  queue: QueueState,
  now: number,
  mode: PauseReleaseMode
): QueueResetFields {
  const keepPause = mode === 'defer-pause-release' && queue.queueLifecycle === 'operator-paused';
  return {
    requests: [],
    inFlightId: null,
    // FR-R3-011 — `paused: false` is deliberately absent. It was the retired
    // mirror of `queueLifecycle`, and writing it back would put a record on
    // disk that the v13 collapse then has to lift again on the next activation.
    pausedReason: null,
    pauseSource: keepPause ? queue.pauseSource : null,
    queueLifecycle: keepPause ? 'operator-paused' : 'active-empty',
    scheduledStartAt: null,
    scheduledStartSource: null,
    updatedAt: now
  };
}

/**
 * Does this queue's own record hold anything a reset would clear?
 *
 * The no-op gate for both methods (FR-008/SC-004). `idle-pending` and an armed
 * `scheduledStartAt` are in the set because they are state Clean All promises
 * to clear: LC-Q-05 was that `clearAll` read past both, so a workspace whose
 * only remaining state was one queue's armed schedule reported already-clean,
 * wrote nothing, and left the timer live to start a queue the operator had
 * just emptied.
 *
 * Queue-record fields only. The active `WorkflowRun` lives under its own
 * memento key and the watchdog backoff is workspace-wide, so each caller
 * checks those itself — `clearQueue` the Run alone (FR-007 keeps the watchdog
 * out of it), `clearAll` both.
 */
export function hasResettableQueueState(queue: QueueState): boolean {
  return (
    queue.requests.length > 0 ||
    queue.inFlightId !== null ||
    queue.queueLifecycle === 'operator-paused' ||
    queue.queueLifecycle === 'idle-pending' ||
    queue.scheduledStartAt !== null
  );
}
