import { describe, expect, it } from 'vitest';
import { deriveOperatorHealth } from '../derive-operator-health';
import type { QueueItem, WorkflowSnapshot } from '../snapshot-types';
import { foldLegacyRun, type LegacyRunFields } from './queue-runtime-fixture';

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

function snapshot(overrides: Partial<WorkflowSnapshot> & LegacyRunFields = {}): WorkflowSnapshot {
  const { status, activeFeature, phases, liveActivity, workflowElapsedMs, delayedRetry, ...rest } =
    overrides;
  return {
    schemaVersion: 4,
    isPrimary: true,
    // Feature 092 — the v3 root run singulars now hang off the queue that owns
    // the Run. `foldLegacyRun` performs that fold, so the call sites below keep
    // their v3 wording.
    queues: foldLegacyRun({
      status: status ?? 'idle',
      activeFeature: activeFeature ?? null,
      phases: phases ?? [],
      liveActivity: liveActivity ?? ({
      summary: null,
      category: null,
      lastEventAt: null,
      freshness: 'idle',
      staleSeconds: null
      }),
      workflowElapsedMs: workflowElapsedMs ?? null,
      delayedRetry
    }),
    queue: {
      orderedItems: [],
      inFlight: null,
      pending: [],
      recent: [],
      paused: false
    },
    auditTail: [],
    monitor: null,
    history: [],
    producedAt: '2026-05-10T00:00:00.000Z',
    ...rest
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

  it('prioritizes required audit unavailability over workflow state', () => {
    expect(deriveOperatorHealth(snapshot({
      evidenceHealth: {
        overall: 'unavailable',
        audit: {
          status: 'unavailable',
          continuationPolicy: 'fail-closed',
          failureCount: 1,
          lastFailureAt: '2026-08-01T00:00:00.000Z',
          cause: 'disk-full'
        },
        rawTranscript: {
          status: 'healthy', continuationPolicy: 'continue-degraded', failureCount: 0,
          lastFailureAt: null, cause: null
        },
        runtimeLog: {
          status: 'healthy', continuationPolicy: 'continue-degraded', failureCount: 0,
          lastFailureAt: null, cause: null
        },
        metricsRollup: {
          status: 'healthy', continuationPolicy: 'continue-degraded', failureCount: 0,
          lastFailureAt: null, cause: null
        },
        historyPointer: {
          status: 'healthy', continuationPolicy: 'continue-degraded', failureCount: 0,
          lastFailureAt: null, cause: null
        }
      }
    }))).toMatchObject({ level: 'blocked', label: 'evidence unavailable' });
  });

  it('surfaces optional sink degradation as attention', () => {
    expect(deriveOperatorHealth(snapshot({
      evidenceHealth: {
        overall: 'degraded',
        audit: {
          status: 'healthy', continuationPolicy: 'fail-closed', failureCount: 0,
          lastFailureAt: null, cause: null
        },
        rawTranscript: {
          status: 'degraded', continuationPolicy: 'continue-degraded', failureCount: 1,
          lastFailureAt: '2026-08-01T00:00:00.000Z', cause: 'stream-error'
        },
        runtimeLog: {
          status: 'healthy', continuationPolicy: 'continue-degraded', failureCount: 0,
          lastFailureAt: null, cause: null
        },
        metricsRollup: {
          status: 'healthy', continuationPolicy: 'continue-degraded', failureCount: 0,
          lastFailureAt: null, cause: null
        },
        historyPointer: {
          status: 'healthy', continuationPolicy: 'continue-degraded', failureCount: 0,
          lastFailureAt: null, cause: null
        }
      }
    }))).toMatchObject({ level: 'attention', label: 'evidence degraded' });
  });

  // FR-R3-009 T396 — a failed rollup append is silent in the product until
  // cumulative totals regress after a rotation, so the banner has to name it.
  it('names the metrics rollup among the degraded sinks', () => {
    const health = deriveOperatorHealth(snapshot({
      evidenceHealth: {
        overall: 'degraded',
        audit: {
          status: 'healthy', continuationPolicy: 'fail-closed', failureCount: 0,
          lastFailureAt: null, cause: null
        },
        rawTranscript: {
          status: 'degraded', continuationPolicy: 'continue-degraded', failureCount: 1,
          lastFailureAt: '2026-08-01T00:00:00.000Z', cause: 'stream-error'
        },
        runtimeLog: {
          status: 'degraded', continuationPolicy: 'continue-degraded', failureCount: 1,
          lastFailureAt: '2026-08-01T00:00:00.000Z', cause: 'io-error'
        },
        metricsRollup: {
          status: 'degraded', continuationPolicy: 'continue-degraded', failureCount: 2,
          lastFailureAt: '2026-08-01T00:00:00.000Z', cause: 'io-error'
        },
        historyPointer: {
          status: 'healthy', continuationPolicy: 'continue-degraded', failureCount: 0,
          lastFailureAt: null, cause: null
        }
      }
    }));
    expect(health).toMatchObject({ level: 'attention', label: 'evidence degraded' });
    expect(health.title).toBe(
      'raw transcript, runtime log and metrics rollup evidence is incomplete; workflow execution remains available'
    );
  });
});
