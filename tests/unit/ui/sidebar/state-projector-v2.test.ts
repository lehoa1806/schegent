import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StateProjector } from '../../../../src/ui/sidebar/state-projector';
import { WorkspaceStateStore, type Memento } from '../../../../src/state/workspace-state';
import { AuditLogWriter } from '../../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../../src/lib/logger';
import type { WorkflowRun } from '../../../../src/state/workflow-run';

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
let audit: AuditLogWriter;
let tmpRoot: string;
let monoClock: { value: number };

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

function runningRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    featureId: 'feat-1',
    featureDir: 'specs/001-x',
    status: 'running',
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
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-projector-v2-'));
  audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
  monoClock = { value: 0 };
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('StateProjector v2 — live activity', () => {
  it('idle workflows expose IDLE_LIVE_ACTIVITY defaults', () => {
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(snap.liveActivity.summary).toBeNull();
    expect(snap.liveActivity.category).toBeNull();
    expect(snap.liveActivity.lastEventAt).toBeNull();
    expect(snap.liveActivity.freshness).toBe('idle');
    expect(snap.liveActivity.staleSeconds).toBeNull();
    p.dispose();
  });

  it('running workflow with no events yet shows live freshness', async () => {
    vi.useFakeTimers();
    await store.setRun(runningRun());
    const p = makeProjector();
    p.start();
    const snap = p.getCurrentSnapshot();
    expect(snap.liveActivity.freshness).toBe('live');
    expect(snap.liveActivity.summary).toBeNull();
    p.dispose();
  });

  it('captures the most recent qualifying audit summary verbatim', async () => {
    vi.useFakeTimers();
    await store.setRun(runningRun());
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
    expect(snap.liveActivity.summary).toBe(snap.auditTail[snap.auditTail.length - 1].summary);
    expect(snap.liveActivity.category).toBe('cli-invocation');
    expect(snap.liveActivity.lastEventAt).toBe(snap.auditTail[snap.auditTail.length - 1].timestamp);
    expect(snap.liveActivity.freshness).toBe('live');
    p.dispose();
  });

  it('system-category events do not advance lastActivity (pause and resume are system)', async () => {
    vi.useFakeTimers();
    await store.setRun(runningRun());
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
    const firstSummary = p.getCurrentSnapshot().liveActivity.summary;
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
    expect(snap.liveActivity.summary).toBe(firstSummary);
    p.dispose();
  });

  it('transitions live → slowing → stalled as monotonic time advances', async () => {
    vi.useFakeTimers();
    await store.setRun(runningRun());
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
    expect(p.getCurrentSnapshot().liveActivity.freshness).toBe('live');

    tickMonotonic(30_000);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(p.getCurrentSnapshot().liveActivity.freshness).toBe('slowing');

    tickMonotonic(60_000);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(p.getCurrentSnapshot().liveActivity.freshness).toBe('stalled');
    p.dispose();
  });

  it('staleSeconds reflects floor(ms / 1000) for non-idle freshness', async () => {
    vi.useFakeTimers();
    await store.setRun(runningRun());
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
    expect(snap.liveActivity.staleSeconds).toBe(45);
    expect(snap.liveActivity.freshness).toBe('slowing');
    p.dispose();
  });

  it('returns to live within one render cycle after a stalled state', async () => {
    vi.useFakeTimers();
    await store.setRun(runningRun());
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
    expect(p.getCurrentSnapshot().liveActivity.freshness).toBe('stalled');

    await audit.append({
      runId: 'run-1',
      phase: 'speckit-plan',
      iteration: 0,
      eventType: 'cli-invocation',
      payload: { summary: 'fresh activity' },
      outcome: 'success'
    });
    await vi.advanceTimersByTimeAsync(120);
    expect(p.getCurrentSnapshot().liveActivity.freshness).toBe('live');
    p.dispose();
  });

  it('paused workflow surfaces freshness=paused regardless of activity age', async () => {
    vi.useFakeTimers();
    await store.setRun(runningRun({ status: 'paused' }));
    const p = makeProjector();
    p.start();
    expect(p.getCurrentSnapshot().liveActivity.freshness).toBe('paused');
    p.dispose();
  });
});

