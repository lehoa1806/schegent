// Feature 084 T021 — boundary validation for the Phase exchange commands.
//
// The payload is two fields and nothing else. `resourceId` is bounded at the
// catalog's own id length so an over-long string is rejected here rather than
// travelling into the resolver, and `resourceKind` is checked against the one
// kind this format admits (FR-020a).

import { PHASE_ID_MAX_LEN } from '../../config/process-definition-validator';
import {
  CMD_EXPORT_PROCESS_YAML,
  CMD_PREFLIGHT_PROCESS_YAML,
  type SidebarCommand
} from '../sidebar-ipc';
import { fail, hasUnexpectedKeys, ok, type IpcValidationResult } from './shared';

export function validateExportProcessYaml(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('missing-payload', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
  }
  const value = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(value, ['resourceKind', 'resourceId'])) {
    return fail('unexpected-payload-fields', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
  }
  if (value['resourceKind'] !== 'phase') {
    return fail('invalid-resource-kind', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
  }
  const resourceId = value['resourceId'];
  if (typeof resourceId !== 'string' || resourceId.length === 0) {
    return fail('invalid-resource-id', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
  }
  if (resourceId.length > PHASE_ID_MAX_LEN) {
    return fail('resource-id-too-long', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
  }
  return ok({
    type: CMD_EXPORT_PROCESS_YAML,
    correlationId,
    payload: { resourceKind: 'phase', resourceId }
  } as SidebarCommand);
}

/**
 * Feature 084 T027 — preflight carries the resource kind and nothing else. No
 * location, no bytes, no scope: the host opens its own dialog and does its own
 * read (FR-020a), so any additional field here would be a wire-level location
 * leak and is rejected rather than ignored.
 */
export function validatePreflightProcessYaml(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('missing-payload', { type: CMD_PREFLIGHT_PROCESS_YAML, correlationId });
  }
  const value = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(value, ['resourceKind'])) {
    return fail('unexpected-payload-fields', { type: CMD_PREFLIGHT_PROCESS_YAML, correlationId });
  }
  if (value['resourceKind'] !== 'phase') {
    return fail('invalid-resource-kind', { type: CMD_PREFLIGHT_PROCESS_YAML, correlationId });
  }
  return ok({
    type: CMD_PREFLIGHT_PROCESS_YAML,
    correlationId,
    payload: { resourceKind: 'phase' }
  } as SidebarCommand);
}
