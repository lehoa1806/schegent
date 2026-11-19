// Per-slice equality stage distribution & JSON.stringify fallback cost measurement (FR-R7-09).
//
// WHAT THIS MEASURES. For each of the 8 SUPPRESSIBLE_SNAPSHOT_SLICES, instruments
// the exact decision stages of `areSnapshotSlicesEqual` (test/perf harness only —
// zero production runtime overhead) over 200 measured samples after 20 warm-up
// samples on:
//   - idle: one empty default queue, no Run, no history;
//   - active: one executing Run with 5 Phases, audit tail of 50, debug tail of 200;
//   - large-history: active workload on 20 live queues + 20 deleted partitions (2,000 history entries);
//   - large-history-2x: 60 deleted partitions attempted via appendHistory (bounded by F09 to 40 partitions / 2,000 entries);
//   - large-history-with-catalogs: large-history + populated catalogs (10 phases, 5 pipelines, 3 workflows)
//     to empirically measure whether structured catalog slices reach the JSON.stringify fallback.
//
// Also measures 1-consumer and 2-consumer (sidebar + dashboard) total routine flush
// host cost (`project()` + N * `preparePost()` + N * routine wire `JSON.stringify`),
// asserts 100% behavioral parity between the stage classifier and `areSnapshotSlicesEqual`
// on every sample, and asserts fixture/sample counts without brittle wall-clock assertions.

import { afterEach, describe, expect, it } from 'vitest';
import { unfencedCommit } from '../../src/state/ownership-claim';
import {
  MAX_DELETED_HISTORY_PARTITIONS,
  WorkspaceStateStore,
  type Memento,
  type PersistedHistoryEntry
} from '../../src/state/workspace-state';
import { HistoryStore } from '../../src/state/history-store';
import { MAX_QUEUES } from '../../src/contracts/queue-bounds';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { emptyBackendModels } from '../../src/contracts/backend-descriptors';
import {
  MAX_RETAINED_HISTORY_ENTRIES,
  MAX_RETAINED_HISTORY_PARTITIONS,
  SUPPRESSIBLE_SNAPSHOT_SLICES,
  type SuppressibleSnapshotSlice
} from '../../src/contracts/snapshot-bounds';
import { WebviewLogSink, DEBUG_LOG_TAIL_MAX } from '../../src/lib/webview-log-sink';
import { StateProjector, type ProjectorTimer } from '../../src/ui/sidebar/state-projector';
import {
  areSnapshotSlicesEqual,
  SnapshotTransport
} from '../../src/ui/sidebar/snapshot-transport';
import type { AuditTailEntry, WorkflowSnapshot } from '../../src/ui/sidebar/snapshot';
import type { WorkflowRun } from '../../src/state/workflow-run';
import type { PhaseDef, PipelineDef } from '../../src/config/pipeline-config';
import { resolvePhaseCatalog, type ResolvedPhaseCatalog } from '../../src/config/process-catalog';
import {
  resolvePipelineCatalog,
  type ResolvedPipelineCatalog
} from '../../src/config/pipeline-catalog';
import { resolveWorkflowCatalog } from '../../src/config/workflow-catalog';
import type { WorkflowCatalogResolution } from '../../src/contracts/workflow-definitions';

const ACTIVE_PHASE_COUNT = 5;
const ACTIVE_AUDIT_TAIL = 50;
const TICK_MS = 1_000;
const DEBOUNCE_MS = 100;
const EPOCH_MS = 1_700_000_000_000;
const HISTORY_PER_PARTITION = 50;
const DELETED_PARTITIONS_LARGE = 20;
const DELETED_PARTITIONS_LARGE_2X = 60;
const WARM_UP_SAMPLES = 20;
const SAMPLES = 200;
const ADOPTION_THRESHOLD_MS = 8;

const CATALOG_PHASE_COUNT = 10;
const CATALOG_PIPELINE_COUNT = 5;
const CATALOG_WORKFLOW_COUNT = 3;

const SLICE_EQUALITY_STAGES = [
  'ref-equal',
  'nullish-mismatch',
  'array-length-mismatch',
  'empty-array',
  'element-ref-equal',
  'history-head-tail-mismatch',
  'json-stringify-fallback'
] as const;

type SliceEqualityStage = (typeof SLICE_EQUALITY_STAGES)[number];

interface StageClassificationResult {
  readonly equal: boolean;
  readonly stage: SliceEqualityStage;
  readonly fallbackMs: number;
  readonly totalMs: number;
}

