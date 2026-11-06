// Snapshot cost, per named workload (FR-R4-F08, contract E: E3, E-T2; TA5).
//
// WHAT THIS RECORDS. The host-side cost of the state snapshot a webview receives,
// and how many snapshots a hidden sidebar is sent. Each workload prints one
// `SNAPSHOT_COST <json>` line in data model section 6's `WorkloadMeasurement`
// shape. This file is a MEASUREMENT: it asserts that it ran (its fixture counts
// and its sample counts) and never asserts a timing, so `tests/perf/budgets.json`
// gets no entry (E5).
//
// THE HIDDEN WORKLOAD. A real `SidebarViewProvider` is resolved over this file's
// own fake `WebviewView` and driven through 60 simulated seconds of the active
// workload's 1 Hz tick while the view is hidden, then revealed once. It prints
// three figures in `hiddenPosts`:
//   - `before`: snapshots the projector delivered while hidden, which is what a
//     provider that posts every flush would post;
//   - `after`: `STATE_SNAPSHOT` posts the fake view actually received while hidden;
//   - `onReveal`: posts the reveal itself caused.
// Before the provider gates on visibility, `after` equals `before` and `onReveal`
// is 0. After it, `after` is 0 and `onReveal` is 1. That second half is the part
// of this file that is red until feature US5.
//
// THE FOUR HOST WORKLOADS (E2, E-T1). Each is built over a real `WorkspaceStateStore` on a local
// `FakeMemento`, a real `HistoryStore` and a real `StateProjector` on a virtual clock:
//   - idle: one empty default queue, no Run, no history;
//   - active: one executing Run with five Phases, an audit tail of 50 and a debug tail of 200;
//   - large-history: the active workload on 20 queues at the 50-entry cap, plus 20 deleted queues'
//     partitions at 50 each, 2,000 history entries in all;
//   - large-history-2x: the same with 60 deleted partitions, 4,000 entries in all (the 50-entry cap
//     is per partition, so more entries means more partitions).
// Each records `project()` time, `JSON.stringify` time and UTF-8 bytes as distributions of 200 samples
// after 20 warm-up samples, and asserts what the workload holds and how many samples were taken.
//
// The fake view lives here rather than in a shared helper so a perf file does not
// import from a unit test file (TA5).

import { afterEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { unfencedCommit } from '../../src/state/ownership-claim';
import {
  MAX_DELETED_HISTORY_PARTITIONS,
  WorkspaceStateStore,
  type Memento,
  type PersistedHistoryEntry
} from '../../src/state/workspace-state';
import { HistoryStore } from '../../src/state/history-store';
import { MAX_QUEUES } from '../../src/contracts/queue-bounds';
import { PHASE_LOG_MAX_ENTRIES } from '../../src/contracts/phase-log-bounds';
import {
  FULL_RESYNC_SNAPSHOT_BYTE_CEILING,
  MAX_RETAINED_HISTORY_ENTRIES,
  MAX_RETAINED_HISTORY_PARTITIONS,
  ROUTINE_SNAPSHOT_BYTE_BUDGET
} from '../../src/contracts/snapshot-bounds';
import { SanitizedLogger } from '../../src/lib/logger';
import { WebviewLogSink, DEBUG_LOG_TAIL_MAX } from '../../src/lib/webview-log-sink';
import { StateProjector, type ProjectorTimer } from '../../src/ui/sidebar/state-projector';
import { SidebarViewProvider } from '../../src/ui/sidebar/sidebar-view-provider';
import { SnapshotTransport } from '../../src/ui/sidebar/snapshot-transport';
import { STATE_SNAPSHOT } from '../../src/ui/sidebar/messages';
import type { AuditTailEntry, WorkflowSnapshot } from '../../src/ui/sidebar/snapshot';
import type { WorkflowRun } from '../../src/state/workflow-run';
import type { PhaseDef } from '../../src/config/pipeline-config';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import {
  appendToWindow,
  hiddenEntryCount,
  PHASE_LOG_WINDOW_MAX_ENTRIES
} from '../../webview-ui/src/lib/phase-log-window';
import {
  boundHistorySnapshots,
  MAX_BUILDER_HISTORY_BYTES,
  MAX_BUILDER_HISTORY_ENTRIES
} from '../../webview-ui/src/components/PipelineBuilderEditors/phase-catalog-actions';
import type { PhaseLogDisplayEntry } from '../../src/services/phase-log/types';

/** Phases the active workload's Run carries. */
const ACTIVE_PHASE_COUNT = 5;
/** The audit tail at its cap (data model: a full audit tail of 50). */
const ACTIVE_AUDIT_TAIL = 50;
/** The simulated hidden period, in seconds. */
const HIDDEN_SECONDS = 60;
const STEP_MS = 100;
const TICK_MS = 1_000;
const DEBOUNCE_MS = 100;
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

/** A virtual clock that runs due timers in order. Nothing here waits in real time. */
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

  public advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueAt = timer.at;
          dueId = id;
        }
      }
      if (dueId === null) break;
      const due = this.timers.get(dueId);
      this.timers.delete(dueId);
      if (due === undefined) break;
      this.now = Math.max(this.now, due.at);
      due.fn();
    }
    this.now = target;
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

