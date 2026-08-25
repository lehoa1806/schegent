// Feature FR-R3-009 (T389, T393) — the metrics rollup reader.
//
// Reads `.schegent/metrics-rollup.jsonl` and returns its records. It is a pure
// read: the reader never writes, never trims, and never backfills. There is
// deliberately no backfill function in this module — a rollup recomputed from a
// corpus that may already have been pruned would inherit exactly the defect the
// rollup exists to remove, and the only way to guarantee it never happens is for
// the code not to exist (T393).

import * as path from 'path';
import type { SanitizedLogger } from '../lib/logger';
import {
  METRICS_ROLLUP_FILENAME,
  type MetricsRollupCarryForward,
  type MetricsRollupRecord
} from './metrics-rollup';
import { streamRollup } from './metrics-rollup-stream';

export interface MetricsRollupReadResult {
  /** False when the file does not exist yet, or could not be read at all. */
  readonly available: boolean;
  readonly records: readonly MetricsRollupRecord[];
  /**
   * FR-R3-082 (T1091) — what a trim discarded, as totals to start from.
   *
   * `undefined` for a rollup that has never been trimmed, which is every rollup
   * written before this feature — so those compose exactly as they always did.
   */
  readonly carryForward: MetricsRollupCarryForward | undefined;
  /** Lines present but unusable. Surfaced so a corrupt tail is visible. */
  readonly unreadableRecords: number;
}

const EMPTY: MetricsRollupReadResult = Object.freeze({
  available: false,
  records: Object.freeze([]),
  carryForward: undefined,
  unreadableRecords: 0
});

export function metricsRollupPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.schegent', METRICS_ROLLUP_FILENAME);
}

/**
 * Read every rollup record for a workspace.
 *
 * The whole file is read on each call rather than offset-cached the way the
 * audit fold is: one record per terminal run is a few hundred bytes a day, so
 * even years of history stays well inside a single read, and an offset cache
 * here would be a second place for the "file shrank" invalidation problem to
 * live. A read failure other than a missing file is reported as unavailable and
 * warned — it must not be mistaken for an empty rollup, because an empty rollup
 * silently means "zero history".
 */
export async function readMetricsRollup(
  workspaceRoot: string,
  logger?: SanitizedLogger
): Promise<MetricsRollupReadResult> {
  // FR-R3-082 (T1093) — streamed, not `readFile`. The header this replaced said
  // the whole file was "well inside a single read" because a record is a few
  // hundred bytes a day; that reasoning is about the ORDINARY case, and an
  // evidence file's size is not this host's to assume. The bound now comes from
  // the reader rather than from an estimate of how much history exists.
  let streamed;
  try {
    streamed = await streamRollup(workspaceRoot, metricsRollupPath(workspaceRoot));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    logger?.warn('metrics rollup read failed; cumulative totals fall back to the retained log', {
      ...(typeof code === 'string' ? { errno: code } : {})
    });
    return EMPTY;
  }
  if (!streamed.available) return EMPTY;

  const { records, carryForward, unreadableRecords } = streamed;

  if (streamed.skippedBytes > 0) {
    // The rollup exceeded the read bound, so this answer is the newest records
    // only and the totals composed from it understate. Never silent: an
    // understated cumulative cost that nobody flagged is the same defect the
    // carry-forward header exists to prevent, arriving by a different door.
    logger?.warn(
      'metrics rollup exceeds the read bound; cumulative totals cover the newest records only',
      { skippedBytes: streamed.skippedBytes }
    );
  }

  if (unreadableRecords > 0) {
    // Counts only — no line bodies, no path. An unreadable record understates
    // cumulative totals by exactly one run, so it must not pass silently. The
    // move to `streamRollup` dropped this warn because the streamer has no
    // logger; the count still reaches here, so the report belongs here.
    logger?.warn(
      'metrics rollup has unreadable records; cumulative totals understate by that many runs',
      { unreadableRecords }
    );
  }

  return { available: true, records, carryForward, unreadableRecords };
}
