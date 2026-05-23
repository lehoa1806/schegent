import { describe, expect, it } from 'vitest';
import { deriveOperatorHealth } from '../derive-operator-health';
import type { QueueItem, WorkflowSnapshot } from '../snapshot-types';

function item(overrides: Partial<QueueItem>): QueueItem {
  return {
    id: overrides.id ?? 'task-1',
    label: overrides.label ?? 'Task',
    enqueuedAt: '2026-05-10T00:00:00.000Z',
    startedAt: null,
    updatedAt: '2026-05-10T00:00:00.000Z',
    completedAt: null,
    status: overrides.status ?? 'pending',
    retryCount: overrides.retryCount ?? 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: null,
    position: 0
  };
}

function snapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return {
    schemaVersion: 3,
    isPrimary: true,
    status: 'idle',
    activeFeature: null,
    phases: [],
    queue: {
      orderedItems: [],
      inFlight: null,
      pending: [],
      recent: [],
      paused: false
    },
    auditTail: [],
    liveActivity: {
      summary: null,
      category: null,
      lastEventAt: null,
      freshness: 'idle',
      staleSeconds: null
    },
    workflowElapsedMs: null,
    monitor: null,
    history: [],
    producedAt: '2026-05-10T00:00:00.000Z',
    ...overrides
  } as unknown as WorkflowSnapshot;
}

describe('deriveOperatorHealth', () => {
  it('returns ok for an idle clean snapshot', () => {
    expect(deriveOperatorHealth(snapshot())).toMatchObject({
      level: 'ok',
      label: 'health ok'
    });
  });

  it('prioritizes stalled activity over queue counts', () => {
    expect(
      deriveOperatorHealth(snapshot({
        liveActivity: {
          summary: 'old',
          category: 'warning',
          lastEventAt: '2026-05-10T00:00:00.000Z',
          freshness: 'stalled',
          staleSeconds: 120
        },
        queue: {
          orderedItems: [],
          inFlight: null,
          pending: [],
          recent: [item({ status: 'failed' })],
          paused: false
        }
      }))
    ).toMatchObject({ level: 'blocked', label: 'activity stalled' });
  });

  it('surfaces scheduled delayed retries', () => {
    expect(
      deriveOperatorHealth(snapshot({
        delayedRetry: {
          pendingRetryAt: '2026-05-10T00:05:00.000Z',
          pendingRetryCause: 'rate_limit',
          delayedRetryCount: 2
        }
      }))
    ).toMatchObject({ level: 'attention', label: 'rate-limit retry' });
  });
});
