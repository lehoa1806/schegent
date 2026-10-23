// Feature 098 (T052, US4) — the idle sidebar over an empty catalog.
//
// FR-030, FR-032, SC-010. Before this feature the projector answered a
// `null` run with seven placeholder tiles read off a hardcoded list — a
// tracker showing a process the operator had never defined, in a product
// where every Phase now arrives by import. With nothing imported there is
// nothing to track, so the projection is empty and the operator is told how
// to make it non-empty.
//
// The guidance is not a field on the tile array: FR-030a makes it one text
// shared by the sidebar and the launch surface, so it lives in
// `src/contracts/empty-catalog-guidance.ts` and both surfaces derive it from
// the count they hold. What this file pins down is the pairing — zero tiles
// *and* guidance that names `examples/`, non-empty tiles *and* no guidance —
// because either half alone would pass while the operator saw nothing useful.
//
// `phase-projector-optional-phase.test.ts` alongside this file covers a
// different case (optional-phase failure badges) and is untouched by this.

import { describe, expect, it } from 'vitest';
import {
  EMPTY_CATALOG_GUIDANCE,
  EXAMPLES_DIRECTORY,
  emptyCatalogGuidance
} from '../../../../src/contracts/empty-catalog-guidance';
import { DEFAULT_ITERATION_CAP } from '../../../../src/services/run-planned-total';
import type { WorkflowRun } from '../../../../src/state/workflow-run';
import {
  buildPhasesFromRun,
  computeSubProgressForTile,
  phaseIndex
} from '../../../../src/ui/sidebar/phase-projector';
import type { PhaseTile } from '../../../../src/ui/sidebar/snapshot';

/**
 * A Run over a Pipeline the operator imported. The ids are deliberately not
 * the seven the built-in layer used to claim: a projection that still fell
 * back to placeholders would be indistinguishable from a correct one if the
 * fixture reused their names.
 */
function makeImportedRun(): WorkflowRun {
  return {
    id: 'run-imported',
    featureId: '098-runtime-only-catalog',
    featureDir: '/workspace/specs/098-runtime-only-catalog',
    status: 'running',
    currentPhase: 'draft',
    currentIteration: 1,
    startedAt: 1,
    lastTransitionAt: 2,
    phasesCompleted: [],
    lastError: null,
    pipeline: {
      id: 'operator-flow',
      name: 'Operator Flow',
      phases: [
        { id: 'draft', name: 'Draft', instruction: 'Draft it.' },
        { id: 'ship', name: 'Ship', instruction: 'Ship it.' }
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
  };
}

describe('Feature 098 (T052) — an empty catalog projects no Phase tiles', () => {
  it('renders zero tiles when there is no Run to project', () => {
    // `null` is the idle sidebar: nothing has been launched, so the tracker
    // has only the catalog to draw on, and the catalog ships empty.
    expect(buildPhasesFromRun(null)).toEqual([]);
  });

  it('pairs the empty projection with guidance naming the examples directory', () => {
    const tiles = buildPhasesFromRun(null);

    const guidance = emptyCatalogGuidance(tiles.length);

    expect(guidance, 'no guidance for an empty projection').not.toBeNull();
    expect(guidance!.body).toContain(EXAMPLES_DIRECTORY);
    // The remedy, not just the state: FR-030 asks the operator to import, and
    // a headline alone would leave them looking at an empty panel.
    expect(guidance!.body.toLowerCase()).toContain('import');
    expect(guidance!.headline.length).toBeGreaterThan(0);
  });

  it('names one guidance object, so no surface can render a variant of it', () => {
    // FR-030a's "one shared source" is only true if the derivation returns
    // *the* message rather than a fresh equal-looking one each call.
    expect(emptyCatalogGuidance(0)).toBe(EMPTY_CATALOG_GUIDANCE);
  });
});

describe('Feature 098 (T052) — a non-empty catalog projects the operator definitions', () => {
  it('projects the imported Pipeline phases, in its order, under its names', () => {
    const tiles = buildPhasesFromRun(makeImportedRun());

    expect(tiles.map((tile) => tile.name)).toEqual(['draft', 'ship']);
    expect(tiles.map((tile) => tile.displayName)).toEqual(['Draft', 'Ship']);
    expect(tiles[0]).toMatchObject({ order: 1, state: 'active' });
    expect(tiles[1]).toMatchObject({ order: 2, state: 'not-started' });
  });

  it('withholds the guidance once there is something to show (FR-032)', () => {
    const tiles = buildPhasesFromRun(makeImportedRun());

    expect(emptyCatalogGuidance(tiles.length)).toBeNull();
  });

  it('falls back to no tiles rather than placeholders when a Run carries no Pipeline', () => {
    // A Run whose Pipeline is absent used to reach the same placeholder list.
    // It is a degenerate state, but the answer is the same one an empty
    // catalog gets: show nothing invented.
    const run = { ...makeImportedRun(), pipeline: null } as unknown as WorkflowRun;

    expect(buildPhasesFromRun(run)).toEqual([]);
  });

  // `phaseIndex` kept a second, hardcoded answer for the case where no order was
  // passed: a seven-id Spec Kit map. No call site took that branch, and the map
  // disagreed with the pipeline it claimed to describe — `speckit-checklist` and
  // `speckit-review` were absent, so both resolved to -1 while `finalize` claimed
  // index 6. The order is now required, and the plan is the only thing that
  // answers.
  describe('a phase has the position its own plan gives it, and no other', () => {
    const order = new Map([['draft', 0], ['ship', 1]]);

    it('answers from the supplied order', () => {
      expect(phaseIndex('draft', order)).toBe(0);
      expect(phaseIndex('ship', order)).toBe(1);
    });

    it('gives a phase the plan does not list no position', () => {
      // Every id the deleted map claimed, against a plan that lists none of them.
      for (const id of [
        'speckit-specify', 'speckit-clarify', 'speckit-plan', 'speckit-tasks',
        'speckit-analyze', 'speckit-implement', 'finalize'
      ]) {
        expect(phaseIndex(id, order), `${id} is not in this plan`).toBe(-1);
      }
    });

    it('gives the terminal state no position even if a plan names it', () => {
      expect(phaseIndex('done', new Map([['done', 0]]))).toBe(-1);
    });
  });
});

/**
 * A Run whose middle Phase declares a retry condition, under a plan that froze a
 * cap of 4.
 *
 * The looping Phase is `refine`, an id no built-in layer ever claimed: a
 * sub-progress bar that still keyed on the Spec Kit names would leave it bare.
 */
function makeLoopingRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    ...makeImportedRun(),
    currentPhase: 'refine',
    currentIteration: 2,
    plannedTotal: { phaseCount: 3, iterationCap: 4, maxPhaseInvocations: 6 },
    pipeline: {
      id: 'operator-flow',
      name: 'Operator Flow',
      phases: [
        { id: 'draft', name: 'Draft', instruction: 'Draft it.' },
        {
          id: 'refine',
          name: 'Refine',
          instruction: 'Refine it.',
          retryCondition: 'open_items > 0'
        },
        { id: 'ship', name: 'Ship', instruction: 'Ship it.' }
      ]
    },
    ...overrides
  };
}

