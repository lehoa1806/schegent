// Feature 082 (T024) — CMD_SAVE_PIPELINES ingress validator.
//
// Structurally identical to `save-phases.ts`: the two catalog saves share one
// revisioned complete-layer envelope. The pre-082 payload carrying no revision
// at all is turned away here as `invalid-payload` (gate 2 of
// specs/082-pipeline-contracts-builder/contracts/save-pipelines-ipc.md) — the
// ingress gate is the only place it can be rejected before router dispatch.
//
// Feature 099 (FR-042) — `scope` is no longer part of the envelope. It named the
// layer a write landed in, and there is one catalog per kind, so it is not
// merely optional here: an envelope that still carries it is an envelope from a
// caller that believes in layers, and `hasUnexpectedKeys` refuses it.

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
  // Feature 085 (FR-036) — the one kind that names a SET, and so the only one
  // carrying no `pipelineId`. Without this arm the envelope the import commit
  // sends is dropped at the transport boundary and never reaches the handler that
  // implements it.
  if (mutation.kind === 'import-package') {
    return !hasUnexpectedKeys(mutation, ['kind', 'pipelineIds'])
      && Array.isArray(mutation.pipelineIds)
      && mutation.pipelineIds.length > 0
      && mutation.pipelineIds.every(validPipelineId);
  }
  return mutation.kind === 'duplicate'
    // Feature 099 (FR-043) — `sourceScope` left the duplicate mutation with the
    // layer tier. It said which layer to copy FROM, and one catalog per kind
    // leaves the source id naming the row exactly. Still listed nowhere, so an
    // envelope carrying it is refused rather than silently stripped.
    && !hasUnexpectedKeys(mutation, ['kind', 'sourcePipelineId', 'pipelineId'])
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
  const invalid = hasUnexpectedKeys(value, ['expectedRevision', 'mutation', 'pipelines'])
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
      expectedRevision: value.expectedRevision,
      mutation: value.mutation,
      pipelines: value.pipelines
    }
  } as SidebarCommand);
}
