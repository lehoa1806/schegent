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
// FR-R6-F07 (NFR-005) adds a byte bound: the window also keeps at most
// `LIVE_LOG_VISIBLE_MAX_BYTES` serialized bytes, the UTF-8 length of each row's
// JSON with the marker included. Over it the oldest entries leave from the head
// into the marker's count, as they do over the count cap. Each entry is measured
// once and its size cached by reference; entries are frozen, so the size cannot
// go stale. The measurement only reads; no field is rewritten.
//
// This module value-imports only from `src/contracts/` (the one direction the
// webview may reach the host) and takes the entry type as a type only.

import type { PhaseLogDisplayEntry } from '../../../src/services/phase-log/types.js';
import {
  LIVE_LOG_VISIBLE_MAX_BYTES,
  PHASE_LOG_MAX_ENTRIES
} from '../../../src/contracts/phase-log-bounds.js';

/** Entries the window keeps, the marker excluded: a full window is `PHASE_LOG_MAX_ENTRIES` rows. */
export const PHASE_LOG_WINDOW_MAX_ENTRIES = PHASE_LOG_MAX_ENTRIES - 1;

/** The `seq` of a marker this window creates. Host reads number from 0 and live entries from 1. */
export const WINDOW_MARKER_SEQ = -1;

function isMarker(entry: PhaseLogDisplayEntry | undefined): entry is PhaseLogDisplayEntry {
  return entry !== undefined && entry.kind === 'truncated-head';
}

const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;

/** The UTF-8 length of `text`, counted without encoding it. A lone surrogate encodes as U+FFFD, 3 bytes. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= HIGH_SURROGATE_FIRST && unit <= HIGH_SURROGATE_LAST) {
      const next = text.charCodeAt(index + 1);
      const paired = next >= LOW_SURROGATE_FIRST && next <= LOW_SURROGATE_LAST;
      bytes += paired ? 4 : 3;
      if (paired) index += 1;
    } else bytes += 3;
  }
  return bytes;
}

const rowSizes = new WeakMap<PhaseLogDisplayEntry, number>();

/** The serialized size of one row: the UTF-8 length of its JSON, cached by reference. */
function rowBytes(row: PhaseLogDisplayEntry): number {
  const cached = rowSizes.get(row);
  if (cached !== undefined) return cached;
  const size = utf8Length(JSON.stringify(row));
  rowSizes.set(row, size);
  return size;
}

function markerFor(marker: PhaseLogDisplayEntry | undefined, dropped: number): PhaseLogDisplayEntry {
  return {
    seq: marker === undefined ? WINDOW_MARKER_SEQ : marker.seq,
    kind: 'truncated-head',
    ts: null,
    body: { droppedEntryCount: dropped },
    bodyTruncated: null
  };
}

/** How many of the oldest entries in `next` must leave so the rest and their marker fit `maxBytes`. */
function removalsForBytes(
  next: readonly PhaseLogDisplayEntry[],
  removed: number,
  marker: PhaseLogDisplayEntry | undefined,
  maxBytes: number
): number {
  const sizes = next.map(rowBytes);
  let kept = sizes.slice(removed).reduce((total, size) => total + size, 0);
  const priorDropped = marker?.body.droppedEntryCount ?? 0;
  let count = removed;
  // The newest entry always stays, so at most next.length - 1 leave.
  while (count < next.length - 1) {
    const head = count === 0
      ? (marker === undefined ? 0 : rowBytes(marker))
      : utf8Length(JSON.stringify(markerFor(marker, priorDropped + count)));
    if (kept + head <= maxBytes) break;
    kept -= sizes.at(count) ?? 0;
    count += 1;
  }
  return count;
}

/**
 * Append `entry` to `entries`, keeping at most `maxEntries` real entries.
 *
 * Below the cap no marker is created. At the cap the oldest entries are removed,
 * and the single `truncated-head` marker at index 0 counts them: a marker that
 * came from the host read keeps its `seq` and has its count raised, and a marker
 * this call creates takes `WINDOW_MARKER_SEQ`. The newest entry is always last.
 *
 * The window also keeps at most `maxBytes` serialized bytes, the marker
 * included; the oldest entries leave first. The newest entry always stays.
 *
 * @param maxEntries the most real entries to keep; at least 1.
 * @param maxBytes the most serialized bytes to keep; `LIVE_LOG_VISIBLE_MAX_BYTES` when absent.
 */
export function appendToWindow(
  entries: readonly PhaseLogDisplayEntry[],
  entry: PhaseLogDisplayEntry,
  maxEntries: number,
  maxBytes: number = LIVE_LOG_VISIBLE_MAX_BYTES
): readonly PhaseLogDisplayEntry[] {
  const first = entries.at(0);
  const marker = isMarker(first) ? first : undefined;
  const real = marker === undefined ? entries : entries.slice(1);
  const next = [...real, entry];
  const overCount = Math.max(0, next.length - maxEntries);
  const removed = removalsForBytes(next, overCount, marker, maxBytes);
  if (removed === 0) {
    return Object.freeze(marker === undefined ? next : [marker, ...next]);
  }
  const head = markerFor(marker, (marker?.body.droppedEntryCount ?? 0) + removed);
  return Object.freeze([head, ...next.slice(removed)]);
}

/** The entries received and not shown: the marker's dropped count, or 0 when there is no marker. */
export function hiddenEntryCount(entries: readonly PhaseLogDisplayEntry[]): number {
  const first = entries.at(0);
  return isMarker(first) ? (first.body.droppedEntryCount ?? 0) : 0;
}
