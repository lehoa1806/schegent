// Feature 083 (US1, T034) — shared saveWorkflows helper.
// Feature 100 (FR-R3-016) T509b — rewritten onto the lifecycle IPC.
//
// The Workflow half of the translation described in `save-phases.ts`. Two things
// are specific to this layer:
//
// Authored node and connection order is part of the payload's meaning (FR-049),
// and the row becomes the definition body unchanged, so nothing here sorts,
// dedupes, or normalises the graph.
//
// The `reset` intent has no successor. It emptied the whole layer in one write,
// which the store can no longer do: a package addresses definitions by id, and
// removal is now one confirmed deactivation per definition. A button whose
// atomicity the store does not provide is a button that lies, so the Reset action
// is gone from the editor rather than reimplemented as a loop; a bulk surface, if
// one is wanted, is FR-R3-017's to design. The union arm survives only because it
// is declared in the shared snapshot types.

import { NO_DRAFT } from '../../../src/contracts/catalog-lifecycle';
import type {
  WorkflowCatalogMutation,
  WorkflowConnection,
  WorkflowNode
} from './snapshot-types';
import {
  deactivateDefinition,
  publishDefinitionPackage,
  EMPTY_LAYER,
  type LifecycleResult,
  type PostMessage
} from './catalog-lifecycle';

/**
 * An authored row as the Builder emits it. Unlike a Pipeline row there is no
 * legacy key form to accommodate: the Workflow catalog is new in this feature,
 * so `workflowId` is the only identity spelling.
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

export type SaveWorkflowsMutation = WorkflowCatalogMutation;

export interface SaveWorkflowsRequest {
  readonly expectedRevision: string;
  readonly mutation: SaveWorkflowsMutation;
  readonly workflows: readonly SaveWorkflowRow[];
  /** Feature 100 (T509b) — shown in the removal prompt. See `save-phases.ts`. */
  readonly removedName?: string;
  /** Focus returns here when the removal prompt closes. */
  readonly originatingElement?: HTMLElement | null;
}

export type SaveWorkflowsResult = LifecycleResult;

/** Make the authored Workflow layer effective. */
export function saveWorkflows(
  request: SaveWorkflowsRequest,
  postMessage?: PostMessage
): Promise<SaveWorkflowsResult> {
  const { expectedRevision, mutation, workflows } = request;
  if (mutation.kind === 'remove') {
    return deactivateDefinition(
      { kind: 'workflow', id: mutation.workflowId, expectedDraftVersion: NO_DRAFT },
      {
        definitionName: request.removedName ?? mutation.workflowId,
        originatingElement: request.originatingElement ?? null
      },
      postMessage
    );
  }
  if (workflows.length === 0) return Promise.resolve(EMPTY_LAYER);
  return publishDefinitionPackage(
    {
      layers: [
        {
          kind: 'workflow',
          expectedRevision,
          definitions: workflows.map((row) => ({ id: row.workflowId, body: row }))
        }
      ]
    },
    postMessage
  );
}
