// FR-R3-128 (T1483, FR-001) — a characterization suite for `RunDriver.drive()`.
//
// WHY IT EXISTS, AND WHAT IT MUST NOT DO. The audit of 2026-08-27 names `drive()`
// the highest-value refactor target because its branch density intersects retries,
// evidence, checkpoint attribution and terminal durability. The recommended shape
// is extraction under characterization tests. This is that suite, and its whole
// value depends on one property:
//
//   IT ASSERTS THE OBSERVABLE TRACE, NOT THE INTERNAL CALL SITES.
//
// `drive()`'s arms are almost entirely audit emission, history recording,
// persistence and notification. A suite that asserted "this private method was
// called" would pin the exact shape the refactor is about to change — it would have
// to be rewritten by the same commit that claims it proved the refactor safe, which
// proves nothing at all. So what is pinned is: which lifecycle audit events were
// emitted, in what order, with which terminal status and payload facts; what the
// history recorder recorded; what the store holds when `drive()` returns; and
// whether the terminal callback fired. Those survive an extraction by construction,
// and they are what an operator and every downstream reader actually depend on.
//
// THE LOAD-BEARING ASSERTION is `exactly one task-execution-ended per Run`. That is
// the invariant `FR-R3-107` established when it consolidated three emission sites
// into one `emitTerminalOutcome`, and it is precisely what an extraction that moves
// three arms into a collaborator can break in a way no other test would notice: a
// duplicated emission still leaves the Run terminal, the history correct and the
// store consistent.
//
// PROVED ABLE TO FAIL. T1483's acceptance is that this suite goes red against a
// deliberate terminal-path mutation. That was performed: `emitTerminalOutcome` was
// made to emit twice, the suite reported the duplicate, and the mutation was
// reverted. A characterization suite that passes on both sides of a behaviour change
// would bless the refactor whatever it did.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { RunDriver, type RunDriverDeps } from '../../../src/services/run-driver';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { SanitizedLogger } from '../../../src/lib/logger';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import type { PhaseRunOutput } from '../../../src/controller/phase-runner';
import type { WorkflowRun } from '../../../src/state/workflow-run';

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

/** One entry in the observable trace. Deliberately coarse. */
interface TraceEntry {
  readonly source: 'lifecycle' | 'history' | 'terminal';
  readonly event: string;
  readonly terminalStatus?: string;
}

interface Harness {
  readonly store: WorkspaceStateStore;
  readonly driver: RunDriver;
  readonly trace: readonly TraceEntry[];
  readonly phaseRunner: { run: ReturnType<typeof vi.fn> };
  readonly checkpoints: { checkpoint: ReturnType<typeof vi.fn> };
  seedRun(overrides?: Partial<WorkflowRun>): Promise<WorkflowRun>;
}

/**
 * Stand a real `RunDriver` up over stub collaborators.
 *
 * Reuses `tests/integration/checkpoints/driver-harness.ts`'s *approach* rather than
 * importing it: that harness interleaves two Runs through real Git for checkpoint
 * attribution, and this needs one Run and a recording trace. Coupling a behavioural
 * pin to a fixture built for a different question makes both harder to read.
 */
