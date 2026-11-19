/**
 * FR-R7-02 — Deterministic workload builders and isolated-run latency harness
 * for `SqliteOperationalBacking` on an on-disk WAL + `synchronous = FULL` store.
 *
 * Separates write-commit latency, read-clone latency (`structuredClone`),
 * `pruneConnectedRunsMap` CPU cost, payload sizes, and Node event-loop delay
 * (`monitorEventLoopDelay`) across the four documented workload tiers.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

import {
  MAX_RETAINED_HISTORY_PARTITIONS
} from '../../../src/contracts/snapshot-bounds.js';
import { MAX_QUEUES } from '../../../src/contracts/queue-bounds.js';
import {
  MAX_PENDING_TASKS_PER_QUEUE,
  type FeatureRequest,
  type QueueState
} from '../../../src/queue/feature-request.js';
import { SAMPLE_SUFFICIENCY } from '../../../src/contracts/runtime-resource-budgets/budget-targets.js';
import type { Distribution } from '../../../src/contracts/runtime-resource-budgets/qualification-record.js';
import {
  checkSampleSufficiency,
  computeDistribution
} from '../../../src/services/runtime-resource-budgets/distribution.js';
import { SqliteApplicationStore } from '../../../src/services/sqlite-store/index.js';
import type { ConnectedWorkflowRun } from '../../../src/state/connected-workflow-run.js';
import {
  CONNECTED_RUNS_CACHE_MAX,
  createSwitchableOperationalMemento,
  pruneConnectedRunsMap,
  type SqliteOperationalBacking
} from '../../../src/state/sqlite-operational-backing.js';
import type { WorkflowRun } from '../../../src/state/workflow-run.js';
import {
  HISTORY_CAP_PER_QUEUE,
  KEYS,
  type Memento,
  type PersistedHistoryEntry,
  type PersistedHistoryMap
} from '../../../src/state/workspace-state.js';
import { removeTempRoot } from '../../temp-root-cleanup.js';

export type OperationalWorkloadTierId =
  | 'baseline-small'
  | 'scenario-1-queue-500'
  | 'documented-max-capacity'
  | 'admission-atomic-batch';

export interface OperationalWorkloadSpec {
  readonly tierId: OperationalWorkloadTierId;
  readonly queueCount: number;
  readonly tasksPerQueue: number;
  readonly liveRunCount: number;
  readonly historyPartitions: number;
  readonly historyEntriesPerPartition: number;
  readonly connectedRunCount: number;
  readonly measureAtomicAdmissionBatch: boolean;
}

export const OPERATIONAL_WORKLOAD_TIERS: readonly OperationalWorkloadSpec[] = Object.freeze([
  {
    tierId: 'baseline-small',
    queueCount: 1,
    tasksPerQueue: 10,
    liveRunCount: 1,
    historyPartitions: 1,
    historyEntriesPerPartition: 10,
    connectedRunCount: 5,
    measureAtomicAdmissionBatch: false
  },
  {
    tierId: 'scenario-1-queue-500',
    queueCount: 1,
    tasksPerQueue: 500,
    liveRunCount: 1,
    historyPartitions: 1,
    historyEntriesPerPartition: HISTORY_CAP_PER_QUEUE,
    connectedRunCount: 32,
    measureAtomicAdmissionBatch: false
  },
  {
    tierId: 'documented-max-capacity',
    queueCount: MAX_QUEUES,
    tasksPerQueue: MAX_PENDING_TASKS_PER_QUEUE,
    liveRunCount: MAX_QUEUES,
    historyPartitions: MAX_RETAINED_HISTORY_PARTITIONS,
    historyEntriesPerPartition: HISTORY_CAP_PER_QUEUE,
    connectedRunCount: CONNECTED_RUNS_CACHE_MAX,
    measureAtomicAdmissionBatch: false
  },
  {
    tierId: 'admission-atomic-batch',
    queueCount: MAX_QUEUES,
    tasksPerQueue: MAX_PENDING_TASKS_PER_QUEUE,
    liveRunCount: MAX_QUEUES,
    historyPartitions: MAX_RETAINED_HISTORY_PARTITIONS,
    historyEntriesPerPartition: HISTORY_CAP_PER_QUEUE,
    connectedRunCount: CONNECTED_RUNS_CACHE_MAX,
    measureAtomicAdmissionBatch: true
  }
]);

export interface EventLoopDelaySnapshot {
  readonly runId: string;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
  readonly sampleCount: number;
}

export interface PayloadBytesSnapshot {
  readonly queueBytes: number;
  readonly runBytes: number;
  readonly historyBytes: number;
  readonly connectedRunsBytes: number;
}

export interface TierRunMeasurements {
  readonly runId: string;
  readonly payloadBytes: PayloadBytesSnapshot;
  readonly writeQueueCommit: Distribution;
  readonly writeRunCommit: Distribution;
  readonly writeHistoryCommit: Distribution;
  readonly writeConnectedRunsCommit: Distribution;
  readonly pruneConnectedRunsOnly: Distribution;
  readonly writeAdmissionBatchCommit?: Distribution;
  readonly readQueueClone: Distribution;
  readonly readRunClone: Distribution;
  readonly readHistoryClone: Distribution;
  readonly readConnectedRunsClone: Distribution;
  readonly eventLoopDelay: EventLoopDelaySnapshot;
  readonly timerLateness: Distribution;
}

export interface TierBenchmarkReport {
  readonly spec: OperationalWorkloadSpec;
  readonly pragmaVerified: {
    readonly journalMode: string;
    readonly synchronous: number;
    readonly foreignKeys: number;
    readonly busyTimeout: number;
    readonly sqliteVersion: string;
  };
  readonly runs: readonly TierRunMeasurements[];
  readonly worstWriteCommitP95Ms: number;
  readonly worstWriteCommitP99Ms: number;
  readonly worstWriteCommitOp: string;
  readonly worstReadCloneP95Ms: number;
  readonly worstReadCloneP99Ms: number;
  readonly worstPruneP95Ms: number;
  readonly worstPruneP99Ms: number;
  readonly worstEventLoopDelayP95Ms: number;
  readonly worstEventLoopDelayP99Ms: number;
}

export interface DecisionGateVerdict {
  readonly budgetP95Ms: 20;
  readonly budgetP99Ms: 100;
  readonly worstWriteCommitP95Ms: number;
  readonly worstWriteCommitP99Ms: number;
  readonly worstWriteCommitTierAndOp: string;
  readonly worstEventLoopDelayP95Ms: number;
  readonly worstEventLoopDelayP99Ms: number;
  readonly worstEventLoopDelayTier: OperationalWorkloadTierId;
  readonly worstReadCloneP95Ms: number;
  readonly worstReadCloneP99Ms: number;
  readonly worstPruneP95Ms: number;
  readonly worstPruneP99Ms: number;
  readonly outcome: 'defer-migration-9' | 'proceed-migration-9';
  readonly rationale: string;
}

export interface BenchmarkEnvironmentSummary {
  readonly platform: string;
  readonly release: string;
  readonly arch: string;
  readonly cpuModel: string;
  readonly cpuCores: number;
  readonly totalMemGiB: number;
  readonly nodeVersion: string;
  readonly sqliteVersion: string;
  readonly loadAvg1m: number;
  readonly loadAvg5m: number;
  readonly loadAvg15m: number;
}

const BUDGET_P95_MS = 20 as const;
const BUDGET_P99_MS = 100 as const;

function createInMemoryLegacyMemento(initial: Record<string, unknown>): Memento {
  const map = new Map<string, unknown>(Object.entries(initial));
  return {
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    }
  };
}

function buildRealisticPipelineSnapshot(index: number): NonNullable<WorkflowRun['pipeline']> {
  return {
    id: `wf-sdd-${index % 4}`,
    name: `Spec-Driven Autonomous Workflow ${index % 4}`,
    version: 3,
    description: 'Standard autonomous multi-phase workflow snapshot frozen at Run admission.',
    phases: [
      { id: 'specify', name: 'Specify', instruction: '/speckit-specify', loopable: false },
      { id: 'clarify', name: 'Clarify', instruction: '/speckit-clarify', loopable: true },
      { id: 'plan', name: 'Plan', instruction: '/speckit-plan', loopable: false },
      { id: 'tasks', name: 'Tasks', instruction: '/speckit-tasks', loopable: false },
      { id: 'implement', name: 'Implement', instruction: '/speckit-implement', loopable: true }
    ]
  };
}

function buildFeatureRequest(
  queueId: string,
  taskIdx: number,
  isInFlight: boolean,
  isTerminal: boolean,
  baseTs: number
): FeatureRequest {
  const id = `${queueId}-task-${String(taskIdx).padStart(4, '0')}`;
  const status: FeatureRequest['status'] = isInFlight
    ? 'in-flight'
    : isTerminal
      ? 'completed'
      : 'pending';
  return {
    id,
    description: `Implement operational milestone item #${taskIdx} on ${queueId}: verify deterministic transitions, audit coverage, and bounded memory usage.`,
    enqueuedAt: baseTs + taskIdx * 100,
    createdAt: baseTs + taskIdx * 100,
    startedAt: isInFlight || isTerminal ? baseTs + taskIdx * 100 + 50 : null,
    updatedAt: baseTs + taskIdx * 100 + 80,
    completedAt: isTerminal ? baseTs + taskIdx * 100 + 500 : null,
    status,
    queueId,
    position: taskIdx,
    runId: isInFlight || isTerminal ? `run-${queueId}-${taskIdx}` : null,
    retryCount: 0,
    lastError: null,
    pausedReason: null,
    pipelineId: `wf-sdd-${taskIdx % 4}`,
    ...(isTerminal ? { phaseProgress: { settled: 5, total: 5 } } : {})
  };
}

function buildQueueStateMap(spec: OperationalWorkloadSpec, baseTs: number): Record<string, QueueState> {
  const queues: Record<string, QueueState> = {};
  for (let q = 0; q < spec.queueCount; q += 1) {
    const queueId = q === 0 ? 'default' : `queue-${String(q + 1).padStart(2, '0')}`;
    const requests: FeatureRequest[] = [];
    const hasLiveRun = q < spec.liveRunCount;
    // Cap pending entries at MAX_PENDING_TASKS_PER_QUEUE (100); remaining tasks in scenario-1-queue-500 are terminal.
    const terminalCount = Math.max(0, spec.tasksPerQueue - MAX_PENDING_TASKS_PER_QUEUE);
    for (let t = 0; t < spec.tasksPerQueue; t += 1) {
      const isTerminal = t < terminalCount;
      const isInFlight = hasLiveRun && t === terminalCount;
      requests.push(buildFeatureRequest(queueId, t, isInFlight, isTerminal, baseTs));
    }
    const inFlightTask = requests.find((r) => r.status === 'in-flight') ?? null;
    queues[queueId] = {
      requests,
      inFlightId: inFlightTask?.id ?? null,
      updatedAt: baseTs + 10_000,
      queueLifecycle: inFlightTask ? 'running' : 'idle-pending',
      pauseSource: null,
      pausedReason: null,
      scheduledStartAt: null,
      scheduledStartSource: null
    };
  }
  return queues;
}

function buildRunMap(
  spec: OperationalWorkloadSpec,
  queues: Readonly<Record<string, QueueState>>,
  baseTs: number
): Record<string, WorkflowRun> {
  const runs: Record<string, WorkflowRun> = {};
  const queueIds = Object.keys(queues);
  for (let i = 0; i < Math.min(spec.liveRunCount, queueIds.length); i += 1) {
    const queueId = queueIds[i]!;
    const queue = queues[queueId]!;
    const activeTask = queue.requests.find((r) => r.id === queue.inFlightId) ?? queue.requests[0]!;
    runs[queueId] = {
      id: activeTask.runId ?? `run-${queueId}-live`,
      featureId: activeTask.id,
      featureDir: `specs/${String(300 + i)}-feature-${i}`,
      status: 'running',
      currentPhase: 'implement',
      currentIteration: 1,
      startedAt: baseTs + i * 1_000,
      lastTransitionAt: baseTs + i * 1_000 + 250,
      phasesCompleted: [
        {
          phase: 'specify',
          iteration: 1,
          startedAt: baseTs + 50,
          endedAt: baseTs + 100,
          result: 'clean',
          terminationReason: 'token',
          exitCode: 0,
          stdoutSummary: 'Specify complete',
          stderrSummary: '',
          auditEntryId: `aud-${i}-1`
        },
        {
          phase: 'clarify',
          iteration: 2,
          startedAt: baseTs + 110,
          endedAt: baseTs + 200,
          result: 'clean',
          terminationReason: 'token',
          exitCode: 0,
          stdoutSummary: 'Clarify complete',
          stderrSummary: '',
          auditEntryId: `aud-${i}-2`
        },
        {
          phase: 'plan',
          iteration: 1,
          startedAt: baseTs + 210,
          endedAt: baseTs + 300,
          result: 'clean',
          terminationReason: 'token',
          exitCode: 0,
          stdoutSummary: 'Plan complete',
          stderrSummary: '',
          auditEntryId: `aud-${i}-3`
        }
      ],
      lastError: null,
      pipeline: buildRealisticPipelineSnapshot(i),
      liveness: {
        lastActivityAt: baseTs + i * 1_000 + 240,
        stdoutLines: 420,
        stderrLines: 3
      },
      plannedTotal: {
        phaseCount: 5,
        iterationCap: 10,
        maxPhaseInvocations: 23
      },
      delayedRetryCount: 0,
      pendingRetryAt: null,
      pendingRetryCause: null,
      creditPause: null,
      phaseOverrides: [],
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      resumeTargetPhaseId: null,
      writtenAtFence: 1
    };
  }
  return runs;
}

function buildHistoryMap(spec: OperationalWorkloadSpec, baseTs: number): PersistedHistoryMap {
  const history: PersistedHistoryMap = {};
  for (let p = 0; p < spec.historyPartitions; p += 1) {
    const partitionKey =
      p === 0
        ? 'default'
        : p < MAX_QUEUES
          ? `queue-${String(p + 1).padStart(2, '0')}`
          : `deleted-queue-${String(p + 1).padStart(2, '0')}`;
    const entries: PersistedHistoryEntry[] = [];
    for (let e = 0; e < spec.historyEntriesPerPartition; e += 1) {
      entries.push({
        runId: `hist-run-${partitionKey}-${e}`,
        featureId: `${partitionKey}-hist-task-${e}`,
        queueId: partitionKey,
        description: `Completed workflow execution #${e} in partition ${partitionKey}.`,
        status: e % 9 === 0 ? 'failed' : 'completed',
        startedAt: baseTs - (p * 100 + e) * 60_000,
        completedAt: baseTs - (p * 100 + e) * 60_000 + 45_000,
        durationMs: 45_000,
        pipelineId: `wf-sdd-${e % 4}`,
        phasesCompleted: 5
      });
    }
    history[partitionKey] = entries;
  }
  return history;
}

function buildConnectedRunsMap(
  spec: OperationalWorkloadSpec,
  baseTs: number
): Record<string, ConnectedWorkflowRun> {
  const map: Record<string, ConnectedWorkflowRun> = {};
  for (let i = 0; i < spec.connectedRunCount; i += 1) {
    const id = `conn-run-${String(i).padStart(4, '0')}`;
    const isActive = i < Math.min(2, spec.liveRunCount);
    const queueId = i === 0 ? 'default' : `queue-${String((i % spec.queueCount) + 1).padStart(2, '0')}`;
    const pipelineSnap = buildRealisticPipelineSnapshot(i);
    map[id] = {
      connectedRunId: id,
      workflowId: `wf-graph-${i % 3}`,
      queueId,
      revision: 4,
      startedAt: baseTs - (spec.connectedRunCount - i) * 1_000,
      graph: {
        id: `wf-graph-${i % 3}`,
        name: `Connected Workflow ${i % 3}`,
        description: 'Multi-node connected workflow definition snapshot.',
        entryNodeId: 'node-1',
        nodes: [
          { id: 'node-1', kind: 'phase', phaseId: 'specify', label: 'Specify' },
          { id: 'node-2', kind: 'phase', phaseId: 'implement', label: 'Implement' }
        ],
        connections: [{ fromNodeId: 'node-1', toNodeId: 'node-2', isDefault: true }]
      } as unknown as ConnectedWorkflowRun['graph'],
      pipelines: {
        [pipelineSnap!.id]: pipelineSnap!
      },
      nodes: {
        'node-1': {
          nodeId: 'node-1',
          attempts: [{ queueItemId: `${queueId}-conn-item-${i}-1`, startedAt: baseTs - 5_000 }]
        },
        'node-2': {
          nodeId: 'node-2',
          attempts: [{ queueItemId: `${queueId}-conn-item-${i}-2`, startedAt: baseTs - 2_000 }]
        }
      },
      decisions: [
        {
          nodeId: 'node-1',
          attemptIndex: 0,
          decidedAt: baseTs - 3_000,
          operands: [{ source: 'node-status', nodeId: 'node-1', resolved: true, compared: 'completed' }],
          connections: [{ index: 0, matched: true, isDefault: true }],
          defaultApplied: true,
          eligible: [0]
        }
      ],
      invocations: {
        [`inv-root-${i}`]: {
          invocationId: `inv-root-${i}`,
          rootRunId: id,
          parentInvocationId: null,
          parentCallNodeId: null,
          parentAttemptId: null,
          workflowId: `wf-graph-${i % 3}`,
          depth: 0,
          nodePath: 'root',
          entryNodeId: 'node-1',
          activeNodeId: isActive ? 'node-2' : null,
          status: isActive ? 'in-flight' : 'completed',
          boundInputs: {},
          resolvedOutputs: {},
          attemptsByNodeId: {},
          decisions: [],
          startedAt: baseTs - (spec.connectedRunCount - i) * 1_000,
          ...(isActive ? {} : { completedAt: baseTs - (spec.connectedRunCount - i) * 1_000 + 500 })
        }
      }
    };
  }
  return map;
}

function measureSyncSeries(
  totalSamples: number,
  step: (iteration: number) => void
): number[] {
  const values = new Array<number>(totalSamples);
  for (let i = 0; i < totalSamples; i += 1) {
    const t0 = performance.now();
    step(i);
    values[i] = performance.now() - t0;
  }
  return values;
}

async function measureEventLoopDelayUnderCommits(
  warmUpSamples: number,
  steadyStateSamples: number,
  runId: string,
  commitStep: (iteration: number) => void
): Promise<{ readonly eventLoopDelay: EventLoopDelaySnapshot; readonly timerLateness: Distribution }> {
  const intervalMs = 1;
  const totalSamples = warmUpSamples + steadyStateSamples;
  const latenessValues = new Array<number>(totalSamples);

  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();

  try {
    for (let i = 0; i < totalSamples; i += 1) {
      if (i === warmUpSamples) {
        histogram.reset();
      }
      const scheduledAt = performance.now();
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          const firedAt = performance.now();
          latenessValues[i] = Math.max(0, firedAt - scheduledAt - intervalMs);
          commitStep(i);
          resolve();
        }, intervalMs);
      });
    }
    // Allow one final timer tick after the last synchronous commit so the histogram observes its stall.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  } finally {
    histogram.disable();
  }

  const eventLoopDelay: EventLoopDelaySnapshot = {
    runId,
    p50Ms: histogram.percentile(50) / 1e6,
    p95Ms: histogram.percentile(95) / 1e6,
    p99Ms: histogram.percentile(99) / 1e6,
    maxMs: histogram.max / 1e6,
    meanMs: histogram.mean / 1e6,
    sampleCount: histogram.count
  };

  const timerLateness = computeDistribution({
    metric: 'timer_lateness_ms',
    runId,
    values: latenessValues,
    warmUpCount: warmUpSamples,
    unit: 'ms'
  });

  return { eventLoopDelay, timerLateness };
}

function measurePayloadBytes(backing: SqliteOperationalBacking): PayloadBytesSnapshot {
  const byteSize = (key: string): number => {
    const val = backing.get<unknown>(key);
    return val === undefined ? 0 : Buffer.byteLength(JSON.stringify(val), 'utf8');
  };
  return {
    queueBytes: byteSize(KEYS.queue),
    runBytes: byteSize(KEYS.run),
    historyBytes: byteSize(KEYS.history),
    connectedRunsBytes: byteSize(KEYS.connectedRuns)
  };
}

export async function runOperationalLatencyTier(
  spec: OperationalWorkloadSpec,
  options: {
    readonly isolatedRuns?: number;
    readonly warmUpSamples?: number;
    readonly steadyStateSamples?: number;
  } = {}
): Promise<TierBenchmarkReport> {
  const isolatedRuns = options.isolatedRuns ?? SAMPLE_SUFFICIENCY.minIsolatedRuns;
  const warmUpSamples = options.warmUpSamples ?? SAMPLE_SUFFICIENCY.minWarmUpSamples;
  const steadyStateSamples = options.steadyStateSamples ?? SAMPLE_SUFFICIENCY.minSteadyStateSamples;
  const totalSamples = warmUpSamples + steadyStateSamples;

  const runs: TierRunMeasurements[] = [];
  let pragmaVerified: TierBenchmarkReport['pragmaVerified'] | null = null;

  for (let runIndex = 0; runIndex < isolatedRuns; runIndex += 1) {
    const runId = `${spec.tierId}-run-${runIndex + 1}`;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `schegent-r7-02-${spec.tierId}-`));
    let store: SqliteApplicationStore | null = null;

    try {
      const dbPath = path.join(tempDir, 'schegent-state.db');
      const baseTs = 1_763_500_000_000 + runIndex * 100_000;
      const initialQueues = buildQueueStateMap(spec, baseTs);
      const initialRuns = buildRunMap(spec, initialQueues, baseTs);
      const initialHistory = buildHistoryMap(spec, baseTs);
      const initialConnected = buildConnectedRunsMap(spec, baseTs);

      const legacyMemento = createInMemoryLegacyMemento({
        [KEYS.schemaVersion]: 15,
        [KEYS.queue]: initialQueues,
        [KEYS.run]: initialRuns,
        [KEYS.history]: initialHistory,
        [KEYS.connectedRuns]: initialConnected
      });

      store = new SqliteApplicationStore({
        databasePath: dbPath,
        journalMode: 'wal'
      });

      const meta = store.writerConnection.inspectRuntimeMetadata();
      const verified = {
        journalMode: String(store.writerConnection.scalar('PRAGMA journal_mode') ?? '').toLowerCase(),
        synchronous: Number(store.writerConnection.scalar('PRAGMA synchronous')),
        foreignKeys: Number(store.writerConnection.scalar('PRAGMA foreign_keys')),
        busyTimeout: Number(store.writerConnection.scalar('PRAGMA busy_timeout')),
        sqliteVersion: meta.sqliteVersion
      };
      if (verified.journalMode !== 'wal' || verified.synchronous !== 2) {
        throw new Error(
          `Expected production WAL + synchronous=FULL(2), got journal_mode=${verified.journalMode}, synchronous=${verified.synchronous}`
        );
      }
      pragmaVerified = verified;

      const switchable = createSwitchableOperationalMemento(legacyMemento);
      let clockMs = baseTs + 50_000;
      const backing = switchable.attachSqlite(store, `scope-${runId}`, () => {
        clockMs += 5;
        return clockMs;
      });

      const payloadBytes = measurePayloadBytes(backing);

      // Prepare frozen snapshot handles for steady-state CoW mutation measurements (mirroring
      // WorkspaceStateStore's structural-sharing read-modify-write pattern).
      let queueMap = backing.get<Record<string, QueueState>>(KEYS.queue)!;
      let runMap = backing.get<Record<string, WorkflowRun>>(KEYS.run)!;
      let historyMap = backing.get<PersistedHistoryMap>(KEYS.history)!;
      let connectedMap = backing.get<Record<string, ConnectedWorkflowRun>>(KEYS.connectedRuns)!;

      const targetTaskIdx = queueMap.default!.requests.length - 1;
      const firstConnectedId = Object.keys(connectedMap)[0]!;

      // 1. Write commit: single-Task mutation on KEYS.queue
      const writeQueueValues = measureSyncSeries(totalSamples, (iter) => {
        const currentDefault = queueMap.default!;
        const prevTask = currentDefault.requests[targetTaskIdx]!;
        const nextRequests = currentDefault.requests.slice();
        nextRequests[targetTaskIdx] = {
          ...prevTask,
          updatedAt: baseTs + 60_000 + iter,
          retryCount: iter % 3
        };
        const nextQueueMap: Record<string, QueueState> = {
          ...queueMap,
          default: {
            ...currentDefault,
            requests: nextRequests,
            updatedAt: baseTs + 60_000 + iter
          }
        };
        backing.update(KEYS.queue, nextQueueMap);
        queueMap = backing.get<Record<string, QueueState>>(KEYS.queue)!;
      });

      // 2. Write commit: single-Run mutation on KEYS.run
      const writeRunValues = measureSyncSeries(totalSamples, (iter) => {
        const currentDefaultRun = runMap.default!;
        const nextRunMap: Record<string, WorkflowRun> = {
          ...runMap,
          default: {
            ...currentDefaultRun,
            currentIteration: (iter % 10) + 1,
            lastTransitionAt: baseTs + 70_000 + iter,
            liveness: {
              lastActivityAt: baseTs + 70_000 + iter,
              stdoutLines: 420 + iter,
              stderrLines: 3
            }
          }
        };
        backing.update(KEYS.run, nextRunMap);
        runMap = backing.get<Record<string, WorkflowRun>>(KEYS.run)!;
      });

      // 3. Write commit: history append (capped at HISTORY_CAP_PER_QUEUE) on KEYS.history
      const writeHistoryValues = measureSyncSeries(totalSamples, (iter) => {
        const prevEntries = historyMap.default!;
        const nextEntries =
          prevEntries.length >= HISTORY_CAP_PER_QUEUE ? prevEntries.slice(1) : prevEntries.slice();
        nextEntries.push({
          runId: `hist-bench-${iter}`,
          featureId: `default-bench-task-${iter}`,
          queueId: 'default',
          description: `Benchmarked history record #${iter}`,
          status: 'completed',
          startedAt: baseTs + 80_000 + iter,
          completedAt: baseTs + 80_500 + iter,
          durationMs: 500,
          pipelineId: 'wf-sdd-0',
          phasesCompleted: 5
        });
        const nextHistoryMap: PersistedHistoryMap = {
          ...historyMap,
          default: nextEntries
        };
        backing.update(KEYS.history, nextHistoryMap);
        historyMap = backing.get<PersistedHistoryMap>(KEYS.history)!;
      });

      // 4. Isolated pruneConnectedRunsMap CPU cost (no SQLite I/O)
      const pruneOnlyValues = measureSyncSeries(totalSamples, (iter) => {
        pruneConnectedRunsMap(connectedMap, runMap, baseTs + 90_000 + iter);
      });

      // 5. Write commit: connectedRuns mutation (includes pruneConnectedRunsMap + SQLite commit)
      const writeConnectedValues = measureSyncSeries(totalSamples, (iter) => {
        const current = connectedMap[firstConnectedId]!;
        const nextConnectedMap: Record<string, ConnectedWorkflowRun> = {
          ...connectedMap,
          [firstConnectedId]: {
            ...current,
            revision: current.revision + 1 + (iter % 2)
          }
        };
        backing.update(KEYS.connectedRuns, nextConnectedMap);
        connectedMap = backing.get<Record<string, ConnectedWorkflowRun>>(KEYS.connectedRuns)!;
      });

      // 6. Optional atomic admission batch (KEYS.run + KEYS.queue in one BEGIN IMMEDIATE)
      let writeAdmissionBatchCommit: Distribution | undefined;
      if (spec.measureAtomicAdmissionBatch) {
        const batchValues = measureSyncSeries(totalSamples, (iter) => {
          const currentDefault = queueMap.default!;
          const prevTask = currentDefault.requests[targetTaskIdx]!;
          const runId = `run-admit-bench-${iter}`;
          const nextRequests = currentDefault.requests.slice();
          nextRequests[targetTaskIdx] = {
            ...prevTask,
            status: 'in-flight',
            runId,
            updatedAt: baseTs + 100_000 + iter
          };
          const nextQueueMap: Record<string, QueueState> = {
            ...queueMap,
            default: {
              ...currentDefault,
              requests: nextRequests,
              inFlightId: prevTask.id,
              updatedAt: baseTs + 100_000 + iter
            }
          };
          const nextRunMap: Record<string, WorkflowRun> = {
            ...runMap,
            default: {
              ...runMap.default!,
              id: runId,
              featureId: prevTask.id,
              lastTransitionAt: baseTs + 100_000 + iter
            }
          };
          backing.updateBatch([
            { key: KEYS.run, value: nextRunMap },
            { key: KEYS.queue, value: nextQueueMap }
          ]);
          queueMap = backing.get<Record<string, QueueState>>(KEYS.queue)!;
          runMap = backing.get<Record<string, WorkflowRun>>(KEYS.run)!;
        });
        writeAdmissionBatchCommit = computeDistribution({
          metric: 'write_admission_batch_commit_ms',
          runId,
          values: batchValues,
          warmUpCount: warmUpSamples,
          unit: 'ms'
        });
      }

      // 7. Read-clone / read-view costs (`get`)
      const readQueueValues = measureSyncSeries(totalSamples, () => {
        backing.get<Record<string, QueueState>>(KEYS.queue);
      });
      const readRunValues = measureSyncSeries(totalSamples, () => {
        backing.get<Record<string, WorkflowRun>>(KEYS.run);
      });
      const readHistoryValues = measureSyncSeries(totalSamples, () => {
        backing.get<PersistedHistoryMap>(KEYS.history);
      });
      const readConnectedValues = measureSyncSeries(totalSamples, () => {
        backing.get<Record<string, ConnectedWorkflowRun>>(KEYS.connectedRuns);
      });

      // 8. Event-loop delay under timer-paced commits of the tier's heaviest operational write
      const { eventLoopDelay, timerLateness } = await measureEventLoopDelayUnderCommits(
        warmUpSamples,
        steadyStateSamples,
        runId,
        (iter) => {
          const currentDefault = queueMap.default!;
          const prevTask = currentDefault.requests[targetTaskIdx]!;
          const nextRequests = currentDefault.requests.slice();
          nextRequests[targetTaskIdx] = {
            ...prevTask,
            updatedAt: baseTs + 120_000 + iter
          };
          const nextQueueMap: Record<string, QueueState> = {
            ...queueMap,
            default: {
              ...currentDefault,
              requests: nextRequests,
              updatedAt: baseTs + 120_000 + iter
            }
          };
          if (spec.measureAtomicAdmissionBatch) {
            const nextRunMap: Record<string, WorkflowRun> = {
              ...runMap,
              default: {
                ...runMap.default!,
                lastTransitionAt: baseTs + 120_000 + iter
              }
            };
            backing.updateBatch([
              { key: KEYS.run, value: nextRunMap },
              { key: KEYS.queue, value: nextQueueMap }
            ]);
            queueMap = backing.get<Record<string, QueueState>>(KEYS.queue)!;
            runMap = backing.get<Record<string, WorkflowRun>>(KEYS.run)!;
          } else {
            backing.update(KEYS.queue, nextQueueMap);
            queueMap = backing.get<Record<string, QueueState>>(KEYS.queue)!;
          }
        }
      );

      runs.push({
        runId,
        payloadBytes,
        writeQueueCommit: computeDistribution({
          metric: 'write_queue_commit_ms',
          runId,
          values: writeQueueValues,
          warmUpCount: warmUpSamples,
          unit: 'ms'
        }),
        writeRunCommit: computeDistribution({
          metric: 'write_run_commit_ms',
          runId,
          values: writeRunValues,
          warmUpCount: warmUpSamples,
          unit: 'ms'
        }),
        writeHistoryCommit: computeDistribution({
          metric: 'write_history_commit_ms',
          runId,
          values: writeHistoryValues,
          warmUpCount: warmUpSamples,
          unit: 'ms'
        }),
        writeConnectedRunsCommit: computeDistribution({
          metric: 'write_connected_runs_commit_ms',
          runId,
          values: writeConnectedValues,
          warmUpCount: warmUpSamples,
          unit: 'ms'
        }),
        pruneConnectedRunsOnly: computeDistribution({
          metric: 'prune_connected_runs_only_ms',
          runId,
          values: pruneOnlyValues,
          warmUpCount: warmUpSamples,
          unit: 'ms'
        }),
        ...(writeAdmissionBatchCommit !== undefined ? { writeAdmissionBatchCommit } : {}),
        readQueueClone: computeDistribution({
          metric: 'read_queue_clone_ms',
          runId,
          values: readQueueValues,
          warmUpCount: warmUpSamples,
          unit: 'ms'
        }),
        readRunClone: computeDistribution({
          metric: 'read_run_clone_ms',
          runId,
          values: readRunValues,
          warmUpCount: warmUpSamples,
          unit: 'ms'
        }),
        readHistoryClone: computeDistribution({
          metric: 'read_history_clone_ms',
          runId,
          values: readHistoryValues,
          warmUpCount: warmUpSamples,
          unit: 'ms'
        }),
        readConnectedRunsClone: computeDistribution({
          metric: 'read_connected_runs_clone_ms',
          runId,
          values: readConnectedValues,
          warmUpCount: warmUpSamples,
          unit: 'ms'
        }),
        eventLoopDelay,
        timerLateness
      });
    } finally {
      store?.close();
      await removeTempRoot(tempDir);
    }
  }

  // Enforce SC-002 sample sufficiency across all 3 runs for every measured distribution.
  const metricGroups: readonly (readonly Distribution[])[] = [
    runs.map((r) => r.writeQueueCommit),
    runs.map((r) => r.writeRunCommit),
    runs.map((r) => r.writeHistoryCommit),
    runs.map((r) => r.writeConnectedRunsCommit),
    runs.map((r) => r.pruneConnectedRunsOnly),
    runs.map((r) => r.readQueueClone),
    runs.map((r) => r.readRunClone),
    runs.map((r) => r.readHistoryClone),
    runs.map((r) => r.readConnectedRunsClone),
    runs.map((r) => r.timerLateness),
    ...(spec.measureAtomicAdmissionBatch
      ? [runs.map((r) => r.writeAdmissionBatchCommit!)]
      : [])
  ];
  for (const group of metricGroups) {
    const check = checkSampleSufficiency(group, {
      minIsolatedRuns: isolatedRuns,
      minWarmUpSamples: warmUpSamples,
      minSteadyStateSamples: steadyStateSamples
    });
    if (!check.sufficient) {
      throw new Error(`Sample sufficiency failed for ${check.metric}: ${check.failures.join('; ')}`);
    }
  }

  let worstWriteCommitP95Ms = 0;
  let worstWriteCommitP99Ms = 0;
  let worstWriteCommitOp = 'write_queue_commit_ms';

  for (const r of runs) {
    const writeDists = [
      r.writeQueueCommit,
      r.writeRunCommit,
      r.writeHistoryCommit,
      r.writeConnectedRunsCommit,
      ...(r.writeAdmissionBatchCommit ? [r.writeAdmissionBatchCommit] : [])
    ];
    for (const d of writeDists) {
      if (d.p95 > worstWriteCommitP95Ms) {
        worstWriteCommitP95Ms = d.p95;
        worstWriteCommitOp = d.metric;
      }
      if (d.p99 > worstWriteCommitP99Ms) {
        worstWriteCommitP99Ms = d.p99;
      }
    }
  }

  const worstReadCloneP95Ms = Math.max(
    ...runs.flatMap((r) => [
      r.readQueueClone.p95,
      r.readRunClone.p95,
      r.readHistoryClone.p95,
      r.readConnectedRunsClone.p95
    ])
  );
  const worstReadCloneP99Ms = Math.max(
    ...runs.flatMap((r) => [
      r.readQueueClone.p99,
      r.readRunClone.p99,
      r.readHistoryClone.p99,
      r.readConnectedRunsClone.p99
    ])
  );
  const worstPruneP95Ms = Math.max(...runs.map((r) => r.pruneConnectedRunsOnly.p95));
  const worstPruneP99Ms = Math.max(...runs.map((r) => r.pruneConnectedRunsOnly.p99));
  const worstEventLoopDelayP95Ms = Math.max(...runs.map((r) => r.eventLoopDelay.p95Ms));
  const worstEventLoopDelayP99Ms = Math.max(...runs.map((r) => r.eventLoopDelay.p99Ms));

  return {
    spec,
    pragmaVerified: pragmaVerified!,
    runs,
    worstWriteCommitP95Ms,
    worstWriteCommitP99Ms,
    worstWriteCommitOp,
    worstReadCloneP95Ms,
    worstReadCloneP99Ms,
    worstPruneP95Ms,
    worstPruneP99Ms,
    worstEventLoopDelayP95Ms,
    worstEventLoopDelayP99Ms
  };
}

export function evaluateDecisionGate(
  reports: readonly TierBenchmarkReport[]
): DecisionGateVerdict {
  let worstWriteCommitP95Ms = 0;
  let worstWriteCommitP99Ms = 0;
  let worstWriteCommitTierAndOp = 'none';
  let worstEventLoopDelayP95Ms = 0;
  let worstEventLoopDelayP99Ms = 0;
  let worstEventLoopDelayTier: OperationalWorkloadTierId = 'baseline-small';
  let worstReadCloneP95Ms = 0;
  let worstReadCloneP99Ms = 0;
  let worstPruneP95Ms = 0;
  let worstPruneP99Ms = 0;

  for (const report of reports) {
    if (report.worstWriteCommitP95Ms > worstWriteCommitP95Ms) {
      worstWriteCommitP95Ms = report.worstWriteCommitP95Ms;
      worstWriteCommitTierAndOp = `${report.spec.tierId}/${report.worstWriteCommitOp}`;
    }
    if (report.worstWriteCommitP99Ms > worstWriteCommitP99Ms) {
      worstWriteCommitP99Ms = report.worstWriteCommitP99Ms;
    }
    if (report.worstEventLoopDelayP95Ms > worstEventLoopDelayP95Ms) {
      worstEventLoopDelayP95Ms = report.worstEventLoopDelayP95Ms;
      worstEventLoopDelayTier = report.spec.tierId;
    }
    if (report.worstEventLoopDelayP99Ms > worstEventLoopDelayP99Ms) {
      worstEventLoopDelayP99Ms = report.worstEventLoopDelayP99Ms;
    }
    if (report.worstReadCloneP95Ms > worstReadCloneP95Ms) {
      worstReadCloneP95Ms = report.worstReadCloneP95Ms;
    }
    if (report.worstReadCloneP99Ms > worstReadCloneP99Ms) {
      worstReadCloneP99Ms = report.worstReadCloneP99Ms;
    }
    if (report.worstPruneP95Ms > worstPruneP95Ms) {
      worstPruneP95Ms = report.worstPruneP95Ms;
    }
    if (report.worstPruneP99Ms > worstPruneP99Ms) {
      worstPruneP99Ms = report.worstPruneP99Ms;
    }
  }

  const withinBudget =
    worstWriteCommitP95Ms <= BUDGET_P95_MS &&
    worstWriteCommitP99Ms <= BUDGET_P99_MS &&
    worstEventLoopDelayP95Ms <= BUDGET_P95_MS &&
    worstEventLoopDelayP99Ms <= BUDGET_P99_MS;

  const outcome = withinBudget ? 'defer-migration-9' : 'proceed-migration-9';
  const rationale = withinBudget
    ? `All documented workload tiers stayed within the Round 6 event-loop budget (worst write commit p95=${worstWriteCommitP95Ms.toFixed(3)} ms <= ${BUDGET_P95_MS} ms, p99=${worstWriteCommitP99Ms.toFixed(3)} ms <= ${BUDGET_P99_MS} ms; worst event-loop delay p95=${worstEventLoopDelayP95Ms.toFixed(3)} ms <= ${BUDGET_P95_MS} ms, p99=${worstEventLoopDelayP99Ms.toFixed(3)} ms <= ${BUDGET_P99_MS} ms). Migration 9 is deferred.`
    : `Measured host-thread latency exceeded the Round 6 event-loop budget (worst write commit p95=${worstWriteCommitP95Ms.toFixed(3)} ms, p99=${worstWriteCommitP99Ms.toFixed(3)} ms on ${worstWriteCommitTierAndOp}; worst event-loop delay p95=${worstEventLoopDelayP95Ms.toFixed(3)} ms, p99=${worstEventLoopDelayP99Ms.toFixed(3)} ms on ${worstEventLoopDelayTier}). Migration 9 is required.`;

  return {
    budgetP95Ms: BUDGET_P95_MS,
    budgetP99Ms: BUDGET_P99_MS,
    worstWriteCommitP95Ms,
    worstWriteCommitP99Ms,
    worstWriteCommitTierAndOp,
    worstEventLoopDelayP95Ms,
    worstEventLoopDelayP99Ms,
    worstEventLoopDelayTier,
    worstReadCloneP95Ms,
    worstReadCloneP99Ms,
    worstPruneP95Ms,
    worstPruneP99Ms,
    outcome,
    rationale
  };
}

export function captureBenchmarkEnvironment(sqliteVersion: string): BenchmarkEnvironmentSummary {
  const safeLoad = (value: number | undefined): number =>
    Number((value !== undefined && Number.isFinite(value) ? value : 0).toFixed(2));
  const [load1, load5, load15] = os.loadavg();
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    cpuCores: os.cpus().length,
    totalMemGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    nodeVersion: process.version,
    sqliteVersion,
    loadAvg1m: safeLoad(load1),
    loadAvg5m: safeLoad(load5),
    loadAvg15m: safeLoad(load15)
  };
}
