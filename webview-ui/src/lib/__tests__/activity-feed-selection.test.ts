import { describe, expect, it } from 'vitest';
import {
  EMPTY_ACTIVITY_FEED_SELECTION,
  reconcileActivityFeedSelection,
  resolveLiveSelection,
  selectActivityFeedQueue,
  selectActivityFeedTask
} from '../activity-feed-selection.svelte';
import type {
  HistoryEntry,
  PhaseTile,
  PipelineDefinition,
  QueueItem,
  QueueProjection,
  QueueSummary,
  WorkflowSnapshot
} from '../snapshot-types';

function phase(name: string, order: number, state: PhaseTile['state']): PhaseTile {
  return Object.freeze({
    name,
    order,
    state,
    iteration: 1,
    lastResult: null,
    elapsedMs: 0,
    subProgress: null
  });
}

function item(overrides: Partial<QueueItem> & { id: string; status: QueueItem['status'] }): QueueItem {
  const { id, status, ...rest } = overrides;
  return Object.freeze({
    id,
    label: id,
    enqueuedAt: '2026-05-10T10:00:00.000Z',
    startedAt: null,
    updatedAt: '2026-05-10T10:00:00.000Z',
    completedAt: null,
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: null,
    status,
    position: 0,
    ...rest
  });
}

function queueSummary(id: string): QueueSummary {
  return Object.freeze({
    id,
    name: id,
    position: 0,
    state: 'active',
    pauseSource: null,
    schedule: null,
    taskCount: 1
  });
}

function snapshot(queue: Partial<QueueProjection>): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 3,
    isPrimary: true,
    status: 'running',
    activeFeature: null,
    phases: Object.freeze([
      phase('speckit-specify', 1, 'completed'),
      phase('speckit-plan', 2, 'active'),
      phase('speckit-tasks', 3, 'not-started')
    ]),
    queue: Object.freeze({
      inFlight: null,
      pending: Object.freeze([]) as readonly QueueItem[],
      recent: Object.freeze([]) as readonly QueueItem[],
      paused: false,
      queues: Object.freeze([queueSummary('default'), queueSummary('work')]),
      ...queue
    }),
    auditTail: Object.freeze([]),
    liveActivity: Object.freeze({
      summary: null,
      category: null,
      lastEventAt: null,
      freshness: 'idle',
      staleSeconds: 0
    }),
    workflowElapsedMs: 0,
    monitor: null,
    history: Object.freeze([]) as readonly HistoryEntry[],
    producedAt: '2026-05-10T12:00:00.000Z',
    activePipeline: Object.freeze({ id: 'standard', name: 'Standard' }),
    availablePipelines: Object.freeze([
      Object.freeze({
        id: 'standard',
        name: 'Standard',
        phases: Object.freeze(['speckit-specify', 'speckit-plan', 'speckit-tasks'])
      }) as PipelineDefinition
    ]),
    availablePhases: Object.freeze([
      Object.freeze({ id: 'speckit-specify', name: 'Specify', instruction: '', loopable: false }),
      Object.freeze({ id: 'speckit-plan', name: 'Plan', instruction: '', loopable: false }),
      Object.freeze({ id: 'speckit-tasks', name: 'Tasks', instruction: '', loopable: false })
    ]),
    availableModels: Object.freeze([])
  } as WorkflowSnapshot);
}

describe('activity-feed-selection helpers', () => {
  it('queue selection prefers the in-flight task and its current phase', () => {
    const snap = snapshot({
      inFlight: item({
        id: 'run-active',
        status: 'in-flight',
        queueId: 'work',
        currentPhase: 'speckit-plan',
        currentPipelineId: 'standard'
      })
    });

    const selection = selectActivityFeedQueue(snap, 'work');

    expect(selection.queueId).toBe('work');
    expect(selection.taskId).toBe('run-active');
    expect(selection.phaseId).toBe('speckit-plan');
    expect(selection.followMode).toBe('manual');
    expect(selection.manualLevel).toBe('queue');
  });

  it('task selection falls back to the active phase when the task has no current phase', () => {
    const snap = snapshot({
      recent: Object.freeze([
        item({
          id: 'run-recent',
          status: 'completed',
          queueId: 'default',
          completedAt: '2026-05-10T12:00:00.000Z',
          currentPipelineId: 'standard'
        })
      ]) as readonly QueueItem[]
    });

    const selection = selectActivityFeedTask(snap, 'run-recent');

    expect(selection.taskId).toBe('run-recent');
    expect(selection.phaseId).toBe('speckit-plan');
  });

  it('live selection resolves to the in-flight task/current phase', () => {
    const snap = snapshot({
      inFlight: item({
        id: 'run-live',
        status: 'in-flight',
        queueId: 'default',
        currentPhase: 'speckit-tasks',
        currentPipelineId: 'standard'
      })
    });

    expect(resolveLiveSelection(snap)).toMatchObject({
      queueId: 'default',
      taskId: 'run-live',
      phaseId: 'speckit-tasks',
      followMode: 'live'
    });
  });

  it('reconcile replaces a disappeared selected task with the best remaining task', () => {
    const snap = snapshot({
      recent: Object.freeze([
        item({
          id: 'remaining',
          status: 'completed',
          queueId: 'default',
          completedAt: '2026-05-10T12:00:00.000Z',
          currentPipelineId: 'standard'
        })
      ]) as readonly QueueItem[]
    });

    const selection = reconcileActivityFeedSelection(snap, {
      ...EMPTY_ACTIVITY_FEED_SELECTION,
      queueId: 'default',
      taskId: 'missing',
      pipelineId: 'standard',
      phaseId: 'speckit-specify',
      followMode: 'manual',
      manualLevel: 'task'
    });

    expect(selection.taskId).toBe('remaining');
    expect(selection.phaseId).toBe('speckit-plan');
  });
});
