// Feature 201 (T006-T009, US2) — the surface and the host, asked the same
// question about the same Phase.
//
// Two independent things decide whether a phase control may be used. The
// webview decides whether to offer it (`phaseControlEligibility`, which sees
// only the projected tile); the host decides whether to honour it
// (`decidePhaseControl`, which sees the whole `WorkflowRun`). Nothing has ever
// required them to agree, and they do not: for a Phase the runner reached and
// bypassed under a disable override, the surface offers Enable and the host
// refuses it with `phase-not-future`. The operator clicks a live control and
// gets a refusal.
//
// This file asks both deciders about the same seven Phases and pins **specific
// values on each side** — never that the two merely agree. Two sides wrong in
// the same direction agree perfectly, so an equality assertion here would be
// satisfied by exactly the defect it was written to catch (FR-013, and
// `contracts/phase-tile-projection.md` C8).
//
// Each row's tile comes out of the real `buildPhasesFromRun`. No `PhaseTile` is
// hand-authored anywhere in this file: a hand-built tile can assert agreement
// about a tile the product never emits, which is the same vacuity wearing a
// different hat (`contracts/phase-tile-projection.md` C9).
//
// **A Phase carrying a `remove` override has no row here, and that is not an
// omission.** `phase-projector.ts:56` filters removed Phases out of the tile
// list before any state pass runs, so the projector never emits a tile for one.
// With no tile there is no `selectedPhaseState` for the surface to read and
// nothing for either decider to be asked about — the row would have to
// hand-author the tile it claims to be testing, which T007 forbids for the
// reason above. The absence is the correct modelling of FR-016, not a gap.
//
// One row is expected to fail when this file first lands. See the R3 note in
// the row table below.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  decidePhaseControl,
  type PhaseControlRejectionReason
} from '../../src/controller/phase-control-decision';
import type { PhaseResult, WorkflowRun } from '../../src/state/workflow-run';
import { buildPhasesFromRun } from '../../src/ui/sidebar/phase-projector';
import type { PhaseTile } from '../../src/ui/sidebar/snapshot';

/**
 * The webview module is loaded by `.js` specifier through a dynamic `import()`,
 * exactly as `snapshot-mirror-structural-parity.test.ts:115` and
 * `action-key-parity.test.ts:116` already load their webview halves. Nothing
 * moves to make this test possible (FR-037): both deciders are imported where
 * they already live.
 */
interface EligibilityInput {
  readonly isPrimary: boolean;
  readonly targetsSubjectRun: boolean;
  readonly currentPhase: string | null;
  readonly activeTaskId: string | null;
  readonly activeRunId: string | null;
  readonly manualPauseAt: string | null;
  readonly selectedPhase: string | null;
  readonly selectedPhaseState: PhaseTile['state'] | null;
  readonly selectedPhaseIsFuture: boolean;
  readonly phaseOverrides: readonly { readonly phaseId: string }[];
  readonly phaseBreakpoints: readonly { readonly phaseId: string }[];
}
interface Eligibility {
  readonly enableDisabled: boolean;
  readonly disableDisabled: boolean;
}
let phaseControlEligibility: (input: EligibilityInput) => Eligibility;

const PHASE_PLAN = 'plan';
const PHASE_BUILD = 'build';
const PHASE_SHIP = 'ship';
const OVERRIDE_AT = '2026-09-05T00:00:00Z';

function completion(phase: string, result: PhaseResult['result']): PhaseResult {
  return {
    phase: phase as PhaseResult['phase'],
    iteration: 1,
    startedAt: 1,
    endedAt: 2,
    result,
    terminationReason: 'exit' as PhaseResult['terminationReason'],
    exitCode: 0,
    stdoutSummary: '',
    stderrSummary: '',
    auditEntryId: null
  };
}

function disabledOverride(phaseId: string): { phaseId: string; action: string; at: string } {
  return { phaseId, action: 'disabled', at: OVERRIDE_AT };
}

/**
 * A three-Phase Run sitting on the middle Phase. `plan` is behind it, `ship` is
 * ahead of it, so a single base fixture reaches every origin in
 * `data-model.md` §2 by naming a different target Phase and adding at most one
 * override or one completion record.
 */
