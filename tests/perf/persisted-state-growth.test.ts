// How the persisted records grow (FR-R4-F08, contract E: E6, E-T4; research R24; FR-018).
//
// WHAT THIS RECORDS. A real `WorkspaceStateStore` over a local `FakeMemento` is driven through a
// synthetic long-lived workspace: 20 queues; every completion appends a history entry and leaves
// its finished Task in the queue; every 250 completions one queue is deleted and a new one
// created. At 0, 100, 1,000 and 5,000 completions it records, separately, the UTF-8 bytes of the
// Task records (`schegent.queue`), the history (`schegent.history`), the Run records
// (`schegent.run`) and the projected snapshot, plus the number of history partitions. One
// `STATE_GROWTH <json>` line carries the four points (data model section 7).
//
// SHAPES, NOT NUMBERS. The test asserts what the store's design predicts, each as a shape:
//   - Task records grow at every point, because finished Tasks stay until the operator clears them
//     and neither `MAX_QUEUES` nor `MAX_PENDING_TASKS_PER_QUEUE` bounds them;
//   - Run records stay at most one per queue, whatever the number of completions;
//   - history is capped per partition, so what grows it is deleted queues' partitions, which the
//     store keeps (queue deletion does not touch them);
//   - the snapshot, which projects every partition, grows with the partition count.
// It asserts no byte figure and no timing, so `tests/perf/budgets.json` gets no entry.
//
// Runs are seeded with `setRun(queueId, run, unfencedCommit('test-fixture'))` and read only
// through `getRunMap()` (hard rules 57 and 58; `no-ambient-run-accessor.test.ts`).

import { describe, expect, it } from 'vitest';
import { unfencedCommit } from '../../src/state/ownership-claim';
import {
  KEYS,
  WorkspaceStateStore,
  type Memento,
  type PersistedHistoryEntry
} from '../../src/state/workspace-state';
import { HistoryStore } from '../../src/state/history-store';
import { StateProjector } from '../../src/ui/sidebar/state-projector';
import type { FeatureRequest, QueueState } from '../../src/queue/feature-request';
import type { WorkflowRun } from '../../src/state/workflow-run';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { MAX_QUEUES } from '../../src/contracts/queue-bounds';

/** The completion counts at which the records are measured (data model section 7). */
const POINTS = [0, 100, 1_000, 5_000] as const;
const QUEUE_CHURN_EVERY = 250;
const RUNNING_QUEUES = 10;
const HISTORY_CAP_PER_PARTITION = 50;
const EPOCH_MS = 1_700_000_000_000;

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

