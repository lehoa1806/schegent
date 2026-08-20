// Feature 083 (T026) — CMD_SAVE_WORKFLOWS ingress validator.
//
// Structurally identical to `save-pipelines.ts` and `save-phases.ts`: all three
// catalog saves share one revisioned complete-layer envelope (feature 099
// FR-042 removed the `scope` field; see `save-pipelines.ts`). This gate
// checks the envelope only (gate 2 of
// specs/083-workflow-graph-builder/contracts/save-workflows-ipc.md). Rows stay
// `unknown` — node, connection, and condition shape is the host validator's
// job, so a malformed graph reaches the handler and is reported as an anchored
// `workflow-validation` error rather than an opaque transport rejection.

import { CMD_SAVE_WORKFLOWS, type SidebarCommand } from '../sidebar-ipc';
import type { WorkflowCatalogMutation } from '../workflow-definitions';
import { fail, hasUnexpectedKeys, ok, type IpcValidationResult } from './shared';

function validWorkflowId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

function validMutation(value: unknown): value is WorkflowCatalogMutation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const mutation = value as Record<string, unknown>;
  if (mutation.kind === 'reset') return !hasUnexpectedKeys(mutation, ['kind']);
  if (mutation.kind === 'create' || mutation.kind === 'edit' || mutation.kind === 'remove') {
    return !hasUnexpectedKeys(mutation, ['kind', 'workflowId']) && validWorkflowId(mutation.workflowId);
  }
  // Feature 086 (FR-046) — the one kind that names a SET, and so the only one
  // carrying no `workflowId`. An empty set is refused here rather than left to the
  // intent algebra: the algebra would report it as a mutation mismatch, a reason
  // that describes the diff when the defect is in the envelope. The number of ids
  // is deliberately not capped — the `workflows` layer beside it is not either,
  // and the document that produced both was already bounded upstream.
  if (mutation.kind === 'import-package') {
    return !hasUnexpectedKeys(mutation, ['kind', 'workflowIds'])
      && Array.isArray(mutation.workflowIds)
      && mutation.workflowIds.length > 0
      && mutation.workflowIds.every(validWorkflowId);
  }
  return mutation.kind === 'duplicate'
    // Feature 099 (FR-043) — `sourceScope` left the duplicate mutation with the
    // layer tier. It said which layer to copy FROM, and one catalog per kind
    // leaves the source id naming the row exactly. Still listed nowhere, so an
    // envelope carrying it is refused rather than silently stripped.
    && !hasUnexpectedKeys(mutation, ['kind', 'sourceWorkflowId', 'workflowId'])
    && validWorkflowId(mutation.sourceWorkflowId)
    && validWorkflowId(mutation.workflowId);
}

export function validateSaveWorkflows(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('missing-payload', { type: CMD_SAVE_WORKFLOWS, correlationId });
  }
  const value = payload as Record<string, unknown>;
  const invalid = hasUnexpectedKeys(value, ['expectedRevision', 'mutation', 'workflows'])
    || typeof value.expectedRevision !== 'string'
    || value.expectedRevision.length === 0
    || value.expectedRevision.length > 128
    || !Array.isArray(value.workflows)
    || !validMutation(value.mutation);
  if (invalid) return fail('invalid-payload', { type: CMD_SAVE_WORKFLOWS, correlationId });
  return ok({
    type: CMD_SAVE_WORKFLOWS,
    correlationId,
    payload: {
      expectedRevision: value.expectedRevision,
      mutation: value.mutation,
      workflows: value.workflows
    }
  } as SidebarCommand);
}
