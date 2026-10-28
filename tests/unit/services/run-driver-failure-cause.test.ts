// FR-R4-F14 (spec 242, contracts V4 and N6; FR-003, FR-005, FR-010, FR-012, FR-025, SC-002) — the
// failure cause at the driver's real branches.
//
// Each case drives `RunDriver.drive()` over a real `WorkspaceStateStore` (so the persisted Run is held
// to `validateRunInvariants`, and a cause beside a non-failed status would throw), with a scripted
// phase runner, and reads the three places the cause must land: the persisted Run, the
// `task-execution-ended` payload as the audit projection leaves it, and the notice the operator sees,
// which must equal the builder's output for that cause and carry nothing the agent wrote.
//
// Later stories add rows to this file: the last-phase branch (US2), the remaining sequencer codes
// (US3) and the probe and evidence branches (US5).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { projectAuditPayload } from '../../../src/audit/audit-payload';
import { resumeAdmissionPatch } from '../../../src/controller/resume-pause-fields';
import type { PhaseRunOutput } from '../../../src/controller/phase-runner';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { FAILURE_CAUSE_LABELS } from '../../../src/contracts/failure-cause';
import { SanitizedLogger } from '../../../src/lib/logger';
import { RunDriver, type RunDriverDeps } from '../../../src/services/run-driver';
import { failureNotice } from '../../../src/services/failure-notice';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';

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

const CLAIM = unfencedCommit('test-fixture');
const DESCRIPTION = 'Add the export button';
const PHASE = 'implement';

/** A planted value that no notice, status detail or event field may ever carry (FR-025, SC-002). */
const SENTINEL = 'SENTINEL-AGENT-OUTPUT-sk-ant-' + 'Z'.repeat(24);

interface Persisted {
  readonly previous: WorkflowRun;
  readonly next: WorkflowRun;
}

interface Harness {
  readonly store: WorkspaceStateStore;
  readonly driver: RunDriver;
  readonly persisted: Persisted[];
  readonly phaseRunner: { run: ReturnType<typeof vi.fn>; appendCapExhaustedPhaseEnd: ReturnType<typeof vi.fn> };
  readonly notifier: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  readonly statusBar: { update: ReturnType<typeof vi.fn> };
  readonly emitTaskLifecycleAudit: ReturnType<typeof vi.fn>;
  readonly queueFinish: ReturnType<typeof vi.fn>;
  readonly complete: ReturnType<typeof vi.fn>;
  readonly probeAvailability: ReturnType<typeof vi.fn>;
  readonly appendRunnerProbeFailedAudit: ReturnType<typeof vi.fn>;
  seedRun(overrides?: Partial<WorkflowRun>): Promise<WorkflowRun>;
  /** Resume the failed Run the way the admission does, and return it as the store now holds it. */
  resume(): Promise<WorkflowRun>;
  /** The `task-execution-ended` payloads emitted so far, in order. */
  endedPayloads(): Array<Record<string, unknown>>;
}

interface HarnessOptions {
  /** The driver's audit-evidence gate. Absent means available. */
  readonly isAuditEvidenceAvailable?: () => boolean;
}

