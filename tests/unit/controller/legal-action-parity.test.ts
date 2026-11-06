// FR-R5-F19 (spec 278, T19.2, US2, FR-010 to FR-012; T020) — which recovery actions are legal in which
// Run state, asked of every authority that decides it.
//
// Four authorities answer "may this action run now?", and nothing has required them to agree:
//   - `decidePhaseControl`           Resume, Restart, Skip, Disable, Enable (host, over the whole Run)
//   - `decideTaskTransition`         Retry of the task row (`return-to-pending`; host, over the row status)
//   - `phaseControlEligibility`      what the sidebar offers (webview mirror, over projected props)
//   - `admitResumeCandidate`         what the palette's retry-active-run admits (host, over the Run)
//
// The host deciders are authoritative. The expectations below are the host's answer, written as data, and
// every other authority is asserted against it, so a mirror that offers a refused action (or hides a legal
// one) is a red cell and not a silent disagreement. Nothing in this file edits a decider: a red cell is a
// finding for T021, which corrects the non-authoritative side only.
//
// Seeded from the T018 characterization (`specs/278-blocked-work-handoff-recovery/measurements.md`).
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PhaseControlService } from '../../../src/controller/phase-control-service';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import { decidePhaseControl, type PhaseControlOperation } from '../../../src/controller/phase-control-decision';
import { decideTaskTransition } from '../../../src/queue/task-transition-decision';
import type { FeatureRequestStatus } from '../../../src/queue/feature-request';
import { runRetryActiveRun } from '../../../src/commands/retry-active-run';
import { admitResumeCandidate } from '../../../src/services/resume-admission-guard';
import type { WorkflowRun } from '../../../src/state/workflow-run';

const PHASE_PLAN = 'plan';
const PHASE_BUILD = 'build';
const PHASE_SHIP = 'ship';
const QUEUE_ID = 'queue-278';
const MANUAL_PAUSE_AT_MS = Date.parse('2026-11-06T00:00:00Z');

interface EligibilityInput {
  readonly isPrimary: boolean;
  readonly targetsSubjectRun: boolean;
  readonly currentPhase: string | null;
  readonly activeTaskId: string | null;
  readonly activeRunId: string | null;
  readonly manualPauseAt: string | null;
  readonly selectedPhase: string | null;
  readonly selectedPhaseState: 'not-started' | 'disabled' | 'active' | 'completed' | 'skipped' | null;
  readonly selectedPhaseIsFuture: boolean;
  readonly phaseOverrides: readonly { readonly phaseId: string }[];
  readonly phaseBreakpoints: readonly { readonly phaseId: string }[];
}
interface Eligibility {
  readonly resumeDisabled: boolean;
  readonly restartDisabled: boolean;
  readonly skipDisabled: boolean;
  readonly disableDisabled: boolean;
  readonly enableDisabled: boolean;
}
let phaseControlEligibility: (input: EligibilityInput) => Eligibility;

beforeAll(async () => {
  const mod = (await import('../../../webview-ui/src/lib/phase-control-eligibility.js')) as {
    phaseControlEligibility: (input: EligibilityInput) => Eligibility;
  };
  phaseControlEligibility = mod.phaseControlEligibility;
});

type Action = 'Resume' | 'Restart' | 'Retry' | 'Skip' | 'Disable' | 'Enable';
const ACTIONS: readonly Action[] = ['Resume', 'Restart', 'Retry', 'Skip', 'Disable', 'Enable'];

/** `legal`, or `refused(<reason>)` with the reason the authoritative decider gives. */
type Cell = 'legal' | `refused(${string})`;

function baseRun(overrides: Partial<WorkflowRun>): WorkflowRun {
  return {
    id: 'run-278',
    featureId: 'task-278',
    featureDir: '',
    status: 'running',
    currentPhase: PHASE_BUILD,
    currentIteration: 2,
    startedAt: 1,
    lastTransitionAt: 2,
    phasesCompleted: [],
    lastError: null,
    pipeline: {
      id: 'parity-flow',
      name: 'Parity Flow',
      phases: [
        { id: PHASE_PLAN, name: 'Plan', instruction: 'Plan it.' },
        { id: PHASE_BUILD, name: 'Build', instruction: 'Build it.' },
        { id: PHASE_SHIP, name: 'Ship', instruction: 'Ship it.' }
      ]
    },
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    creditPause: null,
    ...overrides
  } as unknown as WorkflowRun;
}