/**
 * Mirrors `areSnapshotSlicesEqual` in `src/ui/sidebar/snapshot-transport.ts` step-for-step,
 * recording the terminating stage and timing of any JSON.stringify fallback.
 * Tested for strict parity with `areSnapshotSlicesEqual` on all 7 stages and every sample.
 */
function classifySliceEqualityStage(
  slice: SuppressibleSnapshotSlice,
  prev: unknown,
  next: unknown
): StageClassificationResult {
  const totalStart = performance.now();
  if (prev === next) {
    return {
      equal: true,
      stage: 'ref-equal',
      fallbackMs: 0,
      totalMs: performance.now() - totalStart
    };
  }
  if (prev === undefined || next === undefined || prev === null || next === null) {
    return {
      equal: false,
      stage: 'nullish-mismatch',
      fallbackMs: 0,
      totalMs: performance.now() - totalStart
    };
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    if (prev.length !== next.length) {
      return {
        equal: false,
        stage: 'array-length-mismatch',
        fallbackMs: 0,
        totalMs: performance.now() - totalStart
      };
    }
    if (prev.length === 0) {
      return {
        equal: true,
        stage: 'empty-array',
        fallbackMs: 0,
        totalMs: performance.now() - totalStart
      };
    }
    let allRefEqual = true;
    for (let i = 0; i < prev.length; i += 1) {
      if (prev[i] !== next[i]) {
        allRefEqual = false;
        break;
      }
    }
    if (allRefEqual) {
      return {
        equal: true,
        stage: 'element-ref-equal',
        fallbackMs: 0,
        totalMs: performance.now() - totalStart
      };
    }
    if (slice === 'history') {
      const prevFirst = prev[0] as { runId?: unknown; completedAt?: unknown } | undefined;
      const nextFirst = next[0] as { runId?: unknown; completedAt?: unknown } | undefined;
      const prevLast = prev[prev.length - 1] as
        | { runId?: unknown; completedAt?: unknown }
        | undefined;
      const nextLast = next[next.length - 1] as
        | { runId?: unknown; completedAt?: unknown }
        | undefined;
      if (
        prevFirst?.runId !== nextFirst?.runId ||
        prevFirst?.completedAt !== nextFirst?.completedAt ||
        prevLast?.runId !== nextLast?.runId ||
        prevLast?.completedAt !== nextLast?.completedAt
      ) {
        return {
          equal: false,
          stage: 'history-head-tail-mismatch',
          fallbackMs: 0,
          totalMs: performance.now() - totalStart
        };
      }
    }
  }
  const fallbackStart = performance.now();
  const equal = JSON.stringify(prev) === JSON.stringify(next);
  const fallbackEnd = performance.now();
  return {
    equal,
    stage: 'json-stringify-fallback',
    fallbackMs: fallbackEnd - fallbackStart,
    totalMs: fallbackEnd - totalStart
  };
}

interface Distribution {
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

function distributionOf(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number): number =>
    sorted.at(Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))) ?? 0;
  return {
    samples: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted.at(-1) ?? 0
  };
}

class FakeMemento implements Memento {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

class VirtualClock implements ProjectorTimer {
  public now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  public setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  }

  public clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
}

function activePhases(): readonly PhaseDef[] {
  return Array.from({ length: ACTIVE_PHASE_COUNT }, (_, index) => ({
    id: `phase-${index + 1}`,
    name: `Phase ${index + 1}`,
    instruction: 'Measured workload phase.',
    loopable: false
  }));
}

function activeRun(): WorkflowRun {
  const phases = activePhases();
  return {
    id: 'run-cost-active',
    featureId: 'feat-cost-active',
    featureDir: 'specs/000-cost',
    status: 'running',
    currentPhase: 'phase-3',
    currentIteration: 1,
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
    resumeTargetPhaseId: null,
    pipeline: { id: 'cost-pipeline', name: 'Cost Pipeline', phases }
  };
}

function makeAuditTail(count: number): AuditTailEntry[] {
  return Array.from({ length: count }, (_, index) =>
    Object.freeze({
      id: `cost-${index}`,
      timestamp: new Date(EPOCH_MS + index * 100).toISOString(),
      phase: 'speckit-plan' as const,
      category: 'cli-invocation' as const,
      summary: `synthetic audit event ${index} with a moderately verbose summary line`,
      runId: `run-${index}`,
      scope: 'task' as const
    })
  );
}