function auditTail(count: number): AuditTailEntry[] {
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

/** What a workload holds, and so what its test asserts it holds. */
interface WorkloadSpec {
  readonly name: 'idle' | 'active' | 'large-history' | 'large-history-2x';
  readonly withRun: boolean;
  readonly auditTail: number;
  readonly debugTail: number;
  readonly liveQueues: number;
  readonly deletedPartitions: number;
}

/** The history cap per partition (`HISTORY_CAP_PER_QUEUE`): every partition below is built full. */
const HISTORY_PER_PARTITION = 50;
const DELETED_PARTITIONS_LARGE = 20;
const DELETED_PARTITIONS_LARGE_2X = 60;

const IDLE: WorkloadSpec = { name: 'idle', withRun: false, auditTail: 0, debugTail: 0, liveQueues: 1, deletedPartitions: 0 };
const ACTIVE: WorkloadSpec = { name: 'active', withRun: true, auditTail: ACTIVE_AUDIT_TAIL, debugTail: DEBUG_LOG_TAIL_MAX, liveQueues: 1, deletedPartitions: 0 };
const LARGE_HISTORY: WorkloadSpec = { ...ACTIVE, name: 'large-history', liveQueues: MAX_QUEUES, deletedPartitions: DELETED_PARTITIONS_LARGE };
const LARGE_HISTORY_2X: WorkloadSpec = { ...ACTIVE, name: 'large-history-2x', liveQueues: MAX_QUEUES, deletedPartitions: DELETED_PARTITIONS_LARGE_2X };

/** Deterministic v4-shaped ids, as the registry validator requires and as `render-budget.test.ts` builds them. */
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

/** A workload over a virtual clock, with the counts it claims to hold. */
interface Workload {
  readonly clock: VirtualClock;
  readonly projector: StateProjector;
  readonly queues: number;
  readonly history: number;
}

async function buildWorkload(spec: WorkloadSpec): Promise<Workload> {
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
  // Live partitions are the registered queues; the rest belong to queues that were deleted, whose
  // history the store keeps (data model section 7).
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
  // Pattern D: seeded by queue, read with `getRunMap()` only (hard rules 57, 58).
  if (spec.withRun) await store.setRun(DEFAULT_QUEUE_ID, activeRun(), unfencedCommit('test-fixture'));
  const sink = new WebviewLogSink(DEBUG_LOG_TAIL_MAX);
  for (let index = 0; index < spec.debugTail; index++) {
    sink.appendLine(`[2026-08-01T09:00:00.000Z] INFO measured debug line ${index}`);
  }
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
    getDebugLogTail: () => sink.getEntries()
  });
  projector.start();
  if (spec.auditTail > 0) projector.seedAuditTail(auditTail(spec.auditTail));
  const retainedPartitions =
    spec.liveQueues + Math.min(spec.deletedPartitions, MAX_DELETED_HISTORY_PARTITIONS);
  const history = partitionIds.length > 0 && (spec.liveQueues > 1 || spec.deletedPartitions > 0)
    ? retainedPartitions * HISTORY_PER_PARTITION
    : 0;
  return { clock, projector, queues: spec.liveQueues, history };
}

const buildActiveWorkload = (): Promise<Workload> => buildWorkload(ACTIVE);

