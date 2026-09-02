// Feature 187 (T018, FR-001, FR-002) — the wire shape of a failed start.
//
// The projection is tested apart from `composeQueueRuntimes` because it is where
// the one decision that matters lives: the operator sees a *sanitized* summary,
// never the raw `Error.message`. A step-7 admission throw is the one error text
// in this feature that comes straight off a driver, so it is the one most likely
// to carry an absolute path, and the assertion below is the only thing standing
// between that path and the sidebar.

import { describe, it, expect } from 'vitest';
import { projectStartFailure } from '../../../../src/ui/sidebar/queue-runtime-composer';
import { PAUSED_REASON_MAX_LENGTH } from '../../../../src/ui/sidebar/queue-projector';
import type { QueueStartFailure } from '../../../../src/services/queue-start-failure-registry';

/** The sanitizer's contract, not a stub of it: paths in, a placeholder out. */
const sanitize = (value: string): string =>
  value.replace(/\/Users\/[^\s]*/g, '<path>');

function failure(overrides: Partial<QueueStartFailure> = {}): QueueStartFailure {
  return {
    admission: 'admitNew',
    at: Date.UTC(2026, 8, 2, 10, 30, 0),
    message: 'the driver refused',
    ...overrides
  };
}

describe('projectStartFailure', () => {
  it('projects the admission it attempted, an ISO timestamp and a summary', () => {
    expect(projectStartFailure(failure(), sanitize)).toEqual({
      admission: 'admitNew',
      at: '2026-09-02T10:30:00.000Z',
      summary: 'the driver refused'
    });
  });

  it('carries admitResume through unchanged, so the surface can say which it was', () => {
    expect(projectStartFailure(failure({ admission: 'admitResume' }), sanitize)?.admission).toBe(
      'admitResume'
    );
  });

  it('projects null when the registry holds no report for this queue', () => {
    expect(projectStartFailure(null, sanitize)).toBeNull();
  });

  it('projects null when no registry is wired at all', () => {
    // `undefined` is what `deps.getQueueStartFailure?.(queueId)` evaluates to on a
    // host with no drain wiring. It reads as "not reported", never as a failure.
    expect(projectStartFailure(undefined, sanitize)).toBeNull();
  });

  it('sanitizes a filesystem path out of the message', () => {
    const projected = projectStartFailure(
      failure({ message: 'ENOENT: /Users/operator/secret-project/.schegent/run.json' }),
      sanitize
    );
    expect(projected?.summary).toBe('ENOENT: <path>');
    expect(projected?.summary).not.toContain('/Users/');
  });

  it('caps an over-long message the same way every other error text is capped', () => {
    const projected = projectStartFailure(
      failure({ message: 'x'.repeat(PAUSED_REASON_MAX_LENGTH + 200) }),
      sanitize
    );
    expect(projected?.summary).toHaveLength(PAUSED_REASON_MAX_LENGTH);
    expect(projected?.summary?.endsWith('…')).toBe(true);
  });

  it('projects a null summary for an error that carried no message', () => {
    // `new Error()` has `message === ''`. The report still exists — the start
    // did fail — so the record is projected with nothing to quote.
    const projected = projectStartFailure(failure({ message: '' }), sanitize);
    expect(projected).not.toBeNull();
    expect(projected?.summary).toBeNull();
  });

  it('hands out a frozen record, like every other projection on the wire', () => {
    expect(Object.isFrozen(projectStartFailure(failure(), sanitize))).toBe(true);
  });
});
