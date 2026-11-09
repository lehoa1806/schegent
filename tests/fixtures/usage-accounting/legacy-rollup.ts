/**
 * FR-R6-F06 (T048) — a legacy `metrics-rollup.jsonl` for the legacy-epoch tests: a carry-forward
 * header a trim left behind, then first-terminal run records written by the real serializers,
 * so the import reads exactly what the rollup writer produces.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  EMPTY_CUMULATIVE_TOTALS,
  METRICS_ROLLUP_SCHEMA_VERSION,
  type MetricsRollupCarryForward,
  type MetricsRollupRecord,
  type RollupTerminalStatus,
  serializeCarryForward,
  serializeMetricsRollupRecord
} from '../../../src/metrics/metrics-rollup';
import { metricsRollupPath } from '../../../src/metrics/metrics-rollup-reader';

/** More than one 500-run import batch, so an interruption can land between batches. */
export const LEGACY_RUN_COUNT = 620;
const STATUSES: readonly RollupTerminalStatus[] = ['completed', 'failed', 'canceled'];
const BASE_MS = Date.parse('2026-10-01T00:00:00.000Z');
const MINUTE_MS = 60_000;

export const LEGACY_CARRY_FORWARD: MetricsRollupCarryForward = {
  totals: { ...EMPTY_CUMULATIVE_TOTALS, runs: 40, completedRuns: 30, failedRuns: 10, costUsd: 12.5 },
  runs: 40,
  trimmedThrough: '2026-09-30T23:59:59.000Z'
};

export function legacyRunId(index: number): string {
  return `run-legacy-${String(index).padStart(4, '0')}`;
}

/** Run `index`; every seventh run recorded no cost. The newest run is the last index. */
export function legacyRecord(index: number): MetricsRollupRecord {
  const endedMs = BASE_MS + index * MINUTE_MS;
  const terminalStatus = STATUSES[index % STATUSES.length] ?? 'completed';
  return {
    v: METRICS_ROLLUP_SCHEMA_VERSION,
    runId: legacyRunId(index),
    terminalStatus,
    startedAt: new Date(endedMs - MINUTE_MS / 2).toISOString(),
    endedAt: new Date(endedMs).toISOString(),
    durationMs: MINUTE_MS / 2,
    phasesTotal: 3,
    phasesCompleted: terminalStatus === 'completed' ? 3 : 1,
    phasesSkipped: 0,
    backendInvocations: 2,
    ...(index % 7 === 0 ? {} : { costUsd: 0.015 })
  };
}

export function legacyRollupText(count = LEGACY_RUN_COUNT): string {
  const records = Array.from({ length: count }, (_, index) => serializeMetricsRollupRecord(legacyRecord(index)));
  return serializeCarryForward(LEGACY_CARRY_FORWARD) + records.join('');
}

/** The micro-units the import must sum for runs `0..count-1`: 15,000 per costed run. */
export function legacyCostMicros(count = LEGACY_RUN_COUNT): number {
  let total = 0;
  for (let index = 0; index < count; index += 1) if (index % 7 !== 0) total += 15_000;
  return total;
}

export async function writeLegacyRollup(workspaceRoot: string, text = legacyRollupText()): Promise<string> {
  const file = metricsRollupPath(workspaceRoot);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
  return file;
}
