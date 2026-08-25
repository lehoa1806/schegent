import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { unfencedCommit } from '../../../../src/state/ownership-claim';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StateProjector } from '../../../../src/ui/sidebar/state-projector';
import { WorkspaceStateStore, type Memento } from '../../../../src/state/workspace-state';
import { QueueManager } from '../../../../src/queue/queue-manager';
import { AuditLogWriter } from '../../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../../src/lib/logger';
import type { WorkflowRun } from '../../../../src/state/workflow-run';
import type { LiveActivity, PhaseTile, WorkflowSnapshot } from '../../../../src/ui/sidebar/snapshot';
import { runOf, runtimeOf } from './queue-runtime-read.helpers';
import { DEFAULT_QUEUE_ID } from '../../../../src/queue/queue-registry';
import { SPECKIT_RUN_PIPELINE } from '../../../fixtures/speckit-catalog-fixture';

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

let memento: FakeMemento;
let store: WorkspaceStateStore;
let queue: QueueManager;
let audit: AuditLogWriter;
let tmpRoot: string;
let monoClock: { value: number };
// Feature 092 (T096) — the Task row every Run in this suite belongs to. A Run is
// projected under the queue that holds its Task, so without this row the default
// queue would own nothing and publish the empty projection of FR-053.
let ownedTaskId: string;

// The v4 readings this suite used to take off the snapshot root. Each throws
// rather than returning a default when no Run is up: a projector test that reads
// a live-activity or elapsed value from an idle queue is asking the wrong
// question, and a silent default would hide that.
function liveOf(snapshot: WorkflowSnapshot): LiveActivity {
  const run = runOf(snapshot);
  if (run === null) throw new Error('expected the default queue to own a Run');
  return run.liveActivity;
}

function elapsedOf(snapshot: WorkflowSnapshot): number | null {
  const run = runOf(snapshot);
  if (run === null) throw new Error('expected the default queue to own a Run');
  return run.elapsedMs;
}

/** The phase strip, which belongs to the queue rather than to its Run. */
function tilesOf(snapshot: WorkflowSnapshot): readonly PhaseTile[] {
  return runtimeOf(snapshot).phases;
}

function tickMonotonic(deltaMs: number): void {
  monoClock.value += deltaMs;
}

function makeProjector(opts: { ownerId?: string; debounceMs?: number; tickIntervalMs?: number } = {}): StateProjector {
  return new StateProjector({
    store,
    audit,
    ownerId: opts.ownerId ?? 'this-window',
    debounceMs: opts.debounceMs ?? 100,
    tickIntervalMs: opts.tickIntervalMs ?? 1000,
    monotonicNow: () => monoClock.value
  });
}

