import type { CMD_READ_METRICS, CommandBase } from '../sidebar-ipc';
// The identifier length bound every id crossing this boundary gets. Imported
// rather than restated: two copies of 256 are two things to keep in step, and
// `validators/shared` only type-imports back, so nothing circular is created.
import { QUEUE_ID_MAX } from '../validators/shared';

// Canonical metrics wire entities derived from .schegent/audit.log.
export interface PhaseRecord {
  readonly runId: string;
  readonly phaseType: string;
  readonly iteration: number;
  readonly startTime: string;
  readonly endTime?: string;
  readonly durationMs?: number;
  readonly backendInvocations: number;
  readonly costUsd?: number;
  readonly outcome?: 'completed' | 'failed' | 'jumped' | 'paused-at-breakpoint' | 'skipped';
  readonly rawOutcome?: string;
}

export interface TaskRecord {
  readonly runId: string;
  readonly taskId?: string;
  readonly description: string;
  readonly startTime: string;
  readonly endTime?: string;
  readonly durationMs: number;
  readonly status?: 'completed' | 'failed' | 'canceled';
  readonly isRunning: boolean;
  readonly phasesTotal: number;
  readonly phasesCompleted: number;
  readonly phasesSkipped: number;
  readonly totalCostUsd?: number;
  readonly totalBackendInvocations: number;
  readonly phases: readonly PhaseRecord[];
  readonly source: 'task-lifecycle' | 'phase-reconstruction';
}

export interface PhaseTypeAggregate {
  readonly phaseType: string;
  readonly executionCount: number;
  readonly totalDurationMs: number;
  readonly avgDurationMs: number;
  readonly p50DurationMs: number;
  readonly p90DurationMs: number;
  readonly p99DurationMs: number;
  readonly longestDurationMs: number;
  readonly shortestDurationMs: number;
  readonly totalBackendInvocations: number;
  readonly totalCostUsd?: number;
}

export interface CostTimelinePoint {
  readonly date: string;
  readonly dailyCostUsd: number;
  readonly cumulativeCostUsd: number;
}

// Feature FR-R3-009 (T394) — cumulative totals and the horizon they cover.
//
// `CostTimelinePoint.cumulativeCostUsd` above is a running total *within the
// returned series*, and the series is a fold over whatever the audit corpus
// still retains. It therefore decreases when rotation prunes an archive.
// `CumulativeTotals` is the durable counterpart: composed from the append-only
// rollup (written once per terminal run, while the evidence is still present)
// unioned with the terminal runs the retained log still shows, deduplicated by
// run id. It is monotonic for a given workspace.
export interface CumulativeTotals {
  readonly runs: number;
  readonly completedRuns: number;
  readonly failedRuns: number;
  readonly canceledRuns: number;
  readonly durationMs: number;
  readonly costUsd: number;
  /**
   * True when at least one counted run recorded no cost, so `costUsd` is a
   * lower bound rather than a total. Reported rather than hidden: a run whose
   * phases never reported cost is indistinguishable from a free one.
   */
  readonly costUsdIsPartial: boolean;
  readonly phasesTotal: number;
  readonly phasesCompleted: number;
  readonly phasesSkipped: number;
  readonly backendInvocations: number;
}

/**
 * The two windows a metrics read covers, stated separately so a figure is
 * never presented as all-time when it is not.
 *
 * `totals` is the rollup's range — what `CumulativeTotals` is backed by.
 * `detail` is the retained audit corpus's range — what `tasks`,
 * `phaseTypeAggregates`, and `costTimeline` are derived from.
 */
export interface MetricsCoverage {
  readonly totals: {
    /** False when no rollup file exists yet; totals then cover only `detail`. */
    readonly available: boolean;
    readonly earliest?: string;
    readonly latest?: string;
    /** Terminal runs the rollup itself accounts for. */
    readonly runs: number;
  };
  readonly detail: {
    readonly earliest?: string;
    readonly latest?: string;
    readonly includesArchives: boolean;
  };
}

