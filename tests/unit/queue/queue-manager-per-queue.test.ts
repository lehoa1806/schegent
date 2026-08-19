// Feature 092 — Phase 3 (US1) unit test for the per-queue QueueManager
// behavior (T013, T013a).
//
// Supersedes `queue-manager-single-queue.test.ts`, which asserted the same
// invariants against the one registry entry feature 030 collapsed the workspace
// to. Every invariant it pinned survives; what changed is that each one is now
// a property of *an addressed queue* rather than of the workspace, so each is
// exercised on a second, operator-created queue as well as on the reserved one.
//
// Covers:
//   - peekNextPending(queueId) reads the addressed queue only: a sibling's
//     pending Tasks are invisible to it, in both directions.
//   - peekNextPending respects the addressed entry's paused state, whether the
//     pause came from the operator or from a cascade, and a pause on one queue
//     does not gate the other.
//   - cascade pause/resume applied per entry, with operator-pause precedence
//     and idempotency preserved on each.
//   - the `pauseSource === null iff state !== 'manually-paused'` invariant,
//     asserted across every entry at each observable mutation.
//   - MAX_PENDING_TASKS_PER_QUEUE boundaries (T013a): accepted at `limit - 1`
//     and `limit`, refused at `limit + 1`, and — the point of "per queue" — a
//     second queue still accepting work while the first is saturated (FR-005).

