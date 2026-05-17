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
// Feature 030 (US3, T046) — `UUID_B` previously seeded the second
// queue entry for duplicate-name tests. With MAX_QUEUES=1 those tests
// are unreachable and have been removed; only the cap-1 violation pins
// survive.

describe('queue-registry (017, T008)', () => {
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
    // Feature 030 (US3, T046) — single-queue migration set MAX_QUEUES=1.
    // The `createQueue` export survives for forward compatibility but
    // every call against a fresh default registry now fails with
    // `queue-cap-reached`. The legacy tests that exercised an actual
    // append + duplicate-name detection on a second entry are replaced
    // with cap-violation pins; the validation order (name → id → cap →
    // duplicate-name) is preserved by `createQueue` so the two
    // pre-cap rejection paths (default id, invalid name) still fire
    // their dedicated violations before the cap check.

    it('rejects every append against a default registry (cap=1)', () => {
      const r0 = makeDefaultRegistry(NOW);
      expect(() => createQueue(r0, { id: UUID_A, name: 'Critical', now: NOW + 1 })).toThrowError(
        /cap/
      );
    });

    it('rejects the reserved default id', () => {
      const r0 = makeDefaultRegistry(NOW);
      // Default-id check fires before cap check.
      expect(() => createQueue(r0, { id: DEFAULT_QUEUE_ID, name: 'X', now: NOW + 1 })).toThrowError(
        QueueRegistryViolation
      );
    });

    it('rejects past the cap', () => {
      // The default registry is already at MAX_QUEUES (1); any
      // additional create immediately violates the cap.
      const r = makeDefaultRegistry(NOW);
      expect(r.entries).toHaveLength(MAX_QUEUES);
      expect(() => createQueue(r, { id: UUID_A, name: 'OneMore', now: NOW + 99 })).toThrowError(
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

    // Feature 030 (US3, T046) — the legacy "rejects duplicate-name
    // target" test relied on calling `createQueue` to produce a second
    // entry that would collide with `default queue` on rename. With
    // MAX_QUEUES=1 we can never get two entries to clash; the
    // duplicate-name guard in renameQueue is structurally unreachable
    // on a single-entry registry. The check itself is still in the
    // source for forward compat (kept intentionally — see
    // queue-registry.ts) but its run-time exercise is dropped.
  });

  describe('deleteQueue', () => {
    it('refuses to delete the default queue', () => {
      const r0 = makeDefaultRegistry(NOW);
      expect(() => deleteQueue(r0, { id: DEFAULT_QUEUE_ID, now: NOW + 1 })).toThrowError(
        /cannot be deleted/
      );
    });

    // Feature 030 (US3, T046) — the legacy "removes a non-default
    // queue" path required first creating a second entry via
    // `createQueue`, which is now blocked by the cap-1 rule. With
    // MAX_QUEUES=1 the only entry that ever exists is the default,
    // and the default cannot be deleted (covered above). The unknown-id
    // rejection still pins the entry-lookup branch below.

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
