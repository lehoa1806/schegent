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

/**
 * FR-R3-082 (T1091) — the carry-forward header a trim leaves behind.
 *
 * `FR-R3-009` built this rollup so a pruned archive could not make a reported
 * cost go backwards. A trim that discards records would reintroduce exactly
 * that, so the discarded records' contribution is folded into a header written
 * ahead of the retained ones and every reader sums `header.totals + Σ(records)`.
 * The monotonicity is then STRUCTURAL rather than incidental: there is no
 * arrangement of retained records that can lose it.
 *
 * `runs` is carried separately from `totals.runs` because a reader reports the
 * rollup's own run count as well as the totals, and a trimmed rollup has fewer
 * records than runs — a discrepancy that would otherwise read as data loss.
 */
export interface MetricsRollupCarryForward {
  readonly totals: CumulativeTotals;
  readonly runs: number;
  readonly trimmedThrough: string;
}

export interface RollupParseResult {
  readonly record: MetricsRollupRecord | null;
  /** FR-R3-082 — set when the line is the trim's carry-forward header. */
  readonly carryForward?: MetricsRollupCarryForward;
  /** Set when the line was present but unusable; the caller counts it. */
  readonly warning?: string;
}

/** FR-R3-082 — the header's line kind, written and read in one place. */
export const CARRY_FORWARD_KIND = 'carry-forward';

export function serializeCarryForward(header: MetricsRollupCarryForward): string {
  return `${JSON.stringify({
    v: METRICS_ROLLUP_SCHEMA_VERSION,
    kind: CARRY_FORWARD_KIND,
    totals: header.totals,
    runs: header.runs,
    trimmedThrough: header.trimmedThrough
  })}\n`;
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

  // FR-R3-082 (T1091) — the trim's header. Read before the version gate below
  // for the same reason it is written first: it is a different kind of line, not
  // a malformed record, and reporting it as `unsupported-version` would make a
  // trimmed rollup look corrupt.
  if (raw.kind === CARRY_FORWARD_KIND) {
    const totals = readCumulativeTotals(raw.totals);
    if (totals === null) return { record: null, warning: 'invalid-carry-forward' };
    const runs = typeof raw.runs === 'number' && Number.isFinite(raw.runs) ? raw.runs : 0;
    const trimmedThrough = typeof raw.trimmedThrough === 'string' ? raw.trimmedThrough : '';
    return { record: null, carryForward: { totals, runs, trimmedThrough } };
  }

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
/**
 * FR-R3-082 — read a header's totals, refusing anything that is not the shape.
 *
 * A header whose totals cannot be read is refused rather than treated as zero:
 * zero would silently lose exactly the history the header exists to preserve,
 * which is the failure this whole record was built to prevent.
 */
function readCumulativeTotals(value: unknown): CumulativeTotals | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const num = (key: keyof CumulativeTotals): number | null => {
    const v = raw[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const fields = [
    'runs',
    'completedRuns',
    'failedRuns',
    'canceledRuns',
    'durationMs',
    'costUsd',
    'phasesTotal',
    'phasesCompleted',
    'phasesSkipped',
    'backendInvocations'
  ] as const;
  const out: Record<string, number | boolean> = {};
  for (const field of fields) {
    const parsed = num(field);
    if (parsed === null) return null;
    out[field] = parsed;
  }
  out.costUsdIsPartial = raw.costUsdIsPartial === true;
  return out as unknown as CumulativeTotals;
}

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
  foldTasks: readonly TaskRecord[],
  /**
   * FR-R3-082 (T1091) — what a trim discarded, as a base to start from.
   *
   * Optional, and absent means zero, so a rollup written before trimming existed
   * composes exactly as it always did — no schema version moves for this.
   *
   * Added to the totals rather than folded into `byRunId`, because the header
   * holds totals and not runs: the discarded records are gone, and inventing
   * synthetic facts for them to re-derive the same numbers would be a longer
   * road to the same place with more ways to be wrong.
   */
  carryForward?: MetricsRollupCarryForward
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

  let totals = carryForward?.totals ?? EMPTY_CUMULATIVE_TOTALS;
  for (const facts of byRunId.values()) totals = accumulate(totals, facts);

  // The rollup's own run count includes what the trim carried forward: a
  // trimmed rollup has fewer RECORDS than RUNS, and reporting the record count
  // as the run count would read as history that had gone missing.
  return {
    totals,
    rollupRuns: rollupRuns + (carryForward?.runs ?? 0),
    rollupEarliest,
    rollupLatest
  };
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
