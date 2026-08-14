// Feature 089 (T029, US5, FR-032) — a Pipeline edited while a run holds its
// snapshot.
//
// Feature 082's `tests/integration/pipeline-catalog-run-snapshot.test.ts`
// already pins the freeze at *composition*: `resolvePipeline()` deep-copies and
// transitively freezes, and the contract survives the catalog row's removal.
// What it never does is start a run or finish one, so it cannot speak to the
// second half of FR-032 — that the run then *completes against* the frozen
// contract rather than merely holding an unchanged copy of it.
//
// This fixture does both. A `WorkflowRun` is created, put in flight, the catalog
// row underneath it is rewritten, and the run is driven to `done` through the
// production `PhaseSequencer` — whose every successor lookup passes
// `run.pipeline` into `transition()` (`src/controller/phase-sequencer.ts`). So
// "unchanged" is asserted against the bytes, and "completes against it" against
// the path the run actually walked.

import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  type PhaseDef,
  type PipelineCatalog,
  type PipelineDef
} from '../../../src/config/pipeline-config';
import type { PhaseRunOutput } from '../../../src/controller/phase-runner';
import { PhaseSequencer } from '../../../src/controller/phase-sequencer';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { FeatureRequest } from '../../../src/queue/feature-request';
import { WorkflowRunFactory } from '../../../src/services/workflow-run-factory';
import type { WorkflowRun } from '../../../src/state/workflow-run';

const NOW = 1_700_000_000_000;
const ITERATION_CAP = 5;
const PIPELINE_ID = 'edited-mid-run';

/**
 * Five real Phase ids, so the authored list and the edit that replaces it are
 * both resolvable. `resolvePipeline()` substitutes `done` for anything the
 * catalog cannot find, which would quietly convert a deleted Phase into a
 * passing assertion.
 */
function phase(id: string, name: string): PhaseDef {
  return { id, name, version: 1, instruction: `Run ${name}.`, sourceScope: 'built-in' };
}

const PHASES: PhaseDef[] = [
  phase('speckit-specify', 'Specify'),
  phase('speckit-plan', 'Plan'),
  phase('speckit-tasks', 'Tasks'),
  phase('speckit-implement', 'Implement'),
  phase('done', 'Done')
];

/** What the run is composed against. */
const AUTHORED: readonly string[] = ['speckit-specify', 'speckit-plan', 'done'];

/**
 * What an operator saves while the run is in flight: one Phase dropped, two
 * introduced, and the name changed. Every difference is observable, so an
 * implementation that re-read the catalog could not coincidentally agree.
 */
const EDITED: readonly string[] = ['speckit-tasks', 'speckit-implement', 'done'];

function pipelineRow(phases: readonly string[], name: string): PipelineDef {
  return { id: PIPELINE_ID, name, phases: [...phases] };
}

function catalogFor(phases: readonly string[], name: string): PipelineCatalog {
  return buildCatalog(
    PHASES,
    [pipelineRow(phases, name)],
    { claude: [], codex: [], agy: [] },
    PIPELINE_ID
  );
}

function featureRequest(): FeatureRequest {
  return {
    id: 'feat-1',
    description: 'edit the definition mid-run',
    enqueuedAt: NOW,
    createdAt: NOW,
    startedAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    status: 'in-flight',
    position: 0,
    runId: null,
    retryCount: 0,
    lastError: null,
    pausedReason: null
  };
}

/** A clean phase result, as the runner reports one that succeeded. */
function cleanOutput(): PhaseRunOutput {
  return {
    result: { kind: 'clean', auditEntry: { metrics: {} } as never },
    outcome: 'clean',
    terminationReason: 'token',
    stdoutSummary: '',
    stderrSummary: '',
    exitCode: 0,
    auditEntryId: null,
    warnings: []
  };
}

interface Harness {
  readonly run: WorkflowRun;
  /** Rewrite the catalog row under the in-flight run, as a confirmed save does. */
  edit: () => void;
  readonly catalogPhaseIds: () => readonly string[];
}

