import type { FileHandle } from 'node:fs/promises';

/**
 * FR-R3-052 (H-03) — read a bounded amount, in fixed chunks, from a file whose
 * size is not yours to choose.
 *
 * Three readers took a whole file into memory before any size check:
 *
 *   - `phase-log-reader.ts` called `fs.readFile(streamPath, 'utf8')` with no
 *     `stat` at all.
 *   - `phase-sidecar-reader.ts` called `handle.stat()` and checked only
 *     `isFile()`, then `handle.readFile()`.
 *   - `phase-log-tail-session.ts` did `Buffer.alloc(stat.size - this.offset)`,
 *     and on its FIRST tick `offset` is 0 — so it allocated the entire file.
 *
 * A sparse multi-GiB phase log is trivial to produce (a rotation that never
 * happened, a backend that streamed for hours) and needs no attacker. The
 * allocation must not be proportional to the file.
 *
 * NO SILENT CAPS
 *
 * Every function here reports what it skipped or refused. A reader that quietly
 * returns the first 8 MiB of a 4 GiB log presents a truncated answer as a
 * complete one, and the operator reading it has no way to tell.
 */

/** One read syscall's buffer. Fixed, so allocation never tracks file size. */
export const CHUNK_BYTES = 64 * 1024;

/**
 * How much of a log a caller may take in one pass. Generous for any real phase,
 * and three orders of magnitude below what an unbounded read would take.
 */
export const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024;

export interface BoundedRange {
  readonly bytes: Buffer;
  /** The offset just past the last byte read, for a caller tracking position. */
  readonly nextOffset: number;
  /** Bytes deliberately not read because the bound was reached. */
  readonly skippedBytes: number;
}

/**
 * Read at most `maxBytes` starting at `start`, in `CHUNK_BYTES` chunks.
 *
 * The allocation is the smaller of the remaining length and the bound, so a
 * 4 GiB file costs the bound and not the file.
 */
export async function readBoundedRange(
  handle: FileHandle,
  start: number,
  available: number,
  maxBytes: number = DEFAULT_MAX_READ_BYTES
): Promise<BoundedRange> {
  const wanted = Math.max(0, Math.min(available, maxBytes));
  if (wanted === 0) {
    return { bytes: Buffer.alloc(0), nextOffset: start, skippedBytes: 0 };
  }
  const out = Buffer.alloc(wanted);
  let filled = 0;
  while (filled < wanted) {
    const chunk = Math.min(CHUNK_BYTES, wanted - filled);
    const { bytesRead } = await handle.read(out, filled, chunk, start + filled);
    // A short read means EOF or a concurrent truncation. Either way there is no
    // more to take, and returning what was read beats retrying against a file
    // that is changing underneath.
    if (bytesRead <= 0) break;
    filled += bytesRead;
  }
  return {
    bytes: filled === wanted ? out : out.subarray(0, filled),
    nextOffset: start + filled,
    skippedBytes: Math.max(0, available - filled)
  };
}

export type SizeVerdict =
  | { readonly outcome: 'within'; readonly size: number }
  | { readonly outcome: 'too-large'; readonly size: number; readonly limit: number };

/**
 * For a STRUCTURED document, where truncation is not a degraded answer but a
 * different document.
 *
 * A phase message is parsed as a whole; half of one is not a smaller message, it
 * is invalid input. So the size is a refusal, not a bound to read up to — and the
 * caller reports it as invalid rather than silently reading a prefix that cannot
 * parse.
 */
export async function judgeSize(
  handle: FileHandle,
  maxBytes: number = DEFAULT_MAX_READ_BYTES
): Promise<SizeVerdict> {
  const { size } = await handle.stat();
  return size > maxBytes
    ? { outcome: 'too-large', size, limit: maxBytes }
    : { outcome: 'within', size };
}

/**
 * The tail of a file, bounded.
 *
 * When a caller has no position yet and the file is already larger than the
 * bound, the useful end is the recent one: a log's last 8 MiB tells an operator
 * what just happened, where its first 8 MiB tells them what happened hours ago.
 * The skip is reported, never assumed harmless.
 */
export async function readBoundedTail(
  handle: FileHandle,
  size: number,
  maxBytes: number = DEFAULT_MAX_READ_BYTES
): Promise<BoundedRange> {
  const start = Math.max(0, size - maxBytes);
  const range = await readBoundedRange(handle, start, size - start, maxBytes);
  return { ...range, skippedBytes: range.skippedBytes + start };
}
