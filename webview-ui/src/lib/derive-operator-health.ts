import {
  IDLE_DELAYED_RETRY,
  IDLE_EVIDENCE_HEALTH,
  type DelayedRetryState,
  type QueueItem,
  type WorkflowSnapshot
} from './snapshot-types';
import { defaultQueueRuntime } from './queue-runtime-view';

export type OperatorHealthLevel = 'ok' | 'attention' | 'blocked';

export interface OperatorHealth {
  readonly level: OperatorHealthLevel;
  readonly label: string;
  readonly title: string;
}

export function deriveOperatorHealth(snapshot: WorkflowSnapshot | null): OperatorHealth {
  if (snapshot === null) {
    return {
      level: 'ok',
      label: 'idle',
      title: 'No workspace snapshot has been received yet'
    };
  }

  // Feature 092 — health is reported for the default queue's Run; a second
  // queue's stall belongs to that queue's own row, not to this banner.
  const runtime = defaultQueueRuntime(snapshot);
  const delayedRetry = (runtime?.inFlightRun?.delayedRetry ?? IDLE_DELAYED_RETRY) as DelayedRetryState;
  const items = queueItems(snapshot);
  const failed = items.filter((item) => item.status === 'failed').length;
  const retryTotal = items.reduce((sum, item) => sum + Math.max(0, item.retryCount ?? 0), 0);
  const evidenceHealth = snapshot.evidenceHealth ?? IDLE_EVIDENCE_HEALTH;

  if (evidenceHealth.overall === 'unavailable') {
    return {
      level: 'blocked',
      label: 'evidence unavailable',
      title: 'The required structured audit sink failed; inspect the sanitized runtime or Output log before continuing'
    };
  }
  if (evidenceHealth.overall === 'degraded') {
    const degraded = [
      evidenceHealth.rawTranscript.status === 'degraded' ? 'raw transcript' : null,
      evidenceHealth.runtimeLog.status === 'degraded' ? 'runtime log' : null,
      // FR-R3-009 — the rollup is named here for the same reason the other two
      // are: its failure is silent in the product until totals regress.
      evidenceHealth.metricsRollup?.status === 'degraded' ? 'metrics rollup' : null,
      // FR-R3-010 — an unreadable audit corpus does not stop a run, but it does
      // mean completed runs' evidence cannot be reached from history.
      evidenceHealth.historyPointer?.status === 'degraded' ? 'history evidence' : null
    ].filter((name): name is string => name !== null);
    return {
      level: 'attention',
      label: 'evidence degraded',
      title: `${joinNames(degraded)} evidence is incomplete; workflow execution remains available`
    };
  }

  if (runtime?.inFlightRun?.liveActivity?.freshness === 'stalled') {
    return {
      level: 'blocked',
      label: 'activity stalled',
      title: 'No recent audit or activity events have reached the sidebar'
    };
  }
  if (snapshot.queue.paused) {
    return {
      level: 'attention',
      label: 'queue paused',
      title: snapshot.queue.pausedReason ?? 'The default queue is paused'
    };
  }
  if (delayedRetry.pendingRetryAt !== null) {
    return {
      level: 'attention',
      label: delayedRetry.pendingRetryCause === 'rate_limit' ? 'rate-limit retry' : 'retry scheduled',
      title: `Retry ${delayedRetry.delayedRetryCount}/5 scheduled for ${delayedRetry.pendingRetryAt}`
    };
  }
  if (failed > 0) {
    return {
      level: 'attention',
      label: `${failed} failed`,
      title: `${failed} task${failed === 1 ? '' : 's'} need operator review`
    };
  }
  if (retryTotal > 0) {
    return {
      level: 'attention',
      label: `${retryTotal} retries`,
      title: `${retryTotal} retry attempt${retryTotal === 1 ? '' : 's'} recorded in the current queue view`
    };
  }
  return {
    level: 'ok',
    label: 'health ok',
    title: 'Queue, retry, and live-activity indicators are normal'
  };
}

// Two names read as "a and b"; three or more as "a, b and c". A single name
// passes through unchanged, which is the pre-FR-R3-009 wording.
function joinNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function queueItems(snapshot: WorkflowSnapshot): QueueItem[] {
  return [
    ...(snapshot.queue.inFlight ? [snapshot.queue.inFlight] : []),
    ...snapshot.queue.pending,
    ...snapshot.queue.recent
  ];
}
