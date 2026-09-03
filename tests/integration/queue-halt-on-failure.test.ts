// Feature 195 (FR-R3-156) — a failed task must be able to stop its queue.
//
// T009: the core halt scenario. T059: the halted queue's projection does not
// misattribute a pause. T021: the two ways a halt clears. T017: the explicit
// start refusal. All four share `queue-halt-fixture.ts`'s real
// `WorkspaceStateStore` + `QueueManager` + `AutoDrainCoordinator`, because the
// feature's central claim — the halt is *derived*, not stored — is only
// provable against production code, not a hand-rolled model of it.

import { describe, it, expect } from 'vitest';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { makeHaltHarness } from './queue-halt-fixture';
import { runStartQueueCommand } from '../../src/commands/start-queue';

describe('feature 195 (T009, FR-002, SC-001) — the core halt scenario', () => {
  it('halt-on-failure starts rows 1 and 2, then stops after row 2 fails', async () => {
    const h = await makeHaltHarness('halt-on-failure');
    const rows = await Promise.all(
      ['row-1', 'row-2', 'row-3', 'row-4'].map((description) => h.queue.enqueue(description))
    );

    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(h.started).toEqual([rows[0].id]);
    await h.finish(DEFAULT_QUEUE_ID, 'completed');

    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(h.started).toEqual([rows[0].id, rows[1].id]);
    await h.finish(DEFAULT_QUEUE_ID, 'failed');

    // The queue now carries a failed row (rows[1]) and two still-pending rows
    // (rows[2], rows[3]). Neither ever starts.
    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(h.started).toEqual([rows[0].id, rows[1].id]);
  });

  it('continue starts all four rows regardless of the failure', async () => {
    const h = await makeHaltHarness('continue');
    const rows = await Promise.all(
      ['row-1', 'row-2', 'row-3', 'row-4'].map((description) => h.queue.enqueue(description))
    );

    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    await h.finish(DEFAULT_QUEUE_ID, 'completed');
    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    await h.finish(DEFAULT_QUEUE_ID, 'failed');
    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    await h.finish(DEFAULT_QUEUE_ID, 'completed');
    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    await h.finish(DEFAULT_QUEUE_ID, 'completed');

    expect(h.started).toEqual(rows.map((r) => r.id));
  });
});

describe('feature 195 (T059, FR-010, US1-AC5) — a halt is not reported as a pause', () => {
  it('the halted queue keeps its own lifecycle and carries no pause attribution', async () => {
    const h = await makeHaltHarness('halt-on-failure');
    const failed = await h.queue.enqueue('row-1');
    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    await h.finish(DEFAULT_QUEUE_ID, 'failed');
    void failed;

    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);

    const state = h.store.getQueue(DEFAULT_QUEUE_ID);
    // FR-010 — the halt gate never reads or writes `queueLifecycle`, so a
    // halted queue's lifecycle is whatever it already was (here: `running`,
    // set by `markInFlight`/`finish` — never `operator-paused`) and its
    // `pauseSource` never attributes the halt to a pause that did not happen.
    expect(state.queueLifecycle).not.toBe('operator-paused');
    expect(state.pauseSource).toBeNull();

    const report = h.startFailures.get(DEFAULT_QUEUE_ID);
    expect(report?.kind).toBe('halted');
  });
});

