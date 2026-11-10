// FR-R6-F07 T036 (FR-012) — the label a coverage-gap row shows for each reason.
//
// Each label says what happened in words that stay true after later output
// arrives: `not-yet-produced` describes the moment the view opened, not the
// present. The host's reason is a closed list; anything else is shown as a
// generic gap and never echoed, because the row renders host data as text.

import {
  LIVE_LOG_COVERAGE_REASONS,
  type LiveLogCoverageReason
} from '../../../../src/contracts/phase-log-bounds.js';

const LABELS: Readonly<Record<LiveLogCoverageReason, string>> = Object.freeze({
  'capture-disabled': 'Output capture was off for this run',
  'not-yet-produced': 'No output had been written when this view opened',
  'parse-omission': 'A record that could not be read was left out',
  'oversized-record': 'A record over the size limit was left out',
  'display-truncation': 'An entry too large to show was left out',
  'artifact-expired': 'The log file is no longer available',
  'permission-refused': 'The log file could not be opened safely',
  'transport-gap': 'Events were lost in transport',
  'source-replaced': 'The log file was replaced; later rows come from the new file',
  'range-skipped': 'Earlier output is outside the shown range'
});

const UNKNOWN_LABEL = 'Some output is not shown';

const KNOWN: ReadonlySet<string> = new Set(LIVE_LOG_COVERAGE_REASONS);

/** The reason when it is one the host may send, else `'unknown'`. */
export function coverageGapReason(reason: unknown): LiveLogCoverageReason | 'unknown' {
  return typeof reason === 'string' && KNOWN.has(reason)
    ? (reason as LiveLogCoverageReason)
    : 'unknown';
}

/** The row label for a reason; a reason outside the closed list gets a generic label. */
export function coverageGapLabel(reason: unknown): string {
  const known = coverageGapReason(reason);
  return known === 'unknown' ? UNKNOWN_LABEL : LABELS[known];
}

/** A figure worth showing: a non-negative integer, else `null`. */
export function coverageGapFigure(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
