// Feature 085 T039/T040 — dependency resolution for a package (FR-030a, FR-033).
//
// The SECOND oracle. `import-planner.ts` owns the first — presence, read from
// stored rows at every status, which decides whether a write would destroy work
// an operator authored. This module decides something else entirely: whether the
// Pipeline being imported can actually run. Those two questions have different
// right answers on the same catalog, and research R6 is the record of why they
// must never be answered from one read:
//
//   presence broad on purpose    — a shadowed or invalid row still claims its id
//   resolution narrow on purpose — a shadowed or invalid row is not what runs
//
// The visible consequence is a row pair that reads like a contradiction and is
// not: the Phase row is `skip` because the id is claimed, and the Pipeline row is
// `blocked` naming that same id because the claim does not resolve (FR-030b).
//
// Resolving against stored rows instead would be the project hard rule — never
// resolve a Pipeline binding against anything but the effective Phase catalog —
// broken one layer earlier, at plan time rather than at save time, and the
// symptom would be a package that imports cleanly and fails on its first run.
//
// Pure and total. Errors are values; nothing here throws or performs I/O.

import { validatePipelineBindings } from '../../config/pipeline-binding-validator';
import type { PipelineDefinition } from '../../contracts/pipeline-definitions';
import type { PhaseDefinition, PhaseSourceRecord } from '../../contracts/process-definitions';
import type { BlockedReason, ImportDefect, ImportPlanRow } from './types';

/**
 * How one referenced `phaseId` resolves.
 *
 * The three resolved arms are distinguished for reporting, not for behavior:
 * every one of them satisfies the reference. What differs is where the Phase
 * comes from, which is what an operator reading a partial import needs to know.
 */
export type PhaseDependencyResolution =
  | { readonly status: 'resolved-effective' }
  | { readonly status: 'resolved-planned' }
  | { readonly status: 'resolved-skipped' }
  | { readonly status: 'blocked'; readonly reason: BlockedReason };

/**
 * The three reads resolution needs, kept apart for the same reason the planner
 * keeps its two apart.
 *
 * `effectivePhases` decides resolution (FR-030a). `storedPhases` is consulted for
 * one thing only — telling an id no layer holds from an id a layer holds and
 * cannot resolve (FR-030c) — and never to satisfy a reference. `plannedPhaseRows`
 * is this same plan's already-decided Phase rows, which is how a self-contained
 * package resolves against the Phases it supplies (FR-035) without the resolver
 * having to re-read the document.
 */
export interface PackageResolutionContext {
  readonly effectivePhases: readonly PhaseDefinition[];
  readonly storedPhases: readonly PhaseSourceRecord[];
  readonly plannedPhaseRows: readonly ImportPlanRow[];
}

export type PipelineResolution =
  | { readonly outcome: 'resolved' }
  | { readonly outcome: 'blocked'; readonly reason: BlockedReason }
  | { readonly outcome: 'invalid'; readonly defects: readonly ImportDefect[] };

function blocked(
  code: BlockedReason['code'],
  phaseId: string
): Extract<PhaseDependencyResolution, { status: 'blocked' }> {
  return Object.freeze({ status: 'blocked' as const, reason: Object.freeze({ code, phaseId }) });
}

/** The Phase definitions this plan's `import` rows will write, in plan order. */
function plannedPhases(context: PackageResolutionContext): readonly PhaseDefinition[] {
  const definitions: PhaseDefinition[] = [];
  for (const row of context.plannedPhaseRows) {
    // An `invalid` row is deliberately absent from this list: a malformed
    // resource does not claim its id (FR-032), so it can neither satisfy a
    // reference nor be written. A `skip` row is absent because it is not
    // written either — whatever resolves that id is already in the effective
    // catalog, or is precisely the unresolvable row FR-030b describes.
    if (row.outcome !== 'import' || row.resourceKind !== 'phase') continue;
    definitions.push(row.definition);
  }
  return definitions;
}

/**
 * The effective Phase catalog union the Phases this same confirmed write will
 * make effective (FR-046a).
 *
 * Exported so the union has a name and a direct test rather than being an
 * anonymous concat inside the binding call. It is not a loophole in the
 * effective-catalog hard rule — it is that rule used as designed: a planned Phase
 * is a fully validated definition that this write makes effective BEFORE the
 * Pipeline is written (FR-038). Without it every self-contained package fails
 * validation on the Phases it is itself supplying.
 *
 * The effective definition wins a collision. That is unreachable through the
 * planner — a claimed id plans `skip`, never `import` — but a union must be
 * total, and what runtime resolves today is the honest answer.
 */
