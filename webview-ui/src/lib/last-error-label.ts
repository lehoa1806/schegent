// FR-R5-F19 (spec 278, T19.2, FR-006) — how a row names the error it retains.
//
// A retry readmits a row and keeps the failure it came from, so any status but `failed` can hold an
// error that describes an attempt already over. The label is derived from the row's status alone:
// no stored field, nothing to migrate, nothing to fall out of step with the row.
import type { QueueItem } from './snapshot-types';

export const CURRENT_ERROR_LABEL = 'Last error';
export const PREVIOUS_FAILURE_LABEL = 'Previous failure';

/** The toggle words a failed row has always used; the failure notice names "Show last error" by them. */
const FAILED_SHOW_TOGGLE = 'Show last error';
const FAILED_HIDE_TOGGLE = 'Hide error';

export interface LastErrorLabel {
  /** The error belongs to an attempt already over, not to the row's present state. */
  readonly historical: boolean;
  readonly showToggle: string;
  readonly hideToggle: string;
  /** A visible heading over the error text; `null` for a current failure, which has none. */
  readonly heading: string | null;
  /** The accessible name of the region, followed by " for <row label>". */
  readonly regionName: string;
}

/** `failed` is the one status whose retained error is current. */
export function isHistoricalError(status: QueueItem['status']): boolean {
  return status !== 'failed';
}

export function lastErrorLabel(status: QueueItem['status']): LastErrorLabel {
  if (!isHistoricalError(status)) {
    return {
      historical: false,
      showToggle: FAILED_SHOW_TOGGLE,
      hideToggle: FAILED_HIDE_TOGGLE,
      heading: null,
      regionName: CURRENT_ERROR_LABEL
    };
  }
  return {
    historical: true,
    showToggle: 'Show previous failure',
    hideToggle: 'Hide previous failure',
    heading: PREVIOUS_FAILURE_LABEL,
    regionName: PREVIOUS_FAILURE_LABEL
  };
}
