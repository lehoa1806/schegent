// FR-R3-157 (T029) — the degraded mark reaches the persisted Run, and reaches it
// in the SAME write as the phase result it belongs to.
//
// WHY ATOMICITY IS THE THING ASSERTED (contract C3.3). `drive()` persists a Run
// once per transition. If the degraded entry were appended in a second write, a
// crash, a queue cancellation or a losing fence between the two would leave a
// persisted Run whose `phasesCompleted` says the phase ended and whose
// `degradedPhases` says nothing happened — which is precisely the state FR-006
// forbids, a degraded run indistinguishable from a clean one, and the reader has
// no way to tell it from a legitimately clean phase after the fact.
//
// So the assertion is not "the final store contains the entry" — a two-write
// implementation passes that. It is written against the sequence of
// `(previous, next)` pairs handed to `persistTransition`: no persisted transition
// may grow one list without the other. That fails on a second write and cannot be
// made to pass by reordering.
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

/** One persisted transition, as the driver handed it over. */
interface Persisted {
  readonly previous: WorkflowRun;
  readonly next: WorkflowRun;
}

interface Harness {
  readonly store: WorkspaceStateStore;
  readonly driver: RunDriver;
  readonly persisted: readonly Persisted[];
  readonly phaseRunner: { run: ReturnType<typeof vi.fn> };
  seedRun(overrides?: Partial<WorkflowRun>): Promise<WorkflowRun>;
}

/**
 * A `RunDriver` over stub collaborators, recording every persisted transition.
 *
 * Modelled on `run-driver-characterization.test.ts`'s approach rather than
 * importing its harness: that one records an observable *trace* of audit and
 * history events and deliberately discards the Run bodies, and the Run bodies are
 * the entire subject here.
 */
