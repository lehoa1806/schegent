// FR-R4-F05 (T13; contract F, F7; data-model §3; FR-016) — `classifyEnqueueFailure`
// turns whatever the enqueue write threw into one of two outcomes, and neither carries
// the exception.
//
// WHY TWO OUTCOMES. A queue write that throws used to be reported as
// `rejected-validation` with the exception's message as the reason, which told the
// operator their request was invalid when the queue state could not be read or saved,
// and put a path into an audit row. A refusal by the queue's own rules
// (`QueueMutationRejected`, a closed set of reasons) is a validation outcome with that
// code. Everything else, and the one rejection that means the ownership fence could not
// be read (`fence-unverifiable`), is a storage fault with one fixed code.

import { describe, expect, it } from 'vitest';
import {
  QUEUE_STATE_UNAVAILABLE,
  classifyEnqueueFailure
} from '../../../src/services/enqueue-failure';
import {
  QueueMutationRejected,
  type QueueMutationRejectReason
} from '../../../src/state/workspace-state';

/**
 * Every member of the reason union. Typed as a total record so that a reason added
 * to the union and not listed here fails the compile, not a reviewer's memory.
 */
const REASONS: Readonly<Record<QueueMutationRejectReason, true>> = {
  'unknown-queue-id': true,
  'position-out-of-range': true,
  'task-cap-reached': true,
  'task-not-found': true,
  'task-not-in-pending-state': true,
  'illegal-source-status': true,
  'in-flight-ownership-conflict': true,
  'phase-not-found': true,
  'phase-already-removed': true,
  'cannot-delete-default-queue': true,
  'invalid-global-concurrency-cap': true,
  'fence-superseded': true,
  'fence-unverifiable': true,
  'fence-wrong-resource': true,
  'ownership-lost': true,
  'stale-run-id': true,
  'run-status-precondition': true
};

const PATH = '/synthetic/home/user-252/secret.txt';

describe('classifyEnqueueFailure (T13)', () => {
  const validationReasons = (Object.keys(REASONS) as QueueMutationRejectReason[]).filter(
    (reason) => reason !== 'fence-unverifiable'
  );

  it('names the fixed storage code', () => {
    expect(QUEUE_STATE_UNAVAILABLE).toBe('queue-state-unavailable');
  });

  it('lists the whole reason union, so the table below is exhaustive', () => {
    expect(Object.keys(REASONS)).toHaveLength(17);
    expect(validationReasons).toHaveLength(16);
  });

  it.each(validationReasons)('classifies QueueMutationRejected(%s) as a validation refusal with that code', (reason) => {
    const outcome = classifyEnqueueFailure(new QueueMutationRejected(reason, `refused at ${PATH}`));

    expect(outcome).toEqual({ outcome: 'rejected-validation', reason });
  });

  it('classifies QueueMutationRejected(fence-unverifiable) as a storage fault', () => {
    const outcome = classifyEnqueueFailure(
      new QueueMutationRejected('fence-unverifiable', `could not read ${PATH}`)
    );

    expect(outcome).toEqual({ outcome: 'failed-storage', reason: 'queue-state-unavailable' });
  });

  it.each([
    ['an Error', new Error(`write failed at ${PATH}`)],
    ['a string', `write failed at ${PATH}`],
    ['null', null],
    ['undefined', undefined],
    ['an object', { code: 'E_SYNTHETIC', path: PATH }]
  ])('classifies %s as a storage fault with the fixed code', (_label, thrown) => {
    expect(classifyEnqueueFailure(thrown)).toEqual({
      outcome: 'failed-storage',
      reason: 'queue-state-unavailable'
    });
  });

  it('never carries any part of the exception in its answer', () => {
    const answers = [
      classifyEnqueueFailure(new Error(`write failed at ${PATH}`)),
      classifyEnqueueFailure(new QueueMutationRejected('fence-unverifiable', PATH)),
      classifyEnqueueFailure(new QueueMutationRejected('task-cap-reached', PATH))
    ];

    for (const answer of answers) {
      expect(JSON.stringify(answer)).not.toContain('user-252');
    }
  });
});