/** The fake `WebviewView`: contract V's shape, with live-listener counts. */
class FakeView {
  public visible = true;
  public readonly posts: { readonly type: string; readonly bytes: number }[] = [];
  private visibilityListeners = new Set<(event: unknown) => void>();
  private disposeListeners = new Set<() => void>();

  public readonly webview = {
    cspSource: 'vscode-webview://cost-fixture',
    html: '',
    options: {} as unknown,
    asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => uri.fsPath }),
    postMessage: async (message: { type: string }): Promise<boolean> => {
      this.posts.push({ type: message.type, bytes: Buffer.byteLength(JSON.stringify(message), 'utf8') });
      return true;
    },
    onDidReceiveMessage: (): { dispose: () => void } => ({ dispose: () => undefined })
  };

  public readonly onDidChangeVisibility = (listener: (event: unknown) => void) => {
    this.visibilityListeners.add(listener);
    return { dispose: () => void this.visibilityListeners.delete(listener) };
  };

  public readonly onDidDispose = (listener: () => void) => {
    this.disposeListeners.add(listener);
    return { dispose: () => void this.disposeListeners.delete(listener) };
  };

  public setVisible(visible: boolean): void {
    this.visible = visible;
    for (const listener of [...this.visibilityListeners]) listener({ webviewPanel: this });
  }

  public snapshotPosts(): readonly { readonly type: string; readonly bytes: number }[] {
    return this.posts.filter((post) => post.type === STATE_SNAPSHOT);
  }
}

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round++) await Promise.resolve();
}

const environment = Object.freeze({ os: process.platform, arch: process.arch, node: process.version });

interface Disposable {
  dispose(): void;
}

describe('webview snapshot cost: the active workload', () => {
  const live: Disposable[] = [];
  afterEach(() => {
    for (const item of live.splice(0)) item.dispose();
  });

  it('holds one executing Run with five Phases, a full audit tail and a full debug tail', async () => {
    const workload = await buildActiveWorkload();
    live.push(workload.projector);
    const snapshot: WorkflowSnapshot = workload.projector.getCurrentSnapshot();
    const queue = snapshot.queues.find((candidate) => candidate.queueId === DEFAULT_QUEUE_ID);
    if (queue === undefined || queue.inFlightRun === null) throw new Error('the default queue has no Run');
    expect(queue.inFlightRun.status, 'the Run is executing').toBe('running');
    expect(queue.phases.length, 'the Run carries five Phases').toBe(ACTIVE_PHASE_COUNT);
    expect(snapshot.auditTail.length, 'the audit tail is full').toBe(ACTIVE_AUDIT_TAIL);
    expect(snapshot.debugLogTail.length, 'the debug tail is full').toBe(DEBUG_LOG_TAIL_MAX);
  });
});

/** Samples per distribution, after the warm-up (FR-015). */
const SAMPLES = 200;
const WARM_UP_SAMPLES = 20;

interface Distribution {
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

function distributionOf(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number): number => sorted.at(Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))) ?? 0;
  return { samples: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0 };
}