// Feature 098 (T055) — the frozen Pipeline is no longer optional decoration on
// this fixture. The projector used to answer a Run without one with seven
// placeholder tiles, so every case below got a phase strip for free; it answers
// with zero tiles now, and a strip has to be frozen onto the Run the way
// `createRun()` freezes one. The ids are the Spec Kit ones because these cases
// name `speckit-plan`, `speckit-clarify` and `speckit-analyze` directly.
function runningRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    featureId: ownedTaskId,
    featureDir: 'specs/001-x',
    status: 'running',
    pipeline: SPECKIT_RUN_PIPELINE,
    currentPhase: 'speckit-plan',
    currentIteration: 0,
    startedAt: 1_700_000_000_000,
    lastTransitionAt: 1_700_000_000_000,
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
    ...overrides
  };
}

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
  ownedTaskId = (await queue.enqueue('projector v2 task')).id;
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-projector-v2-'));
  audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
  monoClock = { value: 0 };
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('StateProjector v2 — live activity', () => {
  // Feature 092 (T096) — live activity is a reading of a Run, and an idle queue
  // owns none, so there is no longer an idle live-activity value to inspect: the
  // whole in-flight projection is absent together (FR-053). The frozen
  // `IDLE_LIVE_ACTIVITY` defaults themselves stay pinned in `snapshot.test.ts`.
  it('idle workflows publish no in-flight run to carry live activity', () => {
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(runOf(snap)).toBeNull();
    p.dispose();
  });

  it('running workflow with no events yet shows live freshness', async () => {
    vi.useFakeTimers();
    await store.setRun(DEFAULT_QUEUE_ID, runningRun(), unfencedCommit('test-fixture'));
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(liveOf(snap).freshness).toBe('live');
    expect(liveOf(snap).summary).toBeNull();
    p.dispose();
  });

  it('captures the most recent qualifying audit summary verbatim', async () => {
    vi.useFakeTimers();
    await store.setRun(DEFAULT_QUEUE_ID, runningRun(), unfencedCommit('test-fixture'));
    const p = makeProjector({ debounceMs: 100 });
    p.start();
    p.subscribe(() => {});

    await audit.append({
      runId: 'run-1',
      phase: 'speckit-plan',
      iteration: 0,
      eventType: 'cli-invocation',
      payload: { summary: 'invoked claude with prompt' },
      outcome: 'success'
    });

    await vi.advanceTimersByTimeAsync(120);
    const snap = p.getCurrentSnapshot();
    expect(liveOf(snap).summary).toBe(snap.auditTail[snap.auditTail.length - 1].summary);
    expect(liveOf(snap).category).toBe('cli-invocation');
    expect(liveOf(snap).lastEventAt).toBe(snap.auditTail[snap.auditTail.length - 1].timestamp);
    expect(liveOf(snap).freshness).toBe('live');
    p.dispose();
  });

  it('system-category events do not advance lastActivity (pause and resume are system)', async () => {
    vi.useFakeTimers();
    await store.setRun(DEFAULT_QUEUE_ID, runningRun(), unfencedCommit('test-fixture'));
    const p = makeProjector({ debounceMs: 100 });
    p.start();
    p.subscribe(() => {});

    await audit.append({
      runId: 'run-1',
      phase: 'speckit-plan',
      iteration: 0,
      eventType: 'cli-invocation',
      payload: { summary: 'real activity' },
      outcome: 'success'
    });
    await vi.advanceTimersByTimeAsync(120);
    const firstSummary = liveOf(p.getCurrentSnapshot()).summary;
    expect(firstSummary).not.toBeNull();

    tickMonotonic(5_000);
    await audit.append({
      runId: 'run-1',
      phase: 'speckit-plan',
      iteration: 0,
      eventType: 'pause',
      payload: { summary: 'system heartbeat' },
      outcome: 'info'
    });
    await vi.advanceTimersByTimeAsync(120);

    const snap = p.getCurrentSnapshot();
    expect(liveOf(snap).summary).toBe(firstSummary);
    p.dispose();
  });

  it('transitions live → slowing → stalled as monotonic time advances', async () => {
    vi.useFakeTimers();
    await store.setRun(DEFAULT_QUEUE_ID, runningRun(), unfencedCommit('test-fixture'));
    const p = makeProjector({ debounceMs: 100, tickIntervalMs: 1000 });
    p.start();
    p.subscribe(() => {});

    await audit.append({
      runId: 'run-1',
      phase: 'speckit-plan',
      iteration: 0,
      eventType: 'cli-invocation',
      payload: { summary: 'kickoff' },
      outcome: 'success'
    });
    await vi.advanceTimersByTimeAsync(120);
    expect(liveOf(p.getCurrentSnapshot()).freshness).toBe('live');

    tickMonotonic(30_000);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(liveOf(p.getCurrentSnapshot()).freshness).toBe('slowing');

    tickMonotonic(60_000);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(liveOf(p.getCurrentSnapshot()).freshness).toBe('stalled');
    p.dispose();
  });

  it('staleSeconds reflects floor(ms / 1000) for non-idle freshness', async () => {
    vi.useFakeTimers();
    await store.setRun(DEFAULT_QUEUE_ID, runningRun(), unfencedCommit('test-fixture'));
    const p = makeProjector({ debounceMs: 100, tickIntervalMs: 1000 });
    p.start();
    p.subscribe(() => {});

    await audit.append({
      runId: 'run-1',
      phase: 'speckit-plan',
      iteration: 0,
      eventType: 'cli-invocation',
      payload: { summary: 'kickoff' },
      outcome: 'success'
    });
    await vi.advanceTimersByTimeAsync(120);

    tickMonotonic(45_500);
    await vi.advanceTimersByTimeAsync(1_100);

    const snap = p.getCurrentSnapshot();
    expect(liveOf(snap).staleSeconds).toBe(45);
    expect(liveOf(snap).freshness).toBe('slowing');
    p.dispose();
  });

  it('returns to live within one render cycle after a stalled state', async () => {
    vi.useFakeTimers();
    await store.setRun(DEFAULT_QUEUE_ID, runningRun(), unfencedCommit('test-fixture'));
    const p = makeProjector({ debounceMs: 100, tickIntervalMs: 1000 });
    p.start();
    p.subscribe(() => {});

    await audit.append({
      runId: 'run-1',
      phase: 'speckit-plan',
      iteration: 0,
      eventType: 'cli-invocation',
      payload: { summary: 'kickoff' },
      outcome: 'success'
    });
    await vi.advanceTimersByTimeAsync(120);

    tickMonotonic(120_000);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(liveOf(p.getCurrentSnapshot()).freshness).toBe('stalled');

    await audit.append({
      runId: 'run-1',
      phase: 'speckit-plan',
      iteration: 0,
      eventType: 'cli-invocation',
      payload: { summary: 'fresh activity' },
      outcome: 'success'
    });
    await vi.advanceTimersByTimeAsync(120);
    expect(liveOf(p.getCurrentSnapshot()).freshness).toBe('live');
    p.dispose();
  });

  it('paused workflow surfaces freshness=paused regardless of activity age', async () => {
    vi.useFakeTimers();
    await store.setRun(DEFAULT_QUEUE_ID, runningRun({ status: 'paused' }), unfencedCommit('test-fixture'));
    const p = makeProjector();
    p.start();
    expect(liveOf(p.getCurrentSnapshot()).freshness).toBe('paused');
    p.dispose();
  });
});

