// Feature 187 (T001, US1/US2) — FR-001..FR-004, FR-008.
//
// The registry is the whole of what a failed admission leaves behind, and it is
// deliberately in memory only: the drain re-attempts on the next trigger, so a
// persisted report would outlive the attempt it describes.
//
// What these cases pin is the difference between a *report* and a *history*.
// One entry per queue, latest wins, cleared by a success — because the question
// the surface asks is "did the last attempt fail", not "how many have".
//
// Feature 195 (T014, FR-001, FR-002, FR-007) — widened to a discriminated
// union. The `kind: 'admission'` cases above are unchanged in substance, only
// in shape; the `kind: 'halted'` cases at the bottom are new.

import { describe, expect, it } from 'vitest';
import { QueueStartFailureRegistry } from '../../../src/services/queue-start-failure-registry';

describe('QueueStartFailureRegistry', () => {
  it('records a failure and reads it back against the queue that attempted it', () => {
    const registry = new QueueStartFailureRegistry(() => 1_000);

    registry.recordFailure('q1', { kind: 'admission', admission: 'admitNew', message: 'spawn failed' });

    expect(registry.get('q1')).toEqual({
      kind: 'admission',
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

    registry.recordFailure('q1', { kind: 'admission', admission: 'admitResume', message: 'journal unreadable' });
    now = 2_000;
    registry.recordFailure('q1', { kind: 'admission', admission: 'admitNew', message: 'spawn failed' });

    // The later attempt is what the operator needs, and the log already has the
    // sequence (FR-011). A list here would be a second, worse log.
    expect(registry.get('q1')).toEqual({
      kind: 'admission',
      admission: 'admitNew',
      at: 2_000,
      message: 'spawn failed'
    });
  });

  it('clears the report a later success supersedes', () => {
    const registry = new QueueStartFailureRegistry(() => 1_000);
    registry.recordFailure('q1', { kind: 'admission', admission: 'admitNew', message: 'spawn failed' });

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

    registry.recordFailure('q1', { kind: 'admission', admission: 'admitNew', message: 'spawn failed' });

    expect(registry.get('q2')).toBeNull();

    registry.recordFailure('q2', { kind: 'admission', admission: 'admitResume', message: 'journal unreadable' });
    registry.clear('q1');

    expect(registry.get('q1')).toBeNull();
    const q2 = registry.get('q2');
    expect(q2?.kind === 'admission' && q2.admission).toBe('admitResume');
  });

  it('stamps the time from the injected clock, not from the caller', () => {
    // The registry owns the timestamp so the coordinator does not have to own a
    // clock: it reports *what* happened, and the record says *when*. Asserted
    // with a clock that could not be `Date.now()`.
    const registry = new QueueStartFailureRegistry(() => 42);

    registry.recordFailure('q1', { kind: 'admission', admission: 'admitNew', message: 'spawn failed' });

    expect(registry.get('q1')?.at).toBe(42);
  });

  it('hands out a frozen record, so a reader cannot rewrite the report it read', () => {
    const registry = new QueueStartFailureRegistry(() => 1_000);
    registry.recordFailure('q1', { kind: 'admission', admission: 'admitNew', message: 'spawn failed' });

    const record = registry.get('q1');

    expect(Object.isFrozen(record)).toBe(true);
  });

  describe('the halted kind (feature 195, T014)', () => {
    it('records a halted report and reads it back', () => {
      const registry = new QueueStartFailureRegistry(() => 1_000);

      registry.recordFailure('q1', { kind: 'halted', taskId: 't1', taskName: 'ingest data' });

      expect(registry.get('q1')).toEqual({
        kind: 'halted',
        taskId: 't1',
        taskName: 'ingest data',
        at: 1_000
      });
    });

    it('replaces an admission report with a halted one on the same queue, and vice versa', () => {
      const registry = new QueueStartFailureRegistry(() => 1_000);

      registry.recordFailure('q1', { kind: 'admission', admission: 'admitNew', message: 'spawn failed' });
      registry.recordFailure('q1', { kind: 'halted', taskId: 't1', taskName: 'ingest data' });
      expect(registry.get('q1')?.kind).toBe('halted');

      registry.recordFailure('q1', { kind: 'admission', admission: 'admitNew', message: 'spawn failed' });
      expect(registry.get('q1')?.kind).toBe('admission');
    });

    it('clears a halted report the same as an admission one', () => {
      const registry = new QueueStartFailureRegistry(() => 1_000);
      registry.recordFailure('q1', { kind: 'halted', taskId: 't1', taskName: 'ingest data' });

      registry.clear('q1');

      expect(registry.get('q1')).toBeNull();
    });
  });
});