async function makeHarness(): Promise<Harness> {
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  const trace: TraceEntry[] = [];

  const phaseRunner = {
    run: vi.fn(),
    abort: vi.fn(),
    appendCapExhaustedPhaseEnd: vi.fn().mockResolvedValue(undefined)
  };
  const checkpoints = { checkpoint: vi.fn().mockResolvedValue(undefined) };

  const deps = {
    store,
    runner: phaseRunner,
    logger: new SanitizedLogger([]),
    options: { iterationCap: 5, cwd: '/test/cwd', cliPath: '/test/bin' },
    monitor: null,
    retryCoordinator: {
      registerAttempt: vi.fn(),
      clear: vi.fn(),
      isRetryCapExhaustedOnNextFailure: vi.fn().mockReturnValue(false),
      handleDelayedRetry: vi.fn(),
      maybeEmitRetryRecovered: vi.fn().mockImplementation(async (r: unknown) => r)
    },
    queue: { finish: vi.fn(), pause: vi.fn(), findById: vi.fn(() => null) },
    notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    statusBar: { update: vi.fn(), dispose: vi.fn() },
    historyRecorder: {
      record: vi.fn(async (_run: unknown, _description: string, outcome: string) => {
        trace.push({ source: 'history', event: 'recorded', terminalStatus: outcome });
      })
    },
    checkpoints,
    emitRunEndedBreakpointAudit: vi.fn(),
    emitTaskLifecycleAudit: vi.fn(
      async (eventType: string, _run: unknown, payload?: { terminalStatus?: string }) => {
        trace.push({
          source: 'lifecycle',
          event: eventType,
          ...(payload?.terminalStatus === undefined ? {} : { terminalStatus: payload.terminalStatus })
        });
      }
    ),
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
    persistTransition: async (_previous: unknown, next: WorkflowRun) => {
      await store.setRun(DEFAULT_QUEUE_ID, next, unfencedCommit('test-fixture'));
      return next;
    },
    scheduleAutoDrain: vi.fn(),
    releaseExecutionLease: vi.fn(),
    onRunTerminal: vi.fn(async (run: WorkflowRun) => {
      trace.push({ source: 'terminal', event: 'onRunTerminal', terminalStatus: run.status });
    })
  } as unknown as RunDriverDeps;

  const driver = new RunDriver(deps);

  return {
    store,
    driver,
    trace,
    phaseRunner,
    checkpoints,
    async seedRun(overrides: Partial<WorkflowRun> = {}): Promise<WorkflowRun> {
      const run = {
        id: 'run-char-1',
        taskId: 'task-char-1',
        featureId: 'task-char-1',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        status: 'running',
        currentPhase: 'plan',
        currentIteration: 0,
        pipeline: {
          id: 'pipe-char',
          name: 'Characterization',
          phases: [{ id: 'plan', title: 'Plan', runner: 'claude', effort: 'normal' }]
        },
        phasesCompleted: [],
        pendingRetry: false,
        delayedRetryCount: 0,
        manualPauseAt: null,
        manualPauseCause: null,
        phaseBreakpoints: [],
        phaseOverrides: [],
        resumeTargetPhaseId: null,
        ...overrides
      } as unknown as WorkflowRun;
      await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
      return store.getRun(DEFAULT_QUEUE_ID)!;
    }
  };
}

/** A phase that completed cleanly. */
const COMPLETED_PHASE: PhaseRunOutput = {
  result: { kind: 'complete', warnings: [], auditEntry: null },
  outcome: 'completed',
  terminationReason: 'token',
  stdoutSummary: '',
  stderrSummary: '',
  exitCode: 0,
  warnings: [],
  auditEntryId: null
} as unknown as PhaseRunOutput;

/** A phase that failed fatally. */
const FAILED_PHASE: PhaseRunOutput = {
  result: { kind: 'malformed', warnings: [], fatalCause: 'fatal', auditEntry: null },
  outcome: 'failed',
  terminationReason: 'error',
  stdoutSummary: '',
  stderrSummary: 'fatal',
  exitCode: 1,
  warnings: ['fatal'],
  auditEntryId: null
} as unknown as PhaseRunOutput;

const lifecycle = (trace: readonly TraceEntry[]): readonly TraceEntry[] =>
  trace.filter((entry) => entry.source === 'lifecycle');
const terminalEnds = (trace: readonly TraceEntry[]): readonly TraceEntry[] =>
  lifecycle(trace).filter((entry) => entry.event === 'task-execution-ended');

