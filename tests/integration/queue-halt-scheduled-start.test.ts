// Feature 195 (T019, FR-022, SC-013) — an armed scheduled start on a halted
// queue releases the queue exactly as it does today; the resulting start is
// then refused by the failure question, and the queue's own surface states
// the reason. This must pass with NO change to `QueueScheduleWatchdog` — the
// watchdog only asks `promote` to try; whether the attempt succeeds is
// entirely the drain's question.

import { describe, it, expect } from 'vitest';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { QueueScheduleWatchdog } from '../../src/controller/schedule-watchdog';
import { makeHaltHarness } from './queue-halt-fixture';

describe('feature 195 (T019, FR-022, SC-013) — a due scheduled start on a halted queue', () => {
  it('releases the queue, starts zero tasks, and the queue reports why', async () => {
    const h = await makeHaltHarness('halt-on-failure');
    const failed = await h.queue.enqueue('row-1');
    await h.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    await h.finish(DEFAULT_QUEUE_ID, 'failed');

    // Arm a scheduled start the way `ScheduledStartCoordinator` leaves one
    // behind for the watchdog to recover: `idle-pending`, a deadline in the
    // past, no in-process timer holding it.
    const now = 1_700_000_100_000;
    const before = h.store.getQueue(DEFAULT_QUEUE_ID);
    await h.store.setQueue(
      {
        ...before,
        queueLifecycle: 'idle-pending',
        scheduledStartAt: now - 60_000,
        scheduledStartSource: 'operator-chooser'
      },
      DEFAULT_QUEUE_ID
    );

    const watchdog = new QueueScheduleWatchdog({
      getQueueStates: () => ({ [DEFAULT_QUEUE_ID]: h.store.getQueue(DEFAULT_QUEUE_ID) }),
      hasArmedTimer: () => false,
      promote: async (queueId) => {
        // Feature 065/FR-R3-002 — the shared promotion hop: clear the
        // schedule fields, then offer the queue to the drain. Exactly what
        // `ScheduledStartCoordinator.onFire` and the watchdog both call.
        const cur = h.store.getQueue(queueId);
        await h.store.setQueue(
          { ...cur, queueLifecycle: 'running', scheduledStartAt: null, scheduledStartSource: null },
          queueId
        );
        await h.autoDrain.drainIfIdle(queueId);
      },
      isPrimary: () => true,
      logger: { warn: () => {}, info: () => {} },
      now: () => now
    });

    const acted = await watchdog.tick();

    expect(acted).toEqual([DEFAULT_QUEUE_ID]);
    // Zero *further* tasks started by the scheduled release: `started` still
    // holds only the one row that started (and then failed) before the
    // schedule was armed.
    expect(h.started).toEqual([failed.id]);
    // The queue's own surface names the failed task as the reason.
    const report = h.startFailures.get(DEFAULT_QUEUE_ID);
    expect(report?.kind).toBe('halted');
    expect(report?.kind === 'halted' && report.taskId).toBe(failed.id);
  });
});
