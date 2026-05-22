// Feature 063 — T010 — contract test for the queue-cleared-all audit
// event family. Pins the literal name, the registry membership, and
// the payload shape (FR-007 / FR-018 / SC-001 traceability) so a
// future refactor cannot silently drop the event from the union.
import { describe, expect, it } from 'vitest';
import {
  ALL_AUDIT_EVENT_TYPES,
  KNOWN_AUDIT_EVENT_TYPE_SET,
  QUEUE_FULL_RESET_EVENT_TYPES,
  type QueueClearedAllPayload,
  type QueueFullResetEventType
} from '../../../src/contracts/audit-events';

describe('queue-cleared-all audit event (Feature 063 T009/T010)', () => {
  it('registers queue-cleared-all in QUEUE_FULL_RESET_EVENT_TYPES', () => {
    expect([...QUEUE_FULL_RESET_EVENT_TYPES]).toEqual(['queue-cleared-all']);
  });

  it('exposes queue-cleared-all via ALL_AUDIT_EVENT_TYPES', () => {
    expect(ALL_AUDIT_EVENT_TYPES).toContain('queue-cleared-all');
  });

  it('exposes queue-cleared-all via KNOWN_AUDIT_EVENT_TYPE_SET', () => {
    expect(KNOWN_AUDIT_EVENT_TYPE_SET.has('queue-cleared-all')).toBe(true);
  });

  it('QueueFullResetEventType narrows to a single literal', () => {
    const value: QueueFullResetEventType = 'queue-cleared-all';
    expect(value).toBe('queue-cleared-all');
  });

  it('QueueClearedAllPayload accepts the five contractual fields (acked case)', () => {
    const payload: QueueClearedAllPayload = {
      removedPending: 3,
      removedInFlight: 1,
      pauseStateCleared: true,
      runnerState: 'acked',
      watchdogBackoffCleared: false
    };
    expect(Object.keys(payload).sort()).toEqual([
      'pauseStateCleared',
      'removedInFlight',
      'removedPending',
      'runnerState',
      'watchdogBackoffCleared'
    ]);
  });

  it('QueueClearedAllPayload accepts the timed-out runner state (FR-007)', () => {
    const payload: QueueClearedAllPayload = {
      removedPending: 0,
      removedInFlight: 1,
      pauseStateCleared: false,
      runnerState: 'timed-out',
      watchdogBackoffCleared: false
    };
    expect(payload.runnerState).toBe('timed-out');
  });

  it('QueueClearedAllPayload accepts the no-active-run case', () => {
    const payload: QueueClearedAllPayload = {
      removedPending: 5,
      removedInFlight: 0,
      pauseStateCleared: false,
      runnerState: 'no-active-run',
      watchdogBackoffCleared: false
    };
    expect(payload.runnerState).toBe('no-active-run');
  });
});
