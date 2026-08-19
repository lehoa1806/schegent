import type { CMD_READ_METRICS, CommandBase } from '../sidebar-ipc';

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

export interface ReadMetricsRequest {
  readonly includeArchives?: boolean;
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
  readonly meta: {
    readonly includesArchives: boolean;
    readonly totalScannedEntries: number;
    readonly parseWarnings: number;
  };
}
