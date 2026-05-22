// Feature 065 (T030) — Story 2 end-to-end: `running` queue silent enqueue.
//
// Coverage map per tasks.md T030:
//   (1) running + enqueue → NO `idle-pending-*` or `scheduled-start-*`
//       audit events; the task appears at the tail of pending (FR-006)
//   (2) running + enqueue WITH `startIntent` → the `startIntent` is
//       IGNORED; lifecycle stays `running`; no scheduled-start events
//       (FR-006)
//   (3) on in-flight termination, the next pending is promoted under
//       the existing auto-drain rule with no operator intervention
//   (4) SC-002: across N ≥ 10 enqueues into `running`, the count of
//       state-shape changes (lifecycle/scheduledStartAt) is exactly 0
//       and no `idle-pending-entered` events occur

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { makeHarness, type Harness } from './enqueue-start-separation.helpers';

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
  // Put the queue into `running` lifecycle to model "in-flight" state.
  const cur = h.store.getQueue();
  await h.store.setQueue({
    ...cur,
    queueLifecycle: 'running',
    scheduledStartAt: null,
    scheduledStartSource: null,
    updatedAt: h.clock.now()
  });
});

afterEach(() => {
  h.cleanup();
});

describe('Feature 065 (T030) — User Story 2: running queue silent enqueue', () => {
  it('(1) running + enqueue WITHOUT startIntent → tail-appended; no scheduled / idle-pending audit events', async () => {
    const before = h.store.getQueue();
    expect(before.queueLifecycle).toBe('running');

    const result = await h.service.scheduleOrEnqueue({
      description: 'silent append task',
      scheduledAt: h.clock.now(),
      via: 'webview',
      callerKind: 'human'
    });

    expect(result.outcome).toBe('enqueued');
    expect(result.lifecycleAfter).toBe('running');

    const after = h.store.getQueue();
    expect(after.queueLifecycle).toBe('running');
    expect(after.scheduledStartAt).toBeNull();
    expect(after.scheduledStartSource).toBeNull();
    // FR-006 — no scheduled-start-* / idle-pending-* events emitted.
    expect(h.audit.byType('idle-pending-entered').length).toBe(0);
    expect(h.audit.byType('idle-pending-exited').length).toBe(0);
    expect(h.audit.byType('scheduled-start-armed').length).toBe(0);
    expect(h.audit.byType('scheduled-start-fired').length).toBe(0);
    expect(h.audit.byType('scheduled-start-canceled').length).toBe(0);
    // The task was appended to pending.
    const queued = after.requests.find((r) => r.description === 'silent append task');
    expect(queued).toBeDefined();
    expect(queued!.status).toBe('pending');
  });

  it('(2) running + enqueue WITH scheduled startIntent → intent is IGNORED; lifecycle stays running', async () => {
    const scheduledAt = h.clock.now() + 60 * 60 * 1000;
    const result = await h.service.scheduleOrEnqueue({
      description: 'ignored-intent task',
      scheduledAt: h.clock.now(),
      via: 'webview',
      startIntent: {
        startMode: 'scheduled',
        scheduledStartAt: scheduledAt,
        source: 'operator-chooser'
      },
      callerKind: 'human'
    });

    expect(result.outcome).toBe('enqueued');
    expect(result.lifecycleAfter).toBe('running');
    const after = h.store.getQueue();
    expect(after.queueLifecycle).toBe('running');
    expect(after.scheduledStartAt).toBeNull(); // ignored
    expect(after.scheduledStartSource).toBeNull();
    expect(h.audit.byType('scheduled-start-armed').length).toBe(0);
    expect(h.audit.byType('idle-pending-entered').length).toBe(0);
  });

  it('(2b) running + enqueue WITH startMode=now intent → intent is IGNORED; no idle-pending-exited', async () => {
    const result = await h.service.scheduleOrEnqueue({
      description: 'ignored-now-intent task',
      scheduledAt: h.clock.now(),
      via: 'webview',
      startIntent: { startMode: 'now', source: 'operator-chooser' },
      callerKind: 'human'
    });
    expect(result.outcome).toBe('enqueued');
    expect(result.lifecycleAfter).toBe('running');
    expect(h.audit.byType('idle-pending-exited').length).toBe(0);
  });

  it('(3) on in-flight termination, auto-drain promotes next pending without operator action', async () => {
    // Enqueue two silently.
    await h.service.scheduleOrEnqueue({
      description: 'task-A',
      scheduledAt: h.clock.now(),
      via: 'webview',
      callerKind: 'human'
    });
    await h.service.scheduleOrEnqueue({
      description: 'task-B',
      scheduledAt: h.clock.now(),
      via: 'webview',
      callerKind: 'human'
    });

    // Simulate the in-flight termination: lifecycle returns to
    // active-empty (controller no longer running) and queue has 2 pending.
    const cur = h.store.getQueue();
    await h.store.setQueue({
      ...cur,
      queueLifecycle: 'active-empty',
      updatedAt: h.clock.now()
    });

    // Mark the in-flight (legacy controller) as not running.
    h.controller.running = false;

    await h.autoDrain.drainIfIdle();

    // The first call to startNew must have been made on the
    // controller stub.
    expect(h.controller.startNew).toHaveBeenCalled();
  });

  it('(4) SC-002 — N=10 enqueues into running: 0 state-shape changes, 0 chooser surfaces', async () => {
    const before = h.store.getQueue();
    const initialLifecycle = before.queueLifecycle;
    const initialScheduledStartAt = before.scheduledStartAt;
    const initialScheduledStartSource = before.scheduledStartSource;

    for (let i = 0; i < 10; i++) {
      const result = await h.service.scheduleOrEnqueue({
        description: `bulk-task-${i}`,
        scheduledAt: h.clock.now(),
        via: 'webview',
        // Mix intents: some with no intent, some with start-now, some
        // with a scheduled intent — all MUST be ignored.
        ...(i % 3 === 0
          ? {}
          : {
              startIntent:
                i % 3 === 1
                  ? { startMode: 'now', source: 'operator-chooser' }
                  : {
                      startMode: 'scheduled',
                      scheduledStartAt: h.clock.now() + 60 * 60 * 1000,
                      source: 'operator-chooser'
                    }
            }),
        callerKind: 'human'
      });
      expect(result.outcome).toBe('enqueued');
      expect(result.lifecycleAfter).toBe('running');
    }

    const after = h.store.getQueue();
    // SC-002 — lifecycle and scheduled-start fields are unchanged.
    expect(after.queueLifecycle).toBe(initialLifecycle);
    expect(after.scheduledStartAt).toBe(initialScheduledStartAt);
    expect(after.scheduledStartSource).toBe(initialScheduledStartSource);
    // Zero chooser-related events.
    expect(h.audit.byType('idle-pending-entered').length).toBe(0);
    expect(h.audit.byType('scheduled-start-armed').length).toBe(0);
    expect(h.audit.byType('scheduled-start-fired').length).toBe(0);
    expect(h.audit.byType('automation-enqueue-no-start-mode').length).toBe(0);
  });
});
