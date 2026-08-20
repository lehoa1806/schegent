// Feature 082 (US1, T028) — shared savePipelines helper.
// Feature 100 (FR-R3-016) T509b — rewritten onto the lifecycle IPC.
//
// The Pipeline half of the translation described in `save-phases.ts`: same
// retired command, same `expectedRevision` gate carried onto one package layer,
// same routing of a `remove` to `deactivateDefinition` because a package publish
// cannot express an omission. See that file for the reasoning; it is not repeated
// here so the two cannot drift into two different explanations.
//
// The row is still forwarded verbatim as the definition body. The pre-082 helper
// posted `{ pipelines }` and dropped every authored contract field on the floor;
// nothing here reshapes it, so ports, bindings, and execution defaults reach the
// store intact — and the store never validates a body (099 FR-010), so this is
// the only place that could have damaged them.

import { NO_DRAFT } from '../../../src/contracts/catalog-lifecycle';
import type {
  PhaseBinding,
  PipelineCatalogMutation,
  PipelineExecutionDefaults,
  PipelineInputPort,
  PipelineOutputPort
} from './snapshot-types';
import {
  deactivateDefinition,
  publishDefinitionPackage,
  EMPTY_LAYER,
  type LifecycleResult,
  type PostMessage
} from './catalog-lifecycle';

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

export type SavePipelinesMutation = PipelineCatalogMutation;

export interface SavePipelinesRequest {
  readonly expectedRevision: string;
  readonly mutation: SavePipelinesMutation;
  readonly pipelines: readonly SavePipelineRow[];
  /** Feature 100 (T509b) — shown in the removal prompt. See `save-phases.ts`. */
  readonly removedName?: string;
  /** Focus returns here when the removal prompt closes. */
  readonly originatingElement?: HTMLElement | null;
}

export type SavePipelinesResult = LifecycleResult;

/**
 * Make the authored Pipeline layer effective.
 *
 * A row's id is `pipelineId` or `id` — the two authored spellings the host
 * validator accepts. A package addresses definitions by id, so one of them has to
 * be chosen here; a row carrying neither is dropped rather than published under
 * an empty id, which the host would refuse as a malformed layer and report
 * against the whole document instead of the row that caused it.
 */
export function savePipelines(
  request: SavePipelinesRequest,
  postMessage?: PostMessage
): Promise<SavePipelinesResult> {
  const { expectedRevision, mutation, pipelines } = request;
  if (mutation.kind === 'remove') {
    return deactivateDefinition(
      { kind: 'pipeline', id: mutation.pipelineId, expectedDraftVersion: NO_DRAFT },
      {
        definitionName: request.removedName ?? mutation.pipelineId,
        originatingElement: request.originatingElement ?? null
      },
      postMessage
    );
  }
  const definitions = pipelines
    .map((row) => ({ id: row.pipelineId ?? row.id ?? '', body: row }))
    .filter((definition) => definition.id.length > 0);
  if (definitions.length === 0) return Promise.resolve(EMPTY_LAYER);
  return publishDefinitionPackage(
    { layers: [{ kind: 'pipeline', expectedRevision, definitions }] },
    postMessage
  );
}