describe('webview snapshot cost: the four host workloads', () => {
  const live: Disposable[] = [];
  afterEach(() => {
    for (const item of live.splice(0)) item.dispose();
  });

  async function measure(spec: WorkloadSpec) {
    const workload = await buildWorkload(spec);
    live.push(workload.projector);
    const transport = new SnapshotTransport();
    // Seed initial full snapshot on the transport so subsequent samples measure routine updates
    transport.preparePost(workload.projector.project());
    const projectMs: number[] = [];
    const serializeMs: number[] = [];
    const routineSerializeMs: number[] = [];
    const bytes: number[] = [];
    const routineBytes: number[] = [];
    let last: WorkflowSnapshot | null = null;
    for (let sample = 0; sample < WARM_UP_SAMPLES + SAMPLES; sample += 1) {
      workload.clock.now += TICK_MS;
      const projectStart = performance.now();
      const snapshot = workload.projector.project();
      const projectEnd = performance.now();
      const json = JSON.stringify(snapshot);
      const serializeEnd = performance.now();
      const routineStart = performance.now();
      const prepared = transport.preparePost(snapshot);
      const routineJson = JSON.stringify(prepared.message);
      const routineEnd = performance.now();
      last = snapshot;
      if (sample < WARM_UP_SAMPLES) continue;
      projectMs.push(projectEnd - projectStart);
      serializeMs.push(serializeEnd - projectEnd);
      routineSerializeMs.push(routineEnd - routineStart);
      bytes.push(Buffer.byteLength(json, 'utf8'));
      routineBytes.push(Buffer.byteLength(routineJson, 'utf8'));
    }
    if (last === null) throw new Error('no sample was taken');
    const mem = process.memoryUsage();
    const line = {
      workload: spec.name,
      environment,
      fixture: {
        queues: last.queues.length,
        history: last.history.length,
        auditTail: last.auditTail.length,
        debugTail: last.debugLogTail.length
      },
      snapshotBytes: distributionOf(bytes),
      routineSnapshotBytes: distributionOf(routineBytes),
      projectMs: distributionOf(projectMs),
      serializeMs: distributionOf(serializeMs),
      routineSerializeMs: distributionOf(routineSerializeMs),
      memoryBytes: {
        heapUsed: mem.heapUsed,
        rss: mem.rss
      }
    };
    process.stdout.write(`SNAPSHOT_COST ${JSON.stringify(line)}\n`);
    // Assert fixture cardinality, sample counts, and deterministic byte bounds (FR-R5-F12).
    expect(line.fixture.queues, `${spec.name}: queues`).toBe(workload.queues);
    expect(line.fixture.history, `${spec.name}: history entries`).toBe(workload.history);
    expect(line.fixture.history, `${spec.name}: history bounded by F09`).toBeLessThanOrEqual(
      MAX_RETAINED_HISTORY_ENTRIES
    );
    expect(line.fixture.auditTail, `${spec.name}: audit tail`).toBe(spec.auditTail);
    expect(line.fixture.debugTail, `${spec.name}: debug tail`).toBe(spec.debugTail);
    expect(
      line.snapshotBytes.max,
      `${spec.name}: full-resync bytes within ceiling`
    ).toBeLessThanOrEqual(FULL_RESYNC_SNAPSHOT_BYTE_CEILING);
    expect(
      line.routineSnapshotBytes.max,
      `${spec.name}: routine update bytes within 512 KiB budget`
    ).toBeLessThanOrEqual(ROUTINE_SNAPSHOT_BYTE_BUDGET);
    for (const [name, distribution] of Object.entries({
      snapshotBytes: line.snapshotBytes,
      routineSnapshotBytes: line.routineSnapshotBytes,
      projectMs: line.projectMs,
      serializeMs: line.serializeMs,
      routineSerializeMs: line.routineSerializeMs
    })) {
      expect(distribution.samples, `${spec.name}: ${name} samples`).toBe(SAMPLES);
    }
    return line;
  }

  it('idle: one empty default queue, no Run and no history', async () => {
    const line = await measure(IDLE);
    expect(line.fixture.queues).toBe(1);
    expect(line.fixture.history).toBe(0);
  });

  it('active: one executing Run, an audit tail of 50 and a debug tail of 200', async () => {
    const line = await measure(ACTIVE);
    expect(line.fixture.auditTail).toBe(ACTIVE_AUDIT_TAIL);
  });

  it('large-history: 20 queues and 20 deleted partitions, 2,000 history entries; routine update meets 512 KiB budget', async () => {
    const line = await measure(LARGE_HISTORY);
    expect(line.fixture.history).toBe((MAX_QUEUES + DELETED_PARTITIONS_LARGE) * HISTORY_PER_PARTITION);
    expect(line.fixture.history).toBe(2_000);
    expect(line.routineSnapshotBytes.max).toBeLessThanOrEqual(ROUTINE_SNAPSHOT_BYTE_BUDGET);
  });

  it('large-history-2x: 60 deleted partitions attempted via appendHistory are bounded by F09 to 40 total partitions (2,000 entries)', async () => {
    const line = await measure(LARGE_HISTORY_2X);
    expect(line.fixture.history).toBe(MAX_RETAINED_HISTORY_PARTITIONS * HISTORY_PER_PARTITION);
    expect(line.fixture.history).toBe(2_000);
    expect(line.routineSnapshotBytes.max).toBeLessThanOrEqual(ROUTINE_SNAPSHOT_BYTE_BUDGET);
  });
});

