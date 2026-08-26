import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unfencedCommit } from '../../src/state/ownership-claim';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StateProjector } from '../../src/ui/sidebar/state-projector';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../src/lib/logger';
import type { WorkflowRun } from '../../src/state/workflow-run';
import type { AuditTailEntry } from '../../src/ui/sidebar/snapshot';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { MAX_QUEUES } from '../../src/contracts/queue-bounds';

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

const SNAPSHOT_COUNT = 100;
/**
 * FR-R3-114 row 1 — the scale the product PERMITS, derived from the bounds that enforce it.
 *
 * `MAX_QUEUES` is imported rather than restated: a widening of the queue cap must move this case
 * with it, or the 80x gap this row closed would silently reopen at the new number.
 */
const PERMITTED_PENDING_PER_QUEUE = 100;
/**
 * MEASURED 2026-08-27 on darwin/arm64 (macOS 26.6.2, Node 24.19.0): 2,000 items across 20 queues,
 * 100 `project()` passes in **649.8 ms total, median 6.39 ms, max 8.78 ms**.
 *
 * The budgets are ~3x the observed figures — enough headroom for a loaded machine, tight enough
 * that an order-of-magnitude regression fails. Deliberately NOT set to the observed value: a perf
 * budget at the measurement is a test that fails on a busy laptop and gets deleted.
 */
const PERMITTED_SCALE_TOTAL_BUDGET_MS = 2_000;
const PERMITTED_SCALE_MEDIAN_BUDGET_MS = 20;
const TOTAL_BUDGET_MS = 1_600;
const MEDIAN_BUDGET_MS = 5;

function runningRun(currentIteration = 0, currentPhase: WorkflowRun['currentPhase'] = 'speckit-plan'): WorkflowRun {
  return {
    id: 'run-perf',
    featureId: 'feat-perf',
    featureDir: 'specs/099-perf',
    status: 'running',
    currentPhase,
    currentIteration,
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
    resumeTargetPhaseId: null
  };
}

function syntheticTail(n: number): AuditTailEntry[] {
  const tail: AuditTailEntry[] = [];
  for (let i = 0; i < n; i++) {
    tail.push(
      Object.freeze({
        id: `e-${i}`,
        timestamp: new Date(1_700_000_000_000 + i * 100).toISOString(),
        phase: 'speckit-plan' as const,
        category: 'cli-invocation' as const,
        summary: `synthetic event ${i} with a moderately verbose summary line for realism`,
        runId: `run-${i}`,
        scope: 'task' as const
      })
    );
  }
  return tail;
}

