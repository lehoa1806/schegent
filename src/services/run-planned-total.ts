import { isLoopPhase } from '../controller/phase';
import type { PhaseDef } from '../config/pipeline-config';
import type { TaskPhaseProgressProjection } from '../contracts/snapshot-projections';
import type { PhaseOverride, RunPlannedTotal, WorkflowRun } from '../state/workflow-run';

/**
 * FR-R3-008 (T373) — all of the Run's plan arithmetic, in one place.
 *
 * Three call sites need it and they must agree exactly: the factory freezes the
 * total at creation, `PhaseControlService` refreshes it in the same write that
 * changes `phaseOverrides`, and the snapshot projector computes the numerator to
 * divide by it. A numerator and a denominator derived by two different rules is
 * how a progress bar comes to read 150%, so the rule lives here and nowhere
 * else.
 */

/**
 * Fallback loop bound, matching `schegent.loop.maxIterations`'s manifest default
 * (`settings-schema.ts`) and `general-settings.ts`'s `defaultValue`.
 *
 * The fallback exists so `plannedTotal` is present on **every** Run created
 * after this feature, including one created through a path that forgot to wire
 * the cap through. Absence then means "record predates the feature" and nothing
 * else, which is the only way a projector can safely render absence as unknown.
 */
export const DEFAULT_ITERATION_CAP = 10;

/** Bounds from the same schema row; a persisted total outside them is nonsense. */
export const MIN_ITERATION_CAP = 1;
export const MAX_ITERATION_CAP = 50;

/**
 * The phase outcomes that mean "this phase is done and will not be revisited".
 *
 * A `loopable` phase appends one `PhaseResult` per iteration and a repeated
 * phase one per position, so the numerator counts **distinct phase ids** with
 * one of these outcomes rather than counting entries — entry counting is what
 * lets the numerator pass the denominator. `'skipped'` belongs here: a skipped
 * phase is settled. Every other outcome — `issues_remain`, `transient_error`,
 * `rate_limited`, `timeout`, `paused-at-breakpoint`, `failed` — leaves the phase
 * pending another attempt, so it must not count.
 */
const SETTLED_OUTCOMES: ReadonlySet<string> = new Set(['clean', 'skipped']);

/**
 * A phase, as the plan arithmetic needs to see one.
 *
 * `retryCondition` is what decides the loop weight, because it is what decides
 * the loop: `transition()` re-runs a phase when its condition is non-empty and
 * truthy. `loopable` stays in the shape only so a caller holding a `PhaseDef`
 * that still carries the deprecated flag type-checks — nothing here reads it.
 */
export type PlannedPhase = Pick<PhaseDef, 'id'> & {
  readonly retryCondition?: string;
  readonly loopable?: boolean;
};

/**
 * Clamp an operator-supplied loop bound to the schema's range before freezing it.
 *
 * `loop.maxIterations` is a `resource`-scoped setting, so its value arrives from
 * workspace configuration and may be absent, fractional, or out of range by the
 * time it reaches here. A zero or negative cap would make
 * `maxPhaseInvocations` claim a loop phase never runs, so the clamp happens at
 * the freeze rather than at each read of the frozen value.
 */
export function freezeIterationCap(raw: number | null | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_ITERATION_CAP;
  const whole = Math.floor(raw);
  if (whole < MIN_ITERATION_CAP) return MIN_ITERATION_CAP;
  if (whole > MAX_ITERATION_CAP) return MAX_ITERATION_CAP;
  return whole;
}

/**
 * The ids excluded from **both** sides of the progress fraction.
 *
 * Symmetry is the whole point. The driver appends a `PhaseResult` with
 * `result: 'skipped'` when it reaches an overridden phase, so a denominator that
 * subtracted overrides while the numerator still counted their skip records
 * would report more than 100%. Both sides subtract this set, and T378 keeps the
 * recorded denominator in step by refreshing it in the same write that changes
 * `phaseOverrides`.
 */
export function excludedPhaseIds(
  overrides: readonly PhaseOverride[] | undefined
): ReadonlySet<string> {
  const excluded = new Set<string>();
  for (const override of overrides ?? []) excluded.add(override.phaseId);
  return excluded;
}

/**
 * Compute the recorded total for a plan, an override set, and a frozen cap.
 *
 * `phaseCount` counts **distinct** non-excluded phase ids, because that is what
 * the numerator can reach: a plan may list the same phase twice, and both
 * positions produce `PhaseResult` entries under one id.
 *
 * `maxPhaseInvocations` counts **positions**, each weighted by the loop bound,
 * because a second position genuinely is a second CLI invocation. It is a
 * ceiling and not a forecast — a loop that converges early uses fewer.
 *
 * The weight asks the controller's own `isLoopPhase` which positions can
 * repeat, rather than restating the rule. It used to read `loopable === true`,
 * a field `transition()` has never consulted when it is handed a phase
 * definition — which is always, on the production path. On a runtime-imported
 * catalog that was wrong in both directions: a Phase declaring `retryCondition`
 * and no `loopable` (the only shape the YAML writer emits) was weighted 1 while
 * it could run the cap, and a Phase declaring the deprecated flag alone was
 * weighted the cap while it could only ever run once.
 */
