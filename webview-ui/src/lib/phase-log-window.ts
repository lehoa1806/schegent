// The live tail window (FR-R4-F08: FR-006, FR-007, FR-010).
//
// The webview appended every live phase-log entry to its array without limit, so
// a long Run grew the array, its keyed list and every copy made on each push for
// as long as the tail ran. A host read is capped at 500 rows (the newest 499
// entries and a `truncated-head` marker that counts the rest); this window gives
// the live tail the same shape and the same cap.
//
// `appendToWindow` is pure. It copies entry references into a new array and never
// rebuilds or re-stringifies any field of an entry (hard rule 25: the webview
// must not re-sanitize or re-stringify phase-log `toolArguments`). One append is
// one copy of at most `PHASE_LOG_MAX_ENTRIES` references, so the work does not
// grow with the length of the session.
//
// This module value-imports only from `src/contracts/` (the one direction the
// webview may reach the host) and takes the entry type as a type only.

import type { PhaseLogDisplayEntry } from '../../../src/services/phase-log/types.js';
import { PHASE_LOG_MAX_ENTRIES } from '../../../src/contracts/phase-log-bounds.js';

/** Entries the window keeps, the marker excluded: a full window is `PHASE_LOG_MAX_ENTRIES` rows. */
export const PHASE_LOG_WINDOW_MAX_ENTRIES = PHASE_LOG_MAX_ENTRIES - 1;

/** The `seq` of a marker this window creates. Host reads number from 0 and live entries from 1. */
export const WINDOW_MARKER_SEQ = -1;

function isMarker(entry: PhaseLogDisplayEntry | undefined): entry is PhaseLogDisplayEntry {
  return entry !== undefined && entry.kind === 'truncated-head';
}

/**
 * Append `entry` to `entries`, keeping at most `maxEntries` real entries.
 *
 * Below the cap no marker is created. At the cap the oldest entries are removed,
 * and the single `truncated-head` marker at index 0 counts them: a marker that
 * came from the host read keeps its `seq` and has its count raised, and a marker
 * this call creates takes `WINDOW_MARKER_SEQ`. The newest entry is always last.
 *
 * @param maxEntries the most real entries to keep; at least 1.
 */
export function appendToWindow(
  entries: readonly PhaseLogDisplayEntry[],
  entry: PhaseLogDisplayEntry,
  maxEntries: number
): readonly PhaseLogDisplayEntry[] {
  const first = entries.at(0);
  const marker = isMarker(first) ? first : undefined;
  const real = marker === undefined ? entries : entries.slice(1);
  const next = [...real, entry];
  if (next.length <= maxEntries) {
    return Object.freeze(marker === undefined ? next : [marker, ...next]);
  }
  const removed = next.length - maxEntries;
  const dropped = (marker?.body.droppedEntryCount ?? 0) + removed;
  const head: PhaseLogDisplayEntry = {
    seq: marker === undefined ? WINDOW_MARKER_SEQ : marker.seq,
    kind: 'truncated-head',
    ts: null,
    body: { droppedEntryCount: dropped },
    bodyTruncated: null
  };
  return Object.freeze([head, ...next.slice(removed)]);
}

/** The entries received and not shown: the marker's dropped count, or 0 when there is no marker. */
export function hiddenEntryCount(entries: readonly PhaseLogDisplayEntry[]): number {
  const first = entries.at(0);
  return isMarker(first) ? (first.body.droppedEntryCount ?? 0) : 0;
}