async function makeHarness(iterationCap: number, harnessOptions: HarnessOptions = {}): Promise<Harness> {
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  const persisted: Persisted[] = [];

  const phaseRunner = {
    run: vi.fn(),
    abort: vi.fn(),
    appendCapExhaustedPhaseEnd: vi.fn().mockResolvedValue(undefined),
    evictStagnationTracker: vi.fn()
  };
  const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const statusBar = { update: vi.fn(), dispose: vi.fn() };
  const emitTaskLifecycleAudit = vi.fn();
  const queueFinish = vi.fn(async () => ({ ok: true }));
  const complete = vi.fn(async () => undefined);
  const probeAvailability = vi.fn().mockResolvedValue(true);
  const appendRunnerProbeFailedAudit = vi.fn();

  const deps = {
    store,
    runner: phaseRunner,
    logger: new SanitizedLogger([]),
    options: { iterationCap, cwd: '/test/cwd', cliPath: '/test/bin', ...harnessOptions },
    backendCapabilities: { probeAvailability },
    terminalTransitions: { begin: vi.fn(), complete },
    monitor: null,
    retryCoordinator: {
      registerAttempt: vi.fn(),
      clear: vi.fn(),
      isRetryCapExhaustedOnNextFailure: vi.fn().mockReturnValue(false),
      handleDelayedRetry: vi.fn(),
      maybeEmitRetryRecovered: vi.fn().mockImplementation(async (r: unknown) => r)
    },
    queue: { finish: queueFinish, pause: vi.fn(async () => ({ ok: true })), findById: vi.fn(() => null) },
    notifier,
    statusBar,
    historyRecorder: { record: vi.fn(), recordPhaseOutput: vi.fn() },
    checkpoints: { checkpoint: vi.fn().mockResolvedValue(undefined) },
    emitRunEndedBreakpointAudit: vi.fn(),
    emitTaskLifecycleAudit,
    emitOptionalPhaseFailureContinued: vi.fn(),
    emitRunSnapshotDeclined: vi.fn(),
    emitOutputTargetRefusedAtDispatch: vi.fn(),
    appendPhaseControlAudit: vi.fn(),
    appendRunnerProbeFailedAudit,
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
      await store.setRun(DEFAULT_QUEUE_ID, next, CLAIM);
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
    notifier,
    statusBar,
    emitTaskLifecycleAudit,
    queueFinish,
    complete,
    probeAvailability,
    appendRunnerProbeFailedAudit,
    async seedRun(overrides: Partial<WorkflowRun> = {}): Promise<WorkflowRun> {
      const run = {
        id: 'run-cause-1',
        featureId: 'task-cause-1',
        featureDir: '/tmp/feat',
        startedAt: Date.now(),
        lastTransitionAt: Date.now(),
        status: 'running',
        currentPhase: PHASE,
        currentIteration: 0,
        pipeline: { id: 'pipe-cause', name: 'Cause', phases: [capPhase(PHASE)] },
        phasesCompleted: [],
        lastError: null,
        delayedRetryCount: 0,
        pendingRetryAt: null,
        pendingRetryCause: null,
        manualPauseAt: null,
        manualPauseCause: null,
        phaseBreakpoints: [],
        phaseOverrides: [],
        resumeTargetPhaseId: null,
        ...overrides
      } as unknown as WorkflowRun;
      await store.setRun(DEFAULT_QUEUE_ID, run, CLAIM);
      return store.getRun(DEFAULT_QUEUE_ID)!;
    },
    async resume(): Promise<WorkflowRun> {
      const current = store.getRun(DEFAULT_QUEUE_ID);
      if (current === null) throw new Error('no Run to resume');
      return store.updateRun(
        DEFAULT_QUEUE_ID,
        {
          runId: current.id,
          allowedStatuses: ['failed'],
          label: 'resume-admission',
          // The admission re-freezes the plan the Run already carries; erasing it would leave the
          // resumed phase with no retry condition to be capped by.
          patch: (run) =>
            resumeAdmissionPatch(run, {
              pipeline: run.pipeline,
              defaultRunnerKind: run.defaultRunnerKind,
              mutationPlan: run.mutationPlan,
              envelope: undefined,
              gitApprovalReceipt: undefined
            })
        },
        CLAIM
      );
    },
    endedPayloads(): Array<Record<string, unknown>> {
      return emitTaskLifecycleAudit.mock.calls
        .filter((call) => call[0] === 'task-execution-ended')
        .map((call) => call[2] as Record<string, unknown>);
    }
  };
}

/** A phase whose retry condition stays truthy until `open_questions` reaches zero. */
const capPhase = (id: string) => ({
  id,
  name: id,
  instruction: id,
  retryCondition: 'open_questions > 0'
});