export function computePlannedTotal(args: {
  readonly phases: readonly PlannedPhase[] | undefined;
  readonly overrides: readonly PhaseOverride[] | undefined;
  readonly iterationCap: number | null | undefined;
}): RunPlannedTotal {
  const iterationCap = freezeIterationCap(args.iterationCap);
  const excluded = excludedPhaseIds(args.overrides);
  const counted = new Set<string>();
  let maxPhaseInvocations = 0;
  for (const phase of args.phases ?? []) {
    if (excluded.has(phase.id)) continue;
    counted.add(phase.id);
    maxPhaseInvocations += isLoopPhase(phase.id, phase) ? iterationCap : 1;
  }
  return Object.freeze({
    phaseCount: counted.size,
    iterationCap,
    maxPhaseInvocations
  });
}

/**
 * FR-R3-008 (T378) — the spreadable patch that keeps a Run's recorded total in
 * step with its override set, for use in the *same* object literal that writes
 * the new `phaseOverrides`.
 *
 * Spread-shaped rather than a plain return value, so the two cases the call
 * sites face are one line each. A Run with no pipeline snapshot — a legacy
 * record from before the snapshot was frozen — yields `{}` and keeps whatever it
 * had: there is no plan to count, and writing `0 of 0` would render as complete.
 *
 * The cap comes from `run.plannedTotal`, never from settings. Re-reading the live
 * `loop.maxIterations` here is exactly the mid-run drift the freeze exists to
 * prevent, and an override write is the one moment when doing so would look
 * reasonable. A legacy Run with a snapshot but no recorded total gains one here,
 * with the documented fallback cap — better than leaving the operator without a
 * denominator for a plan they just changed.
 */
export function plannedTotalPatch(
  run: WorkflowRun,
  overrides: readonly PhaseOverride[]
): { plannedTotal?: RunPlannedTotal } {
  const phases = run.pipeline?.phases;
  if (!phases || phases.length === 0) return {};
  return {
    plannedTotal: computePlannedTotal({
      phases,
      overrides,
      iterationCap: run.plannedTotal?.iterationCap ?? DEFAULT_ITERATION_CAP
    })
  };
}

/**
 * The numerator: distinct phases of the plan that are settled and not excluded.
 *
 * Restricted to ids the frozen snapshot actually lists, so a `PhaseResult` for a
 * phase that is no longer in the plan cannot inflate the count past the total.
 */
export function countCompletedInPlan(run: WorkflowRun): number {
  const planned = new Set<string>();
  for (const phase of run.pipeline?.phases ?? []) planned.add(phase.id);
  const excluded = excludedPhaseIds(run.phaseOverrides);
  const settled = new Set<string>();
  for (const result of run.phasesCompleted) {
    if (!SETTLED_OUTCOMES.has(result.result)) continue;
    if (excluded.has(result.phase)) continue;
    if (!planned.has(result.phase)) continue;
    settled.add(result.phase);
  }
  return settled.size;
}

/**
 * FR-R3-158 (FR-003a) — the numerator and its denominator, paired here and
 * nowhere else.
 *
 * This adds no arithmetic. `countCompletedInPlan` and the recorded
 * `plannedTotal` are called exactly as they stand, and every rule the pair
 * inherits — the settled-outcome set, the override exclusion applied to both
 * sides, counting distinct ids rather than records — stays where it already
 * lives. What is new is only that the two are handed over **together**.
 *
 * That is the point, and it is this module's own note about a numerator and a
 * denominator derived by two different rules, applied one layer out. Before
 * this, the only site that paired them was the Run projector; a Task row wanting
 * the same figure had to obtain a total some other way, and the way it reached
 * for — the length of a pipeline it looked up itself — does not subtract
 * overrides. Six of five is what that produces. A caller that cannot get one
 * number without the other cannot reproduce it.
 *
 * `null` means **unknown**, never "settled nothing". It is returned for no Run
 * at all and for a Run that froze no plan: there is no denominator to report
 * against, and `{ settled: 0, total: 0 }` renders as a complete run of nothing.
 * A Run that genuinely settled no phase returns `{ settled: 0, total: N }`.
 */
export function settledPhaseProgress(
  run: WorkflowRun | null | undefined
): TaskPhaseProgressProjection | null {
  const total = run?.plannedTotal;
  if (!run || !total) return null;
  return Object.freeze({ settled: countCompletedInPlan(run), total: total.phaseCount });
}

/**
 * FR-R3-158 (FR-009) — the spreadable patch that records a Run's settled-phase
 * pair onto the Task record it belongs to, for use in the *same* object literal
 * that writes the terminal status.
 *
 * Spread-shaped on `plannedTotalPatch`'s precedent directly above, and for the
 * same reason: the two cases the call site faces are one line rather than a
 * branch, and an unknown pair writes **no key at all**. That distinction is the
 * whole contract. Absence means unknown; `{ settled: 0, total: N }` means a Run
 * that genuinely settled nothing; and `{ settled: 0, total: 0 }` — what a
 * non-optional zero default would produce — reads as a complete run of nothing
 * and is never written.
 *
 * The capture has to happen at the terminal transition because Runs are held one
 * per queue: the next task to start replaces the Run that knows the figure, and
 * a row asked afterwards has nothing to answer from. That disposal erasing the
 * count is the defect this feature exists to end.
 */
export function phaseProgressPatch(
  run: WorkflowRun | null | undefined
): { phaseProgress?: TaskPhaseProgressProjection } {
  const progress = settledPhaseProgress(run);
  return progress === null ? {} : { phaseProgress: progress };
}