async function inFlightRun(): Promise<Harness> {
  let catalog = catalogFor(AUTHORED, 'Authored');
  const factory = new WorkflowRunFactory({
    getCatalog: () => catalog,
    defaultRunnerKind: 'claude',
    logger: new SanitizedLogger()
  });
  const run = await factory.create(featureRequest(), null, PIPELINE_ID);
  return {
    run,
    edit: () => {
      catalog = catalogFor(EDITED, 'Edited');
    },
    catalogPhaseIds: () => catalog.pipelinesById.get(PIPELINE_ID)?.phases ?? []
  };
}

/**
 * Drive the run to termination through the production sequencer, reporting the
 * phases it visited.
 *
 * Nothing here consults the catalog — that is the point. The sequencer decides
 * from `run.pipeline` alone, so the sequence this returns is the frozen
 * contract's or it is nothing.
 */
function driveToCompletion(start: WorkflowRun): { visited: string[]; final: WorkflowRun } {
  const sequencer = new PhaseSequencer();
  const visited: string[] = [];
  let run = start;

  // Bounded so a sequencer regression that never terminates fails as a wrong
  // sequence rather than hanging the suite.
  for (let step = 0; step < PHASES.length + 2; step += 1) {
    visited.push(run.currentPhase);
    if (run.currentPhase === 'done') break;

    const decision = sequencer.decideAfterPhase({
      run,
      output: cleanOutput(),
      iteration: run.currentIteration,
      iterationCap: ITERATION_CAP,
      activePhaseDef: run.pipeline?.phases.find((def) => def.id === run.currentPhase),
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    if (decision.kind !== 'advance-or-loop' || decision.transition.kind === 'halt') break;

    run = {
      ...run,
      currentPhase: decision.transition.nextPhase,
      currentIteration: decision.transition.nextIteration,
      phasesCompleted: [...run.phasesCompleted, decision.phaseResult]
    };
  }
  return { visited, final: run };
}

describe('a Pipeline edited mid-run cannot retarget the run (T029, FR-032)', () => {
  it('rewrites the catalog row for real (positive control)', async () => {
    // Without this, an `edit()` that silently did nothing would leave every
    // assertion below passing while testing the absence of a change.
    const harness = await inFlightRun();
    expect(harness.catalogPhaseIds()).toEqual(AUTHORED);
    harness.edit();
    expect(harness.catalogPhaseIds()).toEqual(EDITED);
    expect(harness.catalogPhaseIds()).not.toEqual(AUTHORED);
  });

  it('leaves the in-flight snapshot byte-identical after the edit', async () => {
    const harness = await inFlightRun();
    const before = structuredClone(harness.run.pipeline);

    harness.edit();

    expect(harness.run.pipeline).toEqual(before);
    expect(harness.run.pipeline?.phases.map((def) => def.id)).toEqual(AUTHORED);
    expect(harness.run.pipeline?.name).toBe('Authored');
  });

  it('completes against the frozen contract, not the edited row', async () => {
    const harness = await inFlightRun();
    harness.edit();

    const { visited, final } = driveToCompletion(harness.run);

    // The whole authored sequence, in order, ending at the terminal phase.
    expect(visited).toEqual([...AUTHORED]);
    expect(final.currentPhase).toBe('done');
  });

  it('never visits a phase the edit introduced', async () => {
    // The discriminating assertion. A run that re-read the catalog would walk
    // `speckit-tasks` and `speckit-implement`; one walking its snapshot cannot.
    const harness = await inFlightRun();
    harness.edit();

    const { visited } = driveToCompletion(harness.run);

    for (const introduced of EDITED.filter((id) => !AUTHORED.includes(id))) {
      expect(visited, `run walked ${introduced}, which the edit introduced`).not.toContain(
        introduced
      );
    }
    // And still visits the one the edit removed.
    expect(visited).toContain('speckit-plan');
  });

  it('holds the same frozen snapshot at the end as at the start', async () => {
    // The repository hard rule is "never mutate **or retarget** an in-flight
    // snapshot". Completion is the window in which a retarget would hide, so
    // the comparison is taken after the run finished, not just after the edit.
    const harness = await inFlightRun();
    const before = structuredClone(harness.run.pipeline);

    harness.edit();
    const { final } = driveToCompletion(harness.run);

    expect(final.pipeline).toEqual(before);
    expect(final.pipeline).toBe(harness.run.pipeline);
    expect(Object.isFrozen(final.pipeline)).toBe(true);
    expect(Object.isFrozen(final.pipeline?.phases)).toBe(true);
  });
});
