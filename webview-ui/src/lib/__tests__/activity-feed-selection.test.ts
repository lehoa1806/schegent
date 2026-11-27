import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_ACTIVITY_FEED_SELECTION,
  getTaskOptions,
  reconcileActivityFeedSelection,
  resolveColdStartFallback,
  resolveLiveSelection,
  selectActivityFeedQueue,
  selectActivityFeedTask
} from '../activity-feed-selection.svelte';
import type {
  BackendRunnerKind,
  HistoryEntry,
  PhaseTile,
  PipelineDefinition,
  QueueItem,
  QueueProjection,
  QueueRuntime,
  QueueSummary,
  WorkflowSnapshot
} from '../snapshot-types';
import { buildQueueRuntime, foldLegacyRun } from './queue-runtime-fixture';

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
    ...rest,
    phaseProgress: null
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
    taskCount: 1,
    failurePolicy: 'halt-on-failure',
    failurePolicyOverride: null
  });
}

// BUG-002 (T076) — the host lists each queue's rows in that queue's runtime
// `tasks`, which is where the helpers read a queue's Tasks (FR-018). A case
// names bucket rows; this files each under the runtime of its own queue.
function tasksOf(queueId: string, queue: Partial<QueueProjection>): readonly QueueItem[] {
  const rows = [...(queue.inFlight ? [queue.inFlight] : []), ...(queue.pending ?? []), ...(queue.recent ?? [])];
  return Object.freeze(rows.filter((row) => (row.queueId ?? 'default') === queueId));
}

function historyEntry(runId: string, queueId: string): HistoryEntry {
  return Object.freeze({
    runId,
    featureId: runId,
    descriptionPreview: runId,
    terminalStatus: 'completed',
    startedAt: '2026-05-10T09:00:00.000Z',
    completedAt: '2026-05-10T09:30:00.000Z',
    durationMs: 1_800_000,
    lastErrorSummary: null,
    auditLogPointer: `runId:${runId}`,
    queueId
  });
}

/** `snap` with `runtime` in place of the runtime of the same queue. */
function withRuntime(snap: WorkflowSnapshot, runtime: QueueRuntime): WorkflowSnapshot {
  return Object.freeze({
    ...snap,
    queues: Object.freeze([...snap.queues.filter((candidate) => candidate.queueId !== runtime.queueId), runtime])
  });
}