describe('Render budget regression (SC-006)', () => {
  let tmpRoot: string;
  let store: WorkspaceStateStore;
  let audit: AuditLogWriter;
  let monoClock: { value: number };

  beforeEach(async () => {
    const memento = new FakeMemento();
    store = new WorkspaceStateStore(memento);
    await store.initialize();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-perf-'));
    audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    monoClock = { value: 0 };
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it(`runs ${SNAPSHOT_COUNT} v2 project() passes under ${TOTAL_BUDGET_MS} ms total with median ≤ ${MEDIAN_BUDGET_MS} ms`, async () => {
    await store.setRun(DEFAULT_QUEUE_ID, runningRun(3, 'speckit-analyze'), unfencedCommit('test-fixture'));
    const projector = new StateProjector({
      store,
      audit,
      ownerId: 'this-window',
      debounceMs: 100,
      tickIntervalMs: 1_000,
      monotonicNow: () => monoClock.value
    });
    projector.start();

    const tail = syntheticTail(50);
    const samples: number[] = [];
    const totalStart = performance.now();
    for (let i = 0; i < SNAPSHOT_COUNT; i++) {
      monoClock.value += 1_000;
      const sampleStart = performance.now();
      projector.seedAuditTail(tail);
      samples.push(performance.now() - sampleStart);
    }
    const totalElapsed = performance.now() - totalStart;
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    const max = samples[samples.length - 1];

    projector.dispose();

    expect(samples).toHaveLength(SNAPSHOT_COUNT);
    expect(
      totalElapsed,
      `total ${totalElapsed.toFixed(2)} ms exceeded budget ${TOTAL_BUDGET_MS} ms (max sample ${max.toFixed(2)} ms)`
    ).toBeLessThan(TOTAL_BUDGET_MS);
    expect(
      median,
      `median ${median.toFixed(2)} ms exceeded ${MEDIAN_BUDGET_MS} ms (max sample ${max.toFixed(2)} ms)`
    ).toBeLessThan(MEDIAN_BUDGET_MS);
  });

  it(`v3: ${SNAPSHOT_COUNT} project() passes with monitor + history + extended queue stay under ${TOTAL_BUDGET_MS} ms (SC-012)`, async () => {
    const memento = (store as unknown as { memento: Memento }).memento ?? null;
    void memento;
    const queueRequests = Array.from({ length: 25 }, (_, i) => ({
      id: `q-${i}`,
      description: `feature ${i} with extended fields and a longer realistic description string`,
      enqueuedAt: 1_700_000_000_000 + i * 1000,
      createdAt: 1_700_000_000_000 + i * 1000,
      updatedAt: 1_700_000_000_500 + i * 1000,
      startedAt: null,
      completedAt: null,
      status: 'pending' as const,
      position: i,
      runId: null,
      retryCount: i % 3,
      lastError: i % 5 === 0 ? 'simulated transient failure' : null,
      pausedReason: null
    }));
    await store.setQueue({
      paused: false,
      pausedReason: null,
      inFlightId: null,
      updatedAt: 1_700_000_000_000,
      queueLifecycle: 'active-empty',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: null,
      requests: queueRequests
    });
    await store.setRun(DEFAULT_QUEUE_ID, runningRun(2, 'speckit-plan'), unfencedCommit('test-fixture'));

    const noopDisposable = { dispose: () => {} };
    const fakeMonitor = {
      getCurrentState: () => ({
        runId: 'run-perf',
        phase: 'speckit-plan' as const,
        invocationStartedAt: 1_700_000_000_000,
        status: 'running' as const,
        stdoutLines: 42,
        stderrLines: 0,
        msSinceLastStdout: 800,
        detectedIssues: [] as readonly string[],
        cliExitCode: null,
        cliExitedAt: null
      }),
      subscribe: () => noopDisposable
    };
    const fakeHistory = {
      list: () => Array.from({ length: 30 }, (_, i) => ({
        runId: `run-h-${i}`,
        featureId: `feat-h-${i}`,
        descriptionPreview: `historic feature ${i} preview`,
        terminalStatus: i % 4 === 0 ? 'failed' : 'completed',
        startedAt: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
        completedAt: new Date(1_700_000_000_500 + i * 60_000).toISOString(),
        durationMs: 500,
        lastErrorSummary: null,
        auditLogPointer: `runId:run-h-${i}`
      })),
      subscribe: () => noopDisposable
    };

    const projector = new StateProjector({
      store,
      audit,
      ownerId: 'this-window',
      debounceMs: 100,
      tickIntervalMs: 1_000,
      monotonicNow: () => monoClock.value,
      monitor: fakeMonitor as unknown as ConstructorParameters<typeof StateProjector>[0]['monitor'],
      history: fakeHistory as unknown as ConstructorParameters<typeof StateProjector>[0]['history']
    });
    projector.start();

    const tail = syntheticTail(50);
    const samples: number[] = [];
    const totalStart = performance.now();
    for (let i = 0; i < SNAPSHOT_COUNT; i++) {
      monoClock.value += 1_000;
      const sampleStart = performance.now();
      projector.seedAuditTail(tail);
      samples.push(performance.now() - sampleStart);
    }
    const totalElapsed = performance.now() - totalStart;
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    const max = samples[samples.length - 1];
    projector.dispose();

    expect(samples).toHaveLength(SNAPSHOT_COUNT);
    expect(
      totalElapsed,
      `v3 total ${totalElapsed.toFixed(2)} ms exceeded budget ${TOTAL_BUDGET_MS} ms (max ${max.toFixed(2)} ms)`
    ).toBeLessThan(TOTAL_BUDGET_MS);
    expect(
      median,
      `v3 median ${median.toFixed(2)} ms exceeded ${MEDIAN_BUDGET_MS} ms (max ${max.toFixed(2)} ms)`
    ).toBeLessThan(MEDIAN_BUDGET_MS);
  });

  it(`v4: ${SNAPSHOT_COUNT} project() passes at the PERMITTED scale — ${MAX_QUEUES} queues x ${PERMITTED_PENDING_PER_QUEUE} pending — stay under ${PERMITTED_SCALE_TOTAL_BUDGET_MS} ms (FR-R3-114 row 1)`, async () => {
    // FR-R3-114 row 1. Every case above this one measures 25 queue items. The product PERMITS
    // 2,000: `MAX_QUEUES` is 20 and each queue accepts 100 pending requests. An 80x gap between
    // the asserted ceiling and the permitted scale is not a perf budget, it is a perf budget for
    // a workspace nobody has — and the snapshot pipeline re-serializes the world at up to 10 Hz.
    //
    // MEASURED, THEN BOUNDED. The budget below is set from the observed figure on the reference
    // machine with headroom, not chosen first and hoped for. The number and its date are recorded
    // in `tests/perf/budgets.json` and in the item's own register, so a later regression is a
    // change to a measurement rather than an argument about what feels slow.
    //
    // WHY IT IS ONE CASE AND NOT A NEW TIER (FR-144). It runs in the existing perf suite, with the
    // existing projector, at the scale the product already allows. A separate scale tier would be
    // a tier nobody runs.
    // Real queue ids: everything but the default is a v4 UUID, which the registry validator
    // enforces. Synthesised deterministically rather than randomly — a perf fixture must not vary
    // between runs, and `Math.random()` in a measurement is a measurement of two things.
    const queueId = (q: number): string =>
      `0000${q.toString(16).padStart(4, '0')}-0000-4000-8000-${q.toString(16).padStart(12, '0')}`;
    const registryEntries = Array.from({ length: MAX_QUEUES }, (_, q) => ({
      id: q === 0 ? DEFAULT_QUEUE_ID : queueId(q),
      name: `Queue ${q}`,
      position: q,
      schedule: null,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000
    }));
    await store.setQueueRegistry({ entries: registryEntries, updatedAt: 1_700_000_000_000 });

    for (const entry of registryEntries) {
      await store.setQueue(
        {
          paused: false,
          pausedReason: null,
          inFlightId: null,
          updatedAt: 1_700_000_000_000,
          queueLifecycle: 'active-empty',
          pauseSource: null,
          scheduledStartAt: null,
          scheduledStartSource: null,
          requests: Array.from({ length: PERMITTED_PENDING_PER_QUEUE }, (_, i) => ({
            id: `${entry.id}-r-${i}`,
            description: `feature ${i} on ${entry.id} with a realistic description string`,
            enqueuedAt: 1_700_000_000_000 + i * 1000,
            createdAt: 1_700_000_000_000 + i * 1000,
            updatedAt: 1_700_000_000_500 + i * 1000,
            startedAt: null,
            completedAt: null,
            status: 'pending' as const,
            position: i,
            runId: null,
            retryCount: 0,
            lastError: null,
            pausedReason: null,
            queueId: entry.id
          }))
        } as never,
        entry.id
      );
    }
    await store.setRun(DEFAULT_QUEUE_ID, runningRun(2, 'speckit-plan'), unfencedCommit('test-fixture'));

    const projector = new StateProjector({
      store,
      audit,
      ownerId: 'this-window',
      debounceMs: 100,
      tickIntervalMs: 1_000,
      monotonicNow: () => monoClock.value
    });
    projector.start();

    const tail = syntheticTail(50);
    const samples: number[] = [];
    const totalStart = performance.now();
    for (let i = 0; i < SNAPSHOT_COUNT; i++) {
      monoClock.value += 1_000;
      const sampleStart = performance.now();
      projector.seedAuditTail(tail);
      samples.push(performance.now() - sampleStart);
    }
    const totalElapsed = performance.now() - totalStart;
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)]!;
    const max = samples[samples.length - 1]!;
    projector.dispose();

    // Non-vacuity: the fixture really does hold the permitted maximum, so a store that silently
    // dropped the queues could not make this case pass by measuring an empty world.
    const queued = registryEntries.reduce(
      (sum, entry) => sum + store.getQueue(entry.id).requests.length,
      0
    );
    expect(queued, 'the fixture must hold the permitted maximum').toBe(
      MAX_QUEUES * PERMITTED_PENDING_PER_QUEUE
    );
    console.log(
      `[FR-R3-114 row 1] ${MAX_QUEUES}x${PERMITTED_PENDING_PER_QUEUE}=${queued} items: ` +
        `total ${totalElapsed.toFixed(1)} ms, median ${median.toFixed(2)} ms, max ${max.toFixed(2)} ms`
    );
    expect(
      totalElapsed,
      `v4 total ${totalElapsed.toFixed(2)} ms exceeded budget ${PERMITTED_SCALE_TOTAL_BUDGET_MS} ms (max ${max.toFixed(2)} ms)`
    ).toBeLessThan(PERMITTED_SCALE_TOTAL_BUDGET_MS);
    expect(
      median,
      `v4 median ${median.toFixed(2)} ms exceeded ${PERMITTED_SCALE_MEDIAN_BUDGET_MS} ms (max ${max.toFixed(2)} ms)`
    ).toBeLessThan(PERMITTED_SCALE_MEDIAN_BUDGET_MS);
  });

  it('hot-path project() with full audit tail and active sub-progress respects per-call budget', async () => {
    await store.setRun(DEFAULT_QUEUE_ID, runningRun(7, 'speckit-clarify'), unfencedCommit('test-fixture'));
    const projector = new StateProjector({
      store,
      audit,
      ownerId: 'this-window',
      debounceMs: 100,
      tickIntervalMs: 1_000,
      monotonicNow: () => monoClock.value
    });
    projector.start();

    const tail = syntheticTail(50);
    const samples: number[] = [];
    for (let i = 0; i < SNAPSHOT_COUNT; i++) {
      monoClock.value += 100;
      const start = performance.now();
      projector.seedAuditTail(tail);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    const total = samples.reduce((a, b) => a + b, 0);

    projector.dispose();

    expect(
      total,
      `hot-path total ${total.toFixed(2)} ms exceeded budget`
    ).toBeLessThan(TOTAL_BUDGET_MS);
    expect(
      median,
      `hot-path median ${median.toFixed(2)} ms exceeded ${MEDIAN_BUDGET_MS} ms`
    ).toBeLessThan(MEDIAN_BUDGET_MS);
  });
});
