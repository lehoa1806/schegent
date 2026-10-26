import type { FreshnessState, WorkflowStatus } from './snapshot';

export const STALE_LIVE_MAX_MS = 30_000;
export const STALE_SLOWING_MAX_MS = 90_000;

export function computeFreshness(
  status: WorkflowStatus,
  msSinceLastActivity: number | null,
  held = false
): FreshnessState {
  if (status === 'idle' || status === 'completed' || status === 'canceled') {
    return 'idle';
  }
  if (status === 'paused') {
    return 'paused';
  }
  // FR-R3-208 — a held Run that is still active reads holding, whatever its silence.
  if (held && status !== 'failed') return 'holding';
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
