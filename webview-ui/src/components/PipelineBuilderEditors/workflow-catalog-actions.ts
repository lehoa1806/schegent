// Feature 083 (US5, T059, FR-035) — the two destructive Workflow writes.
//
// Both live here rather than in `WorkflowCatalogEditor.svelte` for one reason
// that matters and one that does not. The one that matters: the confirmation
// and the mutation it authorises belong in the same scope, so a future edit
// cannot move the `useConfirm` away from the write without moving it out of
// this file entirely — which is the shape `tests/lint/destructive-actions.lint.test.ts`
// scans for. The one that does not: it keeps the editor inside the
// repository-wide 500-line Svelte budget.
//
// Neither function sends anything. Each returns the request the caller should
// send, or `null` when the operator declined, so the caller keeps one submit
// path with one pending-revision gate — a second `saveWorkflows` call site per
// action would be a second place to get that gate wrong.
//
// A `remove` is expressed as an omission: the save is the whole target layer,
// so the removed row is simply absent from `workflows`, and a `reset` is the
// same statement made about every row at once.

import type { SaveWorkflowsRequest } from '../../lib/save-workflows';
import type { WritableWorkflowDefinitionScope } from '../../lib/snapshot-types';
import { useConfirm } from '../../lib/use-confirm';
import { toSaveWorkflowRow } from './workflow-catalog-state';
import type { MutableWorkflow } from './types';

export interface WorkflowRemovalRequest {
  /** The row to drop. Its scope must be writable; a built-in row is refused. */
  readonly row: MutableWorkflow;
  readonly scope: WritableWorkflowDefinitionScope;
  readonly expectedRevision: string;
  /** Every row currently in `scope`, including `row`. */
  readonly layer: readonly MutableWorkflow[];
  /** Focus returns here when the dialog closes. */
  readonly originatingElement: HTMLElement | null;
}

/**
 * Confirm a single-row removal and build the write that performs it.
 *
 * @returns the request to send, or `null` if the operator declined.
 */
export async function confirmWorkflowRemoval(
  request: WorkflowRemovalRequest
): Promise<SaveWorkflowsRequest | null> {
  const { row, scope, expectedRevision, layer, originatingElement } = request;
  const confirmed = await useConfirm('catalog.remove-workflow', {
    originatingElement,
    context: { workflowName: row.name, workflowId: row.workflowId, scope }
  });
  if (!confirmed) return null;
  return {
    scope,
    expectedRevision,
    mutation: { kind: 'remove', workflowId: row.workflowId },
    workflows: layer
      .filter((candidate) => candidate.sourceKey !== row.sourceKey)
      .map(toSaveWorkflowRow)
  };
}

export interface WorkflowResetRequest {
  readonly scope: WritableWorkflowDefinitionScope;
  readonly expectedRevision: string;
  /** How many rows the scope is about to lose; shown in the prompt. */
  readonly workflowCount: number;
  readonly originatingElement: HTMLElement | null;
}

/**
 * Confirm emptying the whole scope layer and build the write that performs it.
 *
 * @returns the request to send, or `null` if the operator declined.
 */
export async function confirmWorkflowLayerReset(
  request: WorkflowResetRequest
): Promise<SaveWorkflowsRequest | null> {
  const { scope, expectedRevision, workflowCount, originatingElement } = request;
  const confirmed = await useConfirm('catalog.reset-workflows', {
    originatingElement,
    context: { scope, workflowCount }
  });
  if (!confirmed) return null;
  return { scope, expectedRevision, mutation: { kind: 'reset' }, workflows: [] };
}
