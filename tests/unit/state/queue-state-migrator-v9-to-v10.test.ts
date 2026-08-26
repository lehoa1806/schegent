// Feature 092 (T010, T011) — the v9 → v10 forward migration.
//
// v10 pluralises `KEYS.queue`: one `QueueState` becomes
// `Record<queueId, QueueState>`. This is the deliberate reversal of the v6
// collapse, and it is the feature's one irreversible artifact, so the six
// guarantees of contracts/queue-registry-and-migration.md §2 are each pinned
// here rather than inferred from a single happy-path assertion:
//
//   1. one entry results, keyed by `'default'`
//   2. every pending Task is carried verbatim
//   3. `KEYS.run` is neither read nor written
//   4. no pre-030 queue is fabricated
//   5. the `scheduledStartAt` / `idle-pending` lockstep holds per entry
//   6. the whole lift is a single write
//
// Guarantee 3 is checked at the *signature* level: the migrator is a pure
// function over the queue record and has no access to a store, so there is
// nothing it could read `KEYS.run` from. That is stronger than asserting a
// mock was not called, and it is why the migrator is pure.

import { describe, it, expect } from 'vitest';
import {
  assertPersistedVersionSupported,
  migrateV9ToV10,
  type QueueStateMap
} from '../../../src/state/queue-state-migrator';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import {
  STATE_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION_V10
} from '../../../src/contracts/state-schema';
import type { QueueState } from '../../../src/queue/feature-request';
import {
  FIXTURE_NOW,
  buildPendingTask,
  buildV9QueueState,
  fixtureQueueId
} from '../../fixtures/state/queue-fixtures';

const NOW = FIXTURE_NOW;

/**
 * A corpus rather than one fixture. SC-003 claims the migration holds for
 * *every* workspace, and a single sample cannot evidence that — each shape
 * below is a distinct combination of the fields the lift touches.
 */
const CORPUS: ReadonlyArray<{ readonly label: string; readonly state: QueueState }> = [
  { label: 'empty queue', state: buildV9QueueState({ pendingCount: 0 }) },
  { label: 'pending only', state: buildV9QueueState({ pendingCount: 5 }) },
  {
    label: 'in-flight plus pending',
    state: buildV9QueueState({ pendingCount: 3, inFlightRunId: 'run-1' })
  },
  { label: 'operator-paused', state: buildV9QueueState({ pendingCount: 2, paused: true }) },
  {
    label: 'idle-pending with a scheduled start',
    state: buildV9QueueState({
      pendingCount: 2,
      queueLifecycle: 'idle-pending',
      scheduledStartAt: NOW + 60_000,
      scheduledStartSource: 'operator-chooser'
    })
  },
  {
    label: 'idle-pending without a scheduled start',
    state: buildV9QueueState({ pendingCount: 1, queueLifecycle: 'idle-pending' })
  },
  {
    label: 'carries a migration notice',
    state: buildV9QueueState({ pendingCount: 1, migrationNotice: 'pending' })
  },
  { label: 'at the pending cap boundary', state: buildV9QueueState({ pendingCount: 100 }) }
];

describe('migrateV9ToV10 — shape', () => {
  it('lifts a single QueueState into a one-entry map keyed by the default id', () => {
    const v9 = buildV9QueueState({ pendingCount: 2 });
    const result = migrateV9ToV10(v9, NOW);

    expect(result.migrated).toBe(true);
    expect(Object.keys(result.queueStates)).toEqual([DEFAULT_QUEUE_ID]);
    expect(result.queueStates[DEFAULT_QUEUE_ID].requests).toHaveLength(2);
  });

  it('fabricates no pre-030 queue', () => {
    // The v6 collapse coalesced the queues that existed then and did not
    // record which Task came from which lane. Guessing one back would invent
    // an operator's structure; exactly one entry is the only honest answer.
    const v9 = buildV9QueueState({ pendingCount: 6 });
    const result = migrateV9ToV10(v9, NOW);

    expect(Object.keys(result.queueStates)).toHaveLength(1);
  });

  it('treats a missing record as nothing to migrate rather than as an empty queue', () => {
    for (const absent of [null, undefined]) {
      const result = migrateV9ToV10(absent, NOW);
      expect(result.migrated).toBe(false);
      expect(result.queueStates).toEqual({});
      expect(result.auditEvents).toEqual([]);
    }
  });

  it('is idempotent on a record already in the v10 map shape', () => {
    const already: QueueStateMap = {
      [DEFAULT_QUEUE_ID]: buildV9QueueState({ pendingCount: 1 }),
      [fixtureQueueId(2)]: buildV9QueueState({ pendingCount: 4 })
    };
    const result = migrateV9ToV10(already, NOW);

    expect(result.migrated).toBe(false);
    expect(result.auditEvents).toEqual([]);
    expect(result.queueStates).toEqual(already);
  });

  it('refuses an unrecognised record rather than guessing at its shape', () => {
    for (const junk of [42, 'queue', true, [], { requests: 'not-an-array' }]) {
      const result = migrateV9ToV10(junk, NOW);
      expect(result.migrated).toBe(false);
      expect(result.queueStates).toEqual({});
    }
  });
});

