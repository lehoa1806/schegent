// Feature 187 (T001, US1/US2) — FR-001..FR-004, FR-008.
//
// The registry is the whole of what a failed admission leaves behind, and it is
// deliberately in memory only: the drain re-attempts on the next trigger, so a
// persisted report would outlive the attempt it describes.
//
// What these cases pin is the difference between a *report* and a *history*.
// One entry per queue, latest wins, cleared by a success — because the question
// the surface asks is "did the last attempt fail", not "how many have".

import { describe, expect, it } from 'vitest';
import { QueueStartFailureRegistry } from '../../../src/services/queue-start-failure-registry';

describe('QueueStartFailureRegistry', () => {
  it('records a failure and reads it back against the queue that attempted it', () => {
    const registry = new QueueStartFailureRegistry(() => 1_000);

    registry.recordFailure('q1', { admission: 'admitNew', message: 'spawn failed' });

    expect(registry.get('q1')).toEqual({
      admission: 'admitNew',
      at: 1_000,
      message: 'spawn failed'
    });
  });

  it('reads null for a queue that has never failed', () => {
    const registry = new QueueStartFailureRegistry(() => 1_000);

    expect(registry.get('never-drained')).toBeNull();
  });

  it('replaces rather than accumulates when the same queue fails again', () => {
    let now = 1_000;
    const registry = new QueueStartFailureRegistry(() => now);

    registry.recordFailure('q1', { admission: 'admitResume', message: 'journal unreadable' });
    now = 2_000;
    registry.recordFailure('q1', { admission: 'admitNew', message: 'spawn failed' });

    // The later attempt is what the operator needs, and the log already has the
    // sequence (FR-011). A list here would be a second, worse log.
    expect(registry.get('q1')).toEqual({
      admission: 'admitNew',
      at: 2_000,
      message: 'spawn failed'
    });
  });

  it('clears the report a later success supersedes', () => {
    const registry = new QueueStartFailureRegistry(() => 1_000);
    registry.recordFailure('q1', { admission: 'admitNew', message: 'spawn failed' });

    registry.clear('q1');

    expect(registry.get('q1')).toBeNull();
  });

  it('clears a queue that has no report without error', () => {
    const registry = new QueueStartFailureRegistry(() => 1_000);

    expect(() => registry.clear('q1')).not.toThrow();
    expect(registry.get('q1')).toBeNull();
  });

  it('scopes a report to one queue — neither reporting on nor clearing another', () => {
    const registry = new QueueStartFailureRegistry(() => 1_000);

    registry.recordFailure('q1', { admission: 'admitNew', message: 'spawn failed' });

    expect(registry.get('q2')).toBeNull();

    registry.recordFailure('q2', { admission: 'admitResume', message: 'journal unreadable' });
    registry.clear('q1');

    expect(registry.get('q1')).toBeNull();
    expect(registry.get('q2')?.admission).toBe('admitResume');
  });

  it('stamps the time from the injected clock, not from the caller', () => {
    // The registry owns the timestamp so the coordinator does not have to own a
    // clock: it reports *what* happened, and the record says *when*. Asserted
    // with a clock that could not be `Date.now()`.
    const registry = new QueueStartFailureRegistry(() => 42);

    registry.recordFailure('q1', { admission: 'admitNew', message: 'spawn failed' });

    expect(registry.get('q1')?.at).toBe(42);
  });

  it('hands out a frozen record, so a reader cannot rewrite the report it read', () => {
    const registry = new QueueStartFailureRegistry(() => 1_000);
    registry.recordFailure('q1', { admission: 'admitNew', message: 'spawn failed' });

    const record = registry.get('q1');

    expect(Object.isFrozen(record)).toBe(true);
  });
});