describe('StateProjector v2 — workflow elapsed time', () => {
  it('idle workflow has workflowElapsedMs === null', () => {
    const p = makeProjector();
    p.start();
    expect(p.getCurrentSnapshot().workflowElapsedMs).toBeNull();
    p.dispose();
  });

  it('running workflow advances elapsed monotonically across ticks', async () => {
    vi.useFakeTimers();
    await store.setRun(runningRun());
    const p = makeProjector({ tickIntervalMs: 1000 });
    p.start();
    p.subscribe(() => {});

    expect(p.getCurrentSnapshot().workflowElapsedMs).toBe(0);

    tickMonotonic(2_500);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(p.getCurrentSnapshot().workflowElapsedMs).toBe(2_500);

    tickMonotonic(3_000);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(p.getCurrentSnapshot().workflowElapsedMs).toBe(5_500);
    p.dispose();
  });

  it('freezes elapsed during pause and resumes from frozen value', async () => {
    vi.useFakeTimers();
    await store.setRun(runningRun());
    const p = makeProjector({ tickIntervalMs: 1000 });
    p.start();
    p.subscribe(() => {});

    tickMonotonic(5_000);
    await store.setRun(runningRun({ status: 'paused' }));
    await vi.advanceTimersByTimeAsync(120);
    const pausedAt = p.getCurrentSnapshot().workflowElapsedMs;
    expect(pausedAt).toBe(5_000);

    tickMonotonic(10_000);
    await vi.advanceTimersByTimeAsync(120);
    expect(p.getCurrentSnapshot().workflowElapsedMs).toBe(5_000);

    await store.setRun(runningRun({ status: 'running' }));
    await vi.advanceTimersByTimeAsync(120);
    tickMonotonic(2_000);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(p.getCurrentSnapshot().workflowElapsedMs).toBe(7_000);
    p.dispose();
  });
});

describe('StateProjector v2 — phase elapsed time', () => {
  it('not-started phases have elapsedMs === 0', () => {
    const p = makeProjector();
    p.start();
    for (const tile of p.getCurrentSnapshot().phases) {
      expect(tile.elapsedMs).toBe(0);
    }
    p.dispose();
  });

  it('active phase elapsed advances with monotonic clock and freezes on phase change', async () => {
    vi.useFakeTimers();
    await store.setRun(runningRun({ currentPhase: 'speckit-plan' }));
    const p = makeProjector({ tickIntervalMs: 1000 });
    p.start();
    p.subscribe(() => {});

    tickMonotonic(3_000);
    await vi.advanceTimersByTimeAsync(1_100);
    let snap = p.getCurrentSnapshot();
    let planTile = snap.phases.find((t) => t.name === 'speckit-plan')!;
    expect(planTile.state).toBe('active');
    expect(planTile.elapsedMs).toBe(3_000);

    await store.setRun(
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
      })
    );
    await vi.advanceTimersByTimeAsync(120);

    tickMonotonic(2_000);
    await vi.advanceTimersByTimeAsync(1_100);
    snap = p.getCurrentSnapshot();
    planTile = snap.phases.find((t) => t.name === 'speckit-plan')!;
    const tasksTile = snap.phases.find((t) => t.name === 'speckit-tasks')!;
    expect(planTile.state).toBe('completed');
    expect(planTile.elapsedMs).toBe(3_000);
    expect(tasksTile.state).toBe('active');
    expect(tasksTile.elapsedMs).toBe(2_000);
    p.dispose();
  });

  it('phase elapsed is monotonic non-decreasing within a single activation', async () => {
    vi.useFakeTimers();
    await store.setRun(runningRun({ currentPhase: 'speckit-plan' }));
    const p = makeProjector({ tickIntervalMs: 1000 });
    p.start();
    p.subscribe(() => {});

    let prev = 0;
    for (let i = 0; i < 5; i++) {
      tickMonotonic(1_000);
      await vi.advanceTimersByTimeAsync(1_100);
      const planTile = p.getCurrentSnapshot().phases.find((t) => t.name === 'speckit-plan')!;
      expect(planTile.elapsedMs).toBeGreaterThanOrEqual(prev);
      prev = planTile.elapsedMs;
    }
    p.dispose();
  });
});