async function makeHarness(iterationCap: number): Promise<Harness> {
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  const persisted: Persisted[] = [];

  const phaseRunner = {
    run: vi.fn(),
    abort: vi.fn(),
    appendCapExhaustedPhaseEnd: vi.fn().mockResolvedValue(undefined),
    evictStagnationTracker: vi.fn()
  };

  const deps = {
    store,
    runner: phaseRunner,
    logger: new SanitizedLogger([]),
    options: { iterationCap, cwd: '/test/cwd', cliPath: '/test/bin' },
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
    historyRecorder: { record: vi.fn() },
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
    persistTransition: async (previous: WorkflowRun, next: WorkflowRun) => {
      persisted.push({ previous, next });
      await store.setRun(DEFAULT_QUEUE_ID, next, unfencedCommit('test-fixture'));
      return next;
    },
    scheduleAutoDrain: vi.fn(),
    releaseExecutionLease: vi.fn(),
    onRunTerminal: vi.fn()
  } as unknown as RunDriverDeps;

  return {
    store,
    driver: new RunDriver(deps),
    persisted,
    phaseRunner,
    async seedRun(overrides: Partial<WorkflowRun> = {}): Promise<WorkflowRun> {
      const run = {
        id: 'run-degraded-1',
        taskId: 'task-degraded-1',
        featureId: 'task-degraded-1',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        status: 'running',
        currentPhase: 'audit',
        currentIteration: 0,
        pipeline: { id: 'pipe-degraded', name: 'Degraded', phases: [] },
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

/**
 * A phase whose retryCondition stays truthy: `open_questions` never reaches 0, so
 * every iteration loops until the cap and the cap branch decides what happens.
 */
const UNSATISFIED: PhaseRunOutput = {
  result: { kind: 'clean', auditEntry: { metrics: { open_questions: 3 } } },
  outcome: 'clean',
  terminationReason: 'token',
  stdoutSummary: '',
  stderrSummary: '',
  exitCode: 0,
  warnings: [],
  auditEntryId: null
} as unknown as PhaseRunOutput;

/** A phase that degrades at its cap, in a pipeline shaped so the cap is hit at once. */
const degradingPhase = (id: string) => ({
  id,
  title: id,
  runner: 'claude',
  effort: 'normal',
  retryCondition: 'open_questions > 0',
  onRetryCap: 'continue-degraded'
});

/** The transitions in which a phase result was appended. */
const phaseAppends = (persisted: readonly Persisted[]): readonly Persisted[] =>
  persisted.filter((p) => p.next.phasesCompleted.length > p.previous.phasesCompleted.length);

const degradedOf = (run: WorkflowRun): readonly { phaseId: string; condition: string }[] =>
  (run.degradedPhases ?? []) as readonly { phaseId: string; condition: string }[];

describe('run-driver — the degraded mark is persisted with its phase result (FR-R3-157)', () => {
  let h: Harness;
  beforeEach(async () => {
    // Cap of 1: `decideBeforePhase` floors the iteration at 1, so a phase reaches
    // `iteration >= iterationCap` on its first dispatch and the cap branch runs
    // without the test having to simulate a retry loop it is not about.
    h = await makeHarness(1);
    h.phaseRunner.run.mockResolvedValue(UNSATISFIED);
  });

  it('appends the entry in the SAME persisted transition as the phase result (C3.3)', async () => {
    await h.driver.drive(
      await h.seedRun({
        pipeline: {
          id: 'pipe-degraded',
          name: 'Degraded',
          phases: [degradingPhase('audit')]
        }
      } as unknown as Partial<WorkflowRun>),
      'degradation'
    );

    const appends = phaseAppends(h.persisted);
    expect(appends, 'no phase result was ever persisted').toHaveLength(1);
    const { previous, next } = appends[0]!;
    // Both lists grew, in one write. This is the whole claim.
    expect(degradedOf(previous)).toHaveLength(0);
    expect(degradedOf(next)).toEqual([{ phaseId: 'audit', condition: 'open_questions > 0' }]);
    expect(next.phasesCompleted.at(-1)?.phase).toBe('audit');
  });

  it('never grows one list without the other in a single write (C3.3)', async () => {
    await h.driver.drive(
      await h.seedRun({
        pipeline: {
          id: 'pipe-degraded',
          name: 'Degraded',
          phases: [degradingPhase('audit')]
        }
      } as unknown as Partial<WorkflowRun>),
      'degradation'
    );

    // The negative half, stated over EVERY transition rather than the one the test
    // above picked out: a second write that appended the mark on its own would add
    // a transition this loop rejects, and would leave the assertion above intact.
    for (const { previous, next } of h.persisted) {
      const markGrew = degradedOf(next).length > degradedOf(previous).length;
      const resultGrew = next.phasesCompleted.length > previous.phasesCompleted.length;
      expect(markGrew, 'a degraded mark was persisted on its own').toBe(markGrew && resultGrew);
    }
  });

  it('accumulates one entry per degraded phase, in the order they happened (C3.2)', async () => {
    // Two phases, both degrading. The second must not replace the first, and the
    // order must be the order of execution — the list is a record of what happened,
    // and a set or a last-writer-wins field would lose the first phase entirely.
    await h.driver.drive(
      await h.seedRun({
        pipeline: {
          id: 'pipe-degraded',
          name: 'Degraded',
          phases: [degradingPhase('audit'), degradingPhase('verify')]
        }
      } as unknown as Partial<WorkflowRun>),
      'degradation'
    );

    expect(degradedOf(h.store.getRun(DEFAULT_QUEUE_ID)!)).toEqual([
      { phaseId: 'audit', condition: 'open_questions > 0' },
      { phaseId: 'verify', condition: 'open_questions > 0' }
    ]);
  });

  it('leaves the field absent when no phase degraded', async () => {
    // Absence means NOT degraded (FR-006). A driver that wrote an empty list would
    // still read as "not degraded" to a correct reader, but it would put the key on
    // every record ever persisted and make the absent case untestable from then on.
    await h.driver.drive(
      await h.seedRun({
        pipeline: {
          id: 'pipe-degraded',
          name: 'Degraded',
          // No retryCondition: the cap branch is never reached.
          phases: [{ id: 'audit', title: 'Audit', runner: 'claude', effort: 'normal' }]
        }
      } as unknown as Partial<WorkflowRun>),
      'degradation'
    );

    expect(h.store.getRun(DEFAULT_QUEUE_ID)!.degradedPhases).toBeUndefined();
  });
});

/**
 * FR-R3-157 (T040, FR-010/FR-010a, contract C3.10) — finalize is handed the fact.
 *
 * WHAT "THE INPUT FINALIZE IS HANDED" IS, AND WHY THE TEST IS SHAPED THIS WAY.
 * `PhaseRunInputs` carries no Run — the interface in
 * `src/controller/phase-runner.ts` declares no Run-typed field — so
 * there is no field on the dispatch argument to look for and a test that searched
 * for one would be asserting a design this feature does not have. The input a
 * phase is actually handed is the Run state it executes against: the persisted Run
 * at the instant the driver dispatches that phase. So the mark is read out of the
 * store from *inside* the runner mock, at the moment finalize starts — not
 * afterwards, when a later write could have supplied it and the test would prove
 * only that the field exists somewhere.
 *
 * FR-010a IS A NON-CLAIM, AND IT IS TESTED AS ONE. The spec says finalize
 * *receives* the fact and explicitly does not say finalize should do anything
 * differently about it — refusing, warning or ignoring is a separate filing. A test
 * that asserted finalize behaved differently would quietly implement that filing.
 * So the second case asserts the opposite: the argument finalize is dispatched with
 * is the same shape in a degraded run as in a clean one. That is the negative half
 * of C3.10, and it is the half a later change is most likely to break.
 */
describe('run-driver — finalize receives the degraded record (FR-R3-157, C3.10)', () => {
  let h: Harness;

  /** A phase that cannot degrade: no retry condition, so the cap branch is unreachable. */
  const plainPhase = (id: string) => ({ id, title: id, runner: 'claude', effort: 'normal' });

  /**
   * Drive `phases` and capture what the store held when `finalize` was dispatched,
   * together with the dispatch argument itself.
   */
  async function driveCapturingFinalize(phases: readonly unknown[]): Promise<{
    runAtFinalize: WorkflowRun | null;
    inputsAtFinalize: Record<string, unknown> | null;
    dispatched: readonly string[];
  }> {
    let runAtFinalize: WorkflowRun | null = null;
    let inputsAtFinalize: Record<string, unknown> | null = null;
    const dispatched: string[] = [];
    // `PhaseRunInputs.phase` is a `Phase`, and `Phase` is a bare `string`
    // (`src/controller/phase.ts:42`) — the phase id, not the phase definition.
    // The definition arrives separately as `phaseDef`.
    h.phaseRunner.run.mockImplementation((inputs: { phase: string }) => {
      dispatched.push(inputs.phase);
      if (inputs.phase === 'finalize') {
        runAtFinalize = h.store.getRun(DEFAULT_QUEUE_ID);
        inputsAtFinalize = inputs as unknown as Record<string, unknown>;
      }
      return Promise.resolve(UNSATISFIED);
    });

    await h.driver.drive(
      await h.seedRun({
        pipeline: { id: 'pipe-degraded', name: 'Degraded', phases }
      } as unknown as Partial<WorkflowRun>),
      'degradation'
    );

    return { runAtFinalize, inputsAtFinalize, dispatched };
  }

  beforeEach(async () => {
    h = await makeHarness(1);
  });

  it('the run finalize executes against already carries the mark, with both names (FR-010)', async () => {
    const { runAtFinalize, dispatched } = await driveCapturingFinalize([
      degradingPhase('audit'),
      plainPhase('finalize')
    ]);

    expect(runAtFinalize, `finalize was never dispatched; ran ${dispatched.join(' -> ')}`).not.toBeNull();
    expect(degradedOf(runAtFinalize!)).toEqual([
      { phaseId: 'audit', condition: 'open_questions > 0' }
    ]);
  });

  it('hands finalize the same argument it would for a clean run (FR-010a)', async () => {
    // The non-claim. Whatever finalize does with the fact is out of scope, so the
    // dispatch must not have acquired a degradation-shaped field, a changed key
    // set, or a different phase identity on the way in. Compared against a clean
    // run of the same pipeline shape rather than against a hardcoded key list,
    // which would go stale the first time an unrelated input field was added.
    const degraded = await driveCapturingFinalize([
      degradingPhase('audit'),
      plainPhase('finalize')
    ]);

    h = await makeHarness(1);
    const clean = await driveCapturingFinalize([plainPhase('audit'), plainPhase('finalize')]);

    expect(degraded.inputsAtFinalize, 'finalize was never dispatched').not.toBeNull();
    expect(clean.inputsAtFinalize, 'the clean control never dispatched finalize').not.toBeNull();
    expect(Object.keys(degraded.inputsAtFinalize!).sort()).toEqual(
      Object.keys(clean.inputsAtFinalize!).sort()
    );
    // And the control really is clean, so the comparison above is between two
    // different states rather than between two copies of the same one.
    expect(clean.runAtFinalize!.degradedPhases).toBeUndefined();
    expect(degradedOf(degraded.runAtFinalize!)).toHaveLength(1);
  });
});