function phaseResult(phase: string) {
  return {
    phase,
    iteration: 1,
    startedAt: 1,
    endedAt: 2,
    result: 'succeeded',
    terminationReason: 'exit',
    exitCode: 0,
    stdoutSummary: '',
    stderrSummary: '',
    auditEntryId: null
  };
}

interface RunState {
  readonly id: string;
  readonly describe: string;
  readonly run: () => WorkflowRun;
  /** The status of the queue row that holds this Run. */
  readonly rowStatus: FeatureRequestStatus;
  readonly expected: Readonly<Record<Action, Cell>>;
}

/**
 * Resume, Restart and Skip address the Run's current Phase; Disable and Enable address `ship`, the Phase the
 * runner has not reached. The cells are the authoritative host answers, read from `phase-control-decision.ts`
 * and `task-transition-decision.ts` (T018), not what the surface currently offers.
 */
const STATES: readonly RunState[] = [
  {
    id: 'failed',
    describe: 'failed Run, no pause recorded',
    run: () => baseRun({ status: 'failed', lastError: { code: 'phase-failed', message: 'phase build exited 1', phase: PHASE_BUILD, iteration: 1, at: 1 } }),
    rowStatus: 'failed',
    expected: {
      Resume: 'refused(run-not-paused)',
      Restart: 'legal',
      Retry: 'legal',
      Skip: 'refused(run-failed)',
      Disable: 'legal',
      Enable: 'refused(no-disabled-override)'
    }
  },
  {
    id: 'manually-paused',
    describe: 'Run paused by the operator',
    run: () => baseRun({ status: 'paused', manualPauseAt: MANUAL_PAUSE_AT_MS, manualPauseCause: 'operator-paused' }),
    rowStatus: 'paused',
    expected: {
      Resume: 'legal',
      Restart: 'legal',
      Retry: 'legal',
      Skip: 'legal',
      Disable: 'legal',
      Enable: 'refused(no-disabled-override)'
    }
  },
  {
    id: 'retry-countdown',
    describe: 'Run paused in a delayed-retry countdown',
    run: () => baseRun({ status: 'paused', pendingRetryAt: 4_000_000_000_000, pendingRetryCause: 'transient_error' }),
    rowStatus: 'in-flight',
    expected: {
      Resume: 'legal',
      Restart: 'legal',
      Retry: 'refused(illegal-source-status)',
      Skip: 'legal',
      Disable: 'legal',
      Enable: 'refused(no-disabled-override)'
    }
  },
  {
    id: 'credit-paused',
    describe: 'Run paused for credits',
    run: () => baseRun({ status: 'paused', creditPause: { pausedAt: 1, windowStartedAt: 2, stoppedAt: 3 } }),
    rowStatus: 'paused',
    expected: {
      Resume: 'legal',
      Restart: 'legal',
      Retry: 'legal',
      Skip: 'legal',
      Disable: 'legal',
      Enable: 'refused(no-disabled-override)'
    }
  },
  {
    id: 'in-flight',
    describe: 'Run executing',
    run: () => baseRun({ status: 'running' }),
    rowStatus: 'in-flight',
    expected: {
      Resume: 'refused(run-not-paused)',
      Restart: 'legal',
      Retry: 'refused(illegal-source-status)',
      Skip: 'legal',
      Disable: 'legal',
      Enable: 'refused(no-disabled-override)'
    }
  },
  {
    id: 'completed',
    describe: 'completed Run (every Phase reached)',
    run: () =>
      baseRun({
        status: 'completed',
        phasesCompleted: [phaseResult(PHASE_PLAN), phaseResult(PHASE_BUILD), phaseResult(PHASE_SHIP)] as never
      }),
    rowStatus: 'completed',
    expected: {
      Resume: 'refused(run-not-paused)',
      Restart: 'refused(run-terminal)',
      Retry: 'refused(illegal-source-status)',
      Skip: 'refused(run-terminal)',
      Disable: 'refused(phase-already-started)',
      Enable: 'refused(no-disabled-override)'
    }
  },
  {
    id: 'legacy-pending-retry-on-failed',
    describe: 'legacy Run: failed, with a retry timer still recorded',
    run: () => baseRun({ status: 'failed', pendingRetryAt: 4_000_000_000_000, pendingRetryCause: 'transient_error' }),
    rowStatus: 'failed',
    expected: {
      // Read, not decided: the host reads the recorded timer and no status, so it admits Resume here.
      Resume: 'legal',
      Restart: 'legal',
      Retry: 'legal',
      Skip: 'refused(run-failed)',
      Disable: 'legal',
      Enable: 'refused(no-disabled-override)'
    }
  }
];