describe('StateProjector v2 — workflow elapsed time', () => {
  // Feature 092 (T096) — the same fold as live activity: elapsed time is a
  // reading of a Run, so an idle queue has no in-flight projection to read it
  // from rather than an in-flight projection reading null.
  it('idle workflow publishes no in-flight run to carry elapsed time', () => {
    const p = makeProjector();
    p.start();
    expect(runOf(p.getCurrentSnapshot())).toBeNull();
    p.dispose();
  });

  it('running workflow advances elapsed monotonically across ticks', async () => {
    vi.useFakeTimers();
    await store.setRun(DEFAULT_QUEUE_ID, runningRun(), unfencedCommit('test-fixture'));
    const p = makeProjector({ tickIntervalMs: 1000 });
    p.start();
    p.subscribe(() => {});

    expect(elapsedOf(p.getCurrentSnapshot())).toBe(0);

    tickMonotonic(2_500);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(elapsedOf(p.getCurrentSnapshot())).toBe(2_500);

    tickMonotonic(3_000);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(elapsedOf(p.getCurrentSnapshot())).toBe(5_500);
    p.dispose();
  });

  it('freezes elapsed during pause and resumes from frozen value', async () => {
    vi.useFakeTimers();
    await store.setRun(DEFAULT_QUEUE_ID, runningRun(), unfencedCommit('test-fixture'));
    const p = makeProjector({ tickIntervalMs: 1000 });
    p.start();
    p.subscribe(() => {});

    tickMonotonic(5_000);
    await store.setRun(DEFAULT_QUEUE_ID, runningRun({ status: 'paused' }), unfencedCommit('test-fixture'));
    await vi.advanceTimersByTimeAsync(120);
    const pausedAt = elapsedOf(p.getCurrentSnapshot());
    expect(pausedAt).toBe(5_000);

    tickMonotonic(10_000);
    await vi.advanceTimersByTimeAsync(120);
    expect(elapsedOf(p.getCurrentSnapshot())).toBe(5_000);

    await store.setRun(DEFAULT_QUEUE_ID, runningRun({ status: 'running' }), unfencedCommit('test-fixture'));
    await vi.advanceTimersByTimeAsync(120);
    tickMonotonic(2_000);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(elapsedOf(p.getCurrentSnapshot())).toBe(7_000);
    p.dispose();
  });
});