import { describe, it, expect, beforeEach } from 'vitest';
import { QueueManager } from '../../../src/queue/queue-manager';
import {
  QueueMutationRejected,
  WorkspaceStateStore,
  type Memento
} from '../../../src/state/workspace-state';
import { createQueue, DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';
import { MAX_PENDING_TASKS_PER_QUEUE } from '../../../src/queue/feature-request';
import type { ProjectedQueueRegistryEntry } from '../../../src/queue/queue-registry';

const QUEUE_B_ID = '11111111-2222-4333-8444-555555555555';

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

describe('queue-manager — feature 092 per-queue behavior (T013)', () => {
  let store: WorkspaceStateStore;
  let queue: QueueManager;

  /**
   * The registry entry for `queueId`, which every assertion below addresses by id.
   *
   * FR-R3-011 — the **projected** entry. Pause state is no longer stored on a
   * registry entry; it is filled in on read from that queue's `QueueState`,
   * which is the same value the drain gate reads. Every assertion in this file
   * about `state` and `pauseSource` therefore now checks the projection of the
   * one persisted answer rather than a second copy of it.
   */
  function entryFor(queueId: string): ProjectedQueueRegistryEntry {
    const found = store.getProjectedQueueRegistry().entries.find((e) => e.id === queueId);
    if (!found) throw new Error(`registry has no entry for ${queueId}`);
    return found;
  }

  /**
   * `pauseSource === null` exactly when the entry is not `manually-paused` —
   * asserted over EVERY entry, because a per-queue writer that addressed the
   * wrong one would still leave the addressed entry self-consistent.
   */
  function expectPauseSourceInvariant(): void {
    for (const e of store.getProjectedQueueRegistry().entries) {
      expect(
        e.state === 'manually-paused' ? e.pauseSource !== null : e.pauseSource === null,
        `entry ${e.id} violates the pauseSource invariant (state=${e.state}, pauseSource=${String(e.pauseSource)})`
      ).toBe(true);
    }
  }

  beforeEach(async () => {
    store = new WorkspaceStateStore(new FakeMemento());
    await store.initialize();
    queue = new QueueManager(store);
    // A second queue, so every invariant below is exercised somewhere other
    // than the reserved entry the pre-092 model was the whole of.
    await store.setQueueRegistry(
      createQueue(store.getQueueRegistry(), {
        id: QUEUE_B_ID,
        name: 'Background',
        now: Date.now()
      })
    );
  });

  describe('peekNextPending(queueId)', () => {
    it('returns the oldest pending Task on the addressed queue', async () => {
      const a = await queue.enqueue('alpha');
      const b = await queue.enqueue('beta');
      // FIFO: alpha was enqueued first, so it is next.
      expect(queue.peekNextPending(DEFAULT_QUEUE_ID)?.id).toBe(a.id);
      expect(
        store
          .getQueue(DEFAULT_QUEUE_ID)
          .requests.filter((r) => r.status === 'pending')
          .map((r) => r.id)
      ).toEqual([a.id, b.id]);
    });

    it('omitting the id addresses the reserved queue', async () => {
      const a = await queue.enqueue('alpha');
      expect(queue.peekNextPending()).toEqual(queue.peekNextPending(DEFAULT_QUEUE_ID));
      expect(queue.peekNextPending()?.id).toBe(a.id);
    });

    it('does not see a sibling queue’s pending Tasks, in either direction', async () => {
      const onDefault = await queue.enqueue('alpha');
      const onB = await queue.enqueue('beta', { queueId: QUEUE_B_ID });

      expect(queue.peekNextPending(DEFAULT_QUEUE_ID)?.id).toBe(onDefault.id);
      expect(queue.peekNextPending(QUEUE_B_ID)?.id).toBe(onB.id);
      // The map key partitions the Tasks, so neither queue's projection can
      // contain the other's row at all.
      expect(store.getQueue(DEFAULT_QUEUE_ID).requests.map((r) => r.id)).toEqual([onDefault.id]);
      expect(store.getQueue(QUEUE_B_ID).requests.map((r) => r.id)).toEqual([onB.id]);
    });

    it('returns a Task on the second queue when the reserved queue is empty', async () => {
      const onB = await queue.enqueue('beta', { queueId: QUEUE_B_ID });
      expect(queue.peekNextPending(DEFAULT_QUEUE_ID)).toBeNull();
      expect(queue.peekNextPending(QUEUE_B_ID)?.id).toBe(onB.id);
    });

    it('returns null when the addressed entry is manually-paused by operator', async () => {
      await queue.enqueue('beta', { queueId: QUEUE_B_ID });
      await queue.setQueuePausedState(true, QUEUE_B_ID);
      expect(entryFor(QUEUE_B_ID).state).toBe('manually-paused');
      expect(entryFor(QUEUE_B_ID).pauseSource).toBe('operator');
      expect(queue.peekNextPending(QUEUE_B_ID)).toBeNull();
      expectPauseSourceInvariant();
    });

    it('returns null when the addressed entry is cascade-paused', async () => {
      await queue.enqueue('beta', { queueId: QUEUE_B_ID });
      await queue.cascadedPause(QUEUE_B_ID);
      expect(entryFor(QUEUE_B_ID).state).toBe('manually-paused');
      expect(entryFor(QUEUE_B_ID).pauseSource).toBe('cascade');
      // Cascade-paused entries also gate peekNextPending — the AutoDrain
      // coordinator's queueState.paused guard catches it too, but
      // peekNextPending itself only reads an `active` entry.
      expect(queue.peekNextPending(QUEUE_B_ID)).toBeNull();
      expectPauseSourceInvariant();
    });

    it('a pause on one queue does not gate the other', async () => {
      const onDefault = await queue.enqueue('alpha');
      await queue.enqueue('beta', { queueId: QUEUE_B_ID });

      await queue.setQueuePausedState(true, QUEUE_B_ID);

      expect(queue.peekNextPending(QUEUE_B_ID)).toBeNull();
      // The whole point of the feature: the reserved queue keeps draining.
      expect(queue.peekNextPending(DEFAULT_QUEUE_ID)?.id).toBe(onDefault.id);
      expect(entryFor(DEFAULT_QUEUE_ID).state).toBe('active');
      expectPauseSourceInvariant();
    });

    it('returns null when the addressed queue has no pending Tasks', async () => {
      await queue.enqueue('alpha');
      expect(queue.peekNextPending(QUEUE_B_ID)).toBeNull();
    });

    it('returns null for a queue id the registry does not know', async () => {
      await queue.enqueue('alpha');
      expect(queue.peekNextPending('99999999-8888-4777-9666-555555555555')).toBeNull();
    });

    it('skips in-flight and terminal Tasks on the addressed queue', async () => {
      const a = await queue.enqueue('alpha', { queueId: QUEUE_B_ID });
      const b = await queue.enqueue('beta', { queueId: QUEUE_B_ID });
      await queue.markInFlight(a.id, 'run-1');
      // alpha is older but in-flight, so beta is next.
      expect(queue.peekNextPending(QUEUE_B_ID)?.id).toBe(b.id);
      await queue.finish(a.id, 'completed');
      expect(queue.peekNextPending(QUEUE_B_ID)?.id).toBe(b.id);
    });
  });

  describe('per-queue paused state', () => {
    it('operator pause writes the addressed queue’s own lifecycle and leaves the sibling alone', async () => {
      await queue.enqueue('alpha');
      await queue.enqueue('beta', { queueId: QUEUE_B_ID });

      const result = await queue.setQueuePausedState(true, QUEUE_B_ID);
      expect(result.ok).toBe(true);

      expect(store.getQueue(QUEUE_B_ID).queueLifecycle === 'operator-paused').toBe(true);
      expect(store.getQueue(QUEUE_B_ID).queueLifecycle).toBe('operator-paused');
      // The registry entry and the queue's own lifecycle agree — the
      // divergence `reconcileQueuePauseStateIfDivergent` exists to repair.
      expect(entryFor(QUEUE_B_ID).state).toBe('manually-paused');

      expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle === 'operator-paused').toBe(false);
      expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).not.toBe('operator-paused');
      expectPauseSourceInvariant();
    });

    it('resume derives the addressed queue’s next lifecycle from its own contents', async () => {
      await queue.enqueue('beta', { queueId: QUEUE_B_ID });
      await queue.setQueuePausedState(true, QUEUE_B_ID);

      const result = await queue.setQueuePausedState(false, QUEUE_B_ID);
      expect(result.ok).toBe(true);

      // B has a pending Task of its own, so it resumes to idle-pending —
      // derived from B's rows, not from the workspace's.
      expect(store.getQueue(QUEUE_B_ID).queueLifecycle).toBe('idle-pending');
      expect(store.getQueue(QUEUE_B_ID).queueLifecycle === 'operator-paused').toBe(false);
      expect(entryFor(QUEUE_B_ID).state).toBe('active');
      expectPauseSourceInvariant();
    });

    it('resume on an empty queue derives active-empty even when a sibling holds work', async () => {
      await queue.enqueue('alpha');
      await queue.setQueuePausedState(true, QUEUE_B_ID);

      await queue.setQueuePausedState(false, QUEUE_B_ID);

      expect(store.getQueue(QUEUE_B_ID).queueLifecycle).toBe('active-empty');
      expectPauseSourceInvariant();
    });

    it('pausing both queues leaves each with its own lifecycle record', async () => {
      await queue.enqueue('alpha');
      await queue.enqueue('beta', { queueId: QUEUE_B_ID });

      await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID);
      await queue.setQueuePausedState(true, QUEUE_B_ID);

      for (const queueId of [DEFAULT_QUEUE_ID, QUEUE_B_ID]) {
        expect(store.getQueue(queueId).queueLifecycle === 'operator-paused', `${queueId} paused`).toBe(true);
        expect(store.getQueue(queueId).queueLifecycle, `${queueId} lifecycle`).toBe(
          'operator-paused'
        );
        expect(entryFor(queueId).state, `${queueId} registry state`).toBe('manually-paused');
      }
      expectPauseSourceInvariant();
    });

    it('refuses a pause addressed to an unknown queue id', async () => {
      const result = await queue.setQueuePausedState(
        true,
        '99999999-8888-4777-9666-555555555555'
      );
      expect(result).toEqual({ ok: false, reason: 'unknown-queue-id' });
      expectPauseSourceInvariant();
    });
  });

  describe('cascade pause/resume invariants, applied per entry', () => {
    it('cascadedPause flips the addressed entry active → manually-paused/cascade', async () => {
      expect(entryFor(QUEUE_B_ID).state).toBe('active');
      expect(entryFor(QUEUE_B_ID).pauseSource).toBeNull();

      const result = await queue.cascadedPause(QUEUE_B_ID);
      expect(result.ok).toBe(true);

      expect(entryFor(QUEUE_B_ID).state).toBe('manually-paused');
      expect(entryFor(QUEUE_B_ID).pauseSource).toBe('cascade');
      expect(store.getQueue(QUEUE_B_ID).queueLifecycle === 'operator-paused').toBe(true);
      // The sibling is untouched by a cascade that was not addressed to it.
      expect(entryFor(DEFAULT_QUEUE_ID).state).toBe('active');
      expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle === 'operator-paused').toBe(false);
      expectPauseSourceInvariant();
    });

    it('cascadedResume restores manually-paused/cascade → active on the addressed entry', async () => {
      await queue.cascadedPause(QUEUE_B_ID);
      const result = await queue.cascadedResume(QUEUE_B_ID);
      expect(result.ok).toBe(true);

      expect(entryFor(QUEUE_B_ID).state).toBe('active');
      expect(entryFor(QUEUE_B_ID).pauseSource).toBeNull();
      expect(store.getQueue(QUEUE_B_ID).queueLifecycle === 'operator-paused').toBe(false);
      expectPauseSourceInvariant();
    });

    it('cascadedResume is a strict NO-OP when the entry’s pauseSource is operator', async () => {
      await queue.setQueuePausedState(true, QUEUE_B_ID);
      expect(entryFor(QUEUE_B_ID).pauseSource).toBe('operator');

      // FR-004 of feature 028, preserved per entry: a cascade resume must not
      // clear a pause the operator installed.
      const result = await queue.cascadedResume(QUEUE_B_ID);
      expect(result.ok).toBe(true);

      expect(entryFor(QUEUE_B_ID).state).toBe('manually-paused');
      expect(entryFor(QUEUE_B_ID).pauseSource).toBe('operator');
      expect(store.getQueue(QUEUE_B_ID).queueLifecycle === 'operator-paused').toBe(true);
      expectPauseSourceInvariant();
    });

    it('cascadedResume is a strict NO-OP when the addressed entry is already active', async () => {
      const result = await queue.cascadedResume(QUEUE_B_ID);
      expect(result.ok).toBe(true);

      expect(entryFor(QUEUE_B_ID).state).toBe('active');
      expect(entryFor(QUEUE_B_ID).pauseSource).toBeNull();
      expectPauseSourceInvariant();
    });

    it('cascadedPause is idempotent on an already cascade-paused entry', async () => {
      await queue.cascadedPause(QUEUE_B_ID);
      expect(entryFor(QUEUE_B_ID).pauseSource).toBe('cascade');

      const result = await queue.cascadedPause(QUEUE_B_ID);
      expect(result.ok).toBe(true);
      expect(entryFor(QUEUE_B_ID).state).toBe('manually-paused');
      expect(entryFor(QUEUE_B_ID).pauseSource).toBe('cascade');
      expectPauseSourceInvariant();
    });

    it('cascadedPause on an operator-paused entry leaves pauseSource as operator', async () => {
      await queue.setQueuePausedState(true, QUEUE_B_ID);
      const result = await queue.cascadedPause(QUEUE_B_ID);
      expect(result.ok).toBe(true);
      expect(entryFor(QUEUE_B_ID).state).toBe('manually-paused');
      // Operator pause must NOT be downgraded to cascade.
      expect(entryFor(QUEUE_B_ID).pauseSource).toBe('operator');
      expectPauseSourceInvariant();
    });

    it('cascade-pauses each entry independently, with different sources side by side', async () => {
      await queue.cascadedPause(QUEUE_B_ID);
      await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID);

      expect(entryFor(QUEUE_B_ID).pauseSource).toBe('cascade');
      expect(entryFor(DEFAULT_QUEUE_ID).pauseSource).toBe('operator');

      // Resuming the cascade half must not touch the operator half.
      await queue.cascadedResume(QUEUE_B_ID);
      expect(entryFor(QUEUE_B_ID).state).toBe('active');
      expect(entryFor(DEFAULT_QUEUE_ID).state).toBe('manually-paused');
      expect(entryFor(DEFAULT_QUEUE_ID).pauseSource).toBe('operator');
      expectPauseSourceInvariant();
    });

    it('refuses a cascade addressed to an unknown queue id', async () => {
      const paused = await queue.cascadedPause('99999999-8888-4777-9666-555555555555');
      expect(paused).toEqual({ ok: false, reason: 'unknown-queue-id' });
      const resumed = await queue.cascadedResume('99999999-8888-4777-9666-555555555555');
      expect(resumed).toEqual({ ok: false, reason: 'unknown-queue-id' });
      expectPauseSourceInvariant();
    });
  });

  describe('pauseSource invariant across a full pause/resume cycle', () => {
    it('holds across cascade pause then resume on a non-reserved queue', async () => {
      expectPauseSourceInvariant();

      await queue.cascadedPause(QUEUE_B_ID);
      expect(entryFor(QUEUE_B_ID).state).toBe('manually-paused');
      expect(entryFor(QUEUE_B_ID).pauseSource).not.toBeNull();
      expectPauseSourceInvariant();

      await queue.cascadedResume(QUEUE_B_ID);
      expect(entryFor(QUEUE_B_ID).state).toBe('active');
      expect(entryFor(QUEUE_B_ID).pauseSource).toBeNull();
      expectPauseSourceInvariant();
    });

    it('holds across operator pause then resume on a non-reserved queue', async () => {
      await queue.setQueuePausedState(true, QUEUE_B_ID);
      expect(entryFor(QUEUE_B_ID).state).toBe('manually-paused');
      expect(entryFor(QUEUE_B_ID).pauseSource).toBe('operator');
      expectPauseSourceInvariant();

      await queue.setQueuePausedState(false, QUEUE_B_ID);
      expect(entryFor(QUEUE_B_ID).state).toBe('active');
      expect(entryFor(QUEUE_B_ID).pauseSource).toBeNull();
      expectPauseSourceInvariant();
    });
  });
});