/**
 * Feature 103 (T092, FR-023, FR-025) — one terminal run as the durable rollup
 * recorded it.
 *
 * This is `MetricsRollupRecord` minus its storage schema marker: the marker
 * says how to read a line off disk and means nothing on the wire, and a reader
 * that saw it would have a second version number to reason about. The rollup
 * declares its record as extending this one, so the two cannot drift.
 *
 * Distinct from `TaskRecord` on purpose. A `TaskRecord` is folded from the
 * retained audit corpus, which rotates on its own schedule; History does not,
 * so a run History still lists can have no `TaskRecord` at all. Its cost and
 * phase counts are here, written once while the evidence was still present.
 */
export interface MetricsRunSummary {
  readonly runId: string;
  readonly terminalStatus: 'completed' | 'failed' | 'canceled';
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly phasesTotal: number;
  readonly phasesCompleted: number;
  readonly phasesSkipped: number;
  readonly backendInvocations: number;
  /**
   * Absent — never zero — when nothing reported a cost. A run that reported
   * nothing is not a run that cost nothing, and the reader has to be able to
   * tell which it is looking at.
   */
  readonly costUsd?: number;
}

/**
 * Feature 103 (T092, FR-023) — how many runs one metrics read may be scoped to.
 *
 * The surface asks for one: the detail it is opening. The bound exists because
 * the list is webview-supplied and every id costs a pass over the rollup. The
 * headroom above one is for a future multi-select, not for a whole-history
 * request — FR-023 rules that out on its own.
 */
export const READ_METRICS_RUN_IDS_MAX = 64;

/**
 * Feature 103 (T092, FR-023) — a bounded list of non-empty run ids.
 *
 * Lives here so `isCmdReadMetrics` and `validateReadMetrics` share one answer
 * to "is this list acceptable". A guard that admitted a list the validator
 * rejects would let the two disagree about what a valid command is.
 */
export function isReadMetricsRunIdList(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > READ_METRICS_RUN_IDS_MAX) return false;
  return value.every(
    (runId) => typeof runId === 'string' && runId.length > 0 && runId.length <= QUEUE_ID_MAX
  );
}

export interface ReadMetricsRequest {
  readonly includeArchives?: boolean;
  /**
   * Feature 103 (T092, FR-023) — scope the summaries to these runs. Additive:
   * omitted means today's request, and today's request gets today's response.
   * Bounded by `READ_METRICS_RUN_IDS_MAX` at the boundary, because the list
   * arrives from the webview and an unbounded one is an unbounded scan.
   */
  readonly runIds?: readonly string[];
}

/**
 * The whole payload rule for a read-metrics command, in one place.
 *
 * Feature 073 required the payload to be present and `includeArchives` to be a
 * boolean when given; Feature 103 (T092, FR-023) added `runIds`, held to the
 * same bound as the validator — a guard that admitted a list the validator
 * rejects would let the two disagree about what a valid command is. An empty
 * object satisfies it, which is what `ReadMetricsCommand`'s field comment means
 * by a required payload.
 *
 * Here rather than in the barrel beside `isCmdReadMetrics` for the reason the
 * Feature 087 entry in the barrel's LOC budget records: a payload predicate
 * that needs none of the barrel's runtime values belongs beside the shape it
 * describes, and only the discriminator check has to stay behind.
 */
export function isReadMetricsRequest(value: unknown): value is ReadMetricsRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const { includeArchives, runIds } = value as { includeArchives?: unknown; runIds?: unknown };
  if (includeArchives !== undefined && typeof includeArchives !== 'boolean') return false;
  return runIds === undefined || isReadMetricsRunIdList(runIds);
}

export interface ReadMetricsCommand extends CommandBase<typeof CMD_READ_METRICS> {
  readonly payload: ReadMetricsRequest;
}

export interface ReadMetricsResponse {
  readonly tasks: readonly TaskRecord[];
  readonly phaseTypeAggregates: readonly PhaseTypeAggregate[];
  readonly costTimeline: readonly CostTimelinePoint[];
  readonly oldestIncludedTimestamp?: string;
  readonly cumulative: CumulativeTotals;
  readonly coverage: MetricsCoverage;
  /**
   * Feature 103 (T092) — present only when the request carried `runIds`, and
   * then holding a record for each asked-for run that has one. Omitted
   * entirely otherwise, so every consumer that predates the field keeps seeing
   * exactly the response it was written against.
   */
  readonly runSummaries?: readonly MetricsRunSummary[];
  readonly meta: {
    readonly includesArchives: boolean;
    readonly totalScannedEntries: number;
    readonly parseWarnings: number;
  };
}