describe('StateProjector v2 — phase elapsed time', () => {
  // Feature 092 (T096) — the strip belongs to the queue that owns the Run, so a
  // Run has to be up for there to be a strip at all; an idle queue publishes an
  // empty phase list and the loop below would assert nothing. The `length` check
  // is what keeps that from passing vacuously.
  it('not-started phases have elapsedMs === 0', async () => {
    await store.setRun(DEFAULT_QUEUE_ID, runningRun({ currentPhase: 'speckit-plan' }), unfencedCommit('test-fixture'));
    const p = makeProjector();
    p.start();
    const notStarted = tilesOf(p.getCurrentSnapshot()).filter(
      (tile) => tile.state === 'not-started'
    );
    expect(notStarted.length).toBeGreaterThan(0);
    for (const tile of notStarted) {
      expect(tile.elapsedMs).toBe(0);
    }
    p.dispose();
  });

  it('active phase elapsed advances with monotonic clock and freezes on phase change', async () => {
    vi.useFakeTimers();
    await store.setRun(DEFAULT_QUEUE_ID, runningRun({ currentPhase: 'speckit-plan' }), unfencedCommit('test-fixture'));
    const p = makeProjector({ tickIntervalMs: 1000 });
    p.start();
    p.subscribe(() => {});

    tickMonotonic(3_000);
    await vi.advanceTimersByTimeAsync(1_100);
    let snap = p.getCurrentSnapshot();
    let planTile = tilesOf(snap).find((t) => t.name === 'speckit-plan')!;
    expect(planTile.state).toBe('active');
    expect(planTile.elapsedMs).toBe(3_000);

    await store.setRun(DEFAULT_QUEUE_ID, 
      runningRun({
        currentPhase: 'speckit-tasks',
        phasesCompleted: [
          {
            phase: 'speckit-plan',
            iteration: 1,
            startedAt: 1_700_000_000_000,
            endedAt: 1_700_000_003_000,
            result: 'clean',
            terminationReason: 'token',
            exitCode: 0,
            stdoutSummary: '',
            stderrSummary: '',
            auditEntryId: null
          }
        ]
      }),
      unfencedCommit('test-fixture')
    );
    await vi.advanceTimersByTimeAsync(120);

    tickMonotonic(2_000);
    await vi.advanceTimersByTimeAsync(1_100);
    snap = p.getCurrentSnapshot();
    planTile = tilesOf(snap).find((t) => t.name === 'speckit-plan')!;
    const tasksTile = tilesOf(snap).find((t) => t.name === 'speckit-tasks')!;
    expect(planTile.state).toBe('completed');
    expect(planTile.elapsedMs).toBe(3_000);
    expect(tasksTile.state).toBe('active');
    expect(tasksTile.elapsedMs).toBe(2_000);
    p.dispose();
  });

  it('phase elapsed is monotonic non-decreasing within a single activation', async () => {
    vi.useFakeTimers();
    await store.setRun(DEFAULT_QUEUE_ID, runningRun({ currentPhase: 'speckit-plan' }), unfencedCommit('test-fixture'));
    const p = makeProjector({ tickIntervalMs: 1000 });
    p.start();
    p.subscribe(() => {});

    let prev = 0;
    for (let i = 0; i < 5; i++) {
      tickMonotonic(1_000);
      await vi.advanceTimersByTimeAsync(1_100);
      const planTile = tilesOf(p.getCurrentSnapshot()).find((t) => t.name === 'speckit-plan')!;
      expect(planTile.elapsedMs).toBeGreaterThanOrEqual(prev);
      prev = planTile.elapsedMs;
    }
    p.dispose();
  });
});

