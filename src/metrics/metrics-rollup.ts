// Feature FR-R3-009 (T386, T392) — the durable metrics rollup's record shape
// and the pure composition rules that turn rollup records plus fold-derived
// runs into monotonic cumulative totals.
//
// Why this exists: every metric in `metrics-service.ts` is a fold over
// `.schegent/audit.log` and its archives, and that corpus is pruned on two
// triggers (an eleventh archive, or a ninety-first day). A cumulative figure
// derived from a shrinking domain shrinks with it, so a total quoted last month
// is not the total this month. The rollup is written once per terminal run,
// while the evidence is still present, and is never recomputed from a corpus
// that may since have been pruned.
//
// What the record may hold: ids, counters, timestamps, and costs. No
// description, no path, no CLI output — the same standard the structured audit
// log is held to, so there is deliberately no free text here to sanitize.
//
// This module is pure: no filesystem, no `vscode`. The writer
// (`metrics-rollup-writer.ts`) and reader (`metrics-rollup-reader.ts`) own the
// I/O; the composition is here so it can be tested without either.

import type {
  CumulativeTotals,
  MetricsCoverage,
  MetricsRunSummary,
  TaskRecord
} from '../contracts/sidebar-ipc';

/**
 * Rollup record schema version.
 *
 * Append-only and forward-only: records are never rewritten in place. A schema
 * change bumps this constant and adds a reader branch — it does not migrate the
 * file, because rewriting the file is the one operation that could lose a total.
 */
export const METRICS_ROLLUP_SCHEMA_VERSION = 1;

/** Filename under `.schegent/`. Newline-delimited JSON, one record per line. */
export const METRICS_ROLLUP_FILENAME = 'metrics-rollup.jsonl';

export type RollupTerminalStatus = 'completed' | 'failed' | 'canceled';

/**
 * One terminal run, as summarised at the moment it reached a terminal state.
 *
 * `costUsd` is absent rather than zero when the run recorded no cost at all:
 * "nothing was reported" and "the run was free" are different facts, and
 * collapsing them would silently understate a total that later gains cost
 * reporting.
 *
 * Feature 103 (T092) — the stored record is the wire summary plus the schema
 * marker. Declared as an extension rather than restated so the two shapes
 * cannot drift: a field added to one is a field on the other, and the marker
 * stays the single difference.
 */
export interface MetricsRollupRecord extends MetricsRunSummary {
  /** Schema version marker. See `METRICS_ROLLUP_SCHEMA_VERSION`. */
  readonly v: number;
  readonly terminalStatus: RollupTerminalStatus;
}

/**
 * Feature 103 (T093) — the wire projection: everything but the schema marker.
 *
 * The marker describes how to read a line off disk. Sending it would give the
 * webview a second version number to reason about and a reason to branch on
 * storage decisions that are not its business.
 */
export function toRunSummary(record: MetricsRollupRecord): MetricsRunSummary {
  const { v: _schemaVersion, ...summary } = record;
  return summary;
}

/**
 * The minimal facts cumulative totals are folded from. Both a rollup record and
 * a fold-derived `TaskRecord` project into this shape, which is what lets the
 * two ranges be unioned and deduplicated by run id without double-counting.
 */
export interface CumulativeRunFacts {
  readonly runId: string;
  readonly terminalStatus: RollupTerminalStatus;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly phasesTotal: number;
  readonly phasesCompleted: number;
  readonly phasesSkipped: number;
  readonly backendInvocations: number;
  readonly costUsd: number | undefined;
}

export interface RollupParseResult {
  readonly record: MetricsRollupRecord | null;
  /** Set when the line was present but unusable; the caller counts it. */
  readonly warning?: string;
}

export const EMPTY_CUMULATIVE_TOTALS: CumulativeTotals = Object.freeze({
  runs: 0,
  completedRuns: 0,
  failedRuns: 0,
  canceledRuns: 0,
  durationMs: 0,
  costUsd: 0,
  costUsdIsPartial: false,
  phasesTotal: 0,
  phasesCompleted: 0,
  phasesSkipped: 0,
  backendInvocations: 0
});

export function serializeMetricsRollupRecord(record: MetricsRollupRecord): string {
  // Key order is fixed for readability of the on-disk file; `costUsd` is
  // omitted entirely when undefined so a reader can tell "not reported" from
  // "reported as zero".
  const body: Record<string, unknown> = {
    v: record.v,
    runId: record.runId,
    terminalStatus: record.terminalStatus,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationMs: record.durationMs,
    phasesTotal: record.phasesTotal,
    phasesCompleted: record.phasesCompleted,
    phasesSkipped: record.phasesSkipped,
    backendInvocations: record.backendInvocations
  };
  if (record.costUsd !== undefined) body.costUsd = record.costUsd;
  return `${JSON.stringify(body)}\n`;
}

