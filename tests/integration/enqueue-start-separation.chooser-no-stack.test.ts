// Feature 065 (T052) — chooser-doesn't-stack edge case regression.
//
// Spec context — `specs/065-enqueue-start-separation/spec.md`:
//   - Line 120: "Two consecutive empty-queue enqueues in rapid succession
//     (before the chooser is dismissed for the first)": the chooser is a
//     queue-wide affordance and MUST NOT stack. The second enqueue appends
//     to pending behind the first; both tasks land in idle-pending and
//     the single open chooser's decision governs the queue as a whole.
//   - Line 123: "Operator enqueues into idle-pending queue, then explicitly
//     clicks 'Start queue'": the chooser appears and applies to the queue.
//     The operator's earlier silent enqueue is not retroactively "started
//     without consent" — the explicit click is the consent.
//
// What this test covers at the integration layer (using the shared
// helpers from T024 → `enqueue-start-separation.helpers.ts`):
//
//   (A) Two rapid human enqueues without `startIntent` against an empty
//       queue land BOTH tasks in pending. The lifecycle is `idle-pending`
//       with `scheduledStartAt === null`. Only ONE `idle-pending-entered`
//       audit event was emitted (the second enqueue did not re-enter the
//       state — it appended into the same state).
//
//   (B) A single `applyStartQueueIntent({ startMode: 'now' })` —
//       modeling the chooser's "Start now" commit on CMD_START_QUEUE —
//       emits exactly ONE `idle-pending-exited` event and flips the
//       lifecycle to `running`. This proves the chooser's decision
//       applies once-to-the-queue, NOT per-task (per FR-018 / Q6).
//
//   (C) Consent-on-explicit-start path: between the silent enqueue and
//       the explicit "Start queue" click, NO transition occurs. The
//       explicit click is the consent; without it, the silent enqueue
//       never retroactively starts.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { makeHarness, type Harness } from './enqueue-start-separation.helpers';

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(() => {
  h.cleanup();
});

