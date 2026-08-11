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
import { validateWorkflowGraph } from '../../config/workflow-graph-validator';
import type { PipelineDefinition, PipelineSourceRecord } from '../../contracts/pipeline-definitions';
import type { PhaseDefinition, PhaseSourceRecord } from '../../contracts/process-definitions';
import type { WorkflowDefinition } from '../../contracts/workflow-definitions';
import type { BlockedDependency, BlockedReason, ImportDefect, ImportPlanRow } from './types';

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

/**
 * `'dependency-blocked'` is deliberately not admitted here (feature 086): this
 * helper reports how a PHASE reference resolved, and a Phase has no dependencies
 * of its own, so its failure is always a root cause. The propagated arm belongs
 * one level up, where a Workflow waits on a Pipeline that is itself blocked.
 */
function blocked(
  code: 'dependency-absent' | 'dependency-unresolvable',
  phaseId: string
): Extract<PhaseDependencyResolution, { status: 'blocked' }> {
  return Object.freeze({
    status: 'blocked' as const,
    reason: Object.freeze({
      code,
      dependency: Object.freeze({ kind: 'phase' as const, resourceId: phaseId })
    })
  });
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

// ---------------------------------------------------------------------------
// Feature 086 T043/T044 — the third pass (FR-035 – FR-043, data-model.md §4.2).
//
// Pass 3 is pass 2 one level up, and everything above applies unchanged: the
// EFFECTIVE Pipeline catalog decides resolution, stored rows only separate
// "supply it" from "repair it", and references resolve BEFORE the graph is
// validated.
//
// One thing is genuinely new, and it is the reason this pass could not simply be
// the same function with different types. A Phase has no dependencies, so a
// blocked Phase reference is always a root cause. A PIPELINE has dependencies, so
// a Workflow can be well-formed, name a Pipeline the document supplies, and still
// be unimportable because that Pipeline is itself blocked. Reporting that as
// `dependency-absent` would tell the operator to supply a Pipeline the document
// already contains; `dependency-blocked` carries `via` so they get a chain from
// what they selected to what is actually wrong (FR-040).
//
// Pass 2's verdicts arrive the same way pass 1's do — through the PLANNED ROWS,
// not a second verdict map. The planner already records a pass-2-blocked Pipeline
// as a `blocked` row, so reading the rows means the two passes cannot disagree
// about a Pipeline's fate: there is only one record of it.
// ---------------------------------------------------------------------------

/**
 * How one referenced `pipelineId` resolves. Mirrors {@link PhaseDependencyResolution},
 * with the propagated blocked arm now reachable in the `reason`.
 */
export type PipelineDependencyResolution =
  | { readonly status: 'resolved-effective' }
  | { readonly status: 'resolved-planned' }
  | { readonly status: 'resolved-skipped' }
  | { readonly status: 'blocked'; readonly reason: BlockedReason };

/**
 * Pass 3's reads. Extends the Phase context rather than replacing it because the
 * planner holds one context for all three passes — a Workflow's node Pipelines
 * were themselves resolved against `effectivePhases`, and splitting the context
 * would let the two halves be built from different catalog reads.
 *
 * The Pipeline triple mirrors the Phase triple exactly. `invalidPipelines` is the
 * one addition: `pipelineId` → short cause, supplied by the CALLER from the
 * shipped `invalidPipelineCauses`, so an id that resolved to an invalid record
 * stays distinguishable from an absent one when the graph pass names a transitive
 * cause. Deriving it here would be a second implementation of a question the
 * catalog already answers.
 */
export interface WorkflowResolutionContext extends PackageResolutionContext {
  readonly effectivePipelines: readonly PipelineDefinition[];
  readonly storedPipelines: readonly PipelineSourceRecord[];
  readonly plannedPipelineRows: readonly ImportPlanRow[];
  readonly invalidPipelines: ReadonlyMap<string, string>;
}

export type WorkflowResolution =
  | { readonly outcome: 'resolved' }
  | { readonly outcome: 'blocked'; readonly reason: BlockedReason }
  | { readonly outcome: 'invalid'; readonly defects: readonly ImportDefect[] };

function pipelineDependency(pipelineId: string): BlockedDependency {
  return Object.freeze({ kind: 'pipeline' as const, resourceId: pipelineId });
}

/** The Pipeline definitions this plan's `import` rows will write, in plan order. */
function plannedPipelines(context: WorkflowResolutionContext): readonly PipelineDefinition[] {
  const definitions: PipelineDefinition[] = [];
  for (const row of context.plannedPipelineRows) {
    // `skip`, `blocked`, and `invalid` are all absent, for the three reasons
    // pass 2 gives: a skipped row is not written, an invalid row does not claim
    // its id (FR-029), and a blocked row is the one a node must NOT be able to
    // resolve against — admitting it would let a Workflow validate against a
    // Pipeline this write is not going to make effective.
    if (row.outcome !== 'import' || row.resourceKind !== 'pipeline') continue;
    definitions.push(row.definition);
  }
  return definitions;
}

/**
 * The effective Pipeline catalog union the Pipelines this same confirmed write
 * will make effective (FR-035a).
 *
 * The Pipeline-level twin of {@link prospectivePhaseCatalog}, and a carve-out on
 * exactly the same terms: a planned Pipeline is a fully validated definition this
 * write makes effective BEFORE the Workflow is written, so a self-contained
 * package is not reported broken on the very Pipelines it ships. Preflight only —
 * nothing persists this projection, and every other call site passes the
 * unaugmented effective catalog.
 */
export function prospectivePipelineCatalog(
  context: WorkflowResolutionContext
): readonly PipelineDefinition[] {
  const byId = new Map<string, PipelineDefinition>();
  for (const definition of context.effectivePipelines) {
    byId.set(definition.pipelineId, definition);
  }
  for (const definition of plannedPipelines(context)) {
    if (!byId.has(definition.pipelineId)) byId.set(definition.pipelineId, definition);
  }
  return Object.freeze([...byId.values()]);
}

/**
 * How one referenced Pipeline id resolves, and when it does not, which of the
 * three failures it is.
 *
 * The rule set read top to bottom, and the order is the shipped Phase order with
 * one arm inserted: this document's own `import` supplies it (FR-035); the
 * effective catalog holds it, whether or not the document also declared it
 * (FR-036); this document declared it and pass 2 blocked it, so the fault is one
 * level further down (FR-039); otherwise the stored rows say only whether the
 * operator should supply a Pipeline or repair one (FR-038).
 *
 * The blocked-row check sits AFTER the effective read on purpose. The two are
 * mutually exclusive through the planner — a claimed id plans `skip`, never
 * `blocked` — but the function must be total, and if an id does resolve in the
 * effective catalog then the node resolves, whatever this document's own copy did.
 */
export function resolvePipelineDependency(
  pipelineId: string,
  context: WorkflowResolutionContext
): PipelineDependencyResolution {
  if (plannedPipelines(context).some((definition) => definition.pipelineId === pipelineId)) {
    return Object.freeze({ status: 'resolved-planned' as const });
  }

  if (context.effectivePipelines.some((definition) => definition.pipelineId === pipelineId)) {
    const declared = context.plannedPipelineRows.some(
      (row) =>
        row.outcome === 'skip' && row.resourceKind === 'pipeline' && row.resourceId === pipelineId
    );
    return Object.freeze({
      status: declared ? ('resolved-skipped' as const) : ('resolved-effective' as const)
    });
  }

  const blockedRow = context.plannedPipelineRows.find(
    (row) =>
      row.outcome === 'blocked' && row.resourceKind === 'pipeline' && row.resourceId === pipelineId
  );
  if (blockedRow?.outcome === 'blocked') {
    // `via` is read straight off pass 2's own reason rather than re-derived, so
    // both root-cause codes reach the operator unchanged — a `via` that always
    // said "absent" would send them to supply a Phase that needs repairing. A
    // Pipeline depends only on Phases, so what is read here is always a Phase;
    // taking the whole `dependency` keeps that a fact about pass 2 rather than an
    // assumption restated here.
    return Object.freeze({
      status: 'blocked' as const,
      reason: Object.freeze({
        code: 'dependency-blocked' as const,
        dependency: pipelineDependency(pipelineId),
        via: blockedRow.reason.dependency
      })
    });
  }

  // Not a second resolution attempt — the reference is already unresolved. This
  // read only distinguishes the operator's next action.
  const claimed = context.storedPipelines.some((row) => row.pipelineId === pipelineId);
  return Object.freeze({
    status: 'blocked' as const,
    reason: Object.freeze({
      code: claimed ? ('dependency-unresolvable' as const) : ('dependency-absent' as const),
      dependency: pipelineDependency(pipelineId)
    })
  });
}

/**
 * The root Workflow's outcome, so far as its node Pipelines decide it.
 *
 * Resolve before validate (FR-041), for the reason one level up from FR-033: a
 * connection's ports are derived from its nodes' Pipelines, so with a Pipeline
 * missing there is nothing to check the endpoints against. Reporting
 * `unresolved-endpoint` here would tell the operator to fix a Workflow whose
 * graph may be perfectly correct (FR-037).
 *
 * When every node resolves, `validateWorkflowGraph` runs — and it stays the single
 * endpoint, cycle, and condition detector. Nothing in this module re-derives what
 * it decides.
 */
export function resolveWorkflowDependencies(
  definition: WorkflowDefinition,
  context: WorkflowResolutionContext
): WorkflowResolution {
  for (const node of definition.nodes) {
    // Authored node order, so which unresolved reference is reported is the
    // document's own order. A repeated Pipeline resolves the same way each time
    // by construction (FR-042).
    const resolution = resolvePipelineDependency(node.pipelineId, context);
    if (resolution.status === 'blocked') {
      return Object.freeze({ outcome: 'blocked' as const, reason: resolution.reason });
    }
  }

  const errors = validateWorkflowGraph(
    definition,
    prospectivePipelineCatalog(context),
    context.invalidPipelines
  );
  if (errors.length === 0) return Object.freeze({ outcome: 'resolved' as const });

  return Object.freeze({
    outcome: 'invalid' as const,
    defects: Object.freeze(errors.map(asDefect))
  });
}
