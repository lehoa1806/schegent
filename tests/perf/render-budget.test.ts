import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StateProjector } from '../../src/ui/sidebar/state-projector';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../src/lib/logger';
import type { WorkflowRun } from '../../src/state/workflow-run';
import type { AuditTailEntry } from '../../src/ui/sidebar/snapshot';

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
const TOTAL_BUDGET_MS = 1_600;
const MEDIAN_BUDGET_MS = 16;

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
        summary: `synthetic event ${i} with a moderately verbose summary line for realism`
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
    await store.setRun(runningRun(3, 'speckit-analyze'));
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
    ).toBeLessThanOrEqual(MEDIAN_BUDGET_MS);
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
      requests: queueRequests
    });
    await store.setRun(runningRun(2, 'speckit-plan'));

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
    ).toBeLessThanOrEqual(MEDIAN_BUDGET_MS);
  });

  it('hot-path project() with full audit tail and active sub-progress respects per-call budget', async () => {
    await store.setRun(runningRun(7, 'speckit-clarify'));
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
    ).toBeLessThanOrEqual(MEDIAN_BUDGET_MS);
  });
});