function baseRun(): WorkflowRun {
  return {
    id: 'run-201-parity',
    featureId: '201-phase-override-way-back',
    featureDir: '/workspace/specs/201-phase-override-way-back',
    status: 'running',
    currentPhase: PHASE_BUILD,
    currentIteration: 1,
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
    resumeTargetPhaseId: null
  } as unknown as WorkflowRun;
}

/** What one decider arm is expected to answer: eligible, or a named reason. */
type ExpectedDecision = 'ELIGIBLE' | PhaseControlRejectionReason;

interface Row {
  readonly id: string;
  readonly origin: string;
  readonly target: string;
  readonly run: () => WorkflowRun;
  readonly state: PhaseTile['state'];
  readonly enableDisabled: boolean;
  readonly classifierEnable: ExpectedDecision;
  readonly disableDisabled: boolean;
  readonly classifierDisable: ExpectedDecision;
}

/**
 * The seven origins of `data-model.md` §2, each asserted at a specific value on
 * both sides.
 *
 * Every `enableDisabled` below is the answer the surface **must** give. Six of
 * them are the answer it already gives. **R3's is not**: today the surface
 * answers `false` there — Enable offered — while the host answers
 * `phase-not-future`. R3 is therefore red until the surface conjunct lands, and
 * that red is the point (sequencing rule 1). The other six passing is this
 * harness's soundness control: a harness where everything passed from the start
 * would prove only that it had been written to pass.
 */
const ROWS: readonly Row[] = [
  {
    id: 'R1',
    origin: 'never reached',
    target: PHASE_SHIP,
    run: baseRun,
    state: 'not-started',
    // No override at all, so Enable has nothing to re-enable.
    enableDisabled: true,
    classifierEnable: 'no-disabled-override',
    // The one row where Disable is genuinely offered, on both sides.
    disableDisabled: false,
    classifierDisable: 'ELIGIBLE'
  },
  {
    id: 'R2',
    origin: 'future, carrying a disable override',
    target: PHASE_SHIP,
    run: () => {
      const run = baseRun();
      (run as { phaseOverrides: unknown[] }).phaseOverrides = [disabledOverride(PHASE_SHIP)];
      return run;
    },
    state: 'disabled',
    // The case Enable exists for: a Phase still ahead of the runner, disabled,
    // and re-enableable. Offered by the surface, accepted by the host.
    enableDisabled: false,
    classifierEnable: 'ELIGIBLE',
    // A standing divergence, recorded rather than fixed (data-model.md §2, note
    // 1): the surface withholds Disable because the tile is already `disabled`,
    // while the host's `disable` arm only asks whether the Phase is future and
    // so would accept a redundant Disable. The surface is STRICTER than the
    // host, never wider, so C1 holds; FR-010 forbids changing Disable's
    // availability to close it. Asserting each side separately is what lets
    // this row be stated at all.
    disableDisabled: true,
    classifierDisable: 'ELIGIBLE'
  },
  {
    id: 'R3',
    origin: 'reached and bypassed, disable override still set',
    target: PHASE_PLAN,
    run: () => {
      const run = baseRun();
      (run as { phaseOverrides: unknown[] }).phaseOverrides = [disabledOverride(PHASE_PLAN)];
      run.phasesCompleted = [completion(PHASE_PLAN, 'skipped')];
      return run;
    },
    state: 'disabled',
    // THE DEFECT. The tile says `disabled` for both R2 and R3, and the surface
    // has only that word to go on, so it offers Enable for both. The host
    // distinguishes them — R2's Phase is still ahead of the runner, R3's is
    // behind it — and refuses R3. Until the projection carries the distinction,
    // this assertion fails and the recorded actual is `false`.
    enableDisabled: true,
    classifierEnable: 'phase-not-future',
    disableDisabled: true,
    classifierDisable: 'phase-already-started'
  },
  {
    id: 'R4',
    origin: 'skipped in execution, no override',
    target: PHASE_PLAN,
    run: () => {
      const run = baseRun();
      run.phasesCompleted = [completion(PHASE_PLAN, 'skipped')];
      return run;
    },
    // `skipped`, not `disabled` — this is the FR-014 distinction the projector
    // draws from whether the id is still in `disabledPhaseIds` when it
    // completes. It stays drawn; this row is here to prove it stayed.
    state: 'skipped',
    enableDisabled: true,
    classifierEnable: 'no-disabled-override',
    disableDisabled: true,
    classifierDisable: 'phase-already-started'
  },
  {
    id: 'R5',
    origin: "the current Phase of a canceled Run",
    target: PHASE_BUILD,
    run: () => {
      const run = baseRun();
      run.status = 'canceled' as WorkflowRun['status'];
      return run;
    },
    state: 'skipped',
    enableDisabled: true,
    // Recorded without changing it (data-model.md §2): the `enable` arm has no
    // terminal-Run guard, so a canceled Run refuses here for want of an
    // override rather than for being terminal. Pre-existing and out of scope.
    classifierEnable: 'no-disabled-override',
    disableDisabled: true,
    classifierDisable: 'phase-already-started'
  },
  {
    id: 'R6',
    origin: 'completed',
    target: PHASE_PLAN,
    run: () => {
      const run = baseRun();
      run.phasesCompleted = [completion(PHASE_PLAN, 'clean')];
      return run;
    },
    state: 'completed',
    enableDisabled: true,
    classifierEnable: 'no-disabled-override',
    disableDisabled: true,
    classifierDisable: 'phase-already-started'
  },
  {
    id: 'R7',
    origin: 'active',
    target: PHASE_BUILD,
    run: baseRun,
    state: 'active',
    enableDisabled: true,
    classifierEnable: 'no-disabled-override',
    disableDisabled: true,
    classifierDisable: 'phase-already-started'
  }
];

