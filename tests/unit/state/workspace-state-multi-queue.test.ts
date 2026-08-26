// Feature 092 (T012) — `KEYS.queue` as a per-queue record.
//
// Three properties, and the third is the one worth writing a file for:
//
//   FR-006  the key holds `Record<queueId, QueueState>`, not a `QueueState`
//   FR-006  a write to one queue leaves every sibling byte-identical
//   FR-007  a read of an unknown queue fabricates nothing
//
// The last is a containment property, not a convenience one. `getQueue()` is
// called from snapshot composition, drain, and every IPC handler, often with an
// id that came off the wire. If a read created the entry it asked for, a typo'd
// or stale queue id would mint a real queue as a side effect of looking at it,
// and the registry — which is the only thing allowed to decide what exists —
// would never hear about it. So a read of an absent queue answers with a
// born-empty value and writes nothing.

import { describe, it, expect, beforeEach } from 'vitest';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import {
  KEYS,
  WorkspaceStateStore,
  type Memento
} from '../../../src/state/workspace-state';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import type { QueueState } from '../../../src/queue/feature-request';
import {
  buildPendingTask,
  buildQueueRegistry,
  buildQueueStateMap,
  buildV9QueueState,
  fixtureQueueId
} from '../../fixtures/state/queue-fixtures';

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

const QUEUE_A = fixtureQueueId(1);
const QUEUE_B = fixtureQueueId(2);

let memento: FakeMemento;
let store: WorkspaceStateStore;

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
});

/** The raw persisted record, bypassing every accessor. */
function raw(): Record<string, QueueState> {
  return memento.get<Record<string, QueueState>>(KEYS.queue) ?? {};
}

describe('workspace-state — KEYS.queue holds a per-queue record (FR-006)', () => {
  it('persists a map keyed by queue id, not a bare QueueState', async () => {
    await store.setQueue(buildV9QueueState({ pendingCount: 2 }), QUEUE_A);

    const persisted = memento.get<unknown>(KEYS.queue);
    expect(Array.isArray((persisted as QueueState).requests)).toBe(false);
    expect(Object.keys(raw())).toContain(QUEUE_A);
    expect(raw()[QUEUE_A].requests).toHaveLength(2);
  });

  it('defaults an un-addressed write to the reserved queue', async () => {
    // 30 source call sites and ~199 test call sites read `getQueue()` with no
    // argument. The default keeps every one of them meaning what it meant.
    await store.setQueue(buildV9QueueState({ pendingCount: 1 }));

    expect(Object.keys(raw())).toEqual([DEFAULT_QUEUE_ID]);
    expect(store.getQueue(DEFAULT_QUEUE_ID).requests).toHaveLength(1);
    expect(store.getQueue(DEFAULT_QUEUE_ID).requests).toHaveLength(1);
  });

  it('round-trips a full registry-shaped map through the accessors', async () => {
    const registry = buildQueueRegistry({ count: 4 });
    const seeded = buildQueueStateMap(registry, (entry) => ({
      pendingCount: entry.position + 1
    }));

    for (const [queueId, state] of Object.entries(seeded)) {
      await store.setQueue(state, queueId);
    }

    for (const entry of registry.entries) {
      expect(store.getQueue(entry.id).requests, entry.id).toHaveLength(entry.position + 1);
    }
    expect(store.getQueueStateIds().slice().sort()).toEqual(
      registry.entries.map((e) => e.id).slice().sort()
    );
  });
});