describe('webview snapshot cost: the hidden workload', () => {
  const live: Disposable[] = [];
  afterEach(() => {
    for (const item of live.splice(0)) item.dispose();
  });

  it(`posts no snapshot over ${HIDDEN_SECONDS} simulated hidden seconds, and one on reveal`, async () => {
    const workload = await buildActiveWorkload();
    live.push(workload.projector);
    const view = new FakeView();
    const provider = new SidebarViewProvider({
      extensionRoot: '/nonexistent-extension-root',
      projector: workload.projector,
      logger: new SanitizedLogger()
    });
    live.push(provider);
    await provider.resolveWebviewView(
      view as unknown as vscode.WebviewView,
      {} as vscode.WebviewViewResolveContext,
      {} as vscode.CancellationToken
    );
    await settle();

    // What an ungated provider would post: every delivery to a listener while hidden.
    let deliveredWhileHidden = 0;
    let deliveredBytesWhileHidden = 0;
    let counting = false;
    live.push(
      workload.projector.subscribe((snapshot) => {
        if (!counting) return;
        deliveredWhileHidden += 1;
        deliveredBytesWhileHidden += Buffer.byteLength(
          JSON.stringify({ type: STATE_SNAPSHOT, payload: snapshot }),
          'utf8'
        );
      })
    );

    // Hidden: the view stops being visible, then 60 simulated seconds of the Run's tick pass.
    view.posts.length = 0;
    view.setVisible(false);
    await settle();
    counting = true;
    for (let elapsed = 0; elapsed < HIDDEN_SECONDS * 1_000; elapsed += STEP_MS) {
      workload.clock.advance(STEP_MS);
      await settle();
    }
    counting = false;
    const hiddenPosts = view.snapshotPosts();
    const postsWhileHidden = hiddenPosts.length;
    const bytesWhileHidden = hiddenPosts.reduce((total, post) => total + post.bytes, 0);

    // Reveal: one visibility event, and nothing else.
    view.posts.length = 0;
    view.setVisible(true);
    await settle();
    const onReveal = view.snapshotPosts().length;

    const line = {
      workload: 'hidden',
      environment,
      hiddenSeconds: HIDDEN_SECONDS,
      hiddenPosts: { before: deliveredWhileHidden, after: postsWhileHidden, onReveal },
      hiddenBytes: { before: deliveredBytesWhileHidden, after: bytesWhileHidden }
    };
    process.stdout.write(`SNAPSHOT_COST ${JSON.stringify(line)}\n`);

    // The workload ran: the projector delivered snapshots while the view was hidden.
    expect(deliveredWhileHidden, 'the Run\'s tick produced snapshots while hidden').toBeGreaterThan(0);
    // The red half until the provider gates on visibility.
    expect(postsWhileHidden, 'STATE_SNAPSHOT posts while hidden').toBe(0);
    expect(onReveal, 'STATE_SNAPSHOT posts caused by the reveal').toBe(1);
  });
});