function decisionOf(
  operation: 'enable' | 'disable',
  run: WorkflowRun,
  targetPhaseId: string
): ExpectedDecision {
  const result = decidePhaseControl({ operation, run, targetPhaseId });
  return result.eligible ? 'ELIGIBLE' : result.reason;
}

describe('Feature 201 (T006-T009) — surface and classifier, asked about the same Phase', () => {
  beforeAll(async () => {
    const mod = (await import('../../webview-ui/src/lib/phase-control-eligibility.js')) as {
      phaseControlEligibility: (input: EligibilityInput) => Eligibility;
    };
    phaseControlEligibility = mod.phaseControlEligibility;
  });

  for (const row of ROWS) {
    it(`${row.id} — ${row.origin}`, () => {
      const run = row.run();
      const tiles = buildPhasesFromRun(run);
      const tile = tiles.find((candidate) => candidate.name === row.target);

      // The fixture must really have produced the origin the row claims. Without
      // this, a fixture that silently built the wrong state would still let both
      // sides "agree" — about a Phase in a state the row was not written about.
      expect(tile, `${row.id}: the projector emitted no tile for '${row.target}'`).toBeDefined();
      expect(tile?.state, `${row.id}: fixture did not produce the '${row.origin}' origin`).toBe(
        row.state
      );

      const surface = phaseControlEligibility({
        isPrimary: true,
        targetsSubjectRun: true,
        currentPhase: run.currentPhase,
        activeTaskId: 'task-201',
        activeRunId: run.id,
        manualPauseAt: null,
        selectedPhase: row.target,
        selectedPhaseState: tile?.state ?? null,
        // Read off the projected tile with the same `?? false` the component
        // uses, because the point of the row is what the real surface would
        // answer given the real projection. Nothing here is an expectation —
        // no asserted value in ROWS changed when this member was added, which
        // is what makes R3 turning green attributable to the product code and
        // not to the harness.
        selectedPhaseIsFuture: tile?.isFuture ?? false,
        phaseOverrides: run.phaseOverrides as readonly { readonly phaseId: string }[],
        phaseBreakpoints: []
      });

      // Both sides are read before either is asserted, so that whichever
      // assertion fires first can name what the OTHER side answered. A
      // disagreement is a fact about the pair; a message that reports only one
      // half of it makes the reader go and find the other half by hand.
      const hostEnable = decisionOf('enable', run, row.target);
      const hostDisable = decisionOf('disable', run, row.target);

      expect(
        surface.enableDisabled,
        `${row.id}: surface Enable availability for a '${row.state}' tile ` +
          `(the host answers '${hostEnable}' for this Phase)`
      ).toBe(row.enableDisabled);
      expect(hostEnable, `${row.id}: host's answer to Enable`).toBe(row.classifierEnable);

      expect(
        surface.disableDisabled,
        `${row.id}: surface Disable availability for a '${row.state}' tile ` +
          `(the host answers '${hostDisable}' for this Phase)`
      ).toBe(row.disableDisabled);
      expect(hostDisable, `${row.id}: host's answer to Disable`).toBe(row.classifierDisable);
    });
  }
});
