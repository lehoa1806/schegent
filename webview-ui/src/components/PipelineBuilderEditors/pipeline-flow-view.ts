// Feature 184 (FR-R3-141, T001) — what the Pipeline canvas components pass
// between themselves.
//
// The Workflow counterpart is two modules: `workflow-flow-view.ts` for selection
// and callbacks, and `workflow-flow-layout.ts` for placement. There is no
// Pipeline layout module and there is not meant to be one. A Workflow is a graph
// whose nodes have to be *placed* — that is 291 lines of rules with tests. A
// Pipeline sequence is an ordered `string[]` rendered left to right, which is a
// problem `#each` already solves. A reviewer looking for `buildPipelineFlowLayout`
// should find nothing, and this comment is why.
//
// Kept as a bundle rather than as loose props for the same reason the Workflow
// one is: the canvas forwards the whole thing to each card, so it cannot fall out
// of step with itself.

import type { MutablePhase } from './types';
import type { PipelineDraftError } from './pipeline-catalog-state';

/**
 * What the Builder has in focus, and therefore what the inspector renders.
 *
 * `pipeline` is the resting state rather than "nothing selected": the Pipeline's
 * own identity fields have to live somewhere now that the canvas replaced the
 * form, and the inspector is that somewhere.
 *
 * A Phase is addressed by **position**, not by Phase id, because the same Phase
 * may legitimately appear twice in one sequence — `['review', 'fix', 'review']`
 * is an authored Pipeline, not a defect. Every existing anchor, binding remap and
 * test id in the Pipeline surface is already positional for that reason
 * (`pipelines-phase-select-{i}`, `phase-{i}` error anchors,
 * `reorderPipelinePhases(from, to)`), so selecting by id would introduce the one
 * identifier in the surface that cannot address a row uniquely.
 */
export type PipelineFlowSelection =
  | { readonly kind: 'pipeline' }
  | { readonly kind: 'phase'; readonly position: number };

export function samePipelineSelection(
  left: PipelineFlowSelection,
  right: PipelineFlowSelection | null
): boolean {
  if (right === null || left.kind !== right.kind) return false;
  if (left.kind === 'pipeline' || right.kind === 'pipeline') return true;
  return left.position === right.position;
}

/** Everything a Phase card reads, forwarded unchanged from the canvas. */
export interface PipelineFlowView {
  /** The open Pipeline's authored sequence, in order. */
  readonly phases: readonly string[];
  /** The effective Phase catalog, for resolving a card's title. */
  readonly catalog: readonly MutablePhase[];
  /** Indexed alongside `phases`; built with `pipelineErrorsAt` on a `phase` anchor. */
  readonly phaseDefects: readonly (readonly PipelineDraftError[])[];
  /**
   * The Phase summary the old sequence row showed on hover (mapping row 28).
   * Carried on the view rather than passed card by card so the canvas cannot
   * wire it to some cards and not others.
   */
  readonly getPhaseTooltip: (phaseId: string) => string;
  readonly readonly: boolean;
  readonly selection: PipelineFlowSelection | null;
  readonly onselect: (selection: PipelineFlowSelection) => void;
  readonly onmoveup: (position: number) => void;
  readonly onmovedown: (position: number) => void;
  readonly onremove: (position: number) => void;
}

/** The Phase a position names, or null when the effective catalog lacks it. */
export function phaseOf(view: PipelineFlowView, position: number): MutablePhase | null {
  // `.at()`, not `[position]`: without `noUncheckedIndexedAccess` the index
  // signature types an out-of-range read as `string`, which makes the guard below
  // look dead to the type checker while it is exactly what keeps a stale position
  // from resolving. `.at()` is typed `string | undefined`, so the guard is
  // necessary on paper as well as at runtime.
  const phaseId = view.phases.at(position);
  if (phaseId === undefined) return null;
  return view.catalog.find((entry) => entry.id === phaseId) ?? null;
}

/**
 * The card's title. The Phase's name when the effective catalog has it, and the
 * authored id when it does not — never blank. A position naming a Phase that no
 * longer resolves is exactly the state the card has to stay legible in, because
 * it is the state the operator has to fix.
 */
export function phaseTitle(view: PipelineFlowView, position: number): string {
  const phase = phaseOf(view, position);
  const name = phase?.name.trim();
  if (name !== undefined && name.length > 0) return name;
  return view.phases[position] ?? '';
}

/** The hover summary for a position, from the same provider the old row used. */
export function phaseTooltip(view: PipelineFlowView, position: number): string {
  return view.getPhaseTooltip(view.phases[position] ?? '');
}