/**
 * The agent's output for one dispatch, with a sentinel planted everywhere the product reads agent text:
 * the parser's warnings, both stream summaries and the audit block's notes.
 */
function unsatisfied(extra: Partial<PhaseRunOutput> = {}): PhaseRunOutput {
  return {
    result: { kind: 'clean', auditEntry: { metrics: { open_questions: 3 }, notes: SENTINEL } },
    outcome: 'clean',
    terminationReason: 'token',
    stdoutSummary: SENTINEL,
    stderrSummary: SENTINEL,
    exitCode: 0,
    warnings: [SENTINEL],
    auditEntryId: null,
    ...extra
  } as unknown as PhaseRunOutput;
}

function satisfied(): PhaseRunOutput {
  return {
    result: { kind: 'clean', auditEntry: { metrics: { open_questions: 0 } } },
    outcome: 'clean',
    terminationReason: 'token',
    stdoutSummary: '',
    stderrSummary: '',
    exitCode: 0,
    warnings: [],
    auditEntryId: null
  } as unknown as PhaseRunOutput;
}

describe('RunDriver — a cap failure records cap_exhausted and says what a Resume will do (US1)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness(2);
    h.phaseRunner.run.mockResolvedValue(unsatisfied({ stalledCount: 2 }));
  });

  it('persists the cause on the Run in the write that makes it failed', async () => {
    await h.driver.drive(await h.seedRun(), DESCRIPTION);

    const failedWrites = h.persisted.filter((entry) => entry.next.status === 'failed');
    expect(failedWrites).toHaveLength(1);
    expect(failedWrites[0]?.next.failureCause).toBe('cap_exhausted');
    expect(h.store.getRun(DEFAULT_QUEUE_ID)?.failureCause).toBe('cap_exhausted');
    expect(h.persisted.filter((entry) => entry.next.status === 'running').every((entry) => !('failureCause' in entry.next))).toBe(
      true
    );
  });

  it('puts the cause on the terminal event, as the audit projection leaves it', async () => {
    await h.driver.drive(await h.seedRun(), DESCRIPTION);

    const ended = h.endedPayloads();
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ terminalStatus: 'failed', failureCause: 'cap_exhausted' });
    expect(projectAuditPayload('task-execution-ended', ended[0] ?? {}).failureCause).toBe('cap_exhausted');
  });

  it('notifies the builder\'s text for the cap, with the iteration, the cap and the count', async () => {
    await h.driver.drive(await h.seedRun(), DESCRIPTION);

    const expected = failureNotice({
      cause: 'cap_exhausted',
      phase: PHASE,
      taskTitle: DESCRIPTION,
      iteration: 2,
      iterationCap: 2,
      stalledCount: 2
    });
    expect(h.notifier.warn).toHaveBeenCalledTimes(1);
    expect(h.notifier.warn).toHaveBeenCalledWith(expected.message);
    expect(expected.message).toContain('(iteration 2 of 2)');
    expect(expected.message).toContain('unchanged across the last 2 comparisons');
    expect(expected.message).toContain(`"Mark '${DESCRIPTION}' as completed"`);
    expect(h.statusBar.update).toHaveBeenLastCalledWith(expect.any(String), {
      kind: 'failed',
      phase: PHASE,
      detail: FAILURE_CAUSE_LABELS.cap_exhausted
    });
  });

  it('carries nothing the agent wrote: the sentinel appears in no notice, status detail or event (SC-002)', async () => {
    await h.driver.drive(await h.seedRun(), DESCRIPTION);

    const surfaces = [
      JSON.stringify(h.notifier.warn.mock.calls),
      JSON.stringify(h.statusBar.update.mock.calls),
      JSON.stringify(h.endedPayloads()),
      JSON.stringify(projectAuditPayload('task-execution-ended', h.endedPayloads()[0] ?? {})),
      String(h.store.getRun(DEFAULT_QUEUE_ID)?.failureCause),
      JSON.stringify(h.store.getRun(DEFAULT_QUEUE_ID)?.lastError)
    ];
    expect(h.phaseRunner.run).toHaveBeenCalled();
    for (const surface of surfaces) expect(surface).not.toContain('SENTINEL');
  });

  it('names no action that does not exist: no bare Resume, no Retry button, no Show last error', async () => {
    await h.driver.drive(await h.seedRun(), DESCRIPTION);

    const message = String(h.notifier.warn.mock.calls[0]?.[0]);
    expect(message).toContain('"Schegent: Resume Paused or Failed Workflow"');
    for (const fragment of ['"Schegent: Resume"', 'Retry feature', 'Schegent: Resume Queue', 'Show last error']) {
      expect(message.includes(fragment), fragment).toBe(false);
    }
  });

  it('leaves the row\'s last error, the phase-end addendum and the queue error exactly as they were', async () => {
    await h.driver.drive(await h.seedRun(), DESCRIPTION);

    const run = h.store.getRun(DEFAULT_QUEUE_ID);
    expect(run?.lastError).toMatchObject({ code: 'invocation-failed', message: 'cap_exhausted', phase: PHASE });
    expect(h.phaseRunner.appendCapExhaustedPhaseEnd).toHaveBeenCalledTimes(1);
    expect(h.queueFinish).toHaveBeenCalledWith(
      'task-cause-1',
      'failed',
      expect.objectContaining({ code: 'invocation-failed', message: 'cap_exhausted' })
    );
  });

  describe('a Resume (FR-010, User Story 1 scenarios 3 to 5)', () => {
    it('blocker unchanged: the resumed attempt fails at the cap again and emits a second event with its own code', async () => {
      await h.driver.drive(await h.seedRun(), DESCRIPTION);
      const resumed = await h.resume();
      expect(resumed.status).toBe('running');
      expect('failureCause' in resumed).toBe(false);
      // The phase runs again at the iteration it failed on, so it reaches the cap on the next result.
      expect(resumed.currentIteration).toBe(2);

      await h.driver.drive(resumed, DESCRIPTION);

      const ended = h.endedPayloads();
      expect(ended.map((payload) => [payload.terminalStatus, payload.failureCause])).toEqual([
        ['failed', 'cap_exhausted'],
        ['failed', 'cap_exhausted']
      ]);
      expect(h.store.getRun(DEFAULT_QUEUE_ID)?.failureCause).toBe('cap_exhausted');
      expect(h.notifier.warn).toHaveBeenCalledTimes(2);
      // The second failure reports the same position: "iteration 2 of 2", not "after 3 iterations".
      expect(h.notifier.warn.mock.calls[1]?.[0]).toBe(h.notifier.warn.mock.calls[0]?.[0]);
    });

    it('blocker resolved: the resumed attempt advances as before, with no failure notice and no cause', async () => {
      await h.driver.drive(await h.seedRun(), DESCRIPTION);
      const resumed = await h.resume();
      h.notifier.warn.mockClear();
      h.phaseRunner.run.mockResolvedValue(satisfied());

      await h.driver.drive(resumed, DESCRIPTION);

      const finalRun = h.store.getRun(DEFAULT_QUEUE_ID);
      expect(finalRun?.status).toBe('completed');
      expect(finalRun !== null && 'failureCause' in finalRun).toBe(false);
      expect(h.notifier.warn).not.toHaveBeenCalled();
      const ended = h.endedPayloads();
      expect(ended).toHaveLength(2);
      expect(ended[1]).toMatchObject({ terminalStatus: 'completed' });
      expect(ended[1]).not.toHaveProperty('failureCause');
    });
  });
});

