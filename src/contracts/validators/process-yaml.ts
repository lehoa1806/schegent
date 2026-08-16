// Feature 084 T021 / feature 085 T013 — boundary validation for the process
// exchange commands.
//
// `resourceId` is bounded at the catalog's own id length so an over-long string
// is rejected here rather than travelling into the resolver, and `resourceKind`
// is checked against the closed set the format admits (FR-020a). No field here
// names a filesystem location, in either direction.

import {
  CMD_EXPORT_PROCESS_YAML,
  CMD_PREFLIGHT_PROCESS_YAML,
  type SidebarCommand
} from '../sidebar-ipc';
import { RESOURCE_ID_MAX_LEN, admitsExportInclusion } from '../sidebar-ipc/process-yaml';
import { fail, hasUnexpectedKeys, ok, type IpcValidationResult } from './shared';

type ExportableKind = keyof typeof RESOURCE_ID_MAX_LEN;

/**
 * Derived from `RESOURCE_ID_MAX_LEN`'s own keys, not a re-listed literal union —
 * a second, manually-kept-in-sync copy of this vocabulary is exactly how the
 * Workflow arm shipped unreachable behind this same gate (feature 086); see the
 * comment on `validateExportProcessYaml` below.
 */
function isExportableKind(value: unknown): value is ExportableKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RESOURCE_ID_MAX_LEN, value);
}

/**
 * Feature 085 (FR-012, research R8) — a Phase has no references, so the
 * inclusion choice does not exist for it. The wire type is a discriminated
 * union, and this is where that discrimination is enforced: `inclusion` is
 * required for a Pipeline and rejected for a Phase, rather than being ignored.
 *
 * Feature 086 (T068) adds the Workflow arm, and the kind/mode decision moved to
 * `admitsExportInclusion` beside the union. This validator had its own copy of the
 * Pipeline vocabulary, which is why 086's type widening compiled while a Workflow
 * export was still refused here as `invalid-resource-kind` — dropped at debug
 * level, never reaching the handler that implements it. The distinct failure
 * reasons stay local, because only this gate reports them.
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
  if (!isExportableKind(resourceKind)) {
    return fail('invalid-resource-kind', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
  }
  const resourceId = value['resourceId'];
  // The Model Catalog is a singleton (contract §3): it carries no `resourceId`
  // at all, so its failure here is an extra field rather than a bad value.
  if (resourceKind === 'modelCatalog') {
    if (resourceId !== undefined) {
      return fail('unexpected-payload-fields', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
    }
  } else {
    if (typeof resourceId !== 'string' || resourceId.length === 0) {
      return fail('invalid-resource-id', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
    }
    if (resourceId.length > RESOURCE_ID_MAX_LEN[resourceKind]) {
      return fail('resource-id-too-long', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
    }
  }
  const inclusion = value['inclusion'];
  if (!admitsExportInclusion(resourceKind, inclusion)) {
    // A Phase admits only the absence of an inclusion, so its failure here is an
    // extra field rather than a bad value — the two are different defects and the
    // operator-facing reason should not conflate them.
    const reason = resourceKind === 'phase' ? 'unexpected-payload-fields' : 'invalid-inclusion';
    return fail(reason, { type: CMD_EXPORT_PROCESS_YAML, correlationId });
  }
  return ok({
    type: CMD_EXPORT_PROCESS_YAML,
    correlationId,
    payload:
      resourceKind === 'modelCatalog'
        ? { resourceKind }
        : resourceKind === 'phase'
          ? { resourceKind, resourceId: resourceId as string }
          : { resourceKind, resourceId: resourceId as string, inclusion }
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
