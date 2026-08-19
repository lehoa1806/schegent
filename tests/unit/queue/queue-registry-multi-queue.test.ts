// Feature 092 (T007) — the v10 multi-queue registry invariants.
//
// This file replaces `queue-registry-single-queue.test.ts`, which pinned the
// feature-030 collapse. Three of that file's assertions are deliberately
// inverted here, and one is deliberately *kept*:
//
//   inverted — a multi-entry registry validates instead of raising
//              `expected-single-entry`
//   inverted — `'default'` may sit at any position, not only index 0
//   inverted — a non-default entry may carry a schedule
//   kept     — a registry with no `'default'` entry anywhere is still refused
//
// The last one is the load-bearing case. Feature 030 got the reserved queue's
// existence for free from the positional check; removing that check without
// replacing it with a membership check would let a reorder or a delete quietly
// remove the queue every un-addressed enqueue falls back to.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_QUEUE_ID,
  MAX_QUEUES,
  QueueRegistryViolation,
  makeDefaultRegistry,
  projectQueueRegistry,
  validateQueueRegistry,
  type QueueRegistry,
  type QueueRegistryEntry,
  type QueueSchedule
} from '../../../src/queue/queue-registry';
import {
  FIXTURE_NOW,
  buildQueueRegistry,
  fixtureQueueId
} from '../../fixtures/state/queue-fixtures';

const NOW = FIXTURE_NOW;