/** The one tile the Run is sitting on, projected the way production projects it. */
function activeTile(run: WorkflowRun): PhaseTile {
  const tile = buildPhasesFromRun(run).find((candidate) => candidate.state === 'active');
  expect(tile, 'the fixture must project an active tile').toBeDefined();
  return tile!;
}

// Feature 098 (FR-008) — the iteration bar used to appear for exactly two ids,
// `speckit-clarify` and `speckit-analyze`, through a hardcoded `isRecursivePhase`.
// Whether a Phase loops is a fact about its `retryCondition`, which is what the
// controller's own `transition()` reads, so the bar now asks the tile's frozen
// definition. Its denominator moves the same way: it was a local literal 10,
// where the Run has already frozen the cap the controller will actually enforce.
describe('the iteration bar follows the definition that makes a phase loop', () => {
  it('gives an imported looping phase an iteration bar against the frozen cap', () => {
    const run = makeLoopingRun();

    expect(computeSubProgressForTile(activeTile(run), run, undefined)).toEqual({
      current: 2,
      total: 4,
      label: 'iteration'
    });
  });

  it('gives a phase no iteration bar when its own definition declares no condition', () => {
    // The id spells one of the two names the deleted predicate recognised, and
    // the definition under it says the phase does not loop. The definition wins.
    const run = makeLoopingRun({
      currentPhase: 'speckit-clarify',
      pipeline: {
        id: 'operator-flow',
        name: 'Operator Flow',
        phases: [{ id: 'speckit-clarify', name: 'Clarify', instruction: 'Clarify it.' }]
      }
    });

    expect(computeSubProgressForTile(activeTile(run), run, undefined)).toBeNull();
  });

  it('clamps the current iteration to the frozen cap', () => {
    const run = makeLoopingRun({ currentIteration: 9 });

    expect(computeSubProgressForTile(activeTile(run), run, undefined)).toMatchObject({
      current: 4,
      total: 4
    });
  });

  it('falls back to the default cap for a Run that froze no planned total', () => {
    const run = makeLoopingRun({ plannedTotal: undefined });

    expect(computeSubProgressForTile(activeTile(run), run, undefined)).toMatchObject({
      current: 2,
      total: DEFAULT_ITERATION_CAP
    });
  });

  it('shows no bar before the first iteration', () => {
    const run = makeLoopingRun({ currentIteration: 0 });

    expect(computeSubProgressForTile(activeTile(run), run, undefined)).toBeNull();
  });

  it('shows no bar for a tile that is not the active one', () => {
    const run = makeLoopingRun();
    const idle = buildPhasesFromRun(run).find((tile) => tile.name === 'ship')!;

    expect(computeSubProgressForTile(idle, run, { current: 1, total: 2 })).toBeNull();
  });

  // Every looping phase now reaches the branch that used to be reserved for two
  // ids, and one of them — the implement phase of the example pipeline — is the
  // phase that reports task counts. Counted tasks are the finer measure of the
  // same work, so they win; the iteration bar is what a looping phase shows when
  // nothing finer has been observed.
  it('prefers observed task counts over the iteration bar', () => {
    const run = makeLoopingRun();

    expect(computeSubProgressForTile(activeTile(run), run, { current: 3, total: 12 })).toEqual({
      current: 3,
      total: 12,
      label: 'task'
    });
  });

  it('still shows task counts for a phase that does not loop', () => {
    const run = makeLoopingRun({ currentPhase: 'ship' });

    expect(computeSubProgressForTile(activeTile(run), run, { current: 1, total: 2 })).toEqual({
      current: 1,
      total: 2,
      label: 'task'
    });
  });
});

