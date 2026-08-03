// Feature 084 T021 / feature 085 T013 — boundary validation for the process
// exchange commands.
//
// `resourceId` is bounded at the catalog's own id length so an over-long string
// is rejected here rather than travelling into the resolver, and `resourceKind`
// is checked against the closed set the format admits (FR-020a). No field here
// names a filesystem location, in either direction.

import { PIPELINE_ID_MAX_LEN } from '../../config/pipeline-definition-validator';
import { PHASE_ID_MAX_LEN } from '../../config/process-definition-validator';
import {
  CMD_EXPORT_PROCESS_YAML,
  CMD_PREFLIGHT_PROCESS_YAML,
  type SidebarCommand
} from '../sidebar-ipc';
import type { PipelineExportInclusion } from '../sidebar-ipc/process-yaml';
import { fail, hasUnexpectedKeys, ok, type IpcValidationResult } from './shared';

const EXPORT_INCLUSIONS: readonly PipelineExportInclusion[] = [
  'references-only',
  'include-referenced'
];

/**
 * Feature 085 (FR-012, research R8) — a Phase has no references, so the
 * inclusion choice does not exist for it. The wire type is a discriminated
 * union, and this is where that discrimination is enforced: `inclusion` is
 * required for a Pipeline and rejected for a Phase, rather than being ignored.
 */
export function validateExportProcessYaml(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('missing-payload', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
  }
  const value = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(value, ['resourceKind', 'resourceId', 'inclusion'])) {
    return fail('unexpected-payload-fields', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
  }
  const resourceKind = value['resourceKind'];
  if (resourceKind !== 'phase' && resourceKind !== 'pipeline') {
    return fail('invalid-resource-kind', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
  }
  const resourceId = value['resourceId'];
  if (typeof resourceId !== 'string' || resourceId.length === 0) {
    return fail('invalid-resource-id', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
  }
  const maxLength = resourceKind === 'phase' ? PHASE_ID_MAX_LEN : PIPELINE_ID_MAX_LEN;
  if (resourceId.length > maxLength) {
    return fail('resource-id-too-long', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
  }
  if (resourceKind === 'phase') {
    if (value['inclusion'] !== undefined) {
      return fail('unexpected-payload-fields', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
    }
    return ok({
      type: CMD_EXPORT_PROCESS_YAML,
      correlationId,
      payload: { resourceKind: 'phase', resourceId }
    } as SidebarCommand);
  }
  const inclusion = value['inclusion'];
  if (!EXPORT_INCLUSIONS.includes(inclusion as PipelineExportInclusion)) {
    return fail('invalid-inclusion', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
  }
  return ok({
    type: CMD_EXPORT_PROCESS_YAML,
    correlationId,
    payload: { resourceKind: 'pipeline', resourceId, inclusion: inclusion as PipelineExportInclusion }
  } as SidebarCommand);
}

/**
 * Feature 084 T027 / feature 085 T013 — preflight carries NOTHING. No location,
 * no bytes, no scope, and no kind: the host opens its own dialog, does its own
 * read (FR-020a), and dispatches on the `kind:` the document itself declares
 * (FR-055a). Any field here would be either a wire-level location leak or a
 * classification the operator should never have had to make, so every one is
 * rejected rather than ignored.
 */
export function validatePreflightProcessYaml(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('missing-payload', { type: CMD_PREFLIGHT_PROCESS_YAML, correlationId });
  }
  if (hasUnexpectedKeys(payload as Record<string, unknown>, [])) {
    return fail('unexpected-payload-fields', { type: CMD_PREFLIGHT_PROCESS_YAML, correlationId });
  }
  return ok({
    type: CMD_PREFLIGHT_PROCESS_YAML,
    correlationId,
    payload: {}
  } as SidebarCommand);
}
