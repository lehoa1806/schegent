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
import type { WorkflowRun } from '../../../../src/state/workflow-run';
import { buildPhasesFromRun } from '../../../../src/ui/sidebar/phase-projector';

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
});