function cellOfDecision(
  decision: { eligible: true } | { eligible: false; reason: string }
): Cell {
  return decision.eligible ? 'legal' : (`refused(${decision.reason})` as const);
}

const PHASE_OPERATION: Readonly<Record<Exclude<Action, 'Retry'>, PhaseControlOperation>> = {
  Resume: 'resume',
  Restart: 'restart',
  Skip: 'skip',
  Disable: 'disable',
  Enable: 'enable'
};

function hostCell(state: RunState, action: Action): Cell {
  if (action === 'Retry') {
    return cellOfDecision(
      decideTaskTransition({
        operation: 'return-to-pending',
        currentStatus: state.rowStatus,
        queueAlreadyHasDifferentInFlight: false
      })
    );
  }
  const targetPhaseId = action === 'Disable' || action === 'Enable' ? PHASE_SHIP : PHASE_BUILD;
  return cellOfDecision(decidePhaseControl({ operation: PHASE_OPERATION[action], run: state.run(), targetPhaseId }));
}

/**
 * The sidebar's answer for a Run, as a primary window, fed what `RunDetailTier` feeds the menu: the surface
 * is about the Run only while its row is `in-flight` (`isExecuting`), so a `paused`, `failed` or `completed`
 * row is off target and every control is disabled by construction (FR-R4-F20 pins this for a failed row).
 */
function mirrorEnabled(state: RunState, action: Exclude<Action, 'Retry'>): boolean {
  const run = state.run();
  const operable = run.status === 'running' || run.status === 'paused' || run.status === 'failed';
  const shipState = run.phasesCompleted.some((entry) => entry.phase === PHASE_SHIP) ? 'completed' : 'not-started';
  const eligibility = phaseControlEligibility({
    isPrimary: true,
    targetsSubjectRun: state.rowStatus === 'in-flight',
    currentPhase: operable ? run.currentPhase : null,
    activeTaskId: run.featureId,
    activeRunId: run.id,
    // The snapshot projects the stored epoch milliseconds to an ISO string; the mirror reads that string.
    manualPauseAt: run.manualPauseAt === null ? null : new Date(run.manualPauseAt).toISOString(),
    selectedPhase: PHASE_SHIP,
    selectedPhaseState: shipState,
    selectedPhaseIsFuture: shipState === 'not-started',
    phaseOverrides: run.phaseOverrides,
    phaseBreakpoints: run.phaseBreakpoints
  });
  const disabled: Readonly<Record<Exclude<Action, 'Retry'>, boolean>> = {
    Resume: eligibility.resumeDisabled,
    Restart: eligibility.restartDisabled,
    Skip: eligibility.skipDisabled,
    Disable: eligibility.disableDisabled,
    Enable: eligibility.enableDisabled
  };
  return !disabled[action];
}

describe('control: the matrix is not vacuous', () => {
  it('names every state and every action, and holds both a legal and a refused cell', () => {
    expect(STATES.length).toBeGreaterThanOrEqual(7);
    const cells = STATES.flatMap((state) => ACTIONS.map((action) => state.expected[action]));
    expect(cells).toHaveLength(STATES.length * ACTIONS.length);
    expect(cells).toContain('legal');
    expect(cells.some((cell) => cell.startsWith('refused('))).toBe(true);
  });

  it('can fail: a wrong expectation is detected by the same comparison', () => {
    const failed = STATES.find((state) => state.id === 'failed')!;
    expect(hostCell(failed, 'Resume')).not.toBe('legal');
  });
});

describe('the host deciders answer the table (the authoritative side)', () => {
  for (const state of STATES) {
    for (const action of ACTIONS) {
      it(`${state.describe}: ${action} is ${state.expected[action]}`, () => {
        expect(hostCell(state, action)).toBe(state.expected[action]);
      });
    }
  }

  it('Skip is legal on a manually paused Run and refused on a failed one', () => {
    const paused = STATES.find((state) => state.id === 'manually-paused')!;
    const failed = STATES.find((state) => state.id === 'failed')!;
    expect(hostCell(paused, 'Skip')).toBe('legal');
    expect(hostCell(failed, 'Skip')).toBe('refused(run-failed)');
  });
});

type PhaseControlAction = Exclude<Action, 'Retry'>;
const PHASE_CONTROL_ACTIONS = ACTIONS.filter(
  (candidate): candidate is PhaseControlAction => candidate !== 'Retry'
);

