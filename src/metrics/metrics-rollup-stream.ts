// FR-R3-082 (T1093, T1094) — read the rollup without materializing it.
//
// `REL-06`: "rollup never trims and is wholly loaded". Both halves were true.
// The writer read the whole file into a string to collect known run ids, and the
// reader read it again to compose totals — so a rollup that only ever grew was
// also a rollup that was fully resident twice per append cycle.
//
// The trim (T1091) bounds the file at 8 MiB, which is below
// `DEFAULT_MAX_READ_BYTES`, so a trimmed rollup is always readable in one
// bounded pass. This module is what makes that true of an UNTRIMMED one too: a
// rollup written by a build that predates the trim, or one that grew between
// trims, is consumed in fixed chunks and line by line rather than at once.
//
// Both consumers share this because they were reading the same file with two
// different loaders, which is how the writer's view and the reader's view of
// "what is in the rollup" come to disagree.

import { openWithinRootByPath } from '../lib/safe-open';
import { CHUNK_BYTES, DEFAULT_MAX_READ_BYTES } from '../lib/bounded-read';
import {
  parseMetricsRollupLine,
  type MetricsRollupCarryForward,
  type MetricsRollupRecord
} from './metrics-rollup';

export interface StreamedRollup {
  /** False when the file is not there at all. */
  readonly available: boolean;
  readonly records: readonly MetricsRollupRecord[];
  /** The trim's header, when the file carries one. */
  readonly carryForward: MetricsRollupCarryForward | undefined;
  /** Lines present but unusable. Surfaced so a corrupt tail is visible. */
  readonly unreadableRecords: number;
  /** File size in bytes at the moment it was read, for the trim's threshold. */
  readonly sizeBytes: number;
  /**
   * Bytes at the START of the file this read skipped because the file exceeded
   * the read bound. Reported, never swallowed: the records in them are missing
   * from `records`, so cumulative totals composed from this read understate, and
   * a caller that could not tell would present a partial answer as a whole one.
   */
  readonly skippedBytes: number;
}

const ABSENT: StreamedRollup = Object.freeze({
  available: false,
  records: Object.freeze([]),
  carryForward: undefined,
  unreadableRecords: 0,
  sizeBytes: 0,
  skippedBytes: 0
});

/**
 * Consume `rollupPath` line by line.
 *
 * Throws only what the open throws other than ENOENT — an absent rollup is a
 * legitimate state (nothing has completed yet) and is reported as `available:
 * false`, exactly as the whole-file reader reported it.
 *
 * The partial-line carry between chunks is why this is a loop and not a `split`:
 * a chunk boundary lands mid-record roughly always, and a reader that dropped
 * the straddling line would lose one run per chunk without saying so.
 */
export async function streamRollup(
  workspaceRoot: string,
  rollupPath: string,
  /**
   * How much of the file to consume, newest-first.
   *
   * The chunked read bounds the BUFFER; it does not bound the output, and an
   * unbounded record array is the same unbounded residency the whole-file read
   * had with extra steps. A rollup this large means the trim never ran — a
   * workspace whose `.schegent` refuses, or a file written before trimming
   * existed — and the honest degradation is to read the newest records the bound
   * allows and SAY what was skipped.
   */
  maxBytes: number = DEFAULT_MAX_READ_BYTES
): Promise<StreamedRollup> {
  // FR-R3-082 (T1098) — through the checked walk, which is what strikes this
  // module's entry from the migration ledger. `.schegent/` is a directory a
  // cloned workspace controls, so the components between the root and the
  // rollup are as much the adversary's to arrange as the leaf is.
  const opened = await openWithinRootByPath(workspaceRoot, rollupPath, { flags: 'r' });
  if (opened.outcome === 'refused') {
    // An absent rollup is a legitimate state — nothing has completed yet — and
    // it is reported as `available: false`, exactly as it always was. Any other
    // refusal is a genuine one and is raised, because a rollup that cannot be
    // proven must not read as an empty one: empty means "zero history", and
    // that is a claim about the workspace rather than about the read.
    if (opened.errno === 'ENOENT' || opened.errno === 'ENOTDIR') return ABSENT;
    throw Object.assign(new Error(`metrics rollup refused: ${opened.reason}`), {
      code: opened.errno
    });
  }
  const handle = opened.handle;

  const records: MetricsRollupRecord[] = [];
  let carryForward: MetricsRollupCarryForward | undefined;
  let unreadableRecords = 0;
  let sizeBytes = 0;
  let skippedBytes = 0;

  try {
    sizeBytes = (await handle.stat()).size;
    // Newest last in an append-only file, so the bound keeps the TAIL.
    skippedBytes = Math.max(0, sizeBytes - maxBytes);
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let offset = skippedBytes;
    // A bound that cuts mid-record leaves a fragment at the front. Dropped
    // rather than parsed — it would be counted as an unreadable record, which
    // would be blaming the file for this read's own bound.
    let partial = skippedBytes > 0 ? '' : '';
    let droppedFragment = skippedBytes === 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      const text = partial + buffer.subarray(0, bytesRead).toString('utf8');
      const lines = text.split('\n');
      // The last element is whatever follows the final newline — a complete line
      // only when the chunk happened to end on one, so it is always carried.
      partial = lines.pop() ?? '';
      for (const line of lines) {
        if (!droppedFragment) {
          droppedFragment = true;
          continue;
        }
        const result = consume(line);
        if (result === 'unreadable') unreadableRecords += 1;
      }
    }
    if (partial.length > 0 && consume(partial) === 'unreadable') unreadableRecords += 1;
  } finally {
    await handle.close().catch(() => undefined);
  }

  return { available: true, records, carryForward, unreadableRecords, sizeBytes, skippedBytes };

  function consume(line: string): 'ok' | 'unreadable' {
    const parsed = parseMetricsRollupLine(line);
    if (parsed.record !== null) {
      records.push(parsed.record);
      return 'ok';
    }
    if (parsed.carryForward !== undefined) {
      // Last one wins. A file with two headers is not a shape this writer
      // produces, and choosing the later one is the reading that survives a
      // crash between writing a new header and truncating the old file.
      carryForward = parsed.carryForward;
      return 'ok';
    }
    return parsed.warning === undefined ? 'ok' : 'unreadable';
  }
}
