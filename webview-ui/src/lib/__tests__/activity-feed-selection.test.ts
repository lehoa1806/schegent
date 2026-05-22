import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_ACTIVITY_FEED_SELECTION,
  reconcileActivityFeedSelection,
  resolveColdStartFallback,
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

// Feature 021 T045 (BUG-001 Defect A) — cold-start fallback unit
// coverage. Asserts the four cases from the bugfix patch in
// `specs/021-activity-feed-navigate/tasks.md`.
describe('resolveColdStartFallback (Feature 021 T043 / BUG-001 Defect A)', () => {
  it('(a) returns the recent task with on-disk iterations when one exists', () => {
    const snap = snapshot({
      recent: Object.freeze([
        item({
          id: 'run-with-logs',
          status: 'completed',
          queueId: 'default',
          completedAt: '2026-05-10T12:00:00.000Z',
          currentPipelineId: 'standard',
          currentPhase: 'speckit-plan'
        })
      ]) as readonly QueueItem[]
    });
    const fallback = resolveColdStartFallback(snap, (taskId) => taskId === 'run-with-logs');

    expect(fallback).not.toBeNull();
    expect(fallback?.queueId).toBe('default');
    expect(fallback?.taskId).toBe('run-with-logs');
    expect(fallback?.pipelineId).toBe('standard');
    expect(fallback?.phaseId).toBe('speckit-plan');
    expect(fallback?.iterationN).toBeNull();
    expect(fallback?.followMode).toBe('manual');
    expect(fallback?.manualLevel).toBe('task');
  });

  it('(b) returns null when no recent task has on-disk iterations', () => {
    const snap = snapshot({
      recent: Object.freeze([
        item({
          id: 'run-no-logs',
          status: 'completed',
          queueId: 'default',
          completedAt: '2026-05-10T12:00:00.000Z',
          currentPipelineId: 'standard'
        })
      ]) as readonly QueueItem[]
    });
    const predicate = vi.fn(() => false);

    expect(resolveColdStartFallback(snap, predicate)).toBeNull();
    expect(predicate).toHaveBeenCalledWith('run-no-logs');
  });

  it('(c) tiebreaks on enqueuedAt when updatedAt values are equal', () => {
    const sharedUpdated = '2026-05-10T12:00:00.000Z';
    const snap = snapshot({
      recent: Object.freeze([
        item({
          id: 'run-older',
          status: 'completed',
          queueId: 'default',
          enqueuedAt: '2026-05-10T09:00:00.000Z',
          updatedAt: sharedUpdated,
          completedAt: sharedUpdated,
          currentPipelineId: 'standard',
          currentPhase: 'speckit-specify'
        }),
        item({
          id: 'run-newer',
          status: 'completed',
          queueId: 'default',
          enqueuedAt: '2026-05-10T11:00:00.000Z',
          updatedAt: sharedUpdated,
          completedAt: sharedUpdated,
          currentPipelineId: 'standard',
          currentPhase: 'speckit-plan'
        })
      ]) as readonly QueueItem[]
    });
    const fallback = resolveColdStartFallback(snap, () => true);

    expect(fallback?.taskId).toBe('run-newer');
    expect(fallback?.phaseId).toBe('speckit-plan');
  });

  it('(d) the helper is independent of inFlight state — the caller guards against live runs', () => {
    // The T044 wiring guard (in PhaseLogFeed.svelte) refuses to invoke
    // the helper when `resolveLiveSelection` returns a non-null
    // selection. The helper itself simply ranks the recent tasks; this
    // test pins that behaviour so the wiring remains the
    // single point of guard logic.
    const snap = snapshot({
      inFlight: item({
        id: 'run-active',
        status: 'in-flight',
        queueId: 'default',
        currentPhase: 'speckit-plan',
        currentPipelineId: 'standard'
      }),
      recent: Object.freeze([
        item({
          id: 'run-with-logs',
          status: 'completed',
          queueId: 'default',
          completedAt: '2026-05-10T12:00:00.000Z',
          currentPipelineId: 'standard',
          currentPhase: 'speckit-plan'
        })
      ]) as readonly QueueItem[]
    });
    const live = resolveLiveSelection(snap);
    expect(live).not.toBeNull();
    // If the caller obeys the guard, it will not call the helper. We
    // still pin the helper's pure behaviour: when invoked with a
    // populated recent list it always picks the ranked winner.
    const fallback = resolveColdStartFallback(snap, () => true);
    expect(fallback?.taskId).toBe('run-with-logs');
  });
});