/**
 * Cells the host admits on an in-flight row that the Phase-control menu deliberately does not offer, each
 * with the decision behind it (FR-011, FR-033). A cell listed here must be a real exclusion: a stale entry
 * fails below.
 *
 * OD-1, decided 2026-11-06 (spec 278 measurements.md): during a delayed-retry countdown the host admits
 * Resume (a recorded `pendingRetryAt`), and the menu offers "Retry now" only. Both end the same countdown
 * and start the same Phase, so a second button would be two names for one effect. The menu still offers
 * Resume once the operator has paused the Run (`manualPauseAt`, `phase-control-eligibility.ts`).
 */
const PHASE_MENU_DECIDED_EXCLUSIONS: Readonly<Record<string, string>> = {
  'retry-countdown:Resume': 'OD-1'
};

function gapKey(state: RunState, action: PhaseControlAction): string {
  return `${state.id}:${action}`;
}

/**
 * What the menu should offer: only an executing (`in-flight`) row is the surface's subject, so a `paused`,
 * `failed` or `completed` row offers nothing here (its recovery is the row's Retry, which the host admits
 * from `failed` and `paused` alike) and an in-flight row offers what the host admits less the decided exclusions.
 */
function expectedOffered(state: RunState, action: PhaseControlAction): boolean {
  if (state.rowStatus !== 'in-flight') return false;
  if (gapKey(state, action) in PHASE_MENU_DECIDED_EXCLUSIONS) return false;
  return state.expected[action] === 'legal';
}

describe('the sidebar never offers more than the host admits', () => {
  for (const state of STATES) {
    for (const action of PHASE_CONTROL_ACTIONS) {
      it(`${state.describe}: ${action}`, () => {
        if (mirrorEnabled(state, action)) expect(state.expected[action]).toBe('legal');
      });
    }
  }

  it('can fail: a Run the host refuses Skip on is not offered it, and the check compares the two', () => {
    const failed = STATES.find((state) => state.id === 'failed')!;
    expect(hostCell(failed, 'Skip')).toBe('refused(run-failed)');
    expect(mirrorEnabled(failed, 'Skip')).toBe(false);
  });
});

describe('the sidebar offers what the host admits on the executing Run, less the decided exclusions', () => {
  for (const state of STATES) {
    for (const action of PHASE_CONTROL_ACTIONS) {
      it(`${state.describe}: ${action} is ${expectedOffered(state, action) ? 'offered' : 'not offered'}`, () => {
        expect(mirrorEnabled(state, action)).toBe(expectedOffered(state, action));
      });
    }
  }

  it('every decided exclusion is a real one: the host admits the cell and the menu does not offer it', () => {
    const keys = Object.keys(PHASE_MENU_DECIDED_EXCLUSIONS);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const [stateId, action] = key.split(':') as [string, PhaseControlAction];
      const state = STATES.find((candidate) => candidate.id === stateId);
      expect(state, key).toBeDefined();
      expect(state!.rowStatus, key).toBe('in-flight');
      expect(state!.expected[action], key).toBe('legal');
      expect(mirrorEnabled(state!, action), key).toBe(false);
    }
  });

  it('an off-target row (paused, failed, completed) offers none of the five controls', () => {
    const offTarget = STATES.filter((state) => state.rowStatus !== 'in-flight');
    expect(offTarget.length).toBeGreaterThanOrEqual(3);
    for (const state of offTarget) {
      for (const action of PHASE_CONTROL_ACTIONS) {
        expect(mirrorEnabled(state, action), `${state.id}:${action}`).toBe(false);
      }
    }
  });
});