function snapshot(queue: Partial<QueueProjection>): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    // Feature 092 — the v3 root run singulars now hang off the queue that owns
    // the Run. `foldLegacyRun` performs that fold, so the call sites below keep
    // their v3 wording. BUG-002 — each runtime also lists its own queue's rows.
    queues: Object.freeze([
      ...foldLegacyRun({
        status: 'running',
        activeFeature: null,
        phases: Object.freeze([
        phase('speckit-specify', 1, 'completed'),
        phase('speckit-plan', 2, 'active'),
        phase('speckit-tasks', 3, 'not-started')
        ]),
        liveActivity: Object.freeze({
        summary: null,
        category: null,
        lastEventAt: null,
        freshness: 'idle',
        staleSeconds: 0
        }),
        workflowElapsedMs: 0,
        activePipeline: Object.freeze({ id: 'standard', name: 'Standard' })
      }).map((runtime) => Object.freeze({ ...runtime, tasks: tasksOf(runtime.queueId, queue) })),
      buildQueueRuntime({ queueId: 'work', name: 'work', position: 1, tasks: tasksOf('work', queue) })
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
    monitor: null,
    history: Object.freeze([]) as readonly HistoryEntry[],
    producedAt: '2026-05-10T12:00:00.000Z',
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
    availableModels: Object.freeze({ claude: [], codex: [], agy: [] }) as Record<BackendRunnerKind, readonly string[]>,
    availableBackends: Object.freeze(['claude']) as readonly BackendRunnerKind[]
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
    // 2026-09-06 coincidental: `fallback` is a PhaseLogSelection, whose `iterationN` is
    // `number | null` (webview-ui/src/lib/phase-log-store.svelte.ts:43) and whose null means "no
    // iteration chosen yet". The unconditional `iterationN: number` at
    // specs/028-advanced-phase-pausing/contracts/audit-events.md:55 declares the
    // `phase-breakpoint-fired` audit payload, a different record that shares the name.
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

// Feature 020 BUG-002 (T076) — the helpers read every queue, not the default
// queue's projection alone. `snapshot.queue` carries only the default queue's
// rows, so a Task on any other queue had no option and no Live selection.
describe('BUG-002 — Task options and the Live selection cover every queue', () => {
  it('lists the Tasks of a queue from its runtime and its own history slice (FR-018)', () => {
    const snap = withRuntime(
      Object.freeze({
        ...snapshot({}),
        history: Object.freeze([historyEntry('work-old', 'work'), historyEntry('default-old', 'default')])
      }),
      buildQueueRuntime({
        queueId: 'work',
        name: 'work',
        position: 1,
        tasks: [
          item({
            id: 'work-live',
            status: 'in-flight',
            queueId: 'work',
            currentPhase: 'speckit-plan',
            currentPipelineId: 'standard'
          }),
          item({ id: 'work-next', status: 'pending', queueId: 'work', position: 1 })
        ]
      })
    );

    const work = getTaskOptions(snap, 'work');
    expect(work.map((option) => option.id)).toEqual(['work-live', 'work-next', 'work-old']);
    expect(work.find((option) => option.id === 'work-old')).toMatchObject({ queueId: 'work' });
    expect(getTaskOptions(snap, 'default').map((option) => option.id)).toEqual(['default-old']);
  });

  it('live selection follows the latest-started in-flight Run across every queue (FR-021)', () => {
    const snap = withRuntime(
      snapshot({
        inFlight: item({
          id: 'default-live',
          status: 'in-flight',
          queueId: 'default',
          currentPhase: 'speckit-plan',
          currentPipelineId: 'standard',
          startedAt: '2026-05-10T11:00:00.000Z'
        })
      }),
      buildQueueRuntime({
        queueId: 'work',
        name: 'work',
        position: 1,
        tasks: [
          item({
            id: 'work-live',
            status: 'in-flight',
            queueId: 'work',
            currentPhase: 'speckit-tasks',
            currentPipelineId: 'standard',
            startedAt: '2026-05-10T11:30:00.000Z'
          })
        ]
      })
    );

    expect(resolveLiveSelection(snap)).toMatchObject({
      queueId: 'work',
      taskId: 'work-live',
      phaseId: 'speckit-tasks',
      followMode: 'live'
    });
  });

  it('picks the same Run on every call when start times tie or are missing (FR-021)', () => {
    const tied = '2026-05-10T11:00:00.000Z';
    const live = (queueId: string, startedAt: string | null): QueueItem =>
      item({
        id: `${queueId}-live`,
        status: 'in-flight',
        queueId,
        currentPhase: 'speckit-plan',
        currentPipelineId: 'standard',
        startedAt
      });
    // The array order runs against the position order, so a chooser that took
    // the first or the last in-flight row would land on alpha or gamma. Beta
    // wins: it ties alpha on start time and sits at the lower position, and
    // gamma, with no start time, ranks below both.
    const snap: WorkflowSnapshot = Object.freeze({
      ...snapshot({}),
      queues: Object.freeze([
        buildQueueRuntime({ queueId: 'alpha', name: 'alpha', position: 2, tasks: [live('alpha', tied)] }),
        buildQueueRuntime({ queueId: 'beta', name: 'beta', position: 1, tasks: [live('beta', tied)] }),
        buildQueueRuntime({ queueId: 'gamma', name: 'gamma', position: 0, tasks: [live('gamma', null)] })
      ])
    });

    const first = resolveLiveSelection(snap);
    expect(first).toMatchObject({ queueId: 'beta', taskId: 'beta-live' });
    expect(resolveLiveSelection(snap)).toEqual(first);
  });
});