/** Deterministic v4-shaped ids, as the registry validator requires. */
const queueId = (index: number): string =>
  index === 0
    ? DEFAULT_QUEUE_ID
    : `0000${index.toString(16).padStart(4, '0')}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;

/** The registry's positions are contiguous from 0, so a queue's position is its place in the list. */
function registryEntry(index: number, position: number) {
  return {
    id: queueId(index),
    name: `Queue ${index}`,
    position,
    schedule: null,
    createdAt: EPOCH_MS,
    updatedAt: EPOCH_MS
  };
}

function finishedTask(owner: string, index: number): FeatureRequest {
  const at = EPOCH_MS + index * 1_000;
  return {
    id: `${owner}-task-${index}`,
    description: `finished task ${index} with a realistic description string`,
    enqueuedAt: at,
    createdAt: at,
    startedAt: at + 100,
    updatedAt: at + 900,
    completedAt: at + 900,
    status: 'completed',
    position: index,
    runId: `run-${owner}-${index}`,
    retryCount: 0,
    lastError: null,
    pausedReason: null
  } as FeatureRequest;
}

function queueState(requests: readonly FeatureRequest[]): QueueState {
  return {
    requests: [...requests],
    inFlightId: null,
    paused: false,
    pausedReason: null,
    updatedAt: EPOCH_MS,
    queueLifecycle: 'active-empty',
    pauseSource: null,
    scheduledStartAt: null,
    scheduledStartSource: null
  } as QueueState;
}

function historyEntry(owner: string, index: number): PersistedHistoryEntry {
  const at = EPOCH_MS + index * 1_000;
  return {
    runId: `run-${owner}-${index}`,
    featureId: `${owner}-task-${index}`,
    descriptionPreview: `finished task ${index} with a realistic preview line`,
    terminalStatus: 'completed',
    startedAt: new Date(at).toISOString(),
    completedAt: new Date(at + 900).toISOString(),
    durationMs: 900,
    lastErrorSummary: null,
    auditLogPointer: `runId:run-${owner}-${index}`
  } as PersistedHistoryEntry;
}

function runningRun(owner: string): WorkflowRun {
  return {
    id: `run-live-${owner}`,
    featureId: `feat-live-${owner}`,
    featureDir: 'specs/000-growth',
    status: 'running',
    currentPhase: 'speckit-plan',
    currentIteration: 0,
    startedAt: EPOCH_MS,
    lastTransitionAt: EPOCH_MS,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null
  };
}

interface GrowthPoint {
  readonly completions: number;
  readonly bytes: {
    readonly tasks: number;
    readonly history: number;
    readonly runs: number;
    readonly snapshot: number;
  };
  readonly historyPartitions: number;
  /** Partitions that no registered queue owns: deleted queues' history. */
  readonly deletedPartitions: number;
  /** History entries held by partitions of queues that still exist. */
  readonly liveHistoryEntries: number;
  readonly runs: number;
}

const bytesOfValue = (value: unknown): number => Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');

describe('persisted-state growth over a synthetic long-lived workspace (FR-018)', () => {
  it('records the four points and holds the shapes the store\'s design predicts', async () => {
    const memento = new FakeMemento();
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    const projector = new StateProjector({ store, history: new HistoryStore(store), ownerId: 'this-window' });

    let live = Array.from({ length: MAX_QUEUES }, (_, index) => index);
    let nextQueue = MAX_QUEUES;
    const tasksOf = new Map<string, FeatureRequest[]>();
    await store.setQueueRegistry({ entries: live.map(registryEntry), updatedAt: EPOCH_MS });
    for (const index of live) {
      tasksOf.set(queueId(index), []);
      await store.setQueue(queueState([]), queueId(index));
    }
    for (const index of live.slice(0, RUNNING_QUEUES)) {
      await store.setRun(queueId(index), runningRun(queueId(index)), unfencedCommit('test-fixture'));
    }

    const points: GrowthPoint[] = [];
    const record = (completions: number): void => {
      const historyMap = store.getHistoryMap();
      const liveIds = new Set(store.getQueueRegistry().entries.map((entry) => entry.id));
      const partitions = Object.keys(historyMap);
      points.push({
        completions,
        bytes: {
          tasks: bytesOfValue(memento.get(KEYS.queue)),
          history: bytesOfValue(memento.get(KEYS.history)),
          runs: bytesOfValue(memento.get(KEYS.run)),
          snapshot: bytesOfValue(projector.project())
        },
        historyPartitions: partitions.length,
        deletedPartitions: partitions.filter((id) => !liveIds.has(id)).length,
        liveHistoryEntries: partitions
          .filter((id) => liveIds.has(id))
          .reduce((total, id) => total + (historyMap[id] ?? []).length, 0),
        runs: Object.keys(store.getRunMap()).length
      });
    };

    record(0);
    const lastPoint = POINTS.at(-1) ?? 0;
    for (let completion = 1; completion <= lastPoint; completion += 1) {
      const slot = live.at(completion % live.length);
      if (slot === undefined) throw new Error('no live queue');
      const owner = queueId(slot);
      const tasks = tasksOf.get(owner) ?? [];
      tasks.push(finishedTask(owner, completion));
      tasksOf.set(owner, tasks);
      await store.setQueue(queueState(tasks), owner);
      await store.appendHistory(owner, historyEntry(owner, completion));

      if (completion % QUEUE_CHURN_EVERY === 0) {
        // One queue is deleted (its history partition stays) and a new one created. The default
        // queue cannot be deleted, so the oldest queue after it is the one retired.
        const retiredIndex = live.at(1);
        if (retiredIndex === undefined) throw new Error('no queue to retire');
        const retired = queueId(retiredIndex);
        await store.setRun(retired, null, unfencedCommit('test-fixture'));
        await store.deleteQueueIfNoLiveRun(retired, () => ({ outcome: 'deletable' as const }), EPOCH_MS);
        tasksOf.delete(retired);
        const created = nextQueue;
        nextQueue += 1;
        live = [...live.slice(0, 1), ...live.slice(2), created];
        await store.setQueueRegistry({ entries: live.map(registryEntry), updatedAt: EPOCH_MS });
        tasksOf.set(queueId(created), []);
        await store.setQueue(queueState([]), queueId(created));
      }
      if ((POINTS as readonly number[]).includes(completion)) record(completion);
    }

    const environment = { os: process.platform, arch: process.arch, node: process.version };
    process.stdout.write(`STATE_GROWTH ${JSON.stringify({ environment, points })}\n`);
    projector.dispose();

    expect(points.map((point) => point.completions), 'the four points were taken').toEqual([...POINTS]);
    const first = points.at(0);
    const second = points.at(1);
    const third = points.at(2);
    const fourth = points.at(3);
    if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
      throw new Error('a growth point is missing');
    }

    // Task records grow at every point: nothing clears finished Tasks and nothing else bounds them.
    expect(second.bytes.tasks, 'tasks at 100 above 0').toBeGreaterThan(first.bytes.tasks);
    expect(third.bytes.tasks, 'tasks at 1,000 above 100').toBeGreaterThan(second.bytes.tasks);
    expect(fourth.bytes.tasks, 'tasks at 5,000 above 1,000').toBeGreaterThan(third.bytes.tasks);

    // Run records stay at most one per queue, however many completions pass.
    for (const point of points) {
      expect(point.runs, `runs at ${point.completions}: at most one per queue`).toBeLessThanOrEqual(MAX_QUEUES);
    }
    expect(fourth.bytes.runs, 'runs at 5,000 are no larger than at 0').toBeLessThanOrEqual(first.bytes.runs);

    // History is capped per live partition, so it grows only through deleted queues' partitions.
    for (const point of points) {
      expect(point.liveHistoryEntries, `live history at ${point.completions}`).toBeLessThanOrEqual(MAX_QUEUES * HISTORY_CAP_PER_PARTITION);
    }
    expect(fourth.bytes.history, 'history at 5,000 above 1,000').toBeGreaterThan(third.bytes.history);
    expect(fourth.deletedPartitions, 'deleted partitions at 5,000 above 1,000').toBeGreaterThan(third.deletedPartitions);
    expect(fourth.historyPartitions, 'partitions at 5,000 above 1,000').toBeGreaterThan(third.historyPartitions);

    // The snapshot projects every partition, so it grows with them.
    expect(fourth.bytes.snapshot, 'snapshot at 5,000 above 1,000').toBeGreaterThan(third.bytes.snapshot);
    expect(third.bytes.snapshot, 'snapshot at 1,000 above 0').toBeGreaterThan(first.bytes.snapshot);
  }, 600_000);
});
