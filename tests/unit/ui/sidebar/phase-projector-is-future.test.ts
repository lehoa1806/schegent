// Feature 201 (T015, US1) — every tile carries `isFuture`, and it is the
// runner's notion of "not yet reached", not the tile's position.
//
// FR-002 says every tile the projector emits carries the fact, whatever state
// it ends up in. That "every" is the load-bearing word: the surface reads
// `tile.isFuture ?? false`, so a tile the pass missed silently withholds Enable
// rather than failing. Fail-closed is the right default and a bad thing to be
// relying on by accident, which is why (a) below checks the whole emitted array
// rather than sampling it.
//
// FR-003 says the value echoes the host's `isPhaseFuture`
// (`src/controller/phase-control-decision.ts`) rather than being derived
// from tile order. Test (b) exercises all seven origins of data-model.md §2 in
// one Run, which is what makes an order-derived implementation fail here: rows 1
// and 2 are both ahead of the runner and both true, while rows 3-7 are behind or
// on it and all false — an order comparison gets the disabled rows wrong.

import { describe, expect, it } from 'vitest';
import type { PhaseResult, WorkflowRun } from '../../../../src/state/workflow-run';
import { buildPhasesFromRun } from '../../../../src/ui/sidebar/phase-projector';

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

const OVERRIDE_AT = '2026-09-05T00:00:00Z';

/**
 * One Run reaching all seven origins at once. The runner sits on `active`;
 * `bypassed`, `skipped-run`, `finished` and `removed-phase` are behind it,
 * `untouched` and `future-disabled` ahead of it.
 *
 * The completed Phase is called `finished` and not `done` on purpose: `'done'`
 * is the terminal-Run sentinel, and `phaseIndex` returns -1 for it by name
 * (`phase-projector.ts:184`), so a Phase genuinely called `done` never gets a
 * tile. A fixture using it would have reported a projector defect that is
 * really a reserved word.
 */
function sevenOriginRun(): WorkflowRun {
  return {
    id: 'run-201-isfuture',
    featureId: '201-phase-override-way-back',
    featureDir: '/workspace/specs/201-phase-override-way-back',
    status: 'running',
    currentPhase: 'active',
    currentIteration: 1,
    startedAt: 1,
    lastTransitionAt: 2,
    phasesCompleted: [
      completion('bypassed', 'skipped'),
      completion('skipped-run', 'skipped'),
      completion('finished', 'clean')
    ],
    lastError: null,
    pipeline: {
      id: 'seven-origin-flow',
      name: 'Seven Origin Flow',
      phases: [
        { id: 'bypassed', name: 'Bypassed', instruction: 'x' },
        { id: 'skipped-run', name: 'Skipped', instruction: 'x' },
        { id: 'finished', name: 'Finished', instruction: 'x' },
        { id: 'removed-phase', name: 'Removed', instruction: 'x' },
        { id: 'active', name: 'Active', instruction: 'x' },
        { id: 'untouched', name: 'Untouched', instruction: 'x' },
        { id: 'future-disabled', name: 'Future Disabled', instruction: 'x' }
      ]
    },
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [
      { phaseId: 'bypassed', action: 'disabled', at: OVERRIDE_AT },
      { phaseId: 'future-disabled', action: 'disabled', at: OVERRIDE_AT },
      { phaseId: 'removed-phase', action: 'removed', at: OVERRIDE_AT }
    ],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null
  } as unknown as WorkflowRun;
}