/** A phase result that ends with remaining issues, the agent's text planted in every field it can reach. */
function issuesRemain(): PhaseRunOutput {
  return {
    result: {
      kind: 'remaining_issues',
      issues: [{ summary: SENTINEL }],
      auditEntry: null
    },
    outcome: 'issues_remain',
    terminationReason: 'token',
    stdoutSummary: SENTINEL,
    stderrSummary: SENTINEL,
    exitCode: 0,
    warnings: [SENTINEL],
    auditEntryId: null
  } as unknown as PhaseRunOutput;
}

/** A Run parked on its last phase, with an earlier phase before it so the last one is not the first. */
function atLastPhase(lastPhase: string): Partial<WorkflowRun> {
  return {
    currentPhase: lastPhase,
    pipeline: {
      id: 'pipe-last',
      name: 'Last',
      phases: [
        { id: 'implement', name: 'Implement', instruction: 'implement' },
        { id: lastPhase, name: 'Last', instruction: 'finish' }
      ]
    }
  } as unknown as Partial<WorkflowRun>;
}

describe('RunDriver — a last phase that ends with issues records last_phase_issues_remain (US2)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness(5);
    h.phaseRunner.run.mockResolvedValue(issuesRemain());
  });

  it('persists the cause, puts it on the terminal event, and notifies the builder\'s text', async () => {
    await h.driver.drive(await h.seedRun(atLastPhase('finalize')), DESCRIPTION);

    const run = h.store.getRun(DEFAULT_QUEUE_ID);
    expect(run?.status).toBe('failed');
    expect(run?.currentPhase).toBe('finalize');
    expect(run?.failureCause).toBe('last_phase_issues_remain');

    const ended = h.endedPayloads();
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ terminalStatus: 'failed', failureCause: 'last_phase_issues_remain' });
    expect(projectAuditPayload('task-execution-ended', ended[0] ?? {}).failureCause).toBe(
      'last_phase_issues_remain'
    );

    const expected = failureNotice({
      cause: 'last_phase_issues_remain',
      phase: 'finalize',
      taskTitle: DESCRIPTION
    });
    expect(h.notifier.warn).toHaveBeenCalledTimes(1);
    expect(h.notifier.warn).toHaveBeenCalledWith(expected.message);
    expect(h.statusBar.update).toHaveBeenLastCalledWith(expect.any(String), {
      kind: 'failed',
      phase: 'finalize',
      detail: FAILURE_CAUSE_LABELS.last_phase_issues_remain
    });
  });

  it('advises fixing the issues before the Resume, and promises no Show last error (N3.1)', async () => {
    await h.driver.drive(await h.seedRun(atLastPhase('finalize')), DESCRIPTION);

    const message = String(h.notifier.warn.mock.calls[0]?.[0]);
    const fixAt = message.indexOf('Fix the issues first');
    const resumeAt = message.indexOf('"Schegent: Resume Paused or Failed Workflow"');
    expect(fixAt).toBeGreaterThanOrEqual(0);
    expect(resumeAt).toBeGreaterThan(fixAt);
    expect(message).toContain(`"Mark '${DESCRIPTION}' as completed"`);
    for (const fragment of ['"Schegent: Resume"', 'Retry feature', 'Schegent: Resume Queue', 'Show last error']) {
      expect(message.includes(fragment), fragment).toBe(false);
    }
  });

  it('carries nothing the agent wrote (SC-002)', async () => {
    await h.driver.drive(await h.seedRun(atLastPhase('finalize')), DESCRIPTION);

    for (const surface of [
      JSON.stringify(h.notifier.warn.mock.calls),
      JSON.stringify(h.statusBar.update.mock.calls),
      JSON.stringify(h.endedPayloads())
    ]) {
      expect(surface).not.toContain('SENTINEL');
    }
  });

  it('pauses a bugfix verify phase that ends the pipeline: no cause, no terminal event (scenario 4)', async () => {
    await h.driver.drive(await h.seedRun(atLastPhase('bugfix-verify-post')), DESCRIPTION);

    const run = h.store.getRun(DEFAULT_QUEUE_ID);
    expect(run?.status).toBe('paused');
    expect(run?.manualPauseCause).toBe('verify-paused');
    expect(run !== null && 'failureCause' in run).toBe(false);
    expect(h.endedPayloads()).toEqual([]);
    expect(h.persisted.some((entry) => entry.next.status === 'failed')).toBe(false);
  });
});