/**
 * Parse one rollup line (T389).
 *
 * Tolerant in exactly one direction: unknown fields are ignored and a `v`
 * *higher* than this build understands is still read for the fields it does
 * understand. Rollup fields are additive by policy, so a newer writer's record
 * still carries every v1 field — and skipping it would make a total drop for an
 * operator who downgraded, which is the defect this file exists to remove. A
 * record whose known fields are malformed is refused, never guessed at.
 */
export function parseMetricsRollupLine(line: string): RollupParseResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { record: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { record: null, warning: 'not-json' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { record: null, warning: 'not-an-object' };
  }
  const raw = parsed as Record<string, unknown>;

  const v = raw.v;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < METRICS_ROLLUP_SCHEMA_VERSION) {
    return { record: null, warning: 'unsupported-version' };
  }

  const runId = raw.runId;
  if (typeof runId !== 'string' || runId.length === 0) {
    return { record: null, warning: 'invalid-runId' };
  }

  const terminalStatus = readTerminalStatus(raw.terminalStatus);
  if (terminalStatus === undefined) {
    return { record: null, warning: 'invalid-terminalStatus' };
  }

  const startedAt = readTimestamp(raw.startedAt);
  const endedAt = readTimestamp(raw.endedAt);
  if (startedAt === undefined || endedAt === undefined) {
    return { record: null, warning: 'invalid-timestamp' };
  }

  const durationMs = readCount(raw.durationMs);
  const phasesTotal = readCount(raw.phasesTotal);
  const phasesCompleted = readCount(raw.phasesCompleted);
  const phasesSkipped = readCount(raw.phasesSkipped);
  const backendInvocations = readCount(raw.backendInvocations);
  if (
    durationMs === undefined ||
    phasesTotal === undefined ||
    phasesCompleted === undefined ||
    phasesSkipped === undefined ||
    backendInvocations === undefined
  ) {
    return { record: null, warning: 'invalid-counter' };
  }

  const costUsd = raw.costUsd;
  if (costUsd !== undefined && (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0)) {
    return { record: null, warning: 'invalid-costUsd' };
  }

  return {
    record: {
      v,
      runId,
      terminalStatus,
      startedAt,
      endedAt,
      durationMs,
      phasesTotal,
      phasesCompleted,
      phasesSkipped,
      backendInvocations,
      ...(costUsd === undefined ? {} : { costUsd })
    }
  };
}

/** A rollup record, projected onto the fold-neutral facts shape. */
export function factsFromRollupRecord(record: MetricsRollupRecord): CumulativeRunFacts {
  return {
    runId: record.runId,
    terminalStatus: record.terminalStatus,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationMs: record.durationMs,
    phasesTotal: record.phasesTotal,
    phasesCompleted: record.phasesCompleted,
    phasesSkipped: record.phasesSkipped,
    backendInvocations: record.backendInvocations,
    costUsd: record.costUsd
  };
}

/**
 * A fold-derived task, projected onto the same shape — or `null` when the task
 * has not reached a terminal state the rollup would ever record. A reconstructed
 * task with an unrecognized `terminalStatus` is deliberately excluded: totals
 * count runs whose outcome is known, and a run the fold cannot classify would
 * otherwise be counted here and not by the rollup, making the figure depend on
 * which range it happened to fall in.
 */
export function factsFromTaskRecord(task: TaskRecord): CumulativeRunFacts | null {
  if (task.isRunning) return null;
  if (task.status === undefined) return null;
  if (task.endTime === undefined) return null;
  return {
    runId: task.runId,
    terminalStatus: task.status,
    startedAt: task.startTime,
    endedAt: task.endTime,
    durationMs: task.durationMs,
    phasesTotal: task.phasesTotal,
    phasesCompleted: task.phasesCompleted,
    phasesSkipped: task.phasesSkipped,
    backendInvocations: task.totalBackendInvocations,
    costUsd: task.totalCostUsd
  };
}

export interface ComposedCumulative {
  readonly totals: CumulativeTotals;
  /** Runs the rollup itself accounted for, before the fold's additions. */
  readonly rollupRuns: number;
  readonly rollupEarliest?: string;
  readonly rollupLatest?: string;
}

