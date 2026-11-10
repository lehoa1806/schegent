// FR-R6-F07 (FR-003, FR-012) — where a live-log snapshot starts, and the
// coverage-gap entries a tail session posts in place of what it did not show.
//
// A snapshot holds at most one replay pass of bytes. When the file is longer, it
// starts at the first record boundary at or after `size - pass`, found by
// searching at most one residual's worth of bytes. A record longer than the
// residual bound has no boundary in that window; the start is then the window's
// first byte, and the framer reports what it reads there as an omission. That is
// the documented limit: such a record is never shown whole anyway.

import type { FileHandle } from 'node:fs/promises';
import {
  LIVE_LOG_REPLAY_PASS_MAX_BYTES,
  LIVE_LOG_RESIDUAL_MAX_BYTES,
  type LiveLogCoverageReason
} from '../../contracts/phase-log-bounds';
import { readBoundedRange } from '../../lib/bounded-read';
import type { PhaseLogDisplayEntry } from './types';

const NEWLINE_BYTE = 0x0a;
const BOUNDARY_SEARCH_BYTES = LIVE_LOG_RESIDUAL_MAX_BYTES + 1;

/** The offset a snapshot of a `size`-byte file starts at; 0 when the file fits one pass. */
export async function alignedSnapshotStart(
  handle: FileHandle,
  size: number,
  passMaxBytes: number = LIVE_LOG_REPLAY_PASS_MAX_BYTES
): Promise<number> {
  if (size <= passMaxBytes) return 0;
  const from = size - passMaxBytes;
  // Read from the byte before `from`, so a newline there makes `from` itself a boundary.
  const window = await readBoundedRange(handle, from - 1, BOUNDARY_SEARCH_BYTES, BOUNDARY_SEARCH_BYTES);
  const newline = window.bytes.indexOf(NEWLINE_BYTE);
  return newline === -1 ? from : from + newline;
}

/** A coverage-gap entry; its body carries the reason and integers, never text. */
export function coverageGapEntry(
  reason: LiveLogCoverageReason,
  count: number,
  bytes?: number
): PhaseLogDisplayEntry {
  return {
    seq: 0,
    kind: 'coverage-gap',
    ts: null,
    body: bytes === undefined ? { reason, count } : { reason, count, bytes },
    bodyTruncated: null
  };
}
