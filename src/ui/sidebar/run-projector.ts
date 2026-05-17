// Feature 048 — pure-function run/lock/delayed-retry projection extracted from
// `state-projector.ts`. These helpers are deterministic on their inputs;
// memoization can wrap them at the orchestrator level when callers care.
import type { WorkflowRun, WorkspaceLock } from '../../state/workflow-run';
import { STALENESS_THRESHOLD_MS } from '../../state/lock';
import {
  IDLE_DELAYED_RETRY,
  type ActiveFeatureSummary,
  type DelayedRetryState,
  type WorkflowStatus
} from './snapshot';

export function computeIsPrimary(
  ownerId: string,
  lock: WorkspaceLock | null,
  nowMs: number
): boolean {
  if (!lock) return true;
  if (nowMs - lock.heartbeatAt > STALENESS_THRESHOLD_MS) return true;
  return lock.ownerId === ownerId;
}

export function mapRunStatus(run: WorkflowRun): WorkflowStatus {
  switch (run.status) {
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'failed':
      return 'failed';
    case 'completed':
      return 'completed';
    case 'canceled':
      return 'canceled';
    default:
      return 'idle';
  }
}

export function buildActiveFeature(run: WorkflowRun): ActiveFeatureSummary {
  return {
    id: run.featureId,
    label: run.featureDir,
    startedAt: new Date(run.startedAt).toISOString()
  };
}

/**
 * Feature 011 — surface delayed-retry state on the snapshot. When no run
 * is active or there is no pending retry, returns the IDLE constant so
 * webview gating (`pendingRetryAt !== null`) reliably resolves to false.
 */
export function projectDelayedRetry(run: WorkflowRun | null): DelayedRetryState {
  if (!run) return IDLE_DELAYED_RETRY;
  const count = run.delayedRetryCount ?? 0;
  const pendingAt = run.pendingRetryAt ?? null;
  const cause = run.pendingRetryCause ?? null;
  if (pendingAt === null && cause === null && count === 0) return IDLE_DELAYED_RETRY;
  return Object.freeze({
    pendingRetryAt: pendingAt !== null ? new Date(pendingAt).toISOString() : null,
    pendingRetryCause: cause,
    delayedRetryCount: count
  });
}