describe('Feature 065 (T052) — chooser-no-stack regression (Edge Cases L120 + L123)', () => {
  it('(A) two consecutive human enqueues without intent → both pending, lifecycle idle-pending, ONE idle-pending-entered', async () => {
    const first = await h.service.scheduleOrEnqueue({
      description: 'first task (chooser open)',
      scheduledAt: h.clock.now(),
      via: 'webview',
      callerKind: 'human'
    });
    expect(first.outcome).toBe('enqueued');
    expect(first.lifecycleAfter).toBe('idle-pending');

    // Second enqueue arrives BEFORE any chooser commit happens. Lifecycle
    // is already idle-pending from the first enqueue.
    const second = await h.service.scheduleOrEnqueue({
      description: 'second task (chooser still open)',
      scheduledAt: h.clock.now(),
      via: 'webview',
      callerKind: 'human'
    });
    expect(second.outcome).toBe('enqueued');
    expect(second.lifecycleAfter).toBe('idle-pending');

    // Both tasks landed at the tail of pending — neither got promoted nor
    // launched a separate chooser. The single open chooser's decision
    // (which we'll exercise in (B)) governs the entire queue.
    const queue = h.store.getQueue();
    const pendingItems = queue.requests.filter((r) => r.status === 'pending');
    expect(pendingItems.length).toBe(2);
    expect(pendingItems[0].description).toBe('first task (chooser open)');
    expect(pendingItems[1].description).toBe('second task (chooser still open)');
    expect(queue.queueLifecycle).toBe('idle-pending');
    expect(queue.scheduledStartAt).toBeNull();
    expect(queue.scheduledStartSource).toBeNull();

    // Only ONE `idle-pending-entered` event — from the first enqueue's
    // transition out of `active-empty`. The second enqueue did not
    // re-enter (it appended into the existing idle-pending state).
    const enteredEvents = h.audit.byType('idle-pending-entered');
    expect(enteredEvents.length).toBe(1);
    // No `idle-pending-exited` between the two enqueues.
    expect(h.audit.byType('idle-pending-exited').length).toBe(0);
    // No `scheduled-start-armed` — no chooser committed a schedule yet.
    expect(h.audit.byType('scheduled-start-armed').length).toBe(0);
  });

  it('(B) chooser commit (Start now) applies once-to-the-queue → ONE idle-pending-exited, lifecycle running, all tasks preserved', async () => {
    // Two enqueues without intent → idle-pending with two pending tasks.
    await h.service.scheduleOrEnqueue({
      description: 'task A',
      scheduledAt: h.clock.now(),
      via: 'webview',
      callerKind: 'human'
    });
    await h.service.scheduleOrEnqueue({
      description: 'task B',
      scheduledAt: h.clock.now(),
      via: 'webview',
      callerKind: 'human'
    });
    expect(h.store.getQueue().queueLifecycle).toBe('idle-pending');
    expect(h.audit.byType('idle-pending-entered').length).toBe(1);

    // Operator's single "Start now" chooser commit. This is the production
    // path for the CMD_START_QUEUE handler.
    const applyResult = await h.service.applyStartQueueIntent({
      startMode: 'now',
      source: 'operator-restart'
    });
    expect(applyResult.outcome).toBe('applied');
    expect(applyResult.lifecycleAfter).toBe('running');

    // Exactly ONE `idle-pending-exited` — for the whole queue, not per-task.
    const exitEvents = h.audit.byType('idle-pending-exited');
    expect(exitEvents.length).toBe(1);
    expect(exitEvents[0].payload.exitReason).toBe('operator-start-now');
    expect(exitEvents[0].payload.scheduledStartSource).toBe('operator-restart');

    // Both tasks are still in the queue — the chooser commit didn't drop
    // them. Auto-drain will dispatch them one by one (covered elsewhere).
    const afterCommit = h.store.getQueue();
    expect(afterCommit.queueLifecycle).toBe('running');
    expect(afterCommit.scheduledStartAt).toBeNull();
    expect(afterCommit.scheduledStartSource).toBeNull();
    const stillPresent = afterCommit.requests.filter(
      (r) => r.status === 'pending' || r.status === 'in-flight'
    );
    // Both originals are still in the queue (pending or one in-flight if
    // auto-drain has begun).
    expect(stillPresent.length).toBeGreaterThanOrEqual(2);
  });

  it('(C) consent path: silent enqueue → idle-pending stays idle-pending until explicit "Start queue" click (no retroactive auto-start)', async () => {
    // (1) Silent enqueue (no startIntent — the operator did not commit
    // a chooser choice, just typed a task and hit submit). The queue
    // lands in idle-pending; NO start has been consented to yet.
    const enqueueResult = await h.service.scheduleOrEnqueue({
      description: 'silent enqueue',
      scheduledAt: h.clock.now(),
      via: 'webview',
      callerKind: 'human'
    });
    expect(enqueueResult.outcome).toBe('enqueued');
    expect(enqueueResult.lifecycleAfter).toBe('idle-pending');

    // Crucial assertion: between the silent enqueue and the explicit
    // operator click, the queue MUST NOT have transitioned to `running`.
    expect(h.store.getQueue().queueLifecycle).toBe('idle-pending');
    expect(h.audit.byType('idle-pending-exited').length).toBe(0);
    expect(h.audit.byType('scheduled-start-fired').length).toBe(0);

    // (2) Operator explicitly clicks "Start queue" — this is the chooser
    // committing a `startMode: 'now'` intent via CMD_START_QUEUE. The
    // service's `applyStartQueueIntent` is the production path for that
    // handler.
    const applyResult = await h.service.applyStartQueueIntent({
      startMode: 'now',
      source: 'operator-restart'
    });
    expect(applyResult.outcome).toBe('applied');
    expect(applyResult.lifecycleAfter).toBe('running');

    // Exactly ONE `idle-pending-exited` event recorded — the consent
    // click. Zero events between the silent enqueue and the click —
    // the silent enqueue did not retroactively start anything.
    const exitEvents = h.audit.byType('idle-pending-exited');
    expect(exitEvents.length).toBe(1);
    expect(exitEvents[0].payload.exitReason).toBe('operator-start-now');
    expect(exitEvents[0].payload.scheduledStartSource).toBe('operator-restart');
  });
});
