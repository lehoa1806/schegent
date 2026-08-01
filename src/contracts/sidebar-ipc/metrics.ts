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
  readonly meta: {
    readonly includesArchives: boolean;
    readonly totalScannedEntries: number;
    readonly parseWarnings: number;
  };
}