// FR-R3-151 (FR-012–FR-014, T1627) — a disabled future Phase projects
// `disabled` immediately, before the runner reaches and bypasses it, and the
// distinction between a disabled bypass and an ordinary skip is preserved
// once the runner does reach it.
describe('a disabled future Phase projects disabled immediately (FR-R3-151)', () => {
  function makeDisableableRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
    return {
      ...makeImportedRun(),
      currentPhase: 'draft',
      pipeline: {
        id: 'operator-flow',
        name: 'Operator Flow',
        phases: [
          { id: 'draft', name: 'Draft', instruction: 'Draft it.' },
          { id: 'refine', name: 'Refine', instruction: 'Refine it.' },
          { id: 'ship', name: 'Ship', instruction: 'Ship it.' }
        ]
      },
      ...overrides
    };
  }

  it('before-bypass: projects disabled the moment the override is set, with no phasesCompleted entry yet', () => {
    const run = makeDisableableRun({
      phaseOverrides: [{ phaseId: 'ship', action: 'disabled', setAt: 1, actor: 'operator' }]
    });

    const tiles = buildPhasesFromRun(run);

    expect(tiles.find((tile) => tile.name === 'ship')).toMatchObject({ state: 'disabled' });
    // Unaffected: the active Phase and any other future Phase.
    expect(tiles.find((tile) => tile.name === 'draft')).toMatchObject({ state: 'active' });
    expect(tiles.find((tile) => tile.name === 'refine')).toMatchObject({ state: 'not-started' });
  });

  it('after-bypass: a completed entry with result "skipped" still shows disabled, not skipped, while the override stands', () => {
    const run = makeDisableableRun({
      currentPhase: 'ship',
      phaseOverrides: [{ phaseId: 'refine', action: 'disabled', setAt: 1, actor: 'operator' }],
      phasesCompleted: [
        {
          phase: 'refine',
          iteration: 1,
          startedAt: 0,
          endedAt: 1,
          result: 'skipped',
          terminationReason: 'error',
          exitCode: 0,
          stdoutSummary: '',
          stderrSummary: '',
          auditEntryId: null
        }
      ] as unknown as WorkflowRun['phasesCompleted']
    });

    const tiles = buildPhasesFromRun(run);

    expect(tiles.find((tile) => tile.name === 'refine')).toMatchObject({ state: 'disabled' });
  });

  it('enabled-again: removing the override returns the tile to not-started and leaves phaseBreakpoints untouched', () => {
    // Enabling clears the phaseOverrides entry (PhaseControlService#enablePhase);
    // this asserts the *projection* side of that write, and that the
    // unrelated breakpoints array on the Run object is not something
    // buildPhasesFromRun reads or mutates.
    const runWhileDisabled = makeDisableableRun({
      phaseOverrides: [{ phaseId: 'ship', action: 'disabled', setAt: 1, actor: 'operator' }],
      phaseBreakpoints: [{ phaseId: 'ship', setAt: 1, actor: 'operator' }]
    });
    expect(buildPhasesFromRun(runWhileDisabled).find((tile) => tile.name === 'ship')).toMatchObject({
      state: 'disabled'
    });

    const runAfterEnable = makeDisableableRun({
      phaseOverrides: [],
      phaseBreakpoints: [{ phaseId: 'ship', setAt: 1, actor: 'operator' }]
    });
    expect(buildPhasesFromRun(runAfterEnable).find((tile) => tile.name === 'ship')).toMatchObject({
      state: 'not-started'
    });
    expect(runAfterEnable.phaseBreakpoints).toEqual([{ phaseId: 'ship', setAt: 1, actor: 'operator' }]);
  });

  it('an ordinary skip of the active Phase still projects skipped, not disabled', () => {
    const run = makeDisableableRun({
      currentPhase: 'refine',
      phaseOverrides: [],
      phasesCompleted: [
        {
          phase: 'draft',
          iteration: 1,
          startedAt: 0,
          endedAt: 1,
          result: 'skipped',
          terminationReason: 'error',
          exitCode: 0,
          stdoutSummary: '',
          stderrSummary: '',
          auditEntryId: null
        }
      ] as unknown as WorkflowRun['phasesCompleted']
    });

    expect(buildPhasesFromRun(run).find((tile) => tile.name === 'draft')).toMatchObject({
      state: 'skipped'
    });
  });

  it('disabling one Phase does not affect a different, unrelated Phase', () => {
    const run = makeDisableableRun({
      phaseOverrides: [{ phaseId: 'ship', action: 'disabled', setAt: 1, actor: 'operator' }]
    });

    const tiles = buildPhasesFromRun(run);

    expect(tiles.find((tile) => tile.name === 'ship')).toMatchObject({ state: 'disabled' });
    expect(tiles.find((tile) => tile.name === 'refine')).toMatchObject({ state: 'not-started' });
  });

  // FR-R3-151 (US3 Acceptance Scenario 4) asks for index-differentiated
  // disable when two Phases in one Run's Pipeline snapshot share a catalog
  // id. Documented here rather than silently assumed: `PhaseOverride` (and
  // `PhaseControlService#disablePhase`) address a Phase by id alone, with no
  // occurrence index — the same limitation the pre-existing `phaseOrder: Map
  // <PhaseName, number>` in this file already has, where a repeated name's
  // Map entry is last-write-wins (`tiles.forEach((tile, idx) =>
  // phaseOrder.set(tile.name, idx))` keeps only the final index). Given that,
  // this fix — applied per-tile over the array, not through `phaseOrder` —
  // marks every tile sharing the disabled id, which is the coherent reading
  // available from an id-only override: it cannot fabricate an index the
  // write never carried. True per-occurrence disambiguation would require an
  // index-bearing `PhaseOverride` and a matching host API, which is a
  // distinct, larger change outside this fix's scope.
  it('a repeated catalog Phase id: both occurrences reflect the id-scoped override (documented boundary, not index-scoped)', () => {
    const run = makeDisableableRun({
      pipeline: {
        id: 'operator-flow',
        name: 'Operator Flow',
        phases: [
          { id: 'draft', name: 'Draft', instruction: 'Draft it.' },
          { id: 'refine', name: 'Refine', instruction: 'Refine it.' },
          { id: 'refine', name: 'Refine (again)', instruction: 'Refine it again.' }
        ]
      },
      phaseOverrides: [{ phaseId: 'refine', action: 'disabled', setAt: 1, actor: 'operator' }]
    });

    const tiles = buildPhasesFromRun(run);
    const refineTiles = tiles.filter((tile) => tile.name === 'refine');

    expect(refineTiles).toHaveLength(2);
    expect(refineTiles.every((tile) => tile.state === 'disabled')).toBe(true);
  });
});

// FR-R3-198 (T1877) — a phase whose turn ended unfinished, past the dispatch's
// immediate resumes, halts the Run `failed` on that phase, and the fail arm
// appends its result (research R6). The tile's badge shows it as a failed
// result, not as nothing.
describe('an unfinished turn projects as a failed result (FR-R3-198)', () => {
  it('maps a phase result with outcome incomplete_turn to the failed badge', () => {
    const run: WorkflowRun = {
      ...makeImportedRun(),
      status: 'failed',
      phasesCompleted: [
        {
          phase: 'draft',
          iteration: 1,
          startedAt: 1,
          endedAt: 2,
          result: 'incomplete_turn',
          terminationReason: 'incomplete_turn',
          exitCode: 143,
          stdoutSummary: '',
          stderrSummary: '',
          auditEntryId: null
        }
      ]
    };

    const tiles = buildPhasesFromRun(run);

    expect(tiles.find((tile) => tile.name === 'draft')).toMatchObject({ lastResult: 'failed' });
  });
});
