// Feature 082 (T024) — CMD_SAVE_PIPELINES ingress validator.
//
// Structurally identical to `save-phases.ts`: the two catalog saves share one
// scoped, revisioned complete-layer envelope. The pre-082 unscoped
// `{ pipelines }` payload is turned away here as `invalid-payload` (gate 2 of
// specs/082-pipeline-contracts-builder/contracts/save-pipelines-ipc.md) — the
// ingress gate is the only place it can be rejected before router dispatch.

import { CMD_SAVE_PIPELINES, type SidebarCommand } from '../sidebar-ipc';
import type { PipelineCatalogMutation } from '../pipeline-definitions';
import { fail, hasUnexpectedKeys, ok, type IpcValidationResult } from './shared';

function validPipelineId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

function validMutation(value: unknown): value is PipelineCatalogMutation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const mutation = value as Record<string, unknown>;
  if (mutation.kind === 'reset') return !hasUnexpectedKeys(mutation, ['kind']);
  if (mutation.kind === 'create' || mutation.kind === 'edit' || mutation.kind === 'remove') {
    return !hasUnexpectedKeys(mutation, ['kind', 'pipelineId']) && validPipelineId(mutation.pipelineId);
  }
  return mutation.kind === 'duplicate'
    && !hasUnexpectedKeys(mutation, ['kind', 'sourceScope', 'sourcePipelineId', 'pipelineId'])
    && (mutation.sourceScope === 'built-in'
      || mutation.sourceScope === 'user'
      || mutation.sourceScope === 'workspace')
    && validPipelineId(mutation.sourcePipelineId)
    && validPipelineId(mutation.pipelineId);
}

export function validateSavePipelines(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('missing-payload', { type: CMD_SAVE_PIPELINES, correlationId });
  }
  const value = payload as Record<string, unknown>;
  const invalid = hasUnexpectedKeys(value, ['scope', 'expectedRevision', 'mutation', 'pipelines'])
    || (value.scope !== 'user' && value.scope !== 'workspace')
    || typeof value.expectedRevision !== 'string'
    || value.expectedRevision.length === 0
    || value.expectedRevision.length > 128
    || !Array.isArray(value.pipelines)
    || !validMutation(value.mutation);
  if (invalid) return fail('invalid-payload', { type: CMD_SAVE_PIPELINES, correlationId });
  return ok({
    type: CMD_SAVE_PIPELINES,
    correlationId,
    payload: {
      scope: value.scope,
      expectedRevision: value.expectedRevision,
      mutation: value.mutation,
      pipelines: value.pipelines
    }
  } as SidebarCommand);
}