/** A Run parked on a phase that is NOT the last, so a failure there is decided by the phase alone. */
function atMidPhase(options: { readonly optional?: boolean | undefined } = {}): Partial<WorkflowRun> {
  return {
    currentPhase: PHASE,
    pipeline: {
      id: 'pipe-mid',
      name: 'Mid',
      phases: [
        {
          id: PHASE,
          name: 'Implement',
          instruction: 'implement',
          ...(options.optional === true ? { isRequired: false } : {})
        },
        { id: 'finalize', name: 'Finalize', instruction: 'finish' }
      ]
    }
  } as unknown as Partial<WorkflowRun>;
}

/** What a phase ends with when the agent's text is planted in every field the product reads. */
function ended(
  result: Record<string, unknown>,
  outcome: string,
  terminationReason: string,
  exitCode: number | null = 1
): PhaseRunOutput {
  return {
    result,
    outcome,
    terminationReason,
    stdoutSummary: SENTINEL,
    stderrSummary: SENTINEL,
    exitCode,
    warnings: [],
    auditEntryId: null
  } as unknown as PhaseRunOutput;
}

/** The operator-authored fatal signature text, carrying a secret so redaction would have to act on it. */
const FATAL_SIGNATURE = 'fatal-signature:token=sk-ant-' + 'S'.repeat(24);

