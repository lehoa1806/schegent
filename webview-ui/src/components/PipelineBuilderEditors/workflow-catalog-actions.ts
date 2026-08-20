// Feature 083 (US5, T059, FR-035) — the destructive Workflow write.
// Feature 100 (FR-R3-016) T509b — one write, not two, and it no longer confirms
// here.
//
// The confirmation moved into `deactivateDefinition`, the only function that can
// post the command it authorises (FR-049). Keeping it at the call site was the
// right shape while a removal was an *omission* from a whole-array save — there
// was no single function to attach it to — but there is one now, and a gate
// inside it cannot be forgotten by the next caller.
//
// `confirmWorkflowLayerReset` is gone with the Reset action. It emptied the whole
// layer in one write, which the store can no longer do: a package addresses
// definitions by id, so emptying a catalog is N independent deactivations. A
// button whose atomicity the store does not provide is a button that lies, and a
// bulk surface — if one is wanted — is FR-R3-017's to design rather than this
// item's to fake with a loop.
//
// This module still builds the request rather than sending it, so the caller
// keeps one submit path with one pending-revision gate.

import type { SaveWorkflowsRequest } from '../../lib/save-workflows';
import { toSaveWorkflowRow } from './workflow-catalog-state';
import type { MutableWorkflow } from './types';

export interface WorkflowRemovalRequest {
  /** The row to drop. */
  readonly row: MutableWorkflow;
  readonly expectedRevision: string;
  /** Every row currently in the catalog, including `row`. */
  readonly layer: readonly MutableWorkflow[];
  /** Focus returns here when the dialog closes. */
  readonly originatingElement: HTMLElement | null;
}

/**
 * Build the write that removes one Workflow.
 *
 * `layer` is still passed and still filtered: the request keeps its whole-array
 * shape until FR-R3-017 replaces it, and the remaining rows are what the caller's
 * optimistic view renders while the deactivation is in flight.
 */
export function buildWorkflowRemoval(request: WorkflowRemovalRequest): SaveWorkflowsRequest {
  const { row, expectedRevision, layer, originatingElement } = request;
  return {
    expectedRevision,
    mutation: { kind: 'remove', workflowId: row.workflowId },
    workflows: layer
      .filter((candidate) => candidate.sourceKey !== row.sourceKey)
      .map(toSaveWorkflowRow),
    removedName: row.name,
    originatingElement
  };
}