describe('migrateV9ToV10 — preservation', () => {
  it.each(CORPUS)('carries every pending Task verbatim: $label', ({ state }) => {
    const before = JSON.parse(JSON.stringify(state.requests));
    const result = migrateV9ToV10(state, NOW);
    const after = result.queueStates[DEFAULT_QUEUE_ID].requests;

    expect(after).toEqual(before);
  });

  it.each(CORPUS)('preserves the in-flight pointer: $label', ({ state }) => {
    const result = migrateV9ToV10(state, NOW);
    expect(result.queueStates[DEFAULT_QUEUE_ID].inFlightId).toBe(state.inFlightId);
  });

  it.each(CORPUS)('preserves the pause pair: $label', ({ state }) => {
    const lifted = migrateV9ToV10(state, NOW).queueStates[DEFAULT_QUEUE_ID];
    expect(lifted.paused).toBe(state.paused);
    expect(lifted.pausedReason).toBe(state.pausedReason);
  });

  it('does not renumber, reorder or re-time the tasks it carries', () => {
    const requests = [
      buildPendingTask({ id: 'gamma', position: 0, description: 'third by name' }),
      buildPendingTask({ id: 'alpha', position: 1, description: 'first by name' }),
      buildPendingTask({ id: 'beta', position: 2, description: 'second by name' })
    ];
    const v9: QueueState = { ...buildV9QueueState({ pendingCount: 0 }), requests };

    const after = migrateV9ToV10(v9, NOW).queueStates[DEFAULT_QUEUE_ID].requests;
    expect(after.map((r) => r.id)).toEqual(['gamma', 'alpha', 'beta']);
    expect(after.map((r) => r.position)).toEqual([0, 1, 2]);
    expect(after.map((r) => r.enqueuedAt)).toEqual([FIXTURE_NOW, FIXTURE_NOW, FIXTURE_NOW]);
  });
});

describe('migrateV9ToV10 — the lockstep, asserted per entry', () => {
  it('keeps a scheduled start that is paired with idle-pending', () => {
    const v9 = buildV9QueueState({
      pendingCount: 1,
      queueLifecycle: 'idle-pending',
      scheduledStartAt: NOW + 30_000,
      scheduledStartSource: 'operator-chooser'
    });
    const lifted = migrateV9ToV10(v9, NOW).queueStates[DEFAULT_QUEUE_ID];

    expect(lifted.queueLifecycle).toBe('idle-pending');
    expect(lifted.scheduledStartAt).toBe(NOW + 30_000);
    expect(lifted.scheduledStartSource).toBe('operator-chooser');
  });

  it('clears a one-sided scheduled start rather than persisting the pair broken', () => {
    // `CLAUDE.md`: never persist `scheduledStartAt` without
    // `queueLifecycle === 'idle-pending'`. The record below is exactly that
    // one-sided pair, and a migration is the last place it can be repaired
    // before it becomes the new persisted truth.
    const v9 = buildV9QueueState({
      pendingCount: 1,
      queueLifecycle: 'active-empty',
      scheduledStartAt: NOW + 30_000,
      scheduledStartSource: 'operator-chooser'
    });
    const lifted = migrateV9ToV10(v9, NOW).queueStates[DEFAULT_QUEUE_ID];

    expect(lifted.scheduledStartAt).toBeNull();
    expect(lifted.scheduledStartSource).toBeNull();
  });

  it('accepts idle-pending with no scheduled start — the implication is one-way', () => {
    const v9 = buildV9QueueState({ pendingCount: 2, queueLifecycle: 'idle-pending' });
    const lifted = migrateV9ToV10(v9, NOW).queueStates[DEFAULT_QUEUE_ID];

    expect(lifted.queueLifecycle).toBe('idle-pending');
    expect(lifted.scheduledStartAt).toBeNull();
  });

  it('applies the lockstep to every entry of an already-plural record', () => {
    const broken: QueueStateMap = {
      [DEFAULT_QUEUE_ID]: buildV9QueueState({
        pendingCount: 1,
        queueLifecycle: 'idle-pending',
        scheduledStartAt: NOW + 1000,
        scheduledStartSource: 'operator-chooser'
      }),
      [fixtureQueueId(2)]: buildV9QueueState({
        pendingCount: 1,
        queueLifecycle: 'running',
        scheduledStartAt: NOW + 2000,
        scheduledStartSource: 'operator-chooser'
      })
    };
    // A plural record is not re-migrated, but it must still be *checked*: the
    // per-entry assertion is what makes this a per-queue invariant rather than
    // a property of whichever entry happens to be first.
    for (const [queueId, state] of Object.entries(migrateV9ToV10(broken, NOW).queueStates)) {
      if (state.queueLifecycle !== 'idle-pending') {
        expect(state.scheduledStartAt, `queue ${queueId}`).toBeNull();
      }
    }
  });
});