describe('drive() — the terminal contract (FR-R3-128 characterization)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });

  it('a completed Run emits exactly one task-execution-ended, with status completed', async () => {
    h.phaseRunner.run.mockResolvedValue(COMPLETED_PHASE);
    await h.driver.drive(await h.seedRun(), 'characterization');

    // THE load-bearing assertion. FR-R3-107 consolidated three emission sites into
    // one emitter; a refactor that moves the arms can duplicate it and leave the
    // Run terminal, the history correct and the store consistent — so nothing else
    // in this tree would notice.
    expect(terminalEnds(h.trace)).toHaveLength(1);
    expect(terminalEnds(h.trace)[0]!.terminalStatus).toBe('completed');
    expect(h.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('completed');
  });

  it('a failed Run emits exactly one task-execution-ended, with status failed', async () => {
    h.phaseRunner.run.mockResolvedValue(FAILED_PHASE);
    await h.driver.drive(await h.seedRun(), 'characterization');

    expect(terminalEnds(h.trace)).toHaveLength(1);
    expect(terminalEnds(h.trace)[0]!.terminalStatus).toBe('failed');
    expect(h.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('failed');
  });

  it('the terminal emission precedes the terminal callback', async () => {
    // Order, not just presence. `onRunTerminal` is what releases the queue slot and
    // schedules the next drain; a Run whose slot is released before its terminal
    // record exists is a Run that can vanish from the evidence and still have
    // advanced the queue.
    h.phaseRunner.run.mockResolvedValue(COMPLETED_PHASE);
    await h.driver.drive(await h.seedRun(), 'characterization');

    const endIndex = h.trace.findIndex((e) => e.event === 'task-execution-ended');
    const terminalIndex = h.trace.findIndex((e) => e.event === 'onRunTerminal');
    expect(endIndex, 'no terminal emission was recorded').toBeGreaterThanOrEqual(0);
    expect(terminalIndex, 'no terminal callback fired').toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeLessThan(terminalIndex);
  });

  it('history records the same outcome the terminal emission carries', async () => {
    // Two records of one fact, and they must agree: the audit log is what a
    // reviewer reads and history is what the operator sees.
    for (const [output, expected] of [
      [COMPLETED_PHASE, 'completed'],
      [FAILED_PHASE, 'failed']
    ] as const) {
      const local = await makeHarness();
      local.phaseRunner.run.mockResolvedValue(output);
      await local.driver.drive(await local.seedRun(), 'characterization');

      const ends = terminalEnds(local.trace);
      const histories = local.trace.filter((e) => e.source === 'history');
      expect(ends, expected).toHaveLength(1);
      expect(histories, expected).toHaveLength(1);
      expect(histories[0]!.terminalStatus, expected).toBe(ends[0]!.terminalStatus);
      expect(ends[0]!.terminalStatus).toBe(expected);
    }
  });

  it('drives no second Run while one is in flight', async () => {
    // The re-entrancy guard. Its absence would be invisible in a terminal trace and
    // catastrophic in a queue.
    h.phaseRunner.run.mockImplementation(async () => {
      // Re-enter while the first drive is inside a phase.
      await h.driver.drive(h.store.getRun(DEFAULT_QUEUE_ID)!, 'reentrant');
      return COMPLETED_PHASE;
    });
    await h.driver.drive(await h.seedRun(), 'characterization');
    expect(terminalEnds(h.trace)).toHaveLength(1);
  });
});

describe('drive() — evidence and refusal paths (FR-R3-128 characterization)', () => {
  it('a checkpoint refusal does not stop the Run reaching a terminal state', async () => {
    // FR-R3-004's rule: a DECLINE is recorded and the Git-capable phase proceeds,
    // while a genuine snapshot failure blocks its phase. A refactor that conflated
    // them would either strand Runs or write unattributable patches.
    const h = await makeHarness();
    h.checkpoints.checkpoint.mockResolvedValue(undefined);
    h.phaseRunner.run.mockResolvedValue(COMPLETED_PHASE);
    await h.driver.drive(await h.seedRun(), 'characterization');
    expect(terminalEnds(h.trace)).toHaveLength(1);
    expect(h.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('completed');
  });

  it('a run that starts terminal is not driven', async () => {
    const h = await makeHarness();
    h.phaseRunner.run.mockResolvedValue(COMPLETED_PHASE);
    await h.driver.drive(await h.seedRun({ status: 'completed' } as Partial<WorkflowRun>), 'x');
    // No phase dispatched, no terminal emission: `drive()` is not a way to re-end a
    // Run that already ended.
    expect(h.phaseRunner.run).not.toHaveBeenCalled();
    expect(terminalEnds(h.trace)).toHaveLength(0);
  });
});

describe('the characterization suite pins a trace, not a shape', () => {
  it('names no private member of RunDriver', () => {
    // The property that makes this suite survive the extraction it exists to guard.
    // Asserted mechanically because it is easy to add one assertion about an
    // internal in a hurry, and that one assertion is what makes the suite have to be
    // rewritten by the commit it was supposed to check.
    const body = readFileSync(resolve(__dirname, 'run-driver-characterization.test.ts'), 'utf8');
    for (const internal of [
      'emitTerminalOutcome',
      'dispatchObserved',
      'latestSnapshotOf',
      'sequencer',
      'computePhaseStats',
      'continueOptionalFailure'
    ]) {
      // The names may appear in PROSE — that is how the suite explains itself — but
      // never as a subject of an assertion.
      const asAssertion = new RegExp(`expect\\([^)]*${internal}`);
      expect(asAssertion.test(body), `${internal} is asserted on directly`).toBe(false);
    }
  });
});
