// Feature 048 — pure-function phase projection extracted from
// `state-projector.ts`. The orchestrator owns mutable bookkeeping
// (monotonic timers, phase-message accumulation) while this module owns the
// stateless shape transformation from `WorkflowRun` → `PhaseTile[]`.
//
// Feature 098 (T055, FR-030) — with nothing to project, this projects nothing.
// Both branches below used to fall back to `buildEmptyPhases()`, seven
// placeholder tiles named after the Phases the built-in layer supplied. In a
// product where every Phase arrives by import, those tiles describe a process
// the operator never defined, and an idle sidebar showing them tells them the
// catalog holds something it does not.
//
// The guidance that replaces them is NOT returned from here. FR-030a makes it
// one message shared by this surface and the launch surface, so it lives in
// `src/contracts/empty-catalog-guidance.ts` and each surface derives it from
// the count it already holds — `emptyCatalogGuidance(tiles.length)` here,
// `emptyCatalogGuidance(pipelines.length)` there. Threading it through the
// projection instead would put it on the snapshot, across the IPC boundary and
// into the parity tests, to deliver a constant both ends can already import.
import { isLoopPhase, type Phase, type PhaseOutcome } from '../../controller/phase';
import { DEFAULT_ITERATION_CAP } from '../../services/run-planned-total';
import type { WorkflowRun } from '../../state/workflow-run';
import {
  type PhaseName,
  type PhaseResultState,
  type PhaseTile,
  type SubProgress
} from './snapshot';

// Feature 098 (FR-008, FR-019) — `BUILT_IN_PHASE_INDEX` stood here: a seven-id
// Spec Kit ordering consulted by `phaseIndex` when no order was passed. It was
// already unreachable (all three call sites derive the order from the Run's own
// frozen plan) and already wrong (it omitted `speckit-checklist` and
// `speckit-review`, so those two phases mapped to -1 while `finalize` claimed
// index 6 of a nine-phase pipeline). A tile position is a fact about the plan
// the Run froze, so the order is now a required argument.

export function buildPhasesFromRun(run: WorkflowRun | null): PhaseTile[] {
  type MutableTile = {
    -readonly [K in keyof PhaseTile]: PhaseTile[K];
  };
  if (!run) {
    // Idle. Nothing has been launched, so the tracker has only the catalog to
    // draw on and the catalog ships empty.
    return [];
  }

  const removedPhaseIds = new Set(
    run.phaseOverrides
      .filter((override) => override.action === 'removed')
      .map((override) => override.phaseId)
  );
  const pipelinePhases = run.pipeline?.phases;
  const tiles: MutableTile[] =
    pipelinePhases && pipelinePhases.length > 0
      ? pipelinePhases.filter((def) => !removedPhaseIds.has(def.id)).map<MutableTile>((def, idx) => ({
        name: def.id,
        displayName: def.name,
        ...(def.isRequired !== undefined ? { isRequired: def.isRequired } : {}),
        order: idx + 1,
        state: 'not-started',
        iteration: 0,
        lastResult: null,
        elapsedMs: 0,
        subProgress: null
      }))
      // A Run carrying no Pipeline is degenerate — every Run freezes one at
      // start — but the answer is the one an empty catalog gets: show nothing
      // invented. `removedPhaseIds` has nothing left to filter here.
      : [];

  const phaseOrder = new Map<PhaseName, number>();
  tiles.forEach((tile, idx) => phaseOrder.set(tile.name, idx));

  const currentIdx = phaseIndex(run.currentPhase, phaseOrder);
  const disabledPhaseIds = new Set(
    run.phaseOverrides
      .filter((override) => override.action === 'disabled')
      .map((override) => override.phaseId)
  );

  for (const completed of run.phasesCompleted) {
    const idx = phaseIndex(completed.phase, phaseOrder);
    if (idx === -1) continue;
    const tile = tiles[idx];
    if (completed.result === 'skipped') {
      tile.state = disabledPhaseIds.has(completed.phase) ? 'disabled' : 'skipped';
    } else {
      tile.state = 'completed';
    }
    tile.iteration = Math.max(tile.iteration, completed.iteration);
    tile.lastResult = mapPhaseOutcome(completed.result);
  }

  if (currentIdx >= 0 && currentIdx < tiles.length) {
    const tile = tiles[currentIdx];
    if (run.status === 'running' || run.status === 'paused') {
      tile.state = 'active';
    } else if (run.status === 'failed') {
      tile.state = 'active';
    } else if (run.status === 'completed') {
      tile.state = 'completed';
    } else if (run.status === 'canceled') {
      tile.state = 'skipped';
    }
    // Any phase can theoretically loop if it has a retry condition. If it is looping, its currentIteration will reflect it.
    tile.iteration = Math.max(tile.iteration, run.currentIteration);
  }

  if (run.lastRetryDecision) {
    const decisionPhaseName = run.lastRetryDecision.phase === 'done' ? null : (run.lastRetryDecision.phase as PhaseName);
    if (decisionPhaseName) {
      const idx = phaseIndex(decisionPhaseName, phaseOrder);
      if (idx >= 0 && idx < tiles.length) {
        tiles[idx].lastRetryDecision = {
          missingKeys: [...run.lastRetryDecision.missingKeys]
        };
      }
    }
  }

  return tiles;
}