const SEQUENCER_ROWS: ReadonlyArray<{
  readonly name: string;
  readonly cause: 'incomplete_turn_unresolved' | 'fatal_signature' | 'phase_timeout' | 'phase_failed';
  readonly output: PhaseRunOutput;
  readonly optional?: boolean;
}> = [
  {
    name: 'C1: an unfinished turn after the dispatch\'s resumes (required phase)',
    cause: 'incomplete_turn_unresolved',
    output: ended(
      { kind: 'incomplete_turn', cause: 'background-work-open', auditEntry: null, warnings: [] },
      'incomplete_turn',
      'incomplete_turn',
      0
    )
  },
  {
    name: 'C1: an unfinished turn on an OPTIONAL phase still fails the Run',
    cause: 'incomplete_turn_unresolved',
    optional: true,
    output: ended(
      { kind: 'incomplete_turn', cause: 'background-work-open', auditEntry: null, warnings: [] },
      'incomplete_turn',
      'incomplete_turn',
      0
    )
  },
  {
    name: 'C2: an operator-authored fatal signature on a required phase',
    cause: 'fatal_signature',
    output: ended(
      { kind: 'malformed', warnings: [FATAL_SIGNATURE], auditEntry: null, fatalCause: FATAL_SIGNATURE },
      'failed',
      'error'
    )
  },
  {
    name: 'C3: the absolute invocation deadline (P1)',
    cause: 'phase_timeout',
    output: ended({ kind: 'malformed', warnings: [], auditEntry: null }, 'failed', 'deadline', null)
  },
  {
    name: 'C4: an idle timeout',
    cause: 'phase_timeout',
    output: ended({ kind: 'malformed', warnings: [], auditEntry: null }, 'timeout', 'timeout', null)
  },
  {
    name: 'C5: a non-zero exit with no signature',
    cause: 'phase_failed',
    output: ended({ kind: 'malformed', warnings: [], auditEntry: null }, 'failed', 'error', 2)
  }
];