// Feature 092 (T013a, FR-005) — the pending-Task cap is per queue.
//
// Before v10 the cap counted a filtered slice of one shared array, so "per
// queue" and "per workspace" were the same number by accident. The boundary
// cases below pin the count itself; the saturated-sibling case pins the
// *scope*, which is the half that a shared-array implementation would get
// wrong while still passing every boundary assertion above it.
describe('MAX_PENDING_TASKS_PER_QUEUE is enforced per queue (T013a)', () => {
  let store: WorkspaceStateStore;
  let queue: QueueManager;

  /** Enqueue `count` pending Tasks onto `queueId`. */
  async function fill(queueId: string, count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await queue.enqueue(`task-${queueId}-${i}`, { queueId });
    }
  }

  function pendingCount(queueId: string): number {
    return store.getQueue(queueId).requests.filter((r) => r.status === 'pending').length;
  }

  beforeEach(async () => {
    store = new WorkspaceStateStore(new FakeMemento());
    await store.initialize();
    queue = new QueueManager(store);
    await store.setQueueRegistry(
      createQueue(store.getQueueRegistry(), {
        id: QUEUE_B_ID,
        name: 'Background',
        now: Date.now()
      })
    );
  });

  it('accepts the Task that brings the queue to limit - 1', async () => {
    await fill(DEFAULT_QUEUE_ID, MAX_PENDING_TASKS_PER_QUEUE - 2);
    await expect(queue.enqueue('at-limit-minus-one')).resolves.toMatchObject({
      status: 'pending'
    });
    expect(pendingCount(DEFAULT_QUEUE_ID)).toBe(MAX_PENDING_TASKS_PER_QUEUE - 1);
  });

  it('accepts the Task that brings the queue exactly to the limit', async () => {
    await fill(DEFAULT_QUEUE_ID, MAX_PENDING_TASKS_PER_QUEUE - 1);
    await expect(queue.enqueue('at-limit')).resolves.toMatchObject({ status: 'pending' });
    expect(pendingCount(DEFAULT_QUEUE_ID)).toBe(MAX_PENDING_TASKS_PER_QUEUE);
  });

  it('refuses the Task that would exceed the limit, and persists nothing', async () => {
    await fill(DEFAULT_QUEUE_ID, MAX_PENDING_TASKS_PER_QUEUE);
    expect(pendingCount(DEFAULT_QUEUE_ID)).toBe(MAX_PENDING_TASKS_PER_QUEUE);

    await expect(queue.enqueue('over-the-limit')).rejects.toThrow(QueueMutationRejected);
    await expect(queue.enqueue('over-the-limit')).rejects.toMatchObject({
      reason: 'task-cap-reached'
    });
    // A refused enqueue leaves the queue exactly where it was.
    expect(pendingCount(DEFAULT_QUEUE_ID)).toBe(MAX_PENDING_TASKS_PER_QUEUE);
    expect(
      store.getQueue(DEFAULT_QUEUE_ID).requests.some((r) => r.description === 'over-the-limit')
    ).toBe(false);
  });

  it('lets a second queue accept work while the first is saturated', async () => {
    await fill(DEFAULT_QUEUE_ID, MAX_PENDING_TASKS_PER_QUEUE);
    await expect(queue.enqueue('refused-on-default')).rejects.toMatchObject({
      reason: 'task-cap-reached'
    });

    // The cap is per queue, so a saturated queue does not saturate the
    // workspace — this is the assertion a shared-array cap would fail.
    const onB = await queue.enqueue('accepted-on-b', { queueId: QUEUE_B_ID });
    expect(onB.queueId).toBe(QUEUE_B_ID);
    expect(pendingCount(QUEUE_B_ID)).toBe(1);
    expect(pendingCount(DEFAULT_QUEUE_ID)).toBe(MAX_PENDING_TASKS_PER_QUEUE);
  });

  it('counts only pending Tasks toward the cap, per queue', async () => {
    await fill(DEFAULT_QUEUE_ID, MAX_PENDING_TASKS_PER_QUEUE);
    const head = queue.peekNextPending(DEFAULT_QUEUE_ID);
    expect(head).not.toBeNull();

    // Draining one Task off the head frees exactly one slot on that queue.
    await queue.markInFlight(head!.id, 'run-1');
    await queue.finish(head!.id, 'completed');
    expect(pendingCount(DEFAULT_QUEUE_ID)).toBe(MAX_PENDING_TASKS_PER_QUEUE - 1);

    await expect(queue.enqueue('back-to-the-limit')).resolves.toMatchObject({
      status: 'pending'
    });
    expect(pendingCount(DEFAULT_QUEUE_ID)).toBe(MAX_PENDING_TASKS_PER_QUEUE);
  });
});
