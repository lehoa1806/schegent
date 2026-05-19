import {
  IDLE_DELAYED_RETRY,
  type DelayedRetryState,
  type QueueItem,
  type WorkflowSnapshot
} from './snapshot-types';

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

  const delayedRetry = (snapshot.delayedRetry ?? IDLE_DELAYED_RETRY) as DelayedRetryState;
  const items = queueItems(snapshot);
  const failed = items.filter((item) => item.status === 'failed').length;
  const retryTotal = items.reduce((sum, item) => sum + Math.max(0, item.retryCount ?? 0), 0);

  if (snapshot.liveActivity?.freshness === 'stalled') {
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

function queueItems(snapshot: WorkflowSnapshot): QueueItem[] {
  return [
    ...(snapshot.queue.inFlight ? [snapshot.queue.inFlight] : []),
    ...snapshot.queue.pending,
    ...snapshot.queue.recent
  ];
}
