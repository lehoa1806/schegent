import { describe, it, expect } from 'vitest';
import { migrateLegacyQueueState } from '../../../src/state/queue-state-migrator';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';

const NOW = 1_700_000_000_000;

describe('migrateLegacyQueueState (017, T009)', () => {
  it('returns a fresh default registry for null input', () => {
    const r = migrateLegacyQueueState(null, NOW);
    expect(r.defaultQueueId).toBe(DEFAULT_QUEUE_ID);
    expect(r.registry.entries).toHaveLength(1);
    expect(r.registry.entries[0].id).toBe(DEFAULT_QUEUE_ID);
    expect(r.queueState.requests).toEqual([]);
  });

  it('returns a fresh default registry for undefined input', () => {
    const r = migrateLegacyQueueState(undefined, NOW);
    expect(r.registry.entries).toHaveLength(1);
  });

  it('preserves legacy queue contents on lift', () => {
    const legacy = {
      requests: [
        { id: 'feat-1', description: 'x' },
        { id: 'feat-2', description: 'y', position: 99 }
      ],
      inFlightId: null,
      paused: true,
      pausedReason: 'manual',
      updatedAt: NOW - 100
    };
    const r = migrateLegacyQueueState(legacy, NOW);
    expect(r.queueState.requests).toHaveLength(2);
    expect(r.queueState.requests.map((request) => request.queueId)).toEqual([
      DEFAULT_QUEUE_ID,
      DEFAULT_QUEUE_ID
    ]);
    expect(r.queueState.requests.map((request) => request.position)).toEqual([0, 1]);
    expect(r.queueState.requests.map((request) => request.pauseCause)).toEqual([null, null]);
    expect(r.queueState.paused).toBe(true);
    expect(r.queueState.pausedReason).toBe('manual');
    expect(r.queueState.updatedAt).toBe(NOW - 100);
    expect(r.registry.entries[0].id).toBe(DEFAULT_QUEUE_ID);
    expect(r.registry.entries[0].state).toBe('manually-paused');
    expect(r.auditEvents).toContainEqual({
      type: 'queue-state-migrated',
      taskCount: 2,
      fromSchemaVersion: 2,
      toSchemaVersion: 3
    });
  });

  it('coerces non-object legacy state to a fresh default', () => {
    const r = migrateLegacyQueueState('garbage' as unknown, NOW);
    expect(r.queueState.requests).toEqual([]);
    expect(r.registry.entries[0].id).toBe(DEFAULT_QUEUE_ID);
    expect(r.quarantine).toBe('garbage');
    expect(r.auditEvents[0]).toMatchObject({ type: 'state-migration-failed' });
  });

  it('defaults missing scalar fields safely', () => {
    const r = migrateLegacyQueueState({ requests: [] }, NOW);
    expect(r.queueState.paused).toBe(false);
    expect(r.queueState.pausedReason).toBeNull();
    expect(r.queueState.inFlightId).toBeNull();
    expect(r.queueState.updatedAt).toBe(NOW);
  });

  it('quarantines corrupt task records while preserving valid siblings', () => {
    const r = migrateLegacyQueueState(
      {
        requests: [
          { id: 'feat-1', description: 'valid', status: 'pending', position: 0, runId: null },
          { id: 'bad' }
        ],
        inFlightId: 'missing'
      },
      NOW
    );

    expect(r.queueState.requests.map((request) => request.id)).toEqual(['feat-1']);
    expect(r.queueState.inFlightId).toBeNull();
    expect(r.quarantine).toEqual([{ id: 'bad' }]);
    expect(r.auditEvents[0]).toMatchObject({ type: 'state-migration-failed' });
  });
});