describe('feature 195 (T021, FR-009, SC-003) — retry and remove end the halt', () => {
  it('retrying the failed row clears the halt on the next attempt', async () => {
    const h = await makeHaltHarness('halt-on-failure');
    const first = await h.queue.enqueue('row-1');
    const second = await h.queue.enqueue('row-2');
    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    await h.finish(DEFAULT_QUEUE_ID, 'failed');

    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(h.started).toEqual([first.id]);

    await h.queue.retry(first.id);
    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);

    // No clearing step of this feature's own was invoked — `retry()` is the
    // pre-existing mutation, and the halt is gone because the row it named no
    // longer blocks (FR-003: nothing about the halt was stored to begin with).
    expect(h.started).toEqual([first.id, first.id]);
    void second;
  });

  it('removing the failed row clears the halt on the next attempt', async () => {
    const h = await makeHaltHarness('halt-on-failure');
    const first = await h.queue.enqueue('row-1');
    const second = await h.queue.enqueue('row-2');
    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    await h.finish(DEFAULT_QUEUE_ID, 'failed');

    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(h.started).toEqual([first.id]);

    await h.queue.removeTask(first.id);
    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);

    expect(h.started).toEqual([first.id, second.id]);
  });

  it('a queue with two failed rows where the operator deals with only one stays halted (T022)', async () => {
    const h = await makeHaltHarness('halt-on-failure');
    const first = await h.queue.enqueue('row-1');
    const second = await h.queue.enqueue('row-2');
    const third = await h.queue.enqueue('row-3');

    // Seed two simultaneously-failed rows directly: the drain itself would
    // never start `second` once `first` has failed, so getting there
    // production-style is not what this scenario is about. It is about the
    // condition naming the queue's current rows, not a single remembered
    // event — and that condition does not care how the rows got that way.
    await h.queue.markInFlight(first.id, 'run-1');
    await h.queue.finish(first.id, 'failed');
    await h.queue.markInFlight(second.id, 'run-2');
    await h.queue.finish(second.id, 'failed');

    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(h.started).toEqual([]);

    // Deal with only the earlier failed row (position order): still halted.
    await h.queue.removeTask(first.id);
    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(h.started).toEqual([]);

    // Deal with the second too: nothing blocks; `third` starts.
    await h.queue.removeTask(second.id);
    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(h.started).toEqual([third.id]);
  });

  it('a queue halted when the workspace closed, reopened with the failed row meanwhile removed, is not halted (T023)', async () => {
    const seed = await makeHaltHarness('halt-on-failure');
    await seed.queue.enqueue('row-1');
    await seed.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    await seed.finish(DEFAULT_QUEUE_ID, 'failed');
    await seed.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(seed.startFailures.get(DEFAULT_QUEUE_ID)?.kind).toBe('halted');

    const persistedFailed = seed.store
      .getQueue(DEFAULT_QUEUE_ID)
      .requests.find((r) => r.status === 'failed');
    expect(persistedFailed).toBeDefined();
    // The failed row is removed while the workspace is closed (another
    // window, or an offline cleanup) — the one fact this scenario needs is
    // that the *row* is gone by the time anything reads the record again.
    await seed.queue.removeTask(persistedFailed!.id);

    // "Reopened": a brand-new harness — its own registry, its own
    // `AutoDrainCoordinator`, its own `haltedQueues` memory, none of it
    // carried over — built over the *same* Memento, exactly as a new window
    // opens the same on-disk record. Nothing here initializes the halt;
    // there was never anything stored to initialize it from (FR-003).
    const reopened = await makeHaltHarness('halt-on-failure', seed.memento);
    expect(reopened.startFailures.get(DEFAULT_QUEUE_ID)).toBeNull();

    await reopened.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(reopened.startFailures.get(DEFAULT_QUEUE_ID)).toBeNull();
  });

  it('the persisted record of a halted queue carries only failurePolicy, nothing describing the halt', async () => {
    const h = await makeHaltHarness('halt-on-failure');
    await h.queue.enqueue('row-1');
    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    await h.finish(DEFAULT_QUEUE_ID, 'failed');
    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);

    const state = h.store.getQueue(DEFAULT_QUEUE_ID);
    const keys = Object.keys(state);
    const haltDescribingKeys = keys.filter((k) =>
      /halt/i.test(k) && k !== 'failurePolicy'
    );
    expect(haltDescribingKeys).toEqual([]);
  });
});

describe('feature 195 (T017, FR-021, SC-011, SC-012) — an explicit start is refused', () => {
  it('starts zero tasks and is reported as refused, naming no cancel affordance', async () => {
    const h = await makeHaltHarness('halt-on-failure');
    const first = await h.queue.enqueue('row-1');
    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    await h.finish(DEFAULT_QUEUE_ID, 'failed');
    // The queue is now halted, with no report yet from an *explicit* start —
    // the command below triggers the drain pass that discovers the halt
    // itself (research D5: one decision site, and this command is a reader).

    const outcome = await runStartQueueCommand(
      { queueId: DEFAULT_QUEUE_ID },
      {
        guardedRunService: { applyStartQueueIntent: async () => ({ outcome: 'noop' }) as never },
        controller: { drainQueuedWork: async (queueId?: string) => h.autoDrain.drainIfIdle(queueId) },
        logger: { warn: () => {} },
        startFailures: h.startFailures
      }
    );

    // Only the one row that already started (and then failed) is in `started`
    // — the explicit start command promotes nothing further.
    expect(h.started).toEqual([first.id]);
    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'accepted') {
      expect(outcome.reason).toBe('queue-halted-on-failed-task');
    }
  });
});
