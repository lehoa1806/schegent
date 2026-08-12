import { describe, it, expect } from 'vitest';
import {
  DEFAULT_QUEUE_ID,
  MAX_QUEUES,
  MAX_QUEUE_NAME_LENGTH,
  QueueRegistryViolation,
  createQueue,
  deleteQueue,
  findQueue,
  isValidQueueId,
  isValidQueueName,
  makeDefaultRegistry,
  renameQueue,
  setQueuePaused,
  setQueueState,
  setQueueSchedule,
  validateQueueRegistry
} from '../../../src/queue/queue-registry';

const NOW = 1_700_000_000_000;
const UUID_A = '11111111-2222-4333-8444-555555555555';
// Feature 092 (T033a) — `UUID_B` seeds the second entry again. Feature 030
// removed the duplicate-name tests below because `MAX_QUEUES = 1` made a
// second entry unconstructible, not because the rule stopped applying; with
// the cap back at 20 they are reachable and restored.
const UUID_B = '22222222-3333-4444-8555-666666666666';

/** Deterministic UUIDv4-shaped ids for the cap test. */
function uuidN(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

const SCHEDULE = {
  kind: 'relative' as const,
  expression: 'in 5m',
  setAt: new Date(NOW).toISOString(),
  targetAt: new Date(NOW + 5 * 60_000).toISOString(),
  recurrence: 'one-shot' as const
};

describe('queue-registry (017 T008; multi-queue restored by 092 T008/T009/T033a)', () => {
  describe('makeDefaultRegistry', () => {
    it('returns a registry with a single default entry', () => {
      const r = makeDefaultRegistry(NOW);
      expect(r.entries).toHaveLength(1);
      expect(r.entries[0].id).toBe(DEFAULT_QUEUE_ID);
      expect(r.entries[0].name).toBe('Default queue');
      expect(r.entries[0].position).toBe(0);
      expect(r.entries[0].state).toBe('active');
      expect(r.entries[0].schedule).toBeNull();
    });
  });

  describe('isValidQueueId', () => {
    it('accepts the reserved default id', () => {
      expect(isValidQueueId(DEFAULT_QUEUE_ID)).toBe(true);
    });
    it('accepts a UUIDv4', () => {
      expect(isValidQueueId(UUID_A)).toBe(true);
    });
    it('rejects empty or malformed strings', () => {
      expect(isValidQueueId('')).toBe(false);
      expect(isValidQueueId('not-a-uuid')).toBe(false);
      expect(isValidQueueId('11111111-2222-3333-4444-555555555555')).toBe(false);
    });
  });

  describe('isValidQueueName', () => {
    it('rejects empty/whitespace-only names', () => {
      expect(isValidQueueName('')).toBe(false);
      expect(isValidQueueName('   ')).toBe(false);
    });
    it('accepts 1-char and max-length names', () => {
      expect(isValidQueueName('a')).toBe(true);
      expect(isValidQueueName('x'.repeat(MAX_QUEUE_NAME_LENGTH))).toBe(true);
    });
    it('rejects names beyond max length', () => {
      expect(isValidQueueName('x'.repeat(MAX_QUEUE_NAME_LENGTH + 1))).toBe(false);
    });
  });

  describe('createQueue', () => {
    // Feature 092 (T008, T033a) — the append path is live again. The
    // validation order (name -> id -> cap -> duplicate-name) is unchanged
    // from feature 017; what changed is that the cap no longer swallows
    // every call before the duplicate-name check can be reached.

    it('appends a second entry at the next position', () => {
      const r0 = makeDefaultRegistry(NOW);
      const r1 = createQueue(r0, { id: UUID_A, name: 'Critical', now: NOW + 1 });
      expect(r1.entries).toHaveLength(2);
      expect(r1.entries[1]).toMatchObject({
        id: UUID_A,
        name: 'Critical',
        position: 1,
        state: 'active',
        pauseSource: null,
        schedule: null
      });
      expect(() => validateQueueRegistry(r1)).not.toThrow();
    });

    it('trims the supplied name', () => {
      const r1 = createQueue(makeDefaultRegistry(NOW), {
        id: UUID_A,
        name: '  Critical  ',
        now: NOW + 1
      });
      expect(findQueue(r1, UUID_A)?.name).toBe('Critical');
    });

    it('rejects a duplicate name case- and trim-insensitively', () => {
      const r1 = createQueue(makeDefaultRegistry(NOW), {
        id: UUID_A,
        name: 'Critical',
        now: NOW + 1
      });
      expect(() =>
        createQueue(r1, { id: UUID_B, name: '  cRiTiCaL ', now: NOW + 2 })
      ).toThrowError(/already in use/);
    });

    it('rejects the reserved default id', () => {
      const r0 = makeDefaultRegistry(NOW);
      expect(() => createQueue(r0, { id: DEFAULT_QUEUE_ID, name: 'X', now: NOW + 1 })).toThrowError(
        QueueRegistryViolation
      );
    });

    it('rejects past the cap', () => {
      let r = makeDefaultRegistry(NOW);
      for (let i = 1; i < MAX_QUEUES; i += 1) {
        r = createQueue(r, { id: uuidN(i), name: `Queue ${i}`, now: NOW + i });
      }
      expect(r.entries).toHaveLength(MAX_QUEUES);
      expect(() => createQueue(r, { id: uuidN(99), name: 'OneMore', now: NOW + 99 })).toThrowError(
        /cap/
      );
    });
  });

  describe('renameQueue', () => {
    it('renames an entry and bumps updatedAt', () => {
      const r0 = makeDefaultRegistry(NOW);
      const r1 = renameQueue(r0, { id: DEFAULT_QUEUE_ID, name: 'Primary', now: NOW + 5 });
      expect(findQueue(r1, DEFAULT_QUEUE_ID)?.name).toBe('Primary');
      expect(findQueue(r1, DEFAULT_QUEUE_ID)?.updatedAt).toBe(NOW + 5);
    });

    it('rejects unknown id', () => {
      const r0 = makeDefaultRegistry(NOW);
      expect(() => renameQueue(r0, { id: UUID_A, name: 'X', now: NOW + 1 })).toThrowError(
        /Unknown queue id/
      );
    });

    // Feature 092 (T033a) — restored. Feature 030 dropped this because a
    // one-entry registry has nothing to collide with, so the guard was
    // structurally unreachable rather than wrong.
    it('rejects a rename onto another entry\'s name', () => {
      const r1 = createQueue(makeDefaultRegistry(NOW), {
        id: UUID_A,
        name: 'Critical',
        now: NOW + 1
      });
      expect(() =>
        renameQueue(r1, { id: UUID_A, name: 'default QUEUE', now: NOW + 2 })
      ).toThrowError(/already in use/);
    });

    it('allows an entry to keep its own name', () => {
      const r1 = createQueue(makeDefaultRegistry(NOW), {
        id: UUID_A,
        name: 'Critical',
        now: NOW + 1
      });
      const r2 = renameQueue(r1, { id: UUID_A, name: 'Critical', now: NOW + 2 });
      expect(findQueue(r2, UUID_A)?.name).toBe('Critical');
    });
  });

  describe('deleteQueue', () => {
    it('refuses to delete the default queue', () => {
      const r0 = makeDefaultRegistry(NOW);
      expect(() => deleteQueue(r0, { id: DEFAULT_QUEUE_ID, now: NOW + 1 })).toThrowError(
        /cannot be deleted/
      );
    });

    // Feature 092 (T033a) — restored, together with the position
    // compaction it is the only test of.
    it('removes a non-default queue and compacts positions', () => {
      let r = makeDefaultRegistry(NOW);
      r = createQueue(r, { id: UUID_A, name: 'Critical', now: NOW + 1 });
      r = createQueue(r, { id: UUID_B, name: 'Batch', now: NOW + 2 });
      const after = deleteQueue(r, { id: UUID_A, now: NOW + 3 });
      expect(after.entries.map((e) => e.id)).toEqual([DEFAULT_QUEUE_ID, UUID_B]);
      expect(after.entries.map((e) => e.position)).toEqual([0, 1]);
      expect(() => validateQueueRegistry(after)).not.toThrow();
    });

    it('rejects unknown id', () => {
      const r0 = makeDefaultRegistry(NOW);
      expect(() => deleteQueue(r0, { id: UUID_A, now: NOW + 1 })).toThrowError(/Unknown queue id/);
    });
  });

  describe('setQueuePaused / setQueueState', () => {
    it('transitions between active and manually-paused', () => {
      const r0 = makeDefaultRegistry(NOW);
      const r1 = setQueuePaused(r0, {
        id: DEFAULT_QUEUE_ID,
        paused: true,
        now: NOW + 1
      });
      expect(findQueue(r1, DEFAULT_QUEUE_ID)?.state).toBe('manually-paused');
      const r2 = setQueuePaused(r1, {
        id: DEFAULT_QUEUE_ID,
        paused: false,
        now: NOW + 2
      });
      expect(findQueue(r2, DEFAULT_QUEUE_ID)?.state).toBe('active');
      const r3 = setQueueState(r2, {
        id: DEFAULT_QUEUE_ID,
        state: 'manually-paused',
        now: NOW + 3
      });
      expect(findQueue(r3, DEFAULT_QUEUE_ID)?.state).toBe('manually-paused');
    });
  });

  describe('setQueueSchedule', () => {
    it('attaches and clears schedule', () => {
      const r0 = makeDefaultRegistry(NOW);
      const r1 = setQueueSchedule(r0, {
        id: DEFAULT_QUEUE_ID,
        schedule: {
          kind: 'relative',
          expression: 'in 5m',
          setAt: new Date(NOW).toISOString(),
          targetAt: new Date(NOW + 5 * 60_000).toISOString(),
          recurrence: 'one-shot'
        },
        now: NOW + 1
      });
      expect(findQueue(r1, DEFAULT_QUEUE_ID)?.schedule?.kind).toBe('relative');
      const r2 = setQueueSchedule(r1, { id: DEFAULT_QUEUE_ID, schedule: null, now: NOW + 2 });
      expect(findQueue(r2, DEFAULT_QUEUE_ID)?.schedule).toBeNull();
    });

    // Feature 092 (T009, FR-018) — every entry may carry a schedule. The v6
    // rule asserted `entries[0].schedule === null`, which under a one-entry
    // registry meant "no queue may be scheduled"; under a reordered
    // multi-entry registry `entries[0]` is not even a stable subject.
    it('attaches a schedule to a non-default entry', () => {
      let r = makeDefaultRegistry(NOW);
      r = createQueue(r, { id: UUID_A, name: 'Nightly', now: NOW + 1 });
      r = setQueueSchedule(r, { id: UUID_A, schedule: SCHEDULE, now: NOW + 2 });
      expect(findQueue(r, UUID_A)?.schedule?.expression).toBe('in 5m');
      expect(findQueue(r, DEFAULT_QUEUE_ID)?.schedule).toBeNull();
      expect(() => validateQueueRegistry(r)).not.toThrow();
    });

    it('lets every entry carry a schedule at once', () => {
      let r = makeDefaultRegistry(NOW);
      r = createQueue(r, { id: UUID_A, name: 'Nightly', now: NOW + 1 });
      r = createQueue(r, { id: UUID_B, name: 'Batch', now: NOW + 2 });
      for (const id of [DEFAULT_QUEUE_ID, UUID_A, UUID_B]) {
        r = setQueueSchedule(r, { id, schedule: SCHEDULE, now: NOW + 3 });
      }
      expect(r.entries.every((e) => e.schedule !== null)).toBe(true);
      expect(() => validateQueueRegistry(r)).not.toThrow();
    });
  });

  describe('validateQueueRegistry', () => {
    it('accepts a fresh default registry', () => {
      expect(() => validateQueueRegistry(makeDefaultRegistry(NOW))).not.toThrow();
    });
    it('rejects missing entries array', () => {
      // @ts-expect-error invalid shape on purpose
      expect(() => validateQueueRegistry({ entries: null, updatedAt: NOW })).toThrow();
    });
    it('rejects when default is missing', () => {
      const r = { entries: [], updatedAt: NOW };
      expect(() => validateQueueRegistry(r)).toThrow();
    });
  });
});
