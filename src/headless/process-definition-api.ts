// Feature 089 T009 — validate one Phase, Pipeline, or Workflow definition.
// Contract: specs/089-headless-parity-qualification/contracts/headless-api.md §1
//
// A primary adapter and nothing else: it checks its two arguments, dispatches on
// the closed `kind` set, and returns the corresponding validator's own result
// (FR-001, FR-005). It is deliberately the shortest of the six entrypoints,
// because every rule it appears to enforce belongs to a validator that already
// existed and is already the sidebar's.
//
// The three results are NOT flattened into one vocabulary. A Phase result names a
// `phaseId` and carries `PhaseFieldError`s, a Pipeline result names a
// `pipelineId` and carries `PipelineFieldError`s, and a Workflow validation IS a
// `WorkflowFieldError` list with no wrapper at all — three shapes because they
// answer three different questions. Collapsing them would mean inventing a fourth
// vocabulary that no existing caller speaks and that would then have to be kept
// in step with all three (FR-005).
//
// The catalog is the caller's, and this module neither resolves nor augments it.
// The preflight carve-out of 085's FR-046a and 086's FR-035a — where a
// self-contained package may be validated against the effective catalog union
// what the same confirmed write will make effective — belongs to the import
// planner and is not reachable from here.
//
// This module imports no editor host API (FR-007) and performs no I/O.

import {
  validatePhaseDefinition,
  type PhaseDefinitionValidationResult
} from '../config/process-definition-validator';
import { validatePipelineBindings } from '../config/pipeline-binding-validator';
import { unknownPhaseErrors } from '../config/pipeline-catalog';
import {
  validatePipelineDefinition,
  type PipelineDefinitionValidationResult
} from '../config/pipeline-definition-validator';
import { validateWorkflowGraph } from '../config/workflow-graph-validator';
import type { PhaseDefinition } from '../contracts/process-definitions';
import type { PipelineDefinition, PipelineFieldError } from '../contracts/pipeline-definitions';
import type { WorkflowDefinition, WorkflowFieldError } from '../contracts/workflow-definitions';
import { checkDefinitionArgs, type BoundaryRefusal } from './process-api-validators';

/** The effective catalog each kind is validated against, supplied by the caller. */
export interface ProcessDefinitionCatalog {
  /** The effective Phase catalog. A Pipeline's bindings resolve against this. */
  readonly phases?: readonly PhaseDefinition[];
  /** The effective Pipeline catalog. A Workflow's nodes resolve against this. */
  readonly pipelines?: readonly PipelineDefinition[];
  /** Pipeline id to the reason it is invalid, as `validateWorkflowGraph` reads it. */
  readonly invalidPipelines?: ReadonlyMap<string, string>;
}

export interface ProcessDefinitionInput {
  readonly kind: 'phase' | 'pipeline' | 'workflow';
  readonly definition: unknown;
  readonly catalog?: ProcessDefinitionCatalog;
}

/**
 * A Pipeline's verdict is its shape result plus its cross-reference errors, kept
 * in the one `errors` list `PipelineDefinitionValidationResult` already declares.
 *
 * The two run in sequence and not in parallel: a binding cannot be resolved
 * against a definition that failed to parse, so a shape failure returns as-is
 * and the cross-reference pass is not entered.
 */
export type ProcessDefinitionVerdict =
  | { readonly kind: 'phase'; readonly result: PhaseDefinitionValidationResult }
  | { readonly kind: 'pipeline'; readonly result: PipelineDefinitionValidationResult }
  | { readonly kind: 'workflow'; readonly errors: readonly WorkflowFieldError[] };

/**
 * The options every non-headless call site passes. They are named here rather
 * than defaulted inside the validators because the two differ: the Pipeline
 * validator falls back to version 1 on its own, the Phase validator does not, so
 * an adapter that passed neither would refuse a version-less Phase the sidebar
 * accepts. Parity is a property of the call, not of the callee (FR-001, FR-003).
 */
const SIDEBAR_OPTIONS = { allowLegacyId: true, defaultVersion: 1 } as const;

function validatePipeline(
  definition: unknown,
  catalog: ProcessDefinitionCatalog
): PipelineDefinitionValidationResult {
  const shape = validatePipelineDefinition(definition, SIDEBAR_OPTIONS);
  if (!shape.ok || shape.definition === null) return shape;
  // Both cross-reference checks, in the order and pairing of `crossReferenceErrors`
  // in `cmd-save-pipelines.ts` gate 5 — a `phaseIds` entry with no effective
  // definition is as much a defect as a binding that cannot resolve, and applying
  // only the second would report a Pipeline clean here that the operator's save
  // refuses (FR-011, FR-015, FR-016).
  //
  // Bound to a name that states the invariant `ProcessDefinitionCatalog` declares:
  // the bindings resolve against the caller's already-resolved effective Phase
  // catalog, never a raw layer.
  const effectivePhases = catalog.phases ?? [];
  const knownPhaseIds = new Set(effectivePhases.map((phase) => phase.phaseId));
  const crossReferenceErrors: readonly PipelineFieldError[] = [
    ...unknownPhaseErrors(shape.definition, knownPhaseIds),
    ...validatePipelineBindings(shape.definition, effectivePhases)
  ];
  if (crossReferenceErrors.length === 0) return shape;
  const errors: readonly PipelineFieldError[] = [...shape.errors, ...crossReferenceErrors];
  return { ...shape, ok: false, errors };
}

export function validateProcessDefinition(
  input: ProcessDefinitionInput
): ProcessDefinitionVerdict | BoundaryRefusal {
  const refusal = checkDefinitionArgs(input);
  if (refusal !== null) return refusal;

  const catalog = input.catalog ?? {};
  if (input.kind === 'phase') {
    return { kind: 'phase', result: validatePhaseDefinition(input.definition, SIDEBAR_OPTIONS) };
  }
  if (input.kind === 'pipeline') {
    return { kind: 'pipeline', result: validatePipeline(input.definition, catalog) };
  }
  // A Workflow has no shape validator with a result wrapper: `validateWorkflowGraph`
  // takes an already-typed definition and answers with defects alone. The cast is
  // the boundary's, and it is why `checkDefinitionArgs` refused a non-object above
  // — every field the graph validator reads it reads defensively.
  //
  // Bound to `effectivePipelines` for the same reason as `effectivePhases` above,
  // and additionally because the FR-035a gate in
  // tests/lint/workflow-graph-effective-catalog.test.ts reads this argument's name:
  // a call site that cannot say the catalog is effective is one that may not be.
  const effectivePipelines = catalog.pipelines ?? [];
  return {
    kind: 'workflow',
    errors: validateWorkflowGraph(
      input.definition as WorkflowDefinition,
      effectivePipelines,
      catalog.invalidPipelines ?? new Map()
    )
  };
}