export function prospectivePhaseCatalog(
  context: PackageResolutionContext
): readonly PhaseDefinition[] {
  const byId = new Map<string, PhaseDefinition>();
  for (const definition of context.effectivePhases) {
    byId.set(definition.phaseId, definition);
  }
  for (const definition of plannedPhases(context)) {
    if (!byId.has(definition.phaseId)) byId.set(definition.phaseId, definition);
  }
  return Object.freeze([...byId.values()]);
}

/**
 * How one referenced Phase id resolves, and when it does not, which of the two
 * failures it is (FR-030c).
 *
 * The order matters and is the rule set read top to bottom: this document's own
 * `import` supplies it (FR-035); the effective catalog holds it, whether or not
 * the document also declared it (FR-034); otherwise it is unresolved, and the
 * stored rows say only whether the operator should supply a Phase or repair one.
 */
export function resolvePhaseDependency(
  phaseId: string,
  context: PackageResolutionContext
): PhaseDependencyResolution {
  if (plannedPhases(context).some((definition) => definition.phaseId === phaseId)) {
    return Object.freeze({ status: 'resolved-planned' as const });
  }

  if (context.effectivePhases.some((definition) => definition.phaseId === phaseId)) {
    // FR-034 — a dependency planned `skip` counts as resolved, and this is the
    // reason why: presence in the catalog is what resolves a reference, not
    // being written by this import. The `skip` is reported rather than tested
    // for, so the skip itself is never the thing that satisfies anything.
    const declared = context.plannedPhaseRows.some(
      (row) => row.outcome === 'skip' && row.resourceKind === 'phase' && row.resourceId === phaseId
    );
    return Object.freeze({
      status: declared ? ('resolved-skipped' as const) : ('resolved-effective' as const)
    });
  }

  // Not a second resolution attempt — the reference is already unresolved. This
  // read only distinguishes the operator's next action: supply the Phase, or
  // repair the row that already claims the id.
  const claimed = context.storedPhases.some((row) => row.phaseId === phaseId);
  return blocked(claimed ? 'dependency-unresolvable' : 'dependency-absent', phaseId);
}

/** `PipelineFieldError` reported as a plan defect. */
function asDefect(error: {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}): ImportDefect {
  // `pipelineId` is dropped on purpose: the row that carries these defects
  // already names the resource, and repeating it on every defect would make the
  // id look like part of the defect.
  return Object.freeze({ field: error.field, code: error.code, message: error.message });
}

/**
 * The root Pipeline's outcome, so far as its dependencies decide it.
 *
 * References are resolved BEFORE bindings are validated, and that order is the
 * whole of FR-033. An unresolved Phase also makes every binding addressing it
 * fail, so validating first would report a binding defect and tell the operator
 * to fix a Pipeline that is not wrong. `invalid` is reserved for defects in the
 * resource itself; a missing dependency is somewhere else, and only one of the
 * two is fixed by importing something first.
 *
 * `recommendedNext` never participates (FR-035a). It is advisory navigation
 * between Pipelines, carried verbatim in both directions; a dangling
 * recommendation is not a defect and blocks nothing.
 */
export function resolvePipelineDependencies(
  definition: PipelineDefinition,
  context: PackageResolutionContext
): PipelineResolution {
  for (const phaseId of definition.phaseIds) {
    // Sequence order, so which unresolved reference is reported is the
    // document's own order rather than whichever the iteration reached first. A
    // repeated Phase resolves the same way both times by construction.
    const resolution = resolvePhaseDependency(phaseId, context);
    if (resolution.status === 'blocked') {
      return Object.freeze({ outcome: 'blocked' as const, reason: resolution.reason });
    }
  }

  const errors = validatePipelineBindings(definition, prospectivePhaseCatalog(context));
  if (errors.length === 0) return Object.freeze({ outcome: 'resolved' as const });

  // FR-046a — a binding defect is the Pipeline being wrong, found now rather
  // than as a write failure after the operator has already confirmed. Every
  // defect is carried, not the first (FR-027).
  return Object.freeze({
    outcome: 'invalid' as const,
    defects: Object.freeze(errors.map(asDefect))
  });
}