function entry(overrides: Partial<QueueRegistryEntry> = {}): QueueRegistryEntry {
  return {
    id: DEFAULT_QUEUE_ID,
    name: 'Default queue',
    position: 0,
    schedule: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function registryOf(entries: QueueRegistryEntry[]): QueueRegistry {
  return { entries, updatedAt: NOW };
}

function violationCode(registry: QueueRegistry): string | null {
  try {
    validateQueueRegistry(registry);
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(QueueRegistryViolation);
    return (err as QueueRegistryViolation).code;
  }
}

const SCHEDULE: QueueSchedule = {
  kind: 'relative',
  expression: 'in 5m',
  targetAt: new Date(NOW + 5 * 60_000).toISOString(),
  setAt: new Date(NOW).toISOString(),
  recurrence: 'one-shot'
};

describe('queue-registry — feature 092 multi-queue v10 invariants', () => {
  it('MAX_QUEUES is 20', () => {
    expect(MAX_QUEUES).toBe(20);
  });

  it('still accepts the canonical single-entry shape', () => {
    expect(() => validateQueueRegistry(makeDefaultRegistry(NOW))).not.toThrow();
  });

  it('accepts every entry count from 1 to MAX_QUEUES', () => {
    for (let count = 1; count <= MAX_QUEUES; count += 1) {
      const registry = buildQueueRegistry({ count });
      expect(() => validateQueueRegistry(registry)).not.toThrow();
    }
  });

  it('refuses MAX_QUEUES + 1 entries with queue-cap-reached', () => {
    const registry = buildQueueRegistry({ count: MAX_QUEUES });
    const overflow = registryOf([
      ...registry.entries,
      entry({
        id: fixtureQueueId(MAX_QUEUES + 1),
        name: 'One too many',
        position: MAX_QUEUES
      })
    ]);
    expect(violationCode(overflow)).toBe('queue-cap-reached');
  });

  it('accepts the reserved default entry at a non-zero position', () => {
    // Feature 030 asserted `entries[0].id === 'default'`. A registry the
    // operator has reordered puts it elsewhere, and that must validate.
    const registry = buildQueueRegistry({ count: 3, defaultAtPosition: 2 });
    expect(registry.entries[2].id).toBe(DEFAULT_QUEUE_ID);
    expect(() => validateQueueRegistry(registry)).not.toThrow();
  });

  it('refuses a registry with no default entry anywhere', () => {
    // The membership check that replaces the positional one. Without it,
    // removing `entries[0].id === 'default'` would silently permit this.
    const registry = registryOf([
      entry({ id: fixtureQueueId(1), name: 'Alpha', position: 0 }),
      entry({ id: fixtureQueueId(2), name: 'Beta', position: 1 })
    ]);
    expect(violationCode(registry)).toBe('invalid-registry-state');
  });

  it('refuses an empty registry', () => {
    expect(violationCode(registryOf([]))).toBe('invalid-registry-state');
  });

  it('accepts a schedule on a non-default entry', () => {
    const registry = buildQueueRegistry({ count: 2, schedule: SCHEDULE });
    expect(registry.entries.some((e) => e.schedule !== null)).toBe(true);
    expect(() => validateQueueRegistry(registry)).not.toThrow();
  });

  it('accepts a schedule on the default entry too', () => {
    // FR-018: every entry may carry a schedule. The v6 rule singled out
    // `entries[0]`, which after the reorder above is not a meaningful subject.
    const base = buildQueueRegistry({ count: 2, defaultAtPosition: 0 });
    const withSchedule = registryOf([
      { ...base.entries[0], schedule: SCHEDULE },
      ...base.entries.slice(1)
    ]);
    expect(() => validateQueueRegistry(withSchedule)).not.toThrow();
  });

  it('no longer raises expected-single-entry for any input', () => {
    const registry = buildQueueRegistry({ count: 4 });
    expect(violationCode(registry)).toBeNull();
  });
});

describe('queue-registry — feature 092, content rules unchanged under N entries', () => {
  it('refuses a non-UUIDv4, non-default id', () => {
    const registry = registryOf([
      entry(),
      entry({ id: 'queue-2', name: 'Slug id', position: 1 })
    ]);
    expect(violationCode(registry)).toBe('invalid-queue-id');
  });

  it('refuses duplicate names across entries, case- and trim-insensitively', () => {
    const registry = registryOf([
      entry({ name: 'Release lane' }),
      entry({ id: fixtureQueueId(2), name: '  release LANE  ', position: 1 })
    ]);
    expect(violationCode(registry)).toBe('duplicate-queue-name');
  });

  it('refuses a name that is empty after trim', () => {
    const registry = registryOf([
      entry(),
      entry({ id: fixtureQueueId(2), name: '   ', position: 1 })
    ]);
    expect(violationCode(registry)).toBe('invalid-queue-name');
  });

  it('refuses a name longer than the 64-character bound', () => {
    const registry = registryOf([
      entry(),
      entry({ id: fixtureQueueId(2), name: 'x'.repeat(65), position: 1 })
    ]);
    expect(violationCode(registry)).toBe('invalid-queue-name');
  });

  it('refuses non-contiguous positions', () => {
    const registry = registryOf([
      entry({ position: 0 }),
      entry({ id: fixtureQueueId(2), name: 'Gap', position: 2 })
    ]);
    expect(violationCode(registry)).toBe('invalid-registry-state');
  });

  it('refuses duplicate ids', () => {
    const registry = registryOf([
      entry(),
      entry({ id: DEFAULT_QUEUE_ID, name: 'Twin', position: 1 })
    ]);
    expect(violationCode(registry)).not.toBeNull();
  });

  // FR-R3-011 — the two tests that stood here asserted `validateQueueRegistry`
  // rejects an entry whose `state` and `pauseSource` disagree. The validator no
  // longer makes that check because the record no longer holds either field;
  // the pairing moved to `projectQueueRegistry`, where it is established rather
  // than checked. The multi-entry half of what they protected — "on every
  // entry, not just the first" — is what the two tests below carry forward.

  it('projects the pause pairing on every entry, not just the first', () => {
    const registry = registryOf([
      entry(),
      entry({ id: fixtureQueueId(2), name: 'Paused lane', position: 1 }),
      entry({ id: fixtureQueueId(3), name: 'Active lane', position: 2 })
    ]);
    const projected = projectQueueRegistry(
      registry,
      new Map([
        [DEFAULT_QUEUE_ID, { paused: false, pauseSource: null }],
        [fixtureQueueId(2), { paused: true, pauseSource: 'operator' as const }],
        [fixtureQueueId(3), { paused: false, pauseSource: null }]
      ])
    );

    expect(projected.entries.map((e) => [e.state, e.pauseSource])).toEqual([
      ['active', null],
      ['manually-paused', 'operator'],
      ['active', null]
    ]);
    for (const projectedEntry of projected.entries) {
      expect(projectedEntry.pauseSource === null).toBe(projectedEntry.state !== 'manually-paused');
    }
  });

  it('cannot project either half of the disagreement the validator used to refuse', () => {
    // The two rejected shapes were `manually-paused` with a null source and
    // `active` with a non-null one. Neither is reachable now: the state is read
    // off `paused`, and the source is forced to null on the same branch that
    // makes the state 'active'. Feeding the projection the inputs that produced
    // them shows what it does instead of throwing.
    const registry = registryOf([
      entry(),
      entry({ id: fixtureQueueId(2), name: 'Second lane', position: 1 })
    ]);

    // Paused with no recorded source — defaulted to 'operator' rather than left
    // null, which is the feature-028 rule the collapse kept.
    const pausedWithoutSource = projectQueueRegistry(
      registry,
      new Map([[fixtureQueueId(2), { paused: true, pauseSource: null }]])
    );
    expect(pausedWithoutSource.entries[1]).toMatchObject({
      state: 'manually-paused',
      pauseSource: 'operator'
    });

    // Not paused but carrying a stale source — the source is dropped, so the
    // pair cannot disagree.
    const activeWithSource = projectQueueRegistry(
      registry,
      new Map([[fixtureQueueId(2), { paused: false, pauseSource: 'cascade' as const }]])
    );
    expect(activeWithSource.entries[1]).toMatchObject({ state: 'active', pauseSource: null });
  });
});
