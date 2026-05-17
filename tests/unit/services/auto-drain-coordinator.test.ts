// Feature 013 — Wave 7 (US7 / T102): unit tests for AutoDrainCoordinator.
//
// The coordinator implements the four-step gate at the bottom of
// driveRun(): queue.paused-guard → capacity-guard → peekNextPending
// → lock.tryAcquire → controller.startNew. Each guard short-circuits;
// only the happy path triggers controller.startNew.

import { describe, it, expect, vi } from 'vitest';
import { AutoDrainCoordinator } from '../../../src/services/auto-drain-coordinator';

function makeStore(queueState: { paused: boolean; inFlightId: string | null }) {
  return { getQueue: vi.fn(() => queueState) };
}

function makeQueue(next: { id: string; description: string } | null, hasCapacity = true) {
  return { peekNextPending: vi.fn(() => next), hasCapacity: vi.fn(() => hasCapacity) };
}

function makeLock(acquired: boolean) {
  return { tryAcquire: vi.fn(async () => ({ acquired, ownerId: 'w-1' })) };
}

function makeController() {
  return { startNew: vi.fn(async () => undefined) };
}

describe('AutoDrainCoordinator (T099 / T102)', () => {
  it('promotes the next pending feature when queue is idle and lock is available', async () => {
    const store = makeStore({ paused: false, inFlightId: null });
    const queue = makeQueue({ id: 'q-2', description: 'next item' });
    const lock = makeLock(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      lock: lock as never,
      controller: controller as never
    });
    await coord.drainIfIdle();
    expect(controller.startNew).toHaveBeenCalledWith({ id: 'q-2', description: 'next item' }, null);
  });

  it('short-circuits when the queue is paused', async () => {
    const store = makeStore({ paused: true, inFlightId: null });
    const queue = makeQueue({ id: 'q-2', description: 'next' });
    const lock = makeLock(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      lock: lock as never,
      controller: controller as never
    });
    await coord.drainIfIdle();
    expect(queue.peekNextPending).not.toHaveBeenCalled();
    expect(controller.startNew).not.toHaveBeenCalled();
  });

  it('short-circuits when the global concurrency cap is full', async () => {
    const store = makeStore({ paused: false, inFlightId: 'q-1' });
    const queue = makeQueue({ id: 'q-2', description: 'next' }, false);
    const lock = makeLock(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      lock: lock as never,
      controller: controller as never
    });
    await coord.drainIfIdle();
    expect(queue.peekNextPending).not.toHaveBeenCalled();
    expect(controller.startNew).not.toHaveBeenCalled();
  });

  it('short-circuits when no pending feature exists', async () => {
    const store = makeStore({ paused: false, inFlightId: null });
    const queue = makeQueue(null);
    const lock = makeLock(true);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      lock: lock as never,
      controller: controller as never
    });
    await coord.drainIfIdle();
    expect(lock.tryAcquire).not.toHaveBeenCalled();
    expect(controller.startNew).not.toHaveBeenCalled();
  });

  it('short-circuits when lock acquisition fails', async () => {
    const store = makeStore({ paused: false, inFlightId: null });
    const queue = makeQueue({ id: 'q-2', description: 'next' });
    const lock = makeLock(false);
    const controller = makeController();
    const coord = new AutoDrainCoordinator({
      store: store as never,
      queue: queue as never,
      lock: lock as never,
      controller: controller as never
    });
    await coord.drainIfIdle();
    expect(controller.startNew).not.toHaveBeenCalled();
  });
});
