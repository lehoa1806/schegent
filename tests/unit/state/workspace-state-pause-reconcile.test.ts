// FR-R3-011 — succession test for the retired BUG-001 startup reconciler.
//
// Feature 030's BUG-001 follow-on added `reconcileQueuePauseStateIfDivergent()`
// so that a workspace which had persisted a divergent pause state — legacy
// `QueueState.paused === true` while `QueueRegistry.entries[0].state ===
// 'active'` — would self-heal at activation instead of leaving the submit gate
// refusing tasks against a Resume button that did nothing. This file tested
// that reconciler across four disagreement shapes plus idempotence.
//
// The reconciler is gone, and so is the thing it repaired. The registry no
// longer stores a pause; `getProjectedQueueRegistry()` derives one from the
// queue record on every read, so the two sides cannot disagree at rest and
// there is nothing for a startup pass to reconcile. The file is kept rather
// than deleted because deleting it would leave the reintroduction of a startup
// reconciler looking like new work rather than a regression, and because the
// *load-bearing* behaviour survives the collapse in a different form:
//
//   a workspace whose disk still holds the divergent shape must load to one
//   answer, that answer must be the documented winner, and activation must
//   reach it without a repair pass that can itself be interrupted.
//
// Each test below is the successor of the one it replaces, at the store level.
// The migrator-level combination table lives in
// `tests/unit/state/queue-pause-collapse.test.ts`; what this file adds is that
// `initialize()` actually runs the collapse, writes it once, and settles.

import { describe, it, expect } from 'vitest';
import {
  KEYS,
  SCHEMA_VERSION,
  WorkspaceStateStore,
  type Memento
} from '../../../src/state/workspace-state';
import { STATE_SCHEMA_VERSION } from '../../../src/contracts/state-schema';
import {
  DEFAULT_QUEUE_ID,
  type QueueRegistry,
  type QueueRegistryEntry
} from '../../../src/queue/queue-registry';
import type { QueueState } from '../../../src/queue/feature-request';

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  public readonly writes: string[] = [];
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.writes.push(key);
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

const NOW = 1_700_000_000_000;

/**
 * A pre-collapse registry entry: it still carries the `state` / `pauseSource`
 * pair the v13 migration strips. The cast is the point of the fixture — this
 * shape is exactly what is on operator disks and exactly what no longer
 * type-checks, so building it any other way would test something else.
 */
function legacyEntry(overrides: Record<string, unknown>): QueueRegistryEntry {
  return {
    id: DEFAULT_QUEUE_ID,
    name: 'Default queue',
    position: 0,
    state: 'active',
    pauseSource: null,
    schedule: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  } as unknown as QueueRegistryEntry;
}

/** A pre-collapse queue record, carrying the retired `paused` mirror. */
function legacyQueueState(paused: boolean, pausedReason: string | null = null): QueueState {
  return {
    requests: [],
    inFlightId: null,
    paused,
    pausedReason,
    updatedAt: NOW,
    queueLifecycle: paused ? 'operator-paused' : 'active-empty',
    pauseSource: null,
    scheduledStartAt: null,
    scheduledStartSource: null
  } as QueueState;
}

/**
 * Seed the pre-collapse shape under the *current* numeric version.
 *
 * Both version keys are stamped current on purpose, and that is what makes
 * these tests about the collapse rather than about the migration chain: at the
 * current version every earlier migrator is a no-op, so the only thing that can
 * change the seeded record is `migrateV12ToV13IfNeeded()`, which fires on the
 * mirror's *presence* rather than on a version comparison. Rewinding the number
 * instead would route the same fixture through the v5 → v6 collapse, which
 * rebuilds the queue from the registry and attributes every inherited pause to
 * `'operator'` — a different mechanism reaching a similar-looking answer, and a
 * test that would keep passing if v13 were deleted.
 */
function seedPreCollapse(memento: FakeMemento, queue: QueueState, registry: QueueRegistry): void {
  void memento.update(KEYS.schemaVersion, SCHEMA_VERSION);
  void memento.update(KEYS.schemaVersionNumeric, STATE_SCHEMA_VERSION);
  void memento.update(KEYS.queue, { [DEFAULT_QUEUE_ID]: queue });
  void memento.update(KEYS.queueRegistry, registry);
  void memento.update(KEYS.queueDefaultId, DEFAULT_QUEUE_ID);
}