const queueId = (index: number): string =>
  `0000${index.toString(16).padStart(4, '0')}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;

function idleQueueState() {
  return {
    paused: false,
    pausedReason: null,
    inFlightId: null,
    updatedAt: EPOCH_MS,
    queueLifecycle: 'active-empty' as const,
    pauseSource: null,
    scheduledStartAt: null,
    scheduledStartSource: null,
    requests: []
  };
}

function historyEntry(partition: number, index: number): PersistedHistoryEntry {
  const at = EPOCH_MS + (partition * HISTORY_PER_PARTITION + index) * 1_000;
  return {
    runId: `run-${partition}-${index}`,
    featureId: `feat-${partition}-${index}`,
    descriptionPreview: `history entry ${index} of partition ${partition}, with a realistic preview line`,
    terminalStatus: 'completed',
    startedAt: new Date(at).toISOString(),
    completedAt: new Date(at + 500).toISOString(),
    durationMs: 500,
    lastErrorSummary: null,
    auditLogPointer: `runId:run-${partition}-${index}`
  } as PersistedHistoryEntry;
}

interface PopulatedCatalogFixture {
  readonly phaseCatalog: ResolvedPhaseCatalog;
  readonly pipelineCatalog: ResolvedPipelineCatalog;
  readonly workflowCatalog: WorkflowCatalogResolution;
  readonly runtimeCatalog: {
    readonly phases: readonly PhaseDef[];
    readonly pipelines: readonly PipelineDef[];
    readonly models: ReturnType<typeof emptyBackendModels>;
  };
}

function buildPopulatedCatalogFixture(): PopulatedCatalogFixture {
  const phaseRows = Array.from({ length: CATALOG_PHASE_COUNT }, (_, index) => ({
    phaseId: `bench-phase-${index + 1}`,
    name: `Benchmark Phase ${index + 1}`,
    version: 1,
    description: `Realistic benchmark phase ${index + 1} used to measure steady-state catalog projection and equality cost.`,
    instruction:
      `Execute step ${index + 1} cleanly. Validate every invariant, inspect all affected files, and record concise evidence. ` +
      'Repeat verification after each targeted fix until all tests pass.',
    loopable: index % 3 === 0,
    timeoutSeconds: 600,
    isRequired: true
  }));

  const phaseCatalog = resolvePhaseCatalog({
    rows: phaseRows,
    revision: 'bench-phase-rev-1'
  });

  const pipelineRows = Array.from({ length: CATALOG_PIPELINE_COUNT }, (_, index) => {
    const start = (index * 2) % CATALOG_PHASE_COUNT;
    const phaseIds = Array.from(
      { length: 4 },
      (_, offset) => `bench-phase-${((start + offset) % CATALOG_PHASE_COUNT) + 1}`
    );
    return {
      pipelineId: `bench-pipeline-${index + 1}`,
      name: `Benchmark Pipeline ${index + 1}`,
      version: 1,
      description: `Multi-phase benchmark pipeline ${index + 1} chaining four resolved phases.`,
      phaseIds,
      inputs: [
        {
          portId: 'feature-doc',
          label: 'Feature Document',
          type: 'local-file',
          required: true,
          description: 'Path to the feature request document.'
        }
      ],
      outputs: [
        {
          portId: 'summary',
          label: 'Summary',
          type: 'markdown',
          description: 'Short execution summary.'
        }
      ],
      bindings: [],
      recommendedNext: []
    };
  });

  const pipelineCatalog = resolvePipelineCatalog({
    rows: pipelineRows,
    revision: 'bench-pipeline-rev-1',
    phaseCatalog: phaseCatalog.effective
  });

  const workflowRows = Array.from({ length: CATALOG_WORKFLOW_COUNT }, (_, index) => {
    const firstPhase = `bench-phase-${(index % CATALOG_PHASE_COUNT) + 1}`;
    const secondPhase = `bench-phase-${((index + 1) % CATALOG_PHASE_COUNT) + 1}`;
    const thirdPhase = `bench-phase-${((index + 2) % CATALOG_PHASE_COUNT) + 1}`;
    return {
      workflowId: `bench-workflow-${index + 1}`,
      name: `Benchmark Workflow ${index + 1}`,
      version: 1,
      description: `Three-node benchmark workflow ${index + 1} for steady-state catalog projection measurement.`,
      startNodeIds: ['node-a'],
      nodes: [
        { nodeId: 'node-a', kind: 'phase', phaseId: firstPhase, label: 'Start Phase' },
        { nodeId: 'node-b', kind: 'phase', phaseId: secondPhase, label: 'Middle Phase' },
        { nodeId: 'node-c', kind: 'phase', phaseId: thirdPhase, label: 'Final Phase' }
      ],
      connections: [
        { from: { nodeId: 'node-a' }, to: { nodeId: 'node-b' }, handoff: 'auto' },
        { from: { nodeId: 'node-b' }, to: { nodeId: 'node-c' }, handoff: 'auto' }
      ]
    };
  });

  const workflowCatalog = resolveWorkflowCatalog({
    rows: workflowRows,
    revision: 'bench-workflow-rev-1',
    phaseCatalog,
    pipelineCatalog
  });

  return {
    phaseCatalog,
    pipelineCatalog,
    workflowCatalog,
    runtimeCatalog: Object.freeze({
      phases: phaseCatalog.effectivePhaseDefs,
      pipelines: pipelineCatalog.effectivePipelineDefs,
      models: emptyBackendModels()
    })
  };
}

type WorkloadName =
  | 'idle'
  | 'active'
  | 'large-history'
  | 'large-history-2x'
  | 'large-history-with-catalogs';

interface WorkloadSpec {
  readonly name: WorkloadName;
  readonly withRun: boolean;
  readonly auditTail: number;
  readonly debugTail: number;
  readonly liveQueues: number;
  readonly deletedPartitions: number;
  readonly withPopulatedCatalogs: boolean;
}

const IDLE: WorkloadSpec = {
  name: 'idle',
  withRun: false,
  auditTail: 0,
  debugTail: 0,
  liveQueues: 1,
  deletedPartitions: 0,
  withPopulatedCatalogs: false
};
const ACTIVE: WorkloadSpec = {
  name: 'active',
  withRun: true,
  auditTail: ACTIVE_AUDIT_TAIL,
  debugTail: DEBUG_LOG_TAIL_MAX,
  liveQueues: 1,
  deletedPartitions: 0,
  withPopulatedCatalogs: false
};
const LARGE_HISTORY: WorkloadSpec = {
  ...ACTIVE,
  name: 'large-history',
  liveQueues: MAX_QUEUES,
  deletedPartitions: DELETED_PARTITIONS_LARGE
};
const LARGE_HISTORY_2X: WorkloadSpec = {
  ...ACTIVE,
  name: 'large-history-2x',
  liveQueues: MAX_QUEUES,
  deletedPartitions: DELETED_PARTITIONS_LARGE_2X
};
const LARGE_HISTORY_WITH_CATALOGS: WorkloadSpec = {
  ...LARGE_HISTORY,
  name: 'large-history-with-catalogs',
  withPopulatedCatalogs: true
};

interface BuiltWorkload {
  readonly clock: VirtualClock;
  readonly projector: StateProjector;
  readonly queues: number;
  readonly history: number;
  readonly catalogPhases: number;
  readonly catalogPipelines: number;
  readonly catalogWorkflows: number;
}

async function buildWorkload(spec: WorkloadSpec): Promise<BuiltWorkload> {
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  if (spec.liveQueues > 1) {
    const entries = Array.from({ length: spec.liveQueues }, (_, index) => ({
      id: index === 0 ? DEFAULT_QUEUE_ID : queueId(index),
      name: `Queue ${index}`,
      position: index,
      schedule: null,
      createdAt: EPOCH_MS,
      updatedAt: EPOCH_MS
    }));
    await store.setQueueRegistry({ entries, updatedAt: EPOCH_MS });
    for (const entry of entries) await store.setQueue(idleQueueState() as never, entry.id);
  }
  const partitions = spec.liveQueues + spec.deletedPartitions;
  const partitionIds = Array.from({ length: partitions }, (_, index) =>
    index === 0 ? DEFAULT_QUEUE_ID : queueId(index < spec.liveQueues ? index : 1_000 + index)
  );
  if (spec.liveQueues > 1 || spec.deletedPartitions > 0) {
    for (const [partition, id] of partitionIds.entries()) {
      for (let index = 0; index < HISTORY_PER_PARTITION; index += 1) {
        await store.appendHistory(id, historyEntry(partition, index));
      }
    }
  }
  if (spec.withRun) {
    await store.setRun(DEFAULT_QUEUE_ID, activeRun(), unfencedCommit('test-fixture'));
  }
  const sink = new WebviewLogSink(DEBUG_LOG_TAIL_MAX);
  for (let index = 0; index < spec.debugTail; index += 1) {
    sink.appendLine(`[2026-08-01T09:00:00.000Z] INFO measured debug line ${index}`);
  }
  const catalogs = spec.withPopulatedCatalogs ? buildPopulatedCatalogFixture() : null;
  const clock = new VirtualClock();
  const projector = new StateProjector({
    store,
    history: new HistoryStore(store),
    ownerId: 'this-window',
    debounceMs: DEBOUNCE_MS,
    tickIntervalMs: TICK_MS,
    timer: clock,
    monotonicNow: () => clock.now,
    now: () => new Date(EPOCH_MS + clock.now),
    getDebugLogTail: () => sink.getEntries(),
    ...(catalogs !== null
      ? {
          getCatalog: () => catalogs.runtimeCatalog,
          getPhaseCatalog: () => catalogs.phaseCatalog,
          getPipelineCatalog: () => catalogs.pipelineCatalog,
          getWorkflowCatalog: () => catalogs.workflowCatalog
        }
      : {})
  });
  projector.start();
  if (spec.auditTail > 0) projector.seedAuditTail(makeAuditTail(spec.auditTail));
  const retainedPartitions =
    spec.liveQueues + Math.min(spec.deletedPartitions, MAX_DELETED_HISTORY_PARTITIONS);
  const history =
    partitionIds.length > 0 && (spec.liveQueues > 1 || spec.deletedPartitions > 0)
      ? retainedPartitions * HISTORY_PER_PARTITION
      : 0;
  return {
    clock,
    projector,
    queues: spec.liveQueues,
    history,
    catalogPhases: catalogs ? catalogs.phaseCatalog.effective.length : 0,
    catalogPipelines: catalogs ? catalogs.pipelineCatalog.effective.length : 0,
    catalogWorkflows: catalogs ? catalogs.workflowCatalog.effective.length : 0
  };
}

const environment = Object.freeze({
  os: process.platform,
  arch: process.arch,
  node: process.version
});

function emptyStageCounts(): Record<SliceEqualityStage, number> {
  return {
    'ref-equal': 0,
    'nullish-mismatch': 0,
    'array-length-mismatch': 0,
    'empty-array': 0,
    'element-ref-equal': 0,
    'history-head-tail-mismatch': 0,
    'json-stringify-fallback': 0
  };
}

describe('FR-R7-09: stage classifier parity with areSnapshotSlicesEqual', () => {
  it('matches areSnapshotSlicesEqual across all 7 decision stages', () => {
    const sharedArray = Object.freeze([{ id: 1 }]);
    const sharedItemA = Object.freeze({ id: 'a' });
    const sharedItemB = Object.freeze({ id: 'b' });
    const historyA = { runId: 'r1', completedAt: '2026-11-19T00:00:00Z', status: 'completed' };
    const historyB = { runId: 'r2', completedAt: '2026-11-19T00:01:00Z', status: 'completed' };

    const cases: Array<{
      readonly label: string;
      readonly slice: SuppressibleSnapshotSlice;
      readonly prev: unknown;
      readonly next: unknown;
      readonly expectedStage: SliceEqualityStage;
      readonly expectedEqual: boolean;
    }> = [
      {
        label: 'same reference',
        slice: 'history',
        prev: sharedArray,
        next: sharedArray,
        expectedStage: 'ref-equal',
        expectedEqual: true
      },
      {
        label: 'undefined vs defined',
        slice: 'phaseCatalog',
        prev: undefined,
        next: { state: 'ready' },
        expectedStage: 'nullish-mismatch',
        expectedEqual: false
      },
      {
        label: 'null vs object',
        slice: 'pipelineCatalog',
        prev: null,
        next: { state: 'ready' },
        expectedStage: 'nullish-mismatch',
        expectedEqual: false
      },
      {
        label: 'null vs undefined',
        slice: 'workflowCatalog',
        prev: null,
        next: undefined,
        expectedStage: 'nullish-mismatch',
        expectedEqual: false
      },
      {
        label: 'array length differs',
        slice: 'auditTail',
        prev: [sharedItemA],
        next: [sharedItemA, sharedItemB],
        expectedStage: 'array-length-mismatch',
        expectedEqual: false
      },
      {
        label: 'two distinct empty arrays',
        slice: 'debugLogTail',
        prev: [],
        next: [],
        expectedStage: 'empty-array',
        expectedEqual: true
      },
      {
        label: 'distinct arrays with identical element references',
        slice: 'auditTail',
        prev: [sharedItemA, sharedItemB],
        next: [sharedItemA, sharedItemB],
        expectedStage: 'element-ref-equal',
        expectedEqual: true
      },
      {
        label: 'history head/tail mismatch short-circuit',
        slice: 'history',
        prev: [{ ...historyA }, { ...historyB }],
        next: [{ ...historyA, runId: 'r-other' }, { ...historyB }],
        expectedStage: 'history-head-tail-mismatch',
        expectedEqual: false
      },
      {
        label: 'distinct non-array objects hit JSON.stringify fallback (equal)',
        slice: 'phaseCatalog',
        prev: { state: 'ready', revision: 'r1', records: [] },
        next: { state: 'ready', revision: 'r1', records: [] },
        expectedStage: 'json-stringify-fallback',
        expectedEqual: true
      },
      {
        label: 'distinct non-array objects hit JSON.stringify fallback (different)',
        slice: 'workflowCatalog',
        prev: { state: 'ready', revision: 'r1', records: [] },
        next: { state: 'ready', revision: 'r2', records: [] },
        expectedStage: 'json-stringify-fallback',
        expectedEqual: false
      },
      {
        label: 'history matching head/tail with mutated middle entry falls back to JSON.stringify',
        slice: 'history',
        prev: [
          { ...historyA },
          { runId: 'r-mid', completedAt: '2026-11-19T00:00:30Z', status: 'completed' },
          { ...historyB }
        ],
        next: [
          { ...historyA },
          { runId: 'r-mid-changed', completedAt: '2026-11-19T00:00:30Z', status: 'failed' },
          { ...historyB }
        ],
        expectedStage: 'json-stringify-fallback',
        expectedEqual: false
      },
      {
        label: 'arrays with cloned elements hit JSON.stringify fallback',
        slice: 'availablePhases',
        prev: [{ id: 'p1', name: 'One' }],
        next: [{ id: 'p1', name: 'One' }],
        expectedStage: 'json-stringify-fallback',
        expectedEqual: true
      }
    ];

    expect(new Set(cases.map((c) => c.expectedStage))).toEqual(new Set(SLICE_EQUALITY_STAGES));

    for (const c of cases) {
      const classified = classifySliceEqualityStage(c.slice, c.prev, c.next);
      const production = areSnapshotSlicesEqual(c.slice, c.prev, c.next);
      expect(classified.stage, `${c.label}: stage`).toBe(c.expectedStage);
      expect(classified.equal, `${c.label}: equal`).toBe(c.expectedEqual);
      expect(classified.equal, `${c.label}: parity with production`).toBe(production);
    }
  });
});

describe('FR-R7-09: per-slice equality stages and fallback cost across workloads', () => {
  const live: Array<{ dispose(): void }> = [];
  afterEach(() => {
    for (const item of live.splice(0)) item.dispose();
  });

  async function measureEqualityCost(spec: WorkloadSpec) {
    const workload = await buildWorkload(spec);
    live.push(workload.projector);

    // Dual consumers mirror SidebarViewProvider + DashboardPanel
    const sidebarTransport = new SnapshotTransport();
    const dashboardTransport = new SnapshotTransport();
    let prevSnapshot: WorkflowSnapshot = workload.projector.project();
    sidebarTransport.preparePost(prevSnapshot);
    dashboardTransport.preparePost(prevSnapshot);

    const perSliceCounts = Object.fromEntries(
      SUPPRESSIBLE_SNAPSHOT_SLICES.map((slice) => [slice, emptyStageCounts()])
    ) as Record<SuppressibleSnapshotSlice, Record<SliceEqualityStage, number>>;
    const perSliceEqual = Object.fromEntries(
      SUPPRESSIBLE_SNAPSHOT_SLICES.map((slice) => [slice, 0])
    ) as Record<SuppressibleSnapshotSlice, number>;
    const perSliceFallbackMs = Object.fromEntries(
      SUPPRESSIBLE_SNAPSHOT_SLICES.map((slice) => [slice, [] as number[]])
    ) as Record<SuppressibleSnapshotSlice, number[]>;
    const perSliceTotalMs = Object.fromEntries(
      SUPPRESSIBLE_SNAPSHOT_SLICES.map((slice) => [slice, [] as number[]])
    ) as Record<SuppressibleSnapshotSlice, number[]>;

    const totalFallbackPerFlushMs: number[] = [];
    const totalComparePerFlushMs: number[] = [];
    const oneConsumerFlushMs: number[] = [];
    const twoConsumerFlushMs: number[] = [];

    let lastSnapshot: WorkflowSnapshot = prevSnapshot;
    for (let sample = 0; sample < WARM_UP_SAMPLES + SAMPLES; sample += 1) {
      workload.clock.now += TICK_MS;

      const projectStart = performance.now();
      const nextSnapshot = workload.projector.project();
      const projectEnd = performance.now();
      const projectElapsed = projectEnd - projectStart;

      // Measure 1-consumer and 2-consumer routine flush cost (production path)
      const c1Start = performance.now();
      const post1 = sidebarTransport.preparePost(nextSnapshot);
      JSON.stringify(post1.message);
      const c1End = performance.now();

      const c2Start = performance.now();
      const post2 = dashboardTransport.preparePost(nextSnapshot);
      JSON.stringify(post2.message);
      const c2End = performance.now();

      expect(post1.sync.mode, `${spec.name} sample ${sample}: sidebar routine mode`).toBe(
        'routine'
      );
      expect(post2.sync.mode, `${spec.name} sample ${sample}: dashboard routine mode`).toBe(
        'routine'
      );
      expect(
        post1.sync.omittedSlices?.length,
        `${spec.name} sample ${sample}: sidebar omitted all 8 unchanged slices`
      ).toBe(SUPPRESSIBLE_SNAPSHOT_SLICES.length);
      expect(
        post2.sync.omittedSlices?.length,
        `${spec.name} sample ${sample}: dashboard omitted all 8 unchanged slices`
      ).toBe(SUPPRESSIBLE_SNAPSHOT_SLICES.length);

      const prevRecord = prevSnapshot as unknown as Record<string, unknown>;
      const nextRecord = nextSnapshot as unknown as Record<string, unknown>;
      let flushFallbackMs = 0;
      let flushCompareMs = 0;

      for (const slice of SUPPRESSIBLE_SNAPSHOT_SLICES) {
        const result = classifySliceEqualityStage(slice, prevRecord[slice], nextRecord[slice]);
        const prodResult = areSnapshotSlicesEqual(slice, prevRecord[slice], nextRecord[slice]);
        expect(result.equal, `${spec.name}/${slice} sample ${sample}: parity`).toBe(prodResult);

        if (sample >= WARM_UP_SAMPLES) {
          perSliceCounts[slice][result.stage] += 1;
          if (result.equal) perSliceEqual[slice] += 1;
          perSliceFallbackMs[slice].push(result.fallbackMs);
          perSliceTotalMs[slice].push(result.totalMs);
          flushFallbackMs += result.fallbackMs;
          flushCompareMs += result.totalMs;
        }
      }

      if (sample >= WARM_UP_SAMPLES) {
        totalFallbackPerFlushMs.push(flushFallbackMs);
        totalComparePerFlushMs.push(flushCompareMs);
        const c1Elapsed = c1End - c1Start;
        const c2Elapsed = c2End - c2Start;
        oneConsumerFlushMs.push(projectElapsed + c1Elapsed);
        twoConsumerFlushMs.push(projectElapsed + c1Elapsed + c2Elapsed);
      }

      prevSnapshot = nextSnapshot;
      lastSnapshot = nextSnapshot;
    }

    const slicesSummary = Object.fromEntries(
      SUPPRESSIBLE_SNAPSHOT_SLICES.map((slice) => [
        slice,
        {
          stageCounts: perSliceCounts[slice],
          equalCount: perSliceEqual[slice],
          fallbackCount: perSliceCounts[slice]['json-stringify-fallback'],
          fallbackMs: distributionOf(perSliceFallbackMs[slice]),
          totalCompareMs: distributionOf(perSliceTotalMs[slice])
        }
      ])
    ) as Record<
      SuppressibleSnapshotSlice,
      {
        readonly stageCounts: Record<SliceEqualityStage, number>;
        readonly equalCount: number;
        readonly fallbackCount: number;
        readonly fallbackMs: Distribution;
        readonly totalCompareMs: Distribution;
      }
    >;

    const fallbackDist = distributionOf(totalFallbackPerFlushMs);
    const compareDist = distributionOf(totalComparePerFlushMs);
    const oneConsumerDist = distributionOf(oneConsumerFlushMs);
    const twoConsumerDist = distributionOf(twoConsumerFlushMs);
    const thresholdMet =
      spec.name !== 'idle' &&
      (fallbackDist.p95 >= ADOPTION_THRESHOLD_MS ||
        oneConsumerDist.p95 >= ADOPTION_THRESHOLD_MS ||
        twoConsumerDist.p95 >= ADOPTION_THRESHOLD_MS);

    const line = {
      workload: spec.name,
      environment,
      warmUpSamples: WARM_UP_SAMPLES,
      measuredSamples: SAMPLES,
      fixture: {
        queues: lastSnapshot.queues.length,
        history: lastSnapshot.history.length,
        auditTail: lastSnapshot.auditTail.length,
        debugTail: lastSnapshot.debugLogTail.length,
        catalogPhases: workload.catalogPhases,
        catalogPipelines: workload.catalogPipelines,
        catalogWorkflows: workload.catalogWorkflows
      },
      slices: slicesSummary,
      totalFallbackPerFlushMs: fallbackDist,
      totalComparePerFlushMs: compareDist,
      oneConsumerFlushMs: oneConsumerDist,
      twoConsumerFlushMs: twoConsumerDist,
      thresholdMs: ADOPTION_THRESHOLD_MS,
      thresholdMet
    };

    process.stdout.write(`SLICE_EQUALITY_COST ${JSON.stringify(line)}\n`);

    // Assert fixture cardinalities and sample/stage accounting (no timing assertions per E5)
    expect(line.fixture.queues, `${spec.name}: queues`).toBe(workload.queues);
    expect(line.fixture.history, `${spec.name}: history`).toBe(workload.history);
    expect(line.fixture.history, `${spec.name}: F09 history cap`).toBeLessThanOrEqual(
      MAX_RETAINED_HISTORY_ENTRIES
    );
    expect(line.fixture.auditTail, `${spec.name}: auditTail`).toBe(spec.auditTail);
    expect(line.fixture.debugTail, `${spec.name}: debugTail`).toBe(spec.debugTail);

    for (const slice of SUPPRESSIBLE_SNAPSHOT_SLICES) {
      const entry = line.slices[slice];
      const stageSum = Object.values(entry.stageCounts).reduce((a, b) => a + b, 0);
      expect(stageSum, `${spec.name}/${slice}: stage count sum`).toBe(SAMPLES);
      expect(entry.fallbackCount, `${spec.name}/${slice}: fallback count matches stage`).toBe(
        entry.stageCounts['json-stringify-fallback']
      );
      expect(entry.fallbackMs.samples, `${spec.name}/${slice}: fallback samples`).toBe(SAMPLES);
      expect(entry.totalCompareMs.samples, `${spec.name}/${slice}: compare samples`).toBe(SAMPLES);
    }

    expect(line.totalFallbackPerFlushMs.samples).toBe(SAMPLES);
    expect(line.totalComparePerFlushMs.samples).toBe(SAMPLES);
    expect(line.oneConsumerFlushMs.samples).toBe(SAMPLES);
    expect(line.twoConsumerFlushMs.samples).toBe(SAMPLES);
    return line;
  }

  it('idle: measures equality stages across all 8 suppressible slices', async () => {
    const line = await measureEqualityCost(IDLE);
    expect(line.fixture.queues).toBe(1);
    expect(line.fixture.history).toBe(0);
    expect(line.slices.history.stageCounts['ref-equal']).toBe(SAMPLES);
  });

  it('active: measures equality stages with 5-phase Run, 50 audit entries, and 200 debug entries', async () => {
    const line = await measureEqualityCost(ACTIVE);
    expect(line.fixture.auditTail).toBe(ACTIVE_AUDIT_TAIL);
    expect(line.fixture.debugTail).toBe(DEBUG_LOG_TAIL_MAX);
    expect(line.slices.auditTail.stageCounts['element-ref-equal']).toBe(SAMPLES);
    expect(line.slices.debugLogTail.stageCounts['element-ref-equal']).toBe(SAMPLES);
  });

  it('large-history: measures equality stages on 20 queues + 20 deleted partitions (2,000 history entries)', async () => {
    const line = await measureEqualityCost(LARGE_HISTORY);
    expect(line.fixture.history).toBe(2_000);
    expect(line.slices.history.stageCounts['ref-equal']).toBe(SAMPLES);
  });

  it('large-history-2x: measures equality stages with 60 deleted partitions attempted (F09-bounded to 40 partitions / 2,000 entries)', async () => {
    const line = await measureEqualityCost(LARGE_HISTORY_2X);
    expect(line.fixture.history).toBe(MAX_RETAINED_HISTORY_PARTITIONS * HISTORY_PER_PARTITION);
    expect(line.slices.history.stageCounts['ref-equal']).toBe(SAMPLES);
  });

  it('large-history-with-catalogs: measures equality stages with populated catalogs (10 phases, 5 pipelines, 3 workflows)', async () => {
    const line = await measureEqualityCost(LARGE_HISTORY_WITH_CATALOGS);
    expect(line.fixture.catalogPhases).toBe(CATALOG_PHASE_COUNT);
    expect(line.fixture.catalogPipelines).toBe(CATALOG_PIPELINE_COUNT);
    expect(line.fixture.catalogWorkflows).toBe(CATALOG_WORKFLOW_COUNT);
    // Empirically verify catalog projection behavior in steady state:
    expect(line.slices.availablePhases.stageCounts['element-ref-equal']).toBe(SAMPLES);
    expect(line.slices.availablePipelines.stageCounts['element-ref-equal']).toBe(SAMPLES);
    expect(line.slices.phaseCatalog.fallbackCount).toBe(SAMPLES);
    expect(line.slices.pipelineCatalog.fallbackCount).toBe(SAMPLES);
    expect(line.slices.workflowCatalog.fallbackCount).toBe(SAMPLES);
  });
});
