// A queue with one Task in flight and more pending MUST start the next one on
// its own when the first ends. No operator action, no Start Queue click.
//
// This is the same claim `concurrency-cap.test.ts` T070 makes — "a terminal Run
// frees its slot" — asked of the queue that just finished rather than of a
// *different* queue, and against a window holding exactly one queue. That
// difference is the whole point of a separate file: T070's sweep visits three
// other registry entries before it reaches the queue under test, and each of
// those visits is an `await` during which the terminating Run's session is
// disposed. A window with one queue has no such interval. Its sweep evaluates
// the cap gate on the first entry it looks at, which is the queue whose slot has
// not been given back yet, so the reading is stale by exactly one Run — and
// against the default cap of one, stale by exactly one Run is the difference
// between draining and stopping dead.
//
// The queue is `default` and the cap is 1 because that is the shipped
// configuration: this is what an operator with a single queue of twenty Tasks
// sees after the first one completes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  QUEUE_A,
  drainUntil,
  initGitRepo,
  makeHarness,
  removeWorkspace,
  type Harness
} from './concurrent-run-harness';
import { isTerminalRunStatus } from '../../src/state/workflow-run';

let tmpRoot: string;
let h: Harness;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-single-queue-advance-'));
  await initGitRepo(tmpRoot);
  // One queue, and the default cap. `queues: []` is not the harness default —
  // every other file built on it adds at least a second registry entry, which is
  // precisely the condition that hides this.
  h = await makeHarness(tmpRoot, { concurrencyCap: 1, queues: [] });
});

afterEach(async () => {
  await h.quiesce();
  await h.controller.drainedRunsSettled();
  await removeWorkspace(tmpRoot);
});

/**
 * Release `runId`'s parked invocations until `settled()` holds.
 *
 * The harness's own `runToTerminal` cannot be used for a hand-off on one queue,
 * and the reason is the behavior under test: it waits for `store.getRun(queueId)`
 * to read terminal, and a queue that hands off correctly has already replaced
 * that record with the successor's — `running` — before any poll can observe it.
 * Waiting on it would pass only when the hand-off was slow enough to be caught
 * mid-stride, which is a race in the direction of the bug. Every wait below is
 * therefore stated over Task rows, which outlive the Run record that carried
 * them.
 */
async function stepUntil(
  runId: string,
  settled: () => boolean,
  what: () => string
): Promise<void> {
  await drainUntil(
    () => {
      if (settled()) return true;
      if (h.parkedFor(runId) > 0) h.step(runId);
      return false;
    },
    what
  );
}

const statusOf = (taskId: string): string => h.queue.findById(taskId)?.status ?? 'gone';

describe('a single queue continues to its next Task unprompted', () => {
  it('starts the pending head when the Run before it completes', async () => {
    expect(h.store.getQueueRegistry().entries).toHaveLength(1);

    const first = await h.admit(QUEUE_A, 'first task');
    const second = await h.queue.enqueue('second task', { queueId: QUEUE_A });
    expect(h.queue.peekNextPending(QUEUE_A)?.id).toBe(second.id);

    // No `drainQueuedWork` from the test and no Start Queue: the first Run's own
    // terminal transition is the only trigger, exactly as it is in the product.
    await stepUntil(
      first.runId,
      () => statusOf(second.id) === 'in-flight',
      () =>
        `queue ${QUEUE_A} to start its next Task unprompted ` +
        `(first=${statusOf(first.feature.id)}, second=${statusOf(second.id)}, ` +
        `run=${h.store.getRun(QUEUE_A)?.status ?? 'none'}, ` +
        `live=${h.controller.liveRunCount})`
    );

    expect(statusOf(first.feature.id)).toBe('completed');
    const successor = h.store.getRun(QUEUE_A);
    expect(successor?.id).not.toBe(first.runId);
    expect(successor?.status).toBe('running');
    expect(isTerminalRunStatus(successor!.status)).toBe(false);
    expect(h.controller.liveRunCount).toBe(1);
  });

  it('keeps going for the whole backlog, not just one Task past the first', async () => {
    // Three, because a single hand-off can come out right on a path that happens
    // to have a free slot for unrelated reasons. A queue only *drains* if the
    // hand-off repeats, and the backlog that reported this was twenty deep.
    const first = await h.admit(QUEUE_A, 'task 1');
    const ids = [
      first.feature.id,
      (await h.queue.enqueue('task 2', { queueId: QUEUE_A })).id,
      (await h.queue.enqueue('task 3', { queueId: QUEUE_A })).id
    ];

    // Stop parking. This is the CLI answering promptly, not an operator touching
    // the queue — every promotion below is still the drain's own doing.
    h.openGate();

    await drainUntil(
      () => ids.every((id) => statusOf(id) === 'completed'),
      () => `the whole backlog to drain (${ids.map((id) => statusOf(id)).join(', ')})`
    );

    expect(h.queue.peekNextPending(QUEUE_A)).toBeNull();
  });
});
