// FR-R3-196 (T1873) — a Run that ends normally leaves no terminal transition intent.
//
// Wired end to end for the reason `degraded-mark-survives-run-disposal.test.ts` is: the defect is
// the seam between `RunDriver`'s `settle` (the first `finish`, which lands) and
// `TerminalTransitionCoordinator.complete` (the second, which the closed transition table refuses).
// A unit test over a double that always answers `{ ok: true }` hides it. The queue, the store, the
// history recorder and the coordinator here are the real ones.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { SanitizedLogger } from '../../src/lib/logger';
import { QueueManager } from '../../src/queue/queue-manager';
import { createHistoryRecorder } from '../../src/services/history-recorder';
import { RunDriver, type RunDriverDeps } from '../../src/services/run-driver';
import { TerminalTransitionCoordinator } from '../../src/services/terminal-transition-coordinator';
import { HistoryStore } from '../../src/state/history-store';
import { unfencedCommit } from '../../src/state/ownership-claim';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import type { PhaseRunOutput } from '../../src/controller/phase-runner';
import type { WorkflowRun } from '../../src/state/workflow-run';

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

const CLEAN: PhaseRunOutput = {
  result: { kind: 'clean', auditEntry: { metrics: {} } },
  outcome: 'clean',
  terminationReason: 'token',
  stdoutSummary: '',
  stderrSummary: '',
  exitCode: 0,
  warnings: [],
  auditEntryId: null
} as unknown as PhaseRunOutput;

const cleanPhase = { id: 'audit', title: 'Audit', runner: 'claude', effort: 'normal' };
const RUN_ID = 'run-196-integration';
const REPLAY_REMAINS_PENDING = 'replay remains pending';

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-196-')));
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

async function makeWorld() {
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  const queue = new QueueManager(store);
  const lines: string[] = [];
  const logger = new SanitizedLogger([
    {
      appendLine: (line: string) => {
        lines.push(line);
      }
    }
  ]);
  const historyStore = new HistoryStore(store);
  const historyRecorder = createHistoryRecorder({
    historyStore,
    logger,
    queue,
    store,
    workspaceRoot
  });
  const terminalTransitions = new TerminalTransitionCoordinator(
    store, queue, historyRecorder, logger
  );

  const deps = {
    store,
    runner: {
      run: vi.fn().mockResolvedValue(CLEAN),
      abort: vi.fn(),
      appendCapExhaustedPhaseEnd: vi.fn().mockResolvedValue(undefined),
      evictStagnationTracker: vi.fn()
    },
    logger,
    options: { iterationCap: 1, cwd: '/test/cwd', cliPath: '/test/bin' },
    monitor: null,
    retryCoordinator: {
      registerAttempt: vi.fn(),
      clear: vi.fn(),
      isRetryCapExhaustedOnNextFailure: vi.fn().mockReturnValue(false),
      handleDelayedRetry: vi.fn(),
      maybeEmitRetryRecovered: vi.fn().mockImplementation(async (r: unknown) => r)
    },
    queue,
    terminalTransitions,
    notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    statusBar: { update: vi.fn(), dispose: vi.fn() },
    historyRecorder,
    checkpoints: { checkpoint: vi.fn().mockResolvedValue(undefined) },
    emitRunEndedBreakpointAudit: vi.fn(),
    emitTaskLifecycleAudit: vi.fn(),
    emitOptionalPhaseFailureContinued: vi.fn(),
    emitRunSnapshotDeclined: vi.fn(),
    emitOutputTargetRefusedAtDispatch: vi.fn(),
    appendPhaseControlAudit: vi.fn(),
    appendRunnerProbeFailedAudit: vi.fn(),
    appendBreakpointAudit: vi.fn(),
    isContinueGate: { consume: vi.fn().mockReturnValue(false), arm: vi.fn() },
    lock: {
      release: vi.fn(async () => {}),
      tryAcquire: vi.fn(),
      heartbeat: vi.fn(),
      isHeld: vi.fn(),
      ownerOfRecord: vi.fn(),
      id: 'this-window'
    },
    persistTransition: async (_previous: WorkflowRun, next: WorkflowRun) => {
      await store.setRun(DEFAULT_QUEUE_ID, next, unfencedCommit('test-fixture'));
      return next;
    },
    scheduleAutoDrain: vi.fn(),
    releaseExecutionLease: vi.fn(),
    onRunTerminal: vi.fn()
  } as unknown as RunDriverDeps;

  return { store, queue, historyStore, lines, logger, driver: new RunDriver(deps) };
}

describe('FR-R3-196 (T1873) — a Run driven to completed leaves no intent behind', () => {
  it('journals nothing, warns nothing, records history once, and a later replay has nothing to do', async () => {
    const { store, queue, historyStore, lines, logger, driver } = await makeWorld();
    const task = await queue.enqueue('one clean phase');
    await queue.markInFlight(task.id, RUN_ID);

    const run = {
      id: RUN_ID,
      taskId: task.id,
      featureId: task.id,
      featureDir: 'specs/196',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      status: 'running',
      currentPhase: 'audit',
      currentIteration: 0,
      pipeline: { id: 'pipe', name: 'Pipe', phases: [cleanPhase] },
      phasesCompleted: [],
      lastError: null,
      pendingRetry: false,
      delayedRetryCount: 0,
      pendingRetryAt: null,
      pendingRetryCause: null,
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      phaseOverrides: [],
      resumeTargetPhaseId: null
    } as unknown as WorkflowRun;
    await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
    await driver.drive(store.getRun(DEFAULT_QUEUE_ID)!, task.id);

    expect(Object.keys(store.getTerminalTransitionIntents())).toEqual([]);
    expect(lines.filter((line) => line.includes(REPLAY_REMAINS_PENDING))).toEqual([]);
    expect(queue.findById(task.id)?.status).toBe('completed');
    expect(historyStore.list().filter((entry) => entry.runId === RUN_ID)).toHaveLength(1);

    const finish = vi.fn();
    const record = vi.fn();
    await new TerminalTransitionCoordinator(
      store, { finish } as never, { record } as never, logger
    ).replay();
    expect(finish).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