describe('webview snapshot cost: phase-log window, Builder bounds, activation & memory (FR-R5-F12)', () => {
  const live: Disposable[] = [];
  afterEach(() => {
    for (const item of live.splice(0)) item.dispose();
  });

  it('bounds the 500-row phase-log live window with trim marker across 2,000 appends', () => {
    let entries: readonly PhaseLogDisplayEntry[] = [];
    const appendMs: number[] = [];
    const totalAppends = 2_000;

    for (let seq = 1; seq <= totalAppends; seq += 1) {
      const entry: PhaseLogDisplayEntry = {
        seq,
        kind: seq % 3 === 0 ? 'tool-use' : 'assistant-text',
        ts: new Date(EPOCH_MS + seq * 100).toISOString(),
        body:
          seq % 3 === 0
            ? { toolName: 'read_file', toolArguments: '{"path":"src/index.ts"}', toolId: `t-${seq}` }
            : { text: `phase log line ${seq} with representative assistant output text` },
        bodyTruncated: null
      };
      const start = performance.now();
      entries = appendToWindow(entries, entry, PHASE_LOG_WINDOW_MAX_ENTRIES);
      const end = performance.now();
      if (seq > 500) {
        appendMs.push(end - start);
      }
    }

    const windowBytes = Buffer.byteLength(JSON.stringify(entries), 'utf8');
    const marker = entries[0];
    const trimmedCount = hiddenEntryCount(entries);
    const line = {
      workload: 'phase-log-window',
      environment,
      totalAppends,
      retainedRows: entries.length,
      maxAllowedRows: PHASE_LOG_MAX_ENTRIES,
      trimmedCount,
      windowBytes,
      appendMs: distributionOf(appendMs)
    };
    process.stdout.write(`SNAPSHOT_COST ${JSON.stringify(line)}\n`);

    expect(entries.length).toBe(PHASE_LOG_MAX_ENTRIES);
    expect(marker?.kind).toBe('truncated-head');
    expect(trimmedCount).toBe(totalAppends - PHASE_LOG_WINDOW_MAX_ENTRIES);
  });

  it('enforces F10 Builder undo/redo entry-count (50) and byte (256 KiB) bounds across 200 edits', () => {
    let stack: Array<readonly PhaseDef[]> = [];
    const pushMs: number[] = [];

    // 100 standard edits followed by 100 large instruction edits (~8 KiB each)
    for (let edit = 0; edit < 200; edit += 1) {
      const pad = edit >= 100 ? 'x'.repeat(1_600) : 'short instruction';
      const draft: readonly PhaseDef[] = Array.from({ length: 5 }, (_, p) => ({
        id: `phase-${p + 1}`,
        name: `Phase ${p + 1} (edit ${edit})`,
        instruction: `${pad}-${edit}-${p}`,
        loopable: false
      }));
      const start = performance.now();
      stack = boundHistorySnapshots([...stack, draft]);
      const end = performance.now();
      pushMs.push(end - start);
    }

    const totalBytes = stack.reduce(
      (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry), 'utf8'),
      0
    );
    const line = {
      workload: 'builder-history-bounds',
      environment,
      totalEdits: 200,
      retainedEntries: stack.length,
      maxEntries: MAX_BUILDER_HISTORY_ENTRIES,
      retainedBytes: totalBytes,
      maxBytes: MAX_BUILDER_HISTORY_BYTES,
      pushMs: distributionOf(pushMs)
    };
    process.stdout.write(`SNAPSHOT_COST ${JSON.stringify(line)}\n`);

    expect(stack.length).toBeLessThanOrEqual(MAX_BUILDER_HISTORY_ENTRIES);
    expect(totalBytes).toBeLessThanOrEqual(MAX_BUILDER_HISTORY_BYTES);
  });

  it('measures cold activation path vs 2-rAF browser floor and sustained long-session host memory', async () => {
    const activationStart = performance.now();
    const workload = await buildWorkload(LARGE_HISTORY);
    live.push(workload.projector);
    const transport = new SnapshotTransport();
    const initialPost = transport.preparePost(workload.projector.getCurrentSnapshot());
    const initialWireBytes = Buffer.byteLength(JSON.stringify(initialPost.message), 'utf8');
    const activationCpuMs = performance.now() - activationStart;

    const memBefore = process.memoryUsage();
    const tickRoutineBytes: number[] = [];
    for (let tick = 0; tick < 500; tick += 1) {
      workload.clock.advance(TICK_MS);
      const snap = workload.projector.getCurrentSnapshot();
      const post = transport.preparePost(snap);
      tickRoutineBytes.push(Buffer.byteLength(JSON.stringify(post.message), 'utf8'));
    }
    const memAfter = process.memoryUsage();

    const line = {
      workload: 'activation-and-sustained-memory',
      environment,
      activationHostCpuMs: activationCpuMs,
      browserTwoAnimationFrameFloorMs: 33.33,
      initialFullResyncBytes: initialWireBytes,
      sustainedTicks: 500,
      routineWireBytes: distributionOf(tickRoutineBytes),
      memoryBytes: {
        heapUsedBefore: memBefore.heapUsed,
        heapUsedAfter: memAfter.heapUsed,
        heapDelta: memAfter.heapUsed - memBefore.heapUsed,
        rssAfter: memAfter.rss
      }
    };
    process.stdout.write(`SNAPSHOT_COST ${JSON.stringify(line)}\n`);

    expect(initialWireBytes).toBeLessThanOrEqual(FULL_RESYNC_SNAPSHOT_BYTE_CEILING);
    expect(line.routineWireBytes.max).toBeLessThanOrEqual(ROUTINE_SNAPSHOT_BYTE_BUDGET);
  });
});
