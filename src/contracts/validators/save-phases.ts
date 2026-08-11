import { CMD_SAVE_PHASES, type SidebarCommand } from '../sidebar-ipc';
import type { PhaseCatalogMutation } from '../process-definitions';
import { fail, hasUnexpectedKeys, ok, type IpcValidationResult } from './shared';

function validPhaseId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

function validMutation(value: unknown): value is PhaseCatalogMutation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const mutation = value as Record<string, unknown>;
  if (mutation.kind === 'reset') return !hasUnexpectedKeys(mutation, ['kind']);
  if (
    mutation.kind === 'create' ||
    mutation.kind === 'import' ||
    mutation.kind === 'edit' ||
    mutation.kind === 'remove'
  ) {
    return !hasUnexpectedKeys(mutation, ['kind', 'phaseId']) && validPhaseId(mutation.phaseId);
  }
  // Feature 085 (FR-036) — the one kind that names a SET, and so the only one
  // carrying no `phaseId`. Without this arm the envelope the import commit sends
  // is dropped at the transport boundary and never reaches the handler that
  // implements it.
  if (mutation.kind === 'import-package') {
    return !hasUnexpectedKeys(mutation, ['kind', 'phaseIds'])
      && Array.isArray(mutation.phaseIds)
      && mutation.phaseIds.length > 0
      && mutation.phaseIds.every(validPhaseId);
  }
  return mutation.kind === 'duplicate'
    && !hasUnexpectedKeys(mutation, ['kind', 'sourceScope', 'sourcePhaseId', 'phaseId'])
    && (mutation.sourceScope === 'built-in'
      || mutation.sourceScope === 'user'
      || mutation.sourceScope === 'workspace')
    && validPhaseId(mutation.sourcePhaseId)
    && validPhaseId(mutation.phaseId);
}

export function validateSavePhases(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('missing-payload', { type: CMD_SAVE_PHASES, correlationId });
  }
  const value = payload as Record<string, unknown>;
  const invalid = hasUnexpectedKeys(value, ['scope', 'expectedRevision', 'mutation', 'phases'])
    || (value.scope !== 'user' && value.scope !== 'workspace')
    || typeof value.expectedRevision !== 'string'
    || value.expectedRevision.length === 0
    || value.expectedRevision.length > 128
    || !Array.isArray(value.phases)
    || !validMutation(value.mutation);
  if (invalid) return fail('invalid-payload', { type: CMD_SAVE_PHASES, correlationId });
  return ok({
    type: CMD_SAVE_PHASES,
    correlationId,
    payload: {
      scope: value.scope,
      expectedRevision: value.expectedRevision,
      mutation: value.mutation,
      phases: value.phases
    }
  } as SidebarCommand);
}