describe('StateProjector v2 — sub-progress', () => {
  it('null sub-progress for non-active phases', async () => {
    // Same reason as the elapsed case above: the strip only exists under a queue
    // that owns a Run, so one is seeded and the non-active tiles are the subject.
    await store.setRun(DEFAULT_QUEUE_ID, runningRun({ currentPhase: 'speckit-plan' }), unfencedCommit('test-fixture'));
    const p = makeProjector();
    p.start();
    const inactive = tilesOf(p.getCurrentSnapshot()).filter((tile) => tile.state !== 'active');
    expect(inactive.length).toBeGreaterThan(0);
    for (const tile of inactive) {
      expect(tile.subProgress).toBeNull();
    }
    p.dispose();
  });

  it('clarify in active state derives iteration sub-progress from currentIteration', async () => {
    vi.useFakeTimers();
    await store.setRun(DEFAULT_QUEUE_ID, runningRun({ currentPhase: 'speckit-clarify', currentIteration: 3 }), unfencedCommit('test-fixture'));
    const p = makeProjector();
    p.start();
    const tile = tilesOf(p.getCurrentSnapshot()).find((t) => t.name === 'speckit-clarify')!;
    expect(tile.subProgress).not.toBeNull();
    expect(tile.subProgress!.current).toBe(3);
    expect(tile.subProgress!.total).toBe(10);
    expect(tile.subProgress!.label).toBe('iteration');
    p.dispose();
  });

  it('analyze active state derives iteration sub-progress', async () => {
    vi.useFakeTimers();
    await store.setRun(DEFAULT_QUEUE_ID, runningRun({ currentPhase: 'speckit-analyze', currentIteration: 7 }), unfencedCommit('test-fixture'));
    const p = makeProjector();
    p.start();
    const tile = tilesOf(p.getCurrentSnapshot()).find((t) => t.name === 'speckit-analyze')!;
    expect(tile.subProgress).not.toBeNull();
    expect(tile.subProgress!.current).toBe(7);
    expect(tile.subProgress!.label).toBe('iteration');
    p.dispose();
  });

  it('clarify sub-progress is null when currentIteration is 0', async () => {
    vi.useFakeTimers();
    await store.setRun(DEFAULT_QUEUE_ID, runningRun({ currentPhase: 'speckit-clarify', currentIteration: 0 }), unfencedCommit('test-fixture'));
    const p = makeProjector();
    p.start();
    const tile = tilesOf(p.getCurrentSnapshot()).find((t) => t.name === 'speckit-clarify')!;
    expect(tile.subProgress).toBeNull();
    p.dispose();
  });

  it('implement sub-progress derives from audit payloads with tasksCompleted/tasksTotal', async () => {
    vi.useFakeTimers();
    await store.setRun(DEFAULT_QUEUE_ID, runningRun({ currentPhase: 'speckit-implement' }), unfencedCommit('test-fixture'));
    const p = makeProjector({ debounceMs: 100 });
    p.start();
    p.subscribe(() => {});

    await audit.append({
      runId: 'run-1',
      phase: 'speckit-implement',
      iteration: 1,
      eventType: 'loop-iteration',
      payload: { tasksCompleted: 3, tasksTotal: 12, summary: 'progress' },
      outcome: 'success'
    });
    await vi.advanceTimersByTimeAsync(120);

    const tile = tilesOf(p.getCurrentSnapshot()).find((t) => t.name === 'speckit-implement')!;
    expect(tile.subProgress).not.toBeNull();
    expect(tile.subProgress!.current).toBe(3);
    expect(tile.subProgress!.total).toBe(12);
    expect(tile.subProgress!.label).toBe('task');
    p.dispose();
  });

  it('implement sub-progress is monotonic non-decreasing (clamps to max observed)', async () => {
    vi.useFakeTimers();
    await store.setRun(DEFAULT_QUEUE_ID, runningRun({ currentPhase: 'speckit-implement' }), unfencedCommit('test-fixture'));
    const p = makeProjector({ debounceMs: 100 });
    p.start();
    p.subscribe(() => {});

    await audit.append({
      runId: 'run-1',
      phase: 'speckit-implement',
      iteration: 1,
      eventType: 'loop-iteration',
      payload: { tasksCompleted: 5, tasksTotal: 10 },
      outcome: 'success'
    });
    await vi.advanceTimersByTimeAsync(120);
    expect(tilesOf(p.getCurrentSnapshot()).find((t) => t.name === 'speckit-implement')!.subProgress!.current).toBe(5);

    // A regression payload (current=2) should NOT lower the value.
    await audit.append({
      runId: 'run-1',
      phase: 'speckit-implement',
      iteration: 1,
      eventType: 'loop-iteration',
      payload: { tasksCompleted: 2, tasksTotal: 10 },
      outcome: 'success'
    });
    await vi.advanceTimersByTimeAsync(120);
    expect(tilesOf(p.getCurrentSnapshot()).find((t) => t.name === 'speckit-implement')!.subProgress!.current).toBe(5);

    await audit.append({
      runId: 'run-1',
      phase: 'speckit-implement',
      iteration: 1,
      eventType: 'loop-iteration',
      payload: { tasksCompleted: 8, tasksTotal: 10 },
      outcome: 'success'
    });
    await vi.advanceTimersByTimeAsync(120);
    expect(tilesOf(p.getCurrentSnapshot()).find((t) => t.name === 'speckit-implement')!.subProgress!.current).toBe(8);
    p.dispose();
  });

  it('sub-progress is cleared when the run leaves the implementing phase', async () => {
    vi.useFakeTimers();
    await store.setRun(DEFAULT_QUEUE_ID, runningRun({ currentPhase: 'speckit-implement' }), unfencedCommit('test-fixture'));
    const p = makeProjector({ debounceMs: 100 });
    p.start();
    p.subscribe(() => {});

    await audit.append({
      runId: 'run-1',
      phase: 'speckit-implement',
      iteration: 1,
      eventType: 'loop-iteration',
      payload: { tasksCompleted: 5, tasksTotal: 10 },
      outcome: 'success'
    });
    await vi.advanceTimersByTimeAsync(120);

    await store.setRun(DEFAULT_QUEUE_ID, 
      runningRun({
        currentPhase: 'finalize',
        phasesCompleted: [
          {
            phase: 'speckit-implement',
            iteration: 1,
            startedAt: 1_700_000_000_000,
            endedAt: 1_700_000_005_000,
            result: 'clean',
            terminationReason: 'token',
            exitCode: 0,
            stdoutSummary: '',
            stderrSummary: '',
            auditEntryId: null
          }
        ]
      }),
      unfencedCommit('test-fixture')
    );
    await vi.advanceTimersByTimeAsync(120);

    const snap = p.getCurrentSnapshot();
    const implementTile = tilesOf(snap).find((t) => t.name === 'speckit-implement')!;
    const finalizeTile = tilesOf(snap).find((t) => t.name === 'finalize')!;
    expect(implementTile.state).toBe('completed');
    expect(implementTile.subProgress).toBeNull();
    expect(finalizeTile.subProgress).toBeNull();
    p.dispose();
  });
});

