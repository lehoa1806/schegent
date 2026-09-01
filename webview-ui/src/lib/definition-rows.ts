// Feature 101 (FR-R3-017) T030 — the three authored row shapes, kept when the
// save shims that declared them were deleted.
//
// `save-phases.ts`, `save-pipelines.ts`, and `save-workflows.ts` were transports
// that also happened to own these types. The transport is gone — a Builder save
// is now one `saveDefinitionDraft` naming one definition (FR-026a) — but the
// shapes are not: they are what an editor serialises a row *to*, and what the
// import path publishes. Two callers in two directories, so they live beside the
// dispatcher in `lib/` rather than inside either one's folder.
//
// A row IS the definition body, forwarded verbatim. The store never validates
// and never normalises one (099 FR-010, FR-011), so nothing between an editor and
// the version record reshapes it — which is also why the pre-082 helpers' habit
// of posting a narrowed `{ pipelines }` payload could silently drop authored
// contract fields, and why nothing here does that.

import type { PhaseCapability } from '../../../src/contracts/phase-capabilities';
import type {
  PhaseEvidencePolicy,
  PhaseHostVerification,
  PhaseSideEffects
} from '../../../src/contracts/process-definitions';
import type {
  PhaseBinding,
  PhaseDefinition,
  PipelineExecutionDefaults,
  PipelineInputPort,
  PipelineOutputPort,
  WorkflowConnection,
  WorkflowNode
} from './snapshot-types';

/**
 * The Phase body an editor serialises a row to.
 *
 * The note above says a row IS the definition body and that nothing here narrows
 * one. That was the intent and not the fact: this interface named eleven of the
 * twenty-one fields in `AUTHORED_PHASE_FIELDS`, and `toSavePhaseRow` narrowed to
 * exactly those — so the containment declarations (`sideEffects`,
 * `capabilities`) were dropped on every save, which is the pre-082 habit the note
 * was written to disown. The ten missing names are added here and the builder now
 * walks the authored set instead of restating it.
 *
 * `phaseId` is absent on purpose: the Builder row is `id`-keyed, and a body
 * carrying both spellings is what the host refuses as `identity-ambiguous`.
 */
export interface SavePhaseRow {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly version: number;
  readonly instruction?: string;
  readonly skill?: string;
  readonly model?: string;
  readonly effort?: PhaseDefinition['effort'];
  readonly timeoutSeconds?: number;
  readonly spendBoundUsd?: number;
  readonly spendBoundTokens?: number;
  readonly loopable?: boolean;
  readonly retryCondition?: string;
  readonly isRequired?: boolean;
  readonly forceContinueOnRetryCap?: boolean;
  readonly runner?: string;
  readonly sideEffects?: PhaseSideEffects;
  readonly evidencePolicy?: PhaseEvidencePolicy;
  readonly hostVerification?: PhaseHostVerification;
  readonly capabilities?: readonly PhaseCapability[];
}

/**
 * An authored row as the Builder emits it. Both the portable key form
 * (`pipelineId` / `phaseIds`) and the legacy authored form (`id` / `phases`)
 * are accepted by the host validator, so the row type carries both; the host
 * rejects a row that supplies neither.
 */
export interface SavePipelineRow {
  readonly id?: string;
  readonly pipelineId?: string;
  readonly name: string;
  readonly description?: string;
  readonly version: number;
  readonly phases?: readonly string[];
  readonly phaseIds?: readonly string[];
  readonly inputs?: readonly PipelineInputPort[];
  readonly outputs?: readonly PipelineOutputPort[];
  readonly bindings?: readonly PhaseBinding[];
  readonly executionDefaults?: PipelineExecutionDefaults;
  readonly recommendedNext?: readonly string[];
}

/**
 * An authored row as the Builder emits it. Unlike a Pipeline row there is no
 * legacy key form to accommodate: the Workflow catalog is newer than the split,
 * so `workflowId` is the only identity spelling.
 *
 * Authored node and connection order is part of the payload's meaning (083
 * FR-049), so nothing sorts, dedupes, or normalises the graph on the way out.
 */
export interface SaveWorkflowRow {
  readonly workflowId: string;
  readonly name: string;
  readonly description?: string;
  readonly version: number;
  readonly nodes: readonly WorkflowNode[];
  readonly connections: readonly WorkflowConnection[];
  readonly startNodeIds: readonly string[];
}

/** The id a Pipeline row is addressed by; `''` when it declares neither spelling. */
export function pipelineRowId(row: SavePipelineRow): string {
  return row.pipelineId ?? row.id ?? '';
}