describe('RunDriver — every sequencer failure keeps its own cause (US3, census C1 to C5)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness(5);
  });

  it.each(SEQUENCER_ROWS)('$name', async ({ cause, output, optional }) => {
    h.phaseRunner.run.mockResolvedValue(output);
    await h.driver.drive(await h.seedRun(atMidPhase({ optional })), DESCRIPTION);

    const run = h.store.getRun(DEFAULT_QUEUE_ID);
    expect(run?.status).toBe('failed');
    expect(run?.failureCause).toBe(cause);

    const events = h.endedPayloads();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ terminalStatus: 'failed', failureCause: cause });
    const projected = projectAuditPayload('task-execution-ended', events[0] ?? {});
    expect(projected.failureCause).toBe(cause);

    const expected = failureNotice({ cause, phase: PHASE });
    expect(h.notifier.warn).toHaveBeenCalledTimes(1);
    expect(h.notifier.warn).toHaveBeenCalledWith(expected.message);
    expect(h.statusBar.update).toHaveBeenLastCalledWith(expect.any(String), {
      kind: 'failed',
      phase: PHASE,
      detail: FAILURE_CAUSE_LABELS[cause]
    });
  });

  it('a fatal signature\'s text appears in no notice, status detail, projected event or cause (FR-023, FR-025)', async () => {
    h.phaseRunner.run.mockResolvedValue(SEQUENCER_ROWS[2]!.output);
    await h.driver.drive(await h.seedRun(atMidPhase()), DESCRIPTION);

    // The row's last error carries the signature by design and is unchanged (N5.1); the surfaces this
    // feature adds or builds must not.
    const surfaces = [
      JSON.stringify(h.notifier.warn.mock.calls),
      JSON.stringify(h.statusBar.update.mock.calls),
      JSON.stringify(projectAuditPayload('task-execution-ended', h.endedPayloads()[0] ?? {})),
      String(h.store.getRun(DEFAULT_QUEUE_ID)?.failureCause)
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain('SENTINEL');
      expect(surface).not.toContain('sk-ant');
      expect(surface).not.toContain('fatal-signature');
    }
  });

  it('a completed Run, its event and its rollup input carry no cause', async () => {
    h.phaseRunner.run.mockResolvedValue(satisfied());
    await h.driver.drive(
      await h.seedRun({ pipeline: { id: 'pipe-one', name: 'One', phases: [capPhase(PHASE)] } } as unknown as Partial<WorkflowRun>),
      DESCRIPTION
    );

    const run = h.store.getRun(DEFAULT_QUEUE_ID);
    expect(run?.status).toBe('completed');
    expect(run !== null && 'failureCause' in run).toBe(false);
    const events = h.endedPayloads();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ terminalStatus: 'completed' });
    expect(events[0]).not.toHaveProperty('failureCause');
    expect(projectAuditPayload('task-execution-ended', events[0] ?? {})).not.toHaveProperty('failureCause');
    expect(h.notifier.warn).not.toHaveBeenCalled();
  });
});

/** A Run with an unprobed backend: no phase finished, iteration 0, so the start-of-run probe applies. */
function unprobedRun(): Partial<WorkflowRun> {
  return {
    currentPhase: 'plan',
    pipeline: {
      id: 'pipe-probe',
      name: 'Probe',
      phases: [{ id: 'plan', name: 'Plan', instruction: 'plan', runner: 'codex' }]
    }
  } as unknown as Partial<WorkflowRun>;
}

