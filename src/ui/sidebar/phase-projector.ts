// Feature 048 — pure-function phase projection extracted from
// `state-projector.ts`. The orchestrator owns mutable bookkeeping
// (monotonic timers, phase-message accumulation) while this module owns the
// stateless shape transformation from `WorkflowRun` → `PhaseTile[]`.
import type { Phase, PhaseOutcome } from '../../controller/phase';
import type { WorkflowRun } from '../../state/workflow-run';
import { buildEmptyPhases, isRecursivePhase, type PhaseName, type PhaseTile, type SubProgress } from './snapshot';

const RECURSIVE_PHASE_MAX_ITERATIONS = 10;

export const BUILT_IN_PHASE_INDEX = new Map<PhaseName, number>([
  ['speckit-specify', 0],
  ['speckit-clarify', 1],
  ['speckit-plan', 2],
  ['speckit-tasks', 3],
  ['speckit-analyze', 4],
  ['speckit-implement', 5],
  ['finalize', 6]
]);

export const BUILT_IN_LOOPABLE = new Set<PhaseName>(['speckit-clarify', 'speckit-analyze']);

export function buildPhasesFromRun(run: WorkflowRun | null): PhaseTile[] {
  type MutableTile = {
    -readonly [K in keyof PhaseTile]: PhaseTile[K];
  };
  if (!run) {
    return buildEmptyPhases().map((p) => ({ ...p }));
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
        order: idx + 1,
        state: 'not-started',
        iteration: 0,
        lastResult: null,
        elapsedMs: 0,
        subProgress: null,
        loopable: def.loopable
      }))
      : buildEmptyPhases()
        .filter((phase) => !removedPhaseIds.has(phase.name))
        .map<MutableTile>((p) => ({ ...p }));

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
    if (isLoopableTile(tile)) {
      tile.iteration = Math.max(tile.iteration, run.currentIteration);
    }
  }

  return tiles;
}

export function isLoopableTile(tile: PhaseTile): boolean {
  if (typeof tile.loopable === 'boolean') return tile.loopable;
  return BUILT_IN_LOOPABLE.has(tile.name);
}

export function phaseIndex(phase: Phase, phaseOrder?: Map<PhaseName, number>): number {
  if (phase === 'done') return -1;
  if (phaseOrder) {
    const idx = phaseOrder.get(phase as PhaseName);
    if (typeof idx === 'number') return idx;
    return -1;
  }
  return BUILT_IN_PHASE_INDEX.get(phase as PhaseName) ?? -1;
}

export function mapPhaseOutcome(
  outcome: PhaseOutcome
): 'clean' | 'ambiguities-remain' | 'issues-remain' | null {
  switch (outcome) {
    case 'clean':
      return 'clean';
    case 'issues_remain':
      return 'issues-remain';
    case 'failed':
    case 'rate_limited':
    case 'timeout':
    case 'transient_error':
    case 'skipped':
    case 'paused-at-breakpoint':
      return null;
  }
}

export function computeSubProgressForTile(
  tile: PhaseTile,
  run: WorkflowRun | null,
  observed: { current: number; total: number } | undefined
): SubProgress | null {
  if (tile.state !== 'active' || !run) return null;
  if (isRecursivePhase(tile.name)) {
    const current = run.currentIteration;
    if (!Number.isFinite(current) || current <= 0) return null;
    return Object.freeze({
      current: Math.min(Math.floor(current), RECURSIVE_PHASE_MAX_ITERATIONS),
      total: RECURSIVE_PHASE_MAX_ITERATIONS,
      label: 'iteration' as const
    });
  }
  if (!observed) return null;
  return Object.freeze({
    current: observed.current,
    total: observed.total,
    label: 'task' as const
  });
}
