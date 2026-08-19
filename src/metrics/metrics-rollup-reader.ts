// Feature FR-R3-009 (T389, T393) — the metrics rollup reader.
//
// Reads `.schegent/metrics-rollup.jsonl` and returns its records. It is a pure
// read: the reader never writes, never trims, and never backfills. There is
// deliberately no backfill function in this module — a rollup recomputed from a
// corpus that may already have been pruned would inherit exactly the defect the
// rollup exists to remove, and the only way to guarantee it never happens is for
// the code not to exist (T393).

import * as fs from 'fs/promises';
import * as path from 'path';
import type { SanitizedLogger } from '../lib/logger';
import {
  METRICS_ROLLUP_FILENAME,
  parseMetricsRollupLine,
  type MetricsRollupRecord
} from './metrics-rollup';

export interface MetricsRollupReadResult {
  /** False when the file does not exist yet, or could not be read at all. */
  readonly available: boolean;
  readonly records: readonly MetricsRollupRecord[];
  /** Lines present but unusable. Surfaced so a corrupt tail is visible. */
  readonly unreadableRecords: number;
}

const EMPTY: MetricsRollupReadResult = Object.freeze({
  available: false,
  records: Object.freeze([]),
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
  let content: string;
  try {
    content = await fs.readFile(metricsRollupPath(workspaceRoot), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger?.warn('metrics rollup read failed; cumulative totals fall back to the retained log', {
        ...(typeof code === 'string' ? { errno: code } : {})
      });
    }
    return EMPTY;
  }

  const records: MetricsRollupRecord[] = [];
  let unreadableRecords = 0;
  for (const line of content.split('\n')) {
    const { record, warning } = parseMetricsRollupLine(line);
    if (record !== null) {
      records.push(record);
      continue;
    }
    if (warning !== undefined) unreadableRecords += 1;
  }

  if (unreadableRecords > 0) {
    // Counts only — no line bodies, no path. An unreadable record understates
    // cumulative totals by exactly one run, so it must not pass silently.
    logger?.warn('metrics rollup has unreadable records; cumulative totals understate by that many runs', {
      unreadableRecords
    });
  }

  return { available: true, records, unreadableRecords };
}
