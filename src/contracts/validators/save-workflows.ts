// Feature 083 (T026) — CMD_SAVE_WORKFLOWS ingress validator.
//
// Structurally identical to `save-pipelines.ts` and `save-phases.ts`: all three
// catalog saves share one scoped, revisioned complete-layer envelope. This gate
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
  return mutation.kind === 'duplicate'
    && !hasUnexpectedKeys(mutation, ['kind', 'sourceScope', 'sourceWorkflowId', 'workflowId'])
    && (mutation.sourceScope === 'built-in'
      || mutation.sourceScope === 'user'
      || mutation.sourceScope === 'workspace')
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
  const invalid = hasUnexpectedKeys(value, ['scope', 'expectedRevision', 'mutation', 'workflows'])
    || (value.scope !== 'user' && value.scope !== 'workspace')
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
      scope: value.scope,
      expectedRevision: value.expectedRevision,
      mutation: value.mutation,
      workflows: value.workflows
    }
  } as SidebarCommand);
}