describe('RunDriver — a run that fails before its first phase keeps its own cause (US5, census C8 and C9)', () => {
  /** The probe is skipped under `NODE_ENV=test`; the existing probe suite sets it the same way. */
  async function withProbeEnabled(work: () => Promise<void>): Promise<void> {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      await work();
    } finally {
      process.env.NODE_ENV = original;
    }
  }

  it('C8: a failed runner probe persists runner_probe_failed, emits the terminal event, and names the runner kind', async () => {
    const h = await makeHarness(5);
    h.probeAvailability.mockResolvedValue(false);
    await withProbeEnabled(async () => {
      await h.driver.drive(await h.seedRun(unprobedRun()), DESCRIPTION);
    });

    const run = h.store.getRun(DEFAULT_QUEUE_ID);
    expect(run?.status).toBe('failed');
    expect(run?.failureCause).toBe('runner_probe_failed');
    expect(h.phaseRunner.run).not.toHaveBeenCalled();

    const events = h.endedPayloads();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ terminalStatus: 'failed', failureCause: 'runner_probe_failed' });
    expect(projectAuditPayload('task-execution-ended', events[0] ?? {}).failureCause).toBe('runner_probe_failed');

    const expected = failureNotice({ cause: 'runner_probe_failed', runnerKind: 'codex' });
    expect(h.notifier.warn).toHaveBeenCalledTimes(1);
    expect(h.notifier.warn).toHaveBeenCalledWith(expected.message);
    expect(expected.message).toContain('the codex CLI is missing or does not start');
    expect(expected.message).toContain('the resume checks the CLI again');
    expect(h.statusBar.update).toHaveBeenLastCalledWith(expect.any(String), {
      kind: 'failed',
      phase: 'plan',
      detail: FAILURE_CAUSE_LABELS.runner_probe_failed
    });
  });

  it('C8: the notice names no phase, iteration or cap, and the probe\'s own records are unchanged (N5.1)', async () => {
    const h = await makeHarness(5);
    h.probeAvailability.mockResolvedValue(false);
    await withProbeEnabled(async () => {
      await h.driver.drive(await h.seedRun(unprobedRun()), DESCRIPTION);
    });

    const message = String(h.notifier.warn.mock.calls[0]?.[0]);
    expect(message).not.toMatch(/iteration|cap\b|speckit|\bplan\b/i);
    expect(h.appendRunnerProbeFailedAudit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run-cause-1' }),
      expect.objectContaining({
        runnerKind: 'codex',
        errorMessage: 'Runner probe failed for codex: CLI executable is unavailable or invalid.'
      })
    );
    expect(h.store.getRun(DEFAULT_QUEUE_ID)?.lastError).toMatchObject({
      code: 'runner-probe-failed',
      message: 'Runner probe failed for codex: CLI executable is unavailable or invalid.'
    });
    expect(h.queueFinish).toHaveBeenCalledWith(
      'task-cause-1',
      'failed',
      expect.objectContaining({ code: 'runner-probe-failed' })
    );
  });

  it('C9: missing audit evidence persists audit_evidence_unavailable, emits no terminal event, and completes the Run', async () => {
    const h = await makeHarness(5, { isAuditEvidenceAvailable: () => false });
    await h.driver.drive(await h.seedRun(), DESCRIPTION);

    const run = h.store.getRun(DEFAULT_QUEUE_ID);
    expect(run?.status).toBe('failed');
    expect(run?.failureCause).toBe('audit_evidence_unavailable');
    expect(h.endedPayloads()).toEqual([]);
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.complete.mock.calls[0]?.[0]).toMatchObject({ status: 'failed', failureCause: 'audit_evidence_unavailable' });

    const expected = failureNotice({ cause: 'audit_evidence_unavailable' });
    expect(h.notifier.warn).toHaveBeenCalledTimes(1);
    expect(h.notifier.warn).toHaveBeenCalledWith(expected.message);
    // Today's text, unchanged.
    expect(expected.message).toBe(
      'Schegent: execution stopped because required structured audit evidence is unavailable. Resolve the evidence sink and reload the workspace before resuming.'
    );
    expect(h.statusBar.update).toHaveBeenLastCalledWith(expect.any(String), {
      kind: 'failed',
      phase: PHASE,
      detail: FAILURE_CAUSE_LABELS.audit_evidence_unavailable
    });
  });

  it('C9: the notice names no phase, iteration or cap, and the row\'s last error is unchanged (N5.1)', async () => {
    const h = await makeHarness(5, { isAuditEvidenceAvailable: () => false });
    await h.driver.drive(await h.seedRun(), DESCRIPTION);

    expect(String(h.notifier.warn.mock.calls[0]?.[0])).not.toMatch(/iteration|cap\b|implement/i);
    expect(h.store.getRun(DEFAULT_QUEUE_ID)?.lastError).toMatchObject({
      code: 'audit-evidence-unavailable',
      message: 'Required structured audit evidence is unavailable.'
    });
    expect(h.queueFinish).toHaveBeenCalledWith(
      'task-cause-1',
      'failed',
      expect.objectContaining({ code: 'audit-evidence-unavailable' })
    );
  });
});
