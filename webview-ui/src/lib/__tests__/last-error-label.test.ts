// FR-R5-F19 (spec 278, T19.2, FR-006; tasks T024) — how a row names the error it retains.
//
// A retry readmits a row and keeps the failure it came from, so a row that is `pending`, `in-flight`,
// `paused`, `completed` or `canceled` can hold a `lastErrorSummary` that describes an attempt already
// over. Shown in the same position and words as a current failure it reads as the row's present state.
// The label is derived from the row's status alone: `failed` is the one status whose error is current,
// and nothing is stored, so there is no field to migrate and none to fall out of step.
import { describe, expect, it } from 'vitest';
import {
  CURRENT_ERROR_LABEL,
  isHistoricalError,
  lastErrorLabel,
  PREVIOUS_FAILURE_LABEL
} from '../last-error-label';
import type { QueueItem } from '../snapshot-types';

const STATUSES: ReadonlyArray<QueueItem['status']> = [
  'pending',
  'in-flight',
  'paused',
  'completed',
  'canceled',
  'failed'
];

describe('isHistoricalError', () => {
  it.each(STATUSES)('is %s historical only when the row is not failed', (status) => {
    expect(isHistoricalError(status)).toBe(status !== 'failed');
  });

  it('control: the table holds both answers', () => {
    const answers = new Set(STATUSES.map((status) => isHistoricalError(status)));
    expect(answers).toEqual(new Set([true, false]));
  });
});

describe('lastErrorLabel', () => {
  it('leaves a failed row exactly as it was: the toggle words the notice names', () => {
    expect(lastErrorLabel('failed')).toEqual({
      historical: false,
      showToggle: 'Show last error',
      hideToggle: 'Hide error',
      heading: null,
      regionName: CURRENT_ERROR_LABEL
    });
  });

  it.each(['pending', 'in-flight', 'paused', 'completed', 'canceled'] as const)(
    'labels a retained error on a %s row "Previous failure" and never as the current one',
    (status) => {
      const label = lastErrorLabel(status);

      expect(label.historical).toBe(true);
      expect(label.heading).toBe(PREVIOUS_FAILURE_LABEL);
      expect(label.regionName).toBe(PREVIOUS_FAILURE_LABEL);
      expect(label.showToggle).toBe('Show previous failure');
      expect(label.hideToggle).toBe('Hide previous failure');
      expect(JSON.stringify(label)).not.toContain('last error');
    }
  );

  it('the failed toggle text is the sentence the failure notice names', () => {
    expect(PREVIOUS_FAILURE_LABEL).toBe('Previous failure');
    expect(CURRENT_ERROR_LABEL).toBe('Last error');
    expect(lastErrorLabel('failed').showToggle).toBe('Show last error');
  });
});
