// Feature 187 (T018, FR-001, FR-002) — the wire shape of a failed start.
//
// The projection is tested apart from `composeQueueRuntimes` because it is where
// the one decision that matters lives: the operator sees a *sanitized* summary,
// never the raw `Error.message`. A step-7 admission throw is the one error text
// in this feature that comes straight off a driver, so it is the one most likely
// to carry an absolute path, and the assertion below is the only thing standing
// between that path and the sidebar.
//
// Feature 195 (T015, FR-007, FR-008, FR-024) — widened to the registry's
// discriminated union. The `kind: 'admission'` cases above are unchanged in
// substance; `describe('the halted kind', ...)` below is new, and pins the
// same sanitizer applying to `taskName` as already applies to `message`.

import { describe, it, expect } from 'vitest';
import { projectStartFailure } from '../../../../src/ui/sidebar/queue-runtime-composer';
import { PAUSED_REASON_MAX_LENGTH } from '../../../../src/ui/sidebar/queue-projector';
import type { QueueStartFailure } from '../../../../src/services/queue-start-failure-registry';

/** The sanitizer's contract, not a stub of it: paths in, a placeholder out. */
const sanitize = (value: string): string =>
  value.replace(/\/Users\/[^\s]*/g, '<path>');

function admissionFailure(
  overrides: Partial<Extract<QueueStartFailure, { kind: 'admission' }>> = {}
): QueueStartFailure {
  return {
    kind: 'admission',
    admission: 'admitNew',
    at: Date.UTC(2026, 8, 2, 10, 30, 0),
    message: 'the driver refused',
    ...overrides
  };
}

function haltedFailure(
  overrides: Partial<Extract<QueueStartFailure, { kind: 'halted' }>> = {}
): QueueStartFailure {
  return {
    kind: 'halted',
    taskId: 't1',
    taskName: 'ingest data',
    at: Date.UTC(2026, 8, 2, 10, 30, 0),
    ...overrides
  };
}

describe('projectStartFailure', () => {
  it('projects the admission it attempted, an ISO timestamp and a summary', () => {
    expect(projectStartFailure(admissionFailure(), sanitize)).toEqual({
      kind: 'admission',
      admission: 'admitNew',
      at: '2026-09-02T10:30:00.000Z',
      summary: 'the driver refused'
    });
  });

  it('carries admitResume through unchanged, so the surface can say which it was', () => {
    const projected = projectStartFailure(admissionFailure({ admission: 'admitResume' }), sanitize);
    expect(projected?.kind === 'admission' && projected.admission).toBe('admitResume');
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
      admissionFailure({ message: 'ENOENT: /Users/operator/secret-project/.schegent/run.json' }),
      sanitize
    );
    expect(projected?.kind === 'admission' && projected.summary).toBe('ENOENT: <path>');
    expect(projected?.kind === 'admission' && projected.summary).not.toContain('/Users/');
  });

  it('caps an over-long message the same way every other error text is capped', () => {
    const projected = projectStartFailure(
      admissionFailure({ message: 'x'.repeat(PAUSED_REASON_MAX_LENGTH + 200) }),
      sanitize
    );
    const summary = projected?.kind === 'admission' ? projected.summary : null;
    expect(summary).toHaveLength(PAUSED_REASON_MAX_LENGTH);
    expect(summary?.endsWith('…')).toBe(true);
  });

  it('projects a null summary for an error that carried no message', () => {
    // `new Error()` has `message === ''`. The report still exists — the start
    // did fail — so the record is projected with nothing to quote.
    const projected = projectStartFailure(admissionFailure({ message: '' }), sanitize);
    expect(projected).not.toBeNull();
    expect(projected?.kind === 'admission' && projected.summary).toBeNull();
  });

  it('hands out a frozen record, like every other projection on the wire', () => {
    expect(Object.isFrozen(projectStartFailure(admissionFailure(), sanitize))).toBe(true);
  });

  describe('the halted kind (feature 195, T015)', () => {
    it('projects the task id, a sanitized task name and an ISO timestamp', () => {
      expect(projectStartFailure(haltedFailure(), sanitize)).toEqual({
        kind: 'halted',
        taskId: 't1',
        taskName: 'ingest data',
        at: '2026-09-02T10:30:00.000Z'
      });
    });

    it('sanitizes a filesystem path out of the task name, same as an admission message', () => {
      const projected = projectStartFailure(
        haltedFailure({ taskName: 'process /Users/operator/secret-project/input.csv' }),
        sanitize
      );
      expect(projected?.kind === 'halted' && projected.taskName).toBe('process <path>');
    });

    it('falls back to the task id when sanitizing empties the name, so FR-008 still names something', () => {
      const projected = projectStartFailure(
        haltedFailure({ taskId: 't-fallback', taskName: '   ' }),
        (value) => value.trim()
      );
      expect(projected?.kind === 'halted' && projected.taskName).toBe('t-fallback');
    });

    it('hands out a frozen record', () => {
      expect(Object.isFrozen(projectStartFailure(haltedFailure(), sanitize))).toBe(true);
    });
  });
});