/**
 * The tile position of a phase within one Run's plan, or -1 if the plan does
 * not list it.
 *
 * `phaseOrder` is required: the plan is the only thing that knows where a phase
 * sits, and a phase it does not list has no position — including `'done'`,
 * which is a terminal state of the state machine rather than a tile.
 */
export function phaseIndex(phase: Phase, phaseOrder: ReadonlyMap<PhaseName, number>): number {
  if (phase === 'done') return -1;
  const idx = phaseOrder.get(phase as PhaseName);
  return typeof idx === 'number' ? idx : -1;
}

export function mapPhaseOutcome(outcome: PhaseOutcome): PhaseResultState | null {
  switch (outcome) {
    case 'clean':
      return 'clean';
    case 'issues_remain':
      return 'issues-remain';
    case 'failed':
      return 'failed';
    case 'timeout':
      return 'timed-out';
    case 'rate_limited':
    case 'transient_error':
    case 'skipped':
    case 'paused-at-breakpoint':
      return null;
  }
}

/**
 * The bar under one Phase tile: counted tasks if any were observed, otherwise
 * the iteration count if the Phase is one that loops, otherwise nothing.
 *
 * Feature 098 (FR-008) — both halves of the iteration branch used to be
 * hardcoded. `isRecursivePhase` recognised exactly `speckit-clarify` and
 * `speckit-analyze`, two ids of a built-in catalog that no longer exists, so an
 * imported looping Phase showed no bar and a Phase merely *named* one of those
 * two showed one it had not earned. And its denominator was a local literal 10,
 * standing where the Run has already frozen the cap the controller will enforce.
 * Both now read the Run: the tile's own definition says whether it loops (the
 * same `retryCondition` `transition()` consults), and `plannedTotal` says how far.
 *
 * The task/iteration order is the other half of that change. Re-keying brings
 * every looping Phase into a branch that two ids used to have to themselves —
 * including the implement Phase of the example pipeline, which is the one that
 * reports task counts. Counted tasks measure the same work more finely, so they
 * take precedence, and the iteration bar is what a looping Phase falls back to.
 */
export function computeSubProgressForTile(
  tile: PhaseTile,
  run: WorkflowRun | null,
  observed: { current: number; total: number } | undefined
): SubProgress | null {
  if (tile.state !== 'active' || !run) return null;
  if (observed) {
    return Object.freeze({
      current: observed.current,
      total: observed.total,
      label: 'task' as const
    });
  }
  const phaseDef = run.pipeline?.phases.find((def) => def.id === tile.name);
  if (!isLoopPhase(tile.name, phaseDef)) return null;
  const current = run.currentIteration;
  if (!Number.isFinite(current) || current <= 0) return null;
  const cap = run.plannedTotal?.iterationCap ?? DEFAULT_ITERATION_CAP;
  return Object.freeze({
    current: Math.min(Math.floor(current), cap),
    total: cap,
    label: 'iteration' as const
  });
}