describe('Feature 201 (T015) — the projector writes isFuture on every tile', () => {
  it('(a) every emitted tile carries the member — the whole array, not a sample', () => {
    const tiles = buildPhasesFromRun(sevenOriginRun());

    // Six of seven: `removed-phase` is filtered out at `phase-projector.ts:56`
    // before any pass runs, which is exactly why a removed Phase has no row in
    // the paired parity test either (FR-016).
    expect(tiles.map((tile) => tile.name)).toEqual([
      'bypassed',
      'skipped-run',
      'finished',
      'active',
      'untouched',
      'future-disabled'
    ]);

    const missing = tiles.filter((tile) => typeof tile.isFuture !== 'boolean');
    expect(
      missing.map((tile) => `${tile.name} (${tile.state})`),
      'tiles emitted without isFuture — these would silently withhold Enable'
    ).toEqual([]);
  });

  it('(b) the value matches the origin, for all seven of data-model.md §2', () => {
    const tiles = buildPhasesFromRun(sevenOriginRun());
    const byName = new Map(tiles.map((tile) => [tile.name as string, tile]));

    // origin -> [tile state the projector should have produced, isFuture]
    const expected: ReadonlyArray<readonly [string, string, boolean]> = [
      // Row 1 — never reached, no override.
      ['untouched', 'not-started', true],
      // Row 2 — ahead of the runner and disabled: the one re-enableable case.
      ['future-disabled', 'disabled', true],
      // Row 3 — reached and bypassed, override still set. Same `state` word as
      // row 2 and the opposite answer: this pair is the whole feature.
      ['bypassed', 'disabled', false],
      // Row 4 — skipped in execution, no override (the FR-014 distinction).
      ['skipped-run', 'skipped', false],
      // Row 6 — completed.
      ['finished', 'completed', false],
      // Row 7 — active.
      ['active', 'active', false]
    ];

    for (const [name, state, isFuture] of expected) {
      const tile = byName.get(name);
      expect(tile, `no tile emitted for '${name}'`).toBeDefined();
      expect(tile?.state, `'${name}' did not reach the origin this row is about`).toBe(state);
      expect(tile?.isFuture, `isFuture for '${name}' (state '${state}')`).toBe(isFuture);
    }
  });

  it('(b, cont.) row 5 — the current Phase of a canceled Run is not future', () => {
    // Row 5 needs its own Run because the origin is a property of the Run's
    // status, not of the Phase: cancelation projects the current tile as
    // `skipped` while `currentPhase` still names it.
    const run = sevenOriginRun();
    run.status = 'canceled' as WorkflowRun['status'];
    const tile = buildPhasesFromRun(run).find((candidate) => candidate.name === 'active');

    expect(tile?.state).toBe('skipped');
    expect(tile?.isFuture, 'the Phase the Run was cancelled on has been reached').toBe(false);
  });

  it("a settled Run's 'done' sentinel leaves un-reached Phases future, as the host does", () => {
    // When a Run settles, `currentPhase` moves to the `'done'` sentinel and
    // matches no tile. The echo must not special-case that: the host's
    // `isPhaseFuture` also compares `currentPhase` by value, so it too answers
    // `true` for a Phase the settled Run never reached. Pinned because the
    // sentinel is the one input where "not the current Phase" is true of every
    // tile at once, and a reader could reasonably expect a guard here. Enable
    // stays unavailable on such a Phase anyway — for want of an override, which
    // is the `enable` arm's first check.
    const run = sevenOriginRun();
    run.status = 'completed' as WorkflowRun['status'];
    run.currentPhase = 'done' as WorkflowRun['currentPhase'];
    const byName = new Map(buildPhasesFromRun(run).map((tile) => [tile.name as string, tile]));

    expect(byName.get('untouched')?.isFuture).toBe(true);
    expect(byName.get('finished')?.isFuture).toBe(false);
    expect(byName.get('active')?.isFuture, 'never completed, and no longer current').toBe(true);
  });

  it('the obligation is vacuous where there are no tiles: null Run and empty pipeline', () => {
    expect(buildPhasesFromRun(null)).toEqual([]);

    // Built rather than mutated through a cast, and narrowed before the spread:
    // `pipeline` is OPTIONAL on `WorkflowRun`, so spreading it unnarrowed makes
    // every member optional and `exactOptionalPropertyTypes` rejects the result.
    // The ratchet at `tests/lint/compiler-strictness-ratchet.test.ts` asks a NEW
    // site to satisfy the flag rather than be absorbed into the pinned count.
    const seed = sevenOriginRun();
    const { pipeline } = seed;
    if (pipeline === undefined) throw new Error('sevenOriginRun must carry a pipeline');
    const emptyPipeline: WorkflowRun = { ...seed, pipeline: { ...pipeline, phases: [] } };
    expect(buildPhasesFromRun(emptyPipeline)).toEqual([]);
  });

  it('NON-VACUITY: the fact is not derived from tile order', () => {
    // `bypassed` sits at index 0 and `untouched` at index 4, both on the same
    // Run, and they answer differently in the direction an order comparison
    // gets wrong: the EARLIER tile is the one that is not future. An
    // implementation comparing against the active tile's index would agree here
    // by luck, so the sharper case is `future-disabled` vs `bypassed` — same
    // `disabled` state, opposite answers, decided only by where the runner has
    // been.
    const tiles = buildPhasesFromRun(sevenOriginRun());
    const bypassed = tiles.find((tile) => tile.name === 'bypassed');
    const futureDisabled = tiles.find((tile) => tile.name === 'future-disabled');

    expect(bypassed?.state).toBe(futureDisabled?.state);
    expect(bypassed?.isFuture).not.toBe(futureDisabled?.isFuture);
  });
});
