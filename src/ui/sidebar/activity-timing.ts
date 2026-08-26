import type { PhaseName } from '../../contracts/phase-identity';
import { computeFreshness } from './freshness';
import {
  IDLE_LIVE_ACTIVITY,
  type AuditCategory,
  type LiveActivity,
  type WorkflowStatus
} from './snapshot';

export interface ActivityCache {
  readonly summary: string;
  readonly category: AuditCategory;
  readonly isoAt: string;
}

export function computePhaseElapsedMs(input: {
  readonly phaseName: PhaseName;
  readonly isActive: boolean;
  readonly cumulativePhaseMs: ReadonlyMap<PhaseName, number>;
  readonly phaseStartMonotonic: number | null;
  readonly pausedSinceMonotonic: number | null;
  readonly status: WorkflowStatus;
  readonly monotonicNow: () => number;
}): number {
  const cumulative = input.cumulativePhaseMs.get(input.phaseName) ?? 0;
  if (!input.isActive || input.phaseStartMonotonic === null) {
    return Math.max(0, Math.floor(cumulative));
  }
  const end = input.status === 'paused' && input.pausedSinceMonotonic !== null
    ? input.pausedSinceMonotonic
    : input.monotonicNow();
  return Math.max(
    0,
    Math.floor(cumulative + Math.max(0, end - input.phaseStartMonotonic))
  );
}

export function computeWorkflowElapsedMs(input: {
  readonly workflowStartMonotonic: number | null;
  readonly pausedSinceMonotonic: number | null;
  readonly cumulativePausedMs: number;
  readonly status: WorkflowStatus;
  readonly monotonicNow: () => number;
}): number | null {
  if (input.workflowStartMonotonic === null || input.status === 'idle') return null;
  const end = input.status === 'paused' && input.pausedSinceMonotonic !== null
    ? input.pausedSinceMonotonic
    : input.monotonicNow();
  return Math.max(
    0,
    Math.floor(end - input.workflowStartMonotonic - input.cumulativePausedMs)
  );
}

export function computeLiveActivity(input: {
  readonly status: WorkflowStatus;
  readonly lastActivityAtMonotonic: number | null;
  readonly pausedSinceMonotonic: number | null;
  readonly cache: ActivityCache | null;
  readonly monotonicNow: () => number;
}): LiveActivity {
  if (
    input.status === 'idle' ||
    input.status === 'completed' ||
    input.status === 'canceled'
  ) return IDLE_LIVE_ACTIVITY;
  const end = input.status === 'paused' && input.pausedSinceMonotonic !== null
    ? input.pausedSinceMonotonic
    : input.monotonicNow();
  const msSince = input.lastActivityAtMonotonic === null
    ? null
    : Math.max(0, end - input.lastActivityAtMonotonic);
  const freshness = computeFreshness(input.status, msSince);
  const staleSeconds = freshness === 'idle' || msSince === null
    ? null
    : Math.max(0, Math.floor(msSince / 1_000));
  return Object.freeze({
    summary: input.cache?.summary ?? null,
    category: input.cache?.category ?? null,
    lastEventAt: input.cache?.isoAt ?? null,
    freshness,
    staleSeconds: freshness === 'idle' ? null : staleSeconds
  });
}
