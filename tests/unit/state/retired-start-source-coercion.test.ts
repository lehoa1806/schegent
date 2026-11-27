// Wake-up withdrawal — the retired `'wake-up-runner'` start source.
//
// The literal was dropped from `ScheduledStartSource` with the capability that
// produced it, but a queue record persisted by an earlier release can still
// carry it. `ensureExtendedQueueShape` coerces it to `'programmatic-scheduled'`
// on read — that is what it always meant operationally: a non-human caller
// armed a scheduled start.
//
// Read-time coercion rather than an upgrade-time rewrite is what makes this
// testable without a version bump: the record below is seeded as already-
// current, so no migrator runs, and the value is still normalized. That is the
// property under test — there is no schema version at which the stale literal
// survives into `getQueue()`.

import { describe, it, expect } from 'vitest';
import {
  KEYS,
  SCHEMA_VERSION,
  WorkspaceStateStore,
  type Memento
} from '../../../src/state/workspace-state';
import { STATE_SCHEMA_VERSION } from '../../../src/contracts/state-schema';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { type QueueRegistry } from '../../../src/queue/queue-registry';
import type { QueueState } from '../../../src/queue/feature-request';

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

const NOW = 1_700_000_000_000;
const SCHEDULED_AT = NOW + 60 * 60 * 1000;

const REGISTRY: QueueRegistry = {
  entries: [
    {
      id: DEFAULT_QUEUE_ID,
      name: 'Default queue',
      position: 0,
      schedule: null,
      createdAt: NOW,
      updatedAt: NOW
    }
  ],
  updatedAt: NOW
};

/**
 * Seed an idle-pending queue whose `scheduledStartSource` is whatever the
 * caller names — including the retired literal, which no longer type-checks as
 * a `ScheduledStartSource` and so is cast in exactly the one place a real
 * stale record would enter: the untyped memento.
 */
function seed(memento: FakeMemento, source: string | null): void {
  const queue = {
    requests: [],
    inFlightId: null,
    paused: false,
    pausedReason: null,
    updatedAt: NOW,
    queueLifecycle: 'idle-pending',
    pauseSource: null,
    scheduledStartAt: SCHEDULED_AT,
    scheduledStartSource: source
  } as unknown as QueueState;

  void memento.update(KEYS.schemaVersion, SCHEMA_VERSION);
  void memento.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);
  void memento.update(KEYS.queue, queue);
  void memento.update(KEYS.queueRegistry, REGISTRY);
  void memento.update(KEYS.queueDefaultId, DEFAULT_QUEUE_ID);
}

async function loadQueue(source: string | null): Promise<QueueState> {
  const memento = new FakeMemento();
  seed(memento, source);
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  return store.getQueue(DEFAULT_QUEUE_ID);
}

describe('Wake-up withdrawal — retired scheduledStartSource coercion', () => {
  it("coerces a persisted 'wake-up-runner' source to 'programmatic-scheduled'", async () => {
    const queue = await loadQueue('wake-up-runner');
    expect(queue.scheduledStartSource).toBe('programmatic-scheduled');
  });

  it('preserves the armed schedule while coercing the source', async () => {
    // The coercion re-labels who armed the start. It must not disarm it: the
    // operator scheduled a run and an unrelated capability withdrawal is not a
    // reason to drop it. FR-023a's lockstep also requires that a persisted
    // `scheduledStartAt` keep its `idle-pending` lifecycle.
    const queue = await loadQueue('wake-up-runner');
    expect(queue.queueLifecycle).toBe('idle-pending');
    expect(queue.scheduledStartAt).toBe(SCHEDULED_AT);
  });

  it.each([
    'operator-chooser',
    'operator-restart',
    'programmatic-now',
    'programmatic-scheduled',
    'migration-default',
    'system-rate-limit-recovery'
  ])('leaves the live source %s untouched', async (source) => {
    const queue = await loadQueue(source);
    expect(queue.scheduledStartSource).toBe(source);
  });

  it('leaves a null source null', async () => {
    const queue = await loadQueue(null);
    expect(queue.scheduledStartSource).toBeNull();
  });
});