describe('StateProjector v2 — sub-progress', () => {
  it('null sub-progress for non-active phases', () => {
    const p = makeProjector();
    p.start();
    for (const tile of p.getCurrentSnapshot().phases) {
      expect(tile.subProgress).toBeNull();
    }
    p.dispose();
  });

  it('clarify in active state derives iteration sub-progress from currentIteration', async () => {
    vi.useFakeTimers();
    await store.setRun(runningRun({ currentPhase: 'speckit-clarify', currentIteration: 3 }));
    const p = makeProjector();
    p.start();
    const tile = p.getCurrentSnapshot().phases.find((t) => t.name === 'speckit-clarify')!;
    expect(tile.subProgress).not.toBeNull();
    expect(tile.subProgress!.current).toBe(3);
    expect(tile.subProgress!.total).toBe(10);
    expect(tile.subProgress!.label).toBe('iteration');
    p.dispose();
  });

  it('analyze active state derives iteration sub-progress', async () => {
    vi.useFakeTimers();
    await store.setRun(runningRun({ currentPhase: 'speckit-analyze', currentIteration: 7 }));
    const p = makeProjector();
    p.start();
    const tile = p.getCurrentSnapshot().phases.find((t) => t.name === 'speckit-analyze')!;
    expect(tile.subProgress).not.toBeNull();
    expect(tile.subProgress!.current).toBe(7);
    expect(tile.subProgress!.label).toBe('iteration');
    p.dispose();
  });

  it('clarify sub-progress is null when currentIteration is 0', async () => {
    vi.useFakeTimers();
    await store.setRun(runningRun({ currentPhase: 'speckit-clarify', currentIteration: 0 }));
    const p = makeProjector();
    p.start();
    const tile = p.getCurrentSnapshot().phases.find((t) => t.name === 'speckit-clarify')!;
    expect(tile.subProgress).toBeNull();
    p.dispose();
  });

  it('implement sub-progress derives from audit payloads with tasksCompleted/tasksTotal', async () => {
    vi.useFakeTimers();
    await store.setRun(runningRun({ currentPhase: 'speckit-implement' }));
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

    const tile = p.getCurrentSnapshot().phases.find((t) => t.name === 'speckit-implement')!;
    expect(tile.subProgress).not.toBeNull();
    expect(tile.subProgress!.current).toBe(3);
    expect(tile.subProgress!.total).toBe(12);
    expect(tile.subProgress!.label).toBe('task');
    p.dispose();
  });

  it('implement sub-progress is monotonic non-decreasing (clamps to max observed)', async () => {
    vi.useFakeTimers();
    await store.setRun(runningRun({ currentPhase: 'speckit-implement' }));
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
    expect(p.getCurrentSnapshot().phases.find((t) => t.name === 'speckit-implement')!.subProgress!.current).toBe(5);

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
    expect(p.getCurrentSnapshot().phases.find((t) => t.name === 'speckit-implement')!.subProgress!.current).toBe(5);

    await audit.append({
      runId: 'run-1',
      phase: 'speckit-implement',
      iteration: 1,
      eventType: 'loop-iteration',
      payload: { tasksCompleted: 8, tasksTotal: 10 },
      outcome: 'success'
    });
    await vi.advanceTimersByTimeAsync(120);
    expect(p.getCurrentSnapshot().phases.find((t) => t.name === 'speckit-implement')!.subProgress!.current).toBe(8);
    p.dispose();
  });

  it('sub-progress is cleared when the run leaves the implementing phase', async () => {
    vi.useFakeTimers();
    await store.setRun(runningRun({ currentPhase: 'speckit-implement' }));
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

    await store.setRun(
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
      })
    );
    await vi.advanceTimersByTimeAsync(120);

    const snap = p.getCurrentSnapshot();
    const implementTile = snap.phases.find((t) => t.name === 'speckit-implement')!;
    const finalizeTile = snap.phases.find((t) => t.name === 'finalize')!;
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
    p.subscribe((s) => snapshots.push(s.workflowElapsedMs ?? -1));
    snapshots.length = 0;

    await vi.advanceTimersByTimeAsync(5_500);
    expect(snapshots).toHaveLength(0);
    p.dispose();
  });

  it('ticks regularly while status is running', async () => {
    vi.useFakeTimers();
    await store.setRun(runningRun());
    const p = makeProjector({ tickIntervalMs: 1000, debounceMs: 100 });
    p.start();
    const snapshots: number[] = [];
    p.subscribe((s) => snapshots.push(s.workflowElapsedMs ?? -1));
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
    await store.setRun(runningRun());
    const p = makeProjector({ tickIntervalMs: 1000, debounceMs: 100 });
    p.start();
    p.subscribe(() => {});

    await vi.advanceTimersByTimeAsync(1_100);

    await store.setRun(runningRun({ status: 'completed' }));
    await vi.advanceTimersByTimeAsync(120);

    const tickCountAfterComplete: number[] = [];
    p.subscribe((s) => tickCountAfterComplete.push(s.workflowElapsedMs ?? -1));
    tickCountAfterComplete.length = 0;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(tickCountAfterComplete).toHaveLength(0);
    p.dispose();
  });
});