describe('WorkspaceStateStore — the divergence the BUG-001 reconciler repaired', () => {
  it('legacy paused=true with registry=active resolves to paused, not to active', async () => {
    // The successor of "legacy paused=true + registry=active → both cleared".
    // The reconciler adopted the registry as authoritative and cleared the
    // pause; the collapse resolves the other way, because clearing a pause an
    // operator may have set starts work nobody asked for, while keeping one
    // costs a Resume click.
    const memento = new FakeMemento();
    seedPreCollapse(memento, legacyQueueState(true, 'retry-cap-exhausted:r-old'), {
      entries: [legacyEntry({ state: 'active', pauseSource: null })],
      updatedAt: NOW
    });
    const store = new WorkspaceStateStore(memento);
    await store.initialize();

    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('operator-paused');
    expect(store.getQueue(DEFAULT_QUEUE_ID).pauseSource).toBe('operator');
    expect(store.getQueue(DEFAULT_QUEUE_ID).pausedReason).toBe('retry-cap-exhausted:r-old');
    expect(store.getProjectedQueueRegistry().entries[0]?.state).toBe('manually-paused');
    expect(store.getProjectedQueueRegistry().entries[0]?.pauseSource).toBe('operator');
  });

  it('legacy paused=false with registry=manually-paused resolves to paused, keeping attribution', async () => {
    // The successor of "inverse divergence → legacy set to true". Same
    // resolution as before, reached without a second write: the registry's
    // pause is read as migration input and its source is carried onto the
    // surviving record rather than mirrored back.
    const memento = new FakeMemento();
    seedPreCollapse(memento, legacyQueueState(false, null), {
      entries: [legacyEntry({ state: 'manually-paused', pauseSource: 'cascade' })],
      updatedAt: NOW
    });
    const store = new WorkspaceStateStore(memento);
    await store.initialize();

    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('operator-paused');
    expect(store.getQueue(DEFAULT_QUEUE_ID).pauseSource).toBe('cascade');
    expect(store.getProjectedQueueRegistry().entries[0]?.state).toBe('manually-paused');
    expect(store.getProjectedQueueRegistry().entries[0]?.pauseSource).toBe('cascade');
  });

  it('leaves consistent paused state untouched, reason included', async () => {
    const memento = new FakeMemento();
    seedPreCollapse(memento, legacyQueueState(true, 'operator-paused'), {
      entries: [legacyEntry({ state: 'manually-paused', pauseSource: 'operator' })],
      updatedAt: NOW
    });
    const store = new WorkspaceStateStore(memento);
    await store.initialize();

    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('operator-paused');
    expect(store.getQueue(DEFAULT_QUEUE_ID).pausedReason).toBe('operator-paused');
    expect(store.getProjectedQueueRegistry().entries[0]?.state).toBe('manually-paused');
  });

  it('leaves consistent active state untouched, and does not re-derive the lifecycle', async () => {
    // `active-empty` survives verbatim. The retired reconciler re-derived a
    // lifecycle from `(inFlightId, paused, pendingCount)` whenever it saw a
    // disagreement, which is how it could overwrite a legitimately held
    // `idle-pending` or `active-empty`; the collapse never re-derives.
    const memento = new FakeMemento();
    seedPreCollapse(memento, legacyQueueState(false, null), {
      entries: [legacyEntry({ state: 'active', pauseSource: null })],
      updatedAt: NOW
    });
    const store = new WorkspaceStateStore(memento);
    await store.initialize();

    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('active-empty');
    expect(store.getQueue(DEFAULT_QUEUE_ID).pauseSource).toBeNull();
    expect(store.getProjectedQueueRegistry().entries[0]?.state).toBe('active');
  });

  it('strips the retired representations from disk, so a reconciler would have nothing to read', async () => {
    // The structural claim, and the reason no startup repair pass is needed:
    // after activation neither retired field is on either key.
    const memento = new FakeMemento();
    seedPreCollapse(memento, legacyQueueState(true, 'operator-paused'), {
      entries: [legacyEntry({ state: 'manually-paused', pauseSource: 'operator' })],
      updatedAt: NOW
    });
    const store = new WorkspaceStateStore(memento);
    await store.initialize();

    const persistedQueues = memento.get<Record<string, QueueState>>(KEYS.queue)!;
    expect('paused' in persistedQueues[DEFAULT_QUEUE_ID]!).toBe(false);
    const persistedRegistry = memento.get<QueueRegistry>(KEYS.queueRegistry)!;
    const persistedEntry = persistedRegistry.entries[0] as unknown as Record<string, unknown>;
    expect('state' in persistedEntry).toBe(false);
    expect('pauseSource' in persistedEntry).toBe(false);
  });

  it('is idempotent — a second initialize() resolves nothing and changes nothing', async () => {
    // The successor of the original idempotence test. It asserts on the
    // persisted *value* and on the emitted events rather than on write counts,
    // because `KEYS.queue` is written on every activation regardless: the
    // feature-092 v10 lift re-persists the map whether or not it changed
    // anything (`migrateV9ToV10IfNeeded`), so "no write" is not true today and
    // would fail here for a reason that has nothing to do with the collapse.
    //
    // What the collapse owes is that the second pass finds nothing to resolve
    // and leaves the record byte-identical. `KEYS.queueRegistry` is a fair
    // no-write assertion, since the collapse is the only thing in the chain
    // that touches it.
    const memento = new FakeMemento();
    seedPreCollapse(memento, legacyQueueState(true, 'retry-cap-exhausted:r-old'), {
      entries: [legacyEntry({ state: 'active', pauseSource: null })],
      updatedAt: NOW
    });
    const store = new WorkspaceStateStore(memento);
    const first = await store.initialize();
    expect(first.v13MigrationEvents.length).toBeGreaterThan(0);
    const afterFirst = memento.get<Record<string, QueueState>>(KEYS.queue)!;

    memento.writes.length = 0;
    const second = await store.initialize();

    expect(second.migrated).toBe(false);
    expect(second.v13MigrationEvents).toEqual([]);
    expect(memento.writes).not.toContain(KEYS.queueRegistry);
    expect(memento.get<Record<string, QueueState>>(KEYS.queue)).toEqual(afterFirst);
  });
});