describe('StateProjector v2 — 1Hz tick', () => {
  it('does not tick when status is idle', async () => {
    vi.useFakeTimers();
    const p = makeProjector({ tickIntervalMs: 1000 });
    p.start();
    const snapshots: number[] = [];
    p.subscribe((s) => snapshots.push(runOf(s)?.elapsedMs ?? -1));
    snapshots.length = 0;

    await vi.advanceTimersByTimeAsync(5_500);
    expect(snapshots).toHaveLength(0);
    p.dispose();
  });

  it('ticks regularly while status is running', async () => {
    vi.useFakeTimers();
    await store.setRun(DEFAULT_QUEUE_ID, runningRun(), unfencedCommit('test-fixture'));
    const p = makeProjector({ tickIntervalMs: 1000, debounceMs: 100 });
    p.start();
    const snapshots: number[] = [];
    p.subscribe((s) => snapshots.push(runOf(s)?.elapsedMs ?? -1));
    snapshots.length = 0;

    for (let i = 0; i < 3; i++) {
      tickMonotonic(1_000);
      await vi.advanceTimersByTimeAsync(1_100);
    }
    expect(snapshots.length).toBeGreaterThanOrEqual(3);
    p.dispose();
  });

  it('stops ticking when status moves away from running', async () => {
    vi.useFakeTimers();
    await store.setRun(DEFAULT_QUEUE_ID, runningRun(), unfencedCommit('test-fixture'));
    const p = makeProjector({ tickIntervalMs: 1000, debounceMs: 100 });
    p.start();
    p.subscribe(() => {});

    await vi.advanceTimersByTimeAsync(1_100);

    await store.setRun(DEFAULT_QUEUE_ID, runningRun({ status: 'completed' }), unfencedCommit('test-fixture'));
    await vi.advanceTimersByTimeAsync(120);

    const tickCountAfterComplete: number[] = [];
    p.subscribe((s) => tickCountAfterComplete.push(runOf(s)?.elapsedMs ?? -1));
    tickCountAfterComplete.length = 0;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(tickCountAfterComplete).toHaveLength(0);
    p.dispose();
  });
});
