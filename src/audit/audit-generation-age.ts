// FR-R4-F04 (FR-016, contract A1, A2; data-model §7) — the start of the live audit generation.
//
// The audit log rotates by size and by age. Age used to be the live file's mtime, which every append
// refreshes, so a workspace that kept appending never aged out and a log could hold evidence from months
// ago while claiming to rotate monthly. The age of a generation is now `now - start`, where `start` is
// the oldest usable row timestamp the generation holds.
//
// A timestamp is USABLE if it parses to a finite time. A usable timestamp later than `O`, the time this
// generation was first observed (recorded in the sidecar, see `audit-generation-sidecar.ts`), is not
// believed: a row dated a year ahead must not postpone rotation, so such a row is ignored for the start. If
// no usable row is at or before `O` the generation is aged from `O` itself, which is also what a
// generation with no usable timestamp at all gets. The start can therefore never be later than `O`.
//
// Pure: no I/O and no clock. The caller supplies the timestamps and `O`.

import { createHash } from 'node:crypto';

/**
 * The generation's start, in epoch milliseconds: the oldest usable timestamp at or before
 * `firstObservedAtMs`, or `firstObservedAtMs` when there is none.
 */
export function generationStart(timestamps: readonly string[], firstObservedAtMs: number): number {
  let oldest: number | null = null;
  for (const timestamp of timestamps) {
    const at = Date.parse(timestamp);
    if (!Number.isFinite(at) || at > firstObservedAtMs) continue;
    if (oldest === null || at < oldest) oldest = at;
  }
  return oldest ?? firstObservedAtMs;
}

/**
 * A generation's identity: the lowercase hex SHA-256 of its first line's bytes. A rotation gives the next
 * generation a different first line, so a sidecar written for one generation can never be mistaken for the
 * next one's.
 */
export function generationIdentity(firstLineBytes: Uint8Array): string {
  return createHash('sha256').update(firstLineBytes).digest('hex');
}