/**
 * Compose cumulative totals from the rollup and the retained fold (T392).
 *
 * The rollup wins on overlap: it was written while the evidence was present and
 * is authoritative for its own range. The fold contributes only run ids the
 * rollup does not already hold — runs older than the rollup file (a workspace
 * that predates this feature) and, transiently, a run whose rollup append
 * failed. Deduplication is by run id, so an overlapping range is counted once.
 *
 * Note the honest residual: a run whose rollup write failed contributes through
 * the fold and drops back out when its log evidence is pruned. That is exactly
 * why rollup writability is surfaced in `EvidenceHealthSnapshot` rather than
 * being papered over here — the alternative would be a backfill from a corpus
 * that may already be incomplete, which reintroduces the original defect.
 */
export function composeCumulativeTotals(
  rollupRecords: readonly MetricsRollupRecord[],
  foldTasks: readonly TaskRecord[]
): ComposedCumulative {
  const byRunId = new Map<string, CumulativeRunFacts>();
  let rollupEarliestMs = Number.POSITIVE_INFINITY;
  let rollupLatestMs = Number.NEGATIVE_INFINITY;
  let rollupEarliest: string | undefined;
  let rollupLatest: string | undefined;

  for (const record of rollupRecords) {
    // A duplicate run id inside the rollup is possible in principle (two hosts
    // appending concurrently, each having read the file before the other wrote)
    // and must count once. Last write wins arbitrarily but consistently: both
    // records describe the same run.
    byRunId.set(record.runId, factsFromRollupRecord(record));
    const endedMs = Date.parse(record.endedAt);
    if (!Number.isNaN(endedMs)) {
      if (endedMs < rollupEarliestMs) {
        rollupEarliestMs = endedMs;
        rollupEarliest = record.endedAt;
      }
      if (endedMs > rollupLatestMs) {
        rollupLatestMs = endedMs;
        rollupLatest = record.endedAt;
      }
    }
  }
  const rollupRuns = byRunId.size;

  for (const task of foldTasks) {
    if (byRunId.has(task.runId)) continue;
    const facts = factsFromTaskRecord(task);
    if (facts === null) continue;
    byRunId.set(task.runId, facts);
  }

  let totals = EMPTY_CUMULATIVE_TOTALS;
  for (const facts of byRunId.values()) totals = accumulate(totals, facts);

  return { totals, rollupRuns, rollupEarliest, rollupLatest };
}

function accumulate(totals: CumulativeTotals, facts: CumulativeRunFacts): CumulativeTotals {
  return {
    runs: totals.runs + 1,
    completedRuns: totals.completedRuns + (facts.terminalStatus === 'completed' ? 1 : 0),
    failedRuns: totals.failedRuns + (facts.terminalStatus === 'failed' ? 1 : 0),
    canceledRuns: totals.canceledRuns + (facts.terminalStatus === 'canceled' ? 1 : 0),
    durationMs: totals.durationMs + facts.durationMs,
    costUsd: totals.costUsd + (facts.costUsd ?? 0),
    costUsdIsPartial: totals.costUsdIsPartial || facts.costUsd === undefined,
    phasesTotal: totals.phasesTotal + facts.phasesTotal,
    phasesCompleted: totals.phasesCompleted + facts.phasesCompleted,
    phasesSkipped: totals.phasesSkipped + facts.phasesSkipped,
    backendInvocations: totals.backendInvocations + facts.backendInvocations
  };
}

/** Build the two coverage windows the response states separately (T394/T396). */
export function buildMetricsCoverage(args: {
  readonly rollupAvailable: boolean;
  readonly rollupRuns: number;
  readonly rollupEarliest?: string;
  readonly rollupLatest?: string;
  readonly logEarliest?: string;
  readonly logLatest?: string;
  readonly includesArchives: boolean;
}): MetricsCoverage {
  return {
    totals: {
      available: args.rollupAvailable,
      ...(args.rollupEarliest === undefined ? {} : { earliest: args.rollupEarliest }),
      ...(args.rollupLatest === undefined ? {} : { latest: args.rollupLatest }),
      runs: args.rollupRuns
    },
    detail: {
      ...(args.logEarliest === undefined ? {} : { earliest: args.logEarliest }),
      ...(args.logLatest === undefined ? {} : { latest: args.logLatest }),
      includesArchives: args.includesArchives
    }
  };
}

function readTerminalStatus(value: unknown): RollupTerminalStatus | undefined {
  return value === 'completed' || value === 'failed' || value === 'canceled' ? value : undefined;
}

function readTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

function readCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}
