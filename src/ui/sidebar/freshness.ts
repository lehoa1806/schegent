import type { FreshnessState, WorkflowStatus } from './snapshot';

export const STALE_LIVE_MAX_MS = 30_000;
export const STALE_SLOWING_MAX_MS = 90_000;

export function computeFreshness(
  status: WorkflowStatus,
  msSinceLastActivity: number | null
): FreshnessState {
  if (status === 'idle' || status === 'completed' || status === 'canceled') {
    return 'idle';
  }
  if (status === 'paused') {
    return 'paused';
  }
  if (msSinceLastActivity === null) {
    return 'live';
  }
  if (msSinceLastActivity < STALE_LIVE_MAX_MS) {
    return 'live';
  }
  if (msSinceLastActivity < STALE_SLOWING_MAX_MS) {
    return 'slowing';
  }
  return 'stalled';
}