describe('workspace-state — per-queue isolation (FR-006)', () => {
  beforeEach(async () => {
    await store.setQueue(buildV9QueueState({ pendingCount: 3 }), QUEUE_A);
    await store.setQueue(buildV9QueueState({ pendingCount: 1 }), QUEUE_B);
  });

  it('leaves every sibling byte-identical across a setQueue', async () => {
    const before = JSON.parse(JSON.stringify(raw()[QUEUE_B]));

    await store.setQueue(buildV9QueueState({ pendingCount: 7 }), QUEUE_A);

    expect(raw()[QUEUE_A].requests).toHaveLength(7);
    expect(raw()[QUEUE_B]).toEqual(before);
  });

  it('leaves every sibling byte-identical across an updateQueue', async () => {
    const before = JSON.parse(JSON.stringify(raw()[QUEUE_A]));

    await store.updateQueue(
      (current) => ({
        queue: { ...current, requests: [...current.requests, buildPendingTask({ position: 9 })] },
        result: current.requests.length
      }),
      QUEUE_B,
      unfencedCommit('test-fixture')
    );

    expect(raw()[QUEUE_B].requests).toHaveLength(2);
    expect(raw()[QUEUE_A]).toEqual(before);
  });

  it('pauses one queue without pausing another', async () => {
    await store.updateQueue(
      (current) => ({
        queue: { ...current, paused: true, pausedReason: 'operator', queueLifecycle: 'operator-paused'},
        result: null
      }),
      QUEUE_A,
      unfencedCommit('test-fixture')
    );

    expect(store.getQueue(QUEUE_A).queueLifecycle === 'operator-paused').toBe(true);
    expect(store.getQueue(QUEUE_B).queueLifecycle === 'operator-paused').toBe(false);
    expect(store.getQueue(QUEUE_B).queueLifecycle).not.toBe('operator-paused');
  });

  it('serialises concurrent writes to different queues without losing either', async () => {
    // A `Memento` is one key. Two read/modify/write cycles racing on different
    // queues would each read the map, add their own entry, and write back —
    // and the loser's sibling would vanish. The chain is per-key, so this must
    // hold even though the two mutations touch disjoint queues.
    await Promise.all([
      store.updateQueue(
        (c) => ({ queue: { ...c, requests: [buildPendingTask({ id: 'a1', position: 0 })] }, result: null }),
        QUEUE_A,
        unfencedCommit('test-fixture')
      ),
      store.updateQueue(
        (c) => ({ queue: { ...c, requests: [buildPendingTask({ id: 'b1', position: 0 })] }, result: null }),
        QUEUE_B,
        unfencedCommit('test-fixture')
      )
    ]);

    expect(store.getQueue(QUEUE_A).requests.map((r) => r.id)).toEqual(['a1']);
    expect(store.getQueue(QUEUE_B).requests.map((r) => r.id)).toEqual(['b1']);
  });

  it('deletes one queue state without touching the others', async () => {
    await store.deleteQueueState(QUEUE_A);

    expect(store.hasQueueState(QUEUE_A)).toBe(false);
    expect(store.hasQueueState(QUEUE_B)).toBe(true);
    expect(store.getQueue(QUEUE_B).requests).toHaveLength(1);
  });
});

describe('workspace-state — an unknown queueId fabricates nothing (FR-007)', () => {
  it('answers a read for an absent queue with a born-empty state', () => {
    const absent = store.getQueue(fixtureQueueId(42));

    expect(absent.requests).toEqual([]);
    expect(absent.inFlightId).toBeNull();
        expect(absent.queueLifecycle).toBe('active-empty');
    expect(absent.scheduledStartAt).toBeNull();
    expect(absent.scheduledStartSource).toBeNull();
  });

  it('persists nothing as a side effect of that read', async () => {
    await store.setQueue(buildV9QueueState({ pendingCount: 1 }), QUEUE_A);
    const before = JSON.parse(JSON.stringify(raw()));

    store.getQueue(fixtureQueueId(42));
    store.getQueue('not-even-a-uuid');

    expect(raw()).toEqual(before);
    expect(store.hasQueueState(fixtureQueueId(42))).toBe(false);
    expect(store.getQueueStateIds().slice().sort()).toEqual([DEFAULT_QUEUE_ID, QUEUE_A].sort());
  });

  it('births the reserved queue on initialize and nothing else', () => {
    // The reserved queue is the one entry that *is* created without an
    // operator asking: `initialize()` mints it so an un-addressed enqueue has
    // a target (FR-004). Every other id stays absent until something writes it,
    // which is what makes the read-fabricates-nothing rule above meaningful
    // rather than vacuous.
    expect(store.getQueueStateIds()).toEqual([DEFAULT_QUEUE_ID]);
    expect(store.hasQueueState(DEFAULT_QUEUE_ID)).toBe(true);

    expect(store.getQueue(QUEUE_A).requests).toEqual([]);
    expect(store.hasQueueState(QUEUE_A)).toBe(false);
    expect(store.getQueueStateIds()).toEqual([DEFAULT_QUEUE_ID]);
  });

  it('normalises every entry returned by getQueueStates()', async () => {
    // A partial record reaches the store from migrations and from older tests.
    // `getQueueStates()` is a projection, so it must apply the same
    // `ensureExtendedQueueShape` normalisation `getQueue()` does rather than
    // handing raw persisted values to a caller that expects the v7+ shape.
    await memento.update(KEYS.queue, {
      [QUEUE_A]: { requests: [], inFlightId: null, paused: false, updatedAt: 0 }
    });

    const states = store.getQueueStates();
    expect(states[QUEUE_A].queueLifecycle).toBe('active-empty');
    expect(states[QUEUE_A].scheduledStartAt).toBeNull();
    expect(states[QUEUE_A].scheduledStartSource).toBeNull();
  });
});