describe('migrateV9ToV10 — the audit event', () => {
  it('emits one event naming the queue identifier and nothing else', () => {
    const v9 = buildV9QueueState({ pendingCount: 4, inFlightRunId: 'run-9' });
    const [event, ...rest] = migrateV9ToV10(v9, NOW).auditEvents;

    expect(rest).toHaveLength(0);
    expect(event.type).toBe('state-migrated-v9-to-v10');
    expect(event.fromVersion).toBe(9);
    expect(event.toVersion).toBe(STATE_SCHEMA_VERSION_V10);
    expect(event.occurredAt).toBe(NOW);
    expect(event.queueIds).toEqual([DEFAULT_QUEUE_ID]);
    expect(event.pendingTaskCount).toBe(4);
    expect(event.inFlightTaskCount).toBe(1);
  });

  it('carries no operator-authored text — FR-038a is a payload shape rule', () => {
    // Queue *names* are operator-authored. An audit payload that carried one
    // would put arbitrary operator text into the structured log, which the
    // audit-payload rule in `CLAUDE.md` forbids for the schedule family and
    // which this migration has no reason to be an exception to.
    const v9 = buildV9QueueState({ pendingCount: 1 });
    const [event] = migrateV9ToV10(v9, NOW).auditEvents;
    const serialised = JSON.stringify(event);

    expect(serialised).not.toMatch(/name/i);
    expect(serialised).not.toMatch(/Default queue/);
    expect(serialised).not.toMatch(/description/i);
    expect(serialised).not.toMatch(/Pending task/);
  });

  it('emits nothing when there was nothing to migrate', () => {
    expect(migrateV9ToV10(null, NOW).auditEvents).toEqual([]);
    expect(migrateV9ToV10({ [DEFAULT_QUEUE_ID]: buildV9QueueState() }, NOW).auditEvents).toEqual([]);
  });
});

// Feature 093 (T014, defect D3) — the ceiling is the runtime constant, not a
// version literal. These expectations used to name `10` because the guard named
// `STATE_SCHEMA_VERSION_V10`, and a guard pinned to a past version starts
// refusing workspaces the runtime writes itself at the next bump. Expressing
// both sides in terms of `STATE_SCHEMA_VERSION` means the next bump moves them
// together, and a future rung that forgets to fails here rather than in the
// field.
describe('assertPersistedVersionSupported — forward-only', () => {
  it('refuses a persisted version above the runtime rather than discarding queues', () => {
    expect(() => assertPersistedVersionSupported(STATE_SCHEMA_VERSION + 1)).toThrowError(/exceeds/i);
    expect(() => assertPersistedVersionSupported(99)).toThrowError(/exceeds/i);
  });

  it('accepts every version at or below the runtime, and a workspace with none', () => {
    for (const version of [undefined, 1, 6, 7, 9, STATE_SCHEMA_VERSION_V10, STATE_SCHEMA_VERSION]) {
      expect(() => assertPersistedVersionSupported(version)).not.toThrow();
    }
  });
});