describe('the palette retry-active-run resumes a Run only where the table says its row can be retried or resumed', () => {
  /** Runs the real command over one stored Run and reports whether it asked the controller to resume it. */
  async function paletteResumes(run: WorkflowRun): Promise<boolean> {
    const resumeExisting = vi.fn(async () => true);
    const ctx = {
      store: { getRunMap: () => ({ [QUEUE_ID]: run }) },
      controller: { resumeExisting },
      queue: { hasInFlight: () => true, list: () => [], retry: vi.fn() },
      history: { list: () => [] },
      descriptions: { read: vi.fn() },
      lock: { hasPrimacy: async () => true },
      guarded: { scheduleOrEnqueue: vi.fn() },
      notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    };
    await runRetryActiveRun(undefined, ctx as unknown as Parameters<typeof runRetryActiveRun>[1]);
    return resumeExisting.mock.calls.length > 0;
  }

  /** A failed or paused Run is resumed in place; a running or finished one is not the palette's target. */
  const PALETTE_RESUMES: Readonly<Record<string, boolean>> = {
    failed: true,
    'manually-paused': true,
    'retry-countdown': true,
    'credit-paused': true,
    'in-flight': false,
    completed: false,
    'legacy-pending-retry-on-failed': true
  };

  it('control: the table names a palette answer for every state', () => {
    expect(Object.keys(PALETTE_RESUMES).sort()).toEqual(STATES.map((state) => state.id).sort());
  });

  for (const state of STATES) {
    it(`${state.describe}: the palette ${PALETTE_RESUMES[state.id] ? 'resumes' : 'does not resume'} it`, async () => {
      await expect(paletteResumes(state.run())).resolves.toBe(PALETTE_RESUMES[state.id]);
    });
  }

  it('the guard it relies on refuses an ended Run and admits a failed one', async () => {
    const deps = (run: WorkflowRun) => ({
      getRun: (_queueId: string) => run,
      isDriving: () => false,
      isClosed: () => false,
      liveness: {} as never,
      appendAudit: async () => undefined,
      notify: () => undefined
    });
    const failed = STATES.find((state) => state.id === 'failed')!;
    const completed = STATES.find((state) => state.id === 'completed')!;
    await expect(admitResumeCandidate(deps(failed.run()), QUEUE_ID)).resolves.toMatchObject({ admitted: true });
    await expect(admitResumeCandidate(deps(completed.run()), QUEUE_ID)).resolves.toMatchObject({
      admitted: false,
      refusal: 'run-ended'
    });
  });
});

describe('two surfaces issuing the same action at once admit exactly one', () => {
  /**
   * A store whose `updateRun` runs one patch at a time against the state the previous patch left, as the real
   * per-queue update chain does. Both calls read the same paused snapshot before either writes; only the
   * re-check inside the chain can tell them apart.
   */
  function makeSerialService(initial: WorkflowRun) {
    let current = initial;
    let tail: Promise<unknown> = Promise.resolve();
    const resumeExisting = vi.fn(async () => true);
    const updateRun = vi.fn(
      (_queueId: string, update: { patch: (run: WorkflowRun) => Partial<WorkflowRun> }): Promise<WorkflowRun> => {
        const next = tail.then(() => {
          current = { ...current, ...update.patch(current) };
          return current;
        });
        tail = next.catch(() => undefined);
        return next;
      }
    );
    const service = new PhaseControlService({
      store: {
        getRun: vi.fn(() => initial),
        updateRun,
        getQueue: vi.fn(() => null),
        setWatchdog: vi.fn(async () => {}),
        runCommitClaim: vi.fn(() => unfencedCommit('test-fixture'))
      },
      queue: {
        cascadedPause: vi.fn(async () => {}),
        cascadedResume: vi.fn(async () => {}),
        setQueuePausedState: vi.fn(async () => {})
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      retryCoordinator: { cancelPendingTimer: vi.fn() },
      isDriving: vi.fn(() => false),
      noteActivePhaseOverrideAbort: vi.fn(),
      armIsContinue: vi.fn(),
      cancelActive: vi.fn(),
      resumeExisting,
      auditor: {
        appendPhaseControl: vi.fn(async () => {}),
        emitTaskPaused: vi.fn(async () => {}),
        emitPhaseJumped: vi.fn(async () => {}),
        appendBreakpoint: vi.fn(async () => {})
      }
    } as unknown as ConstructorParameters<typeof PhaseControlService>[0]);
    return { service, resumeExisting };
  }

  it('control: a single Resume of a manually paused Run is admitted', async () => {
    const paused = STATES.find((state) => state.id === 'manually-paused')!;
    const { service } = makeSerialService(paused.run());
    await expect(service.resumeActivePhase(QUEUE_ID)).resolves.toEqual({ ok: true });
  });

  it('admits one of two simultaneous Resumes and refuses the other as run-not-paused', async () => {
    const paused = STATES.find((state) => state.id === 'manually-paused')!;
    const { service, resumeExisting } = makeSerialService(paused.run());

    const results = await Promise.all([service.resumeActivePhase(QUEUE_ID), service.resumeActivePhase(QUEUE_ID)]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: 'run-not-paused' }]);
    await vi.waitFor(() => expect(resumeExisting).toHaveBeenCalledTimes(1));
  });
});
