// Feature 086 T021/T027 — the export closure walk, both levels.
//
// `referencedPhaseOrder` in `pipeline-document.ts` is level 1's rule one level
// down, and this module deliberately mirrors its shape: a projection off the
// authored graph, derived at a single site, so the order the exporter refuses in
// and the order the document writes in cannot disagree (FR-021).
//
// Level 2 (T027) is a second walk over the Pipelines level 1 yields, not a
// generalization of it. Two levels, two functions, because their inputs are
// different kinds of thing — a graph's nodes and a list of resolved Pipelines —
// and because a Phase references nothing, so there is no third level and nothing
// recursive to bound.

import type { PipelineDefinition } from '../../contracts/pipeline-definitions';
import type { WorkflowNode } from '../../contracts/workflow-definitions';
import { referencedPhaseOrder } from './pipeline-document';

/**
 * The distinct Pipelines a graph's nodes name, in first-occurrence order
 * (FR-020, FR-021).
 *
 * `Set` preserves insertion order, so the first node to name a Pipeline fixes
 * its position and every later node naming the same one collapses onto it. That
 * is what makes the walk both idempotent and order-preserving: de-duplicating at
 * the LAST occurrence would move a Pipeline's position in the document when a
 * further node referenced it again, changing the bytes without changing the
 * catalog.
 *
 * The order is authored, never sorted. Sorted output would be identical for
 * every permutation of the graph — determinism of the wrong kind, since it would
 * also be identical for a graph the operator deliberately reordered.
 *
 * This is a projection, and `nodes` is read-only in both senses. Two nodes on
 * one Pipeline yield one definition and remain two nodes with their own
 * identities (FR-017, FR-062): the document carries a lookup table beside the
 * graph, never a graph rewritten to deduplicate itself.
 */
export function referencedPipelineOrder(nodes: readonly WorkflowNode[]): readonly string[] {
  return [...new Set(nodes.map((node) => node.pipelineId))];
}

/**
 * The distinct Phases a closure's Pipelines name, in first-occurrence order across
 * their concatenated `phaseIds` (FR-019, FR-020).
 *
 * `pipelines` must already be in the order `referencedPipelineOrder` fixed, and
 * this walk does not re-derive or re-sort it: level 1 owns that order, and a
 * second opinion here would let the two sections of one document disagree about
 * which Pipeline came first.
 *
 * One seen-set spanning the whole level — `referencedPhaseOrder` over the
 * concatenation, not once per Pipeline — because the document holds one lookup
 * table. Per-Pipeline de-duplication would put a shared Phase at two positions
 * with no rule for which one a reader takes.
 *
 * That set is deliberately SEPARATE from level 1's. A Pipeline and a Phase may
 * legitimately share an identifier: they are different resource kinds in
 * different sections. Threading one set through both levels would drop such a
 * Phase from the closure and export a package that does not resolve — the exact
 * failure a self-contained export exists to prevent.
 *
 * Termination is by construction: a Phase references nothing, so the closure is
 * exactly two levels deep, nothing re-enters level 1, and there is no depth limit
 * to configure or reach. A Phase named after the Pipeline that names it is not a
 * cycle and is not treated as one.
 */
export function referencedPhaseClosure(
  pipelines: readonly PipelineDefinition[]
): readonly string[] {
  return referencedPhaseOrder(pipelines.flatMap((pipeline) => [...pipeline.phaseIds]));
}
