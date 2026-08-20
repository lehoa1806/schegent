// Feature 101 (US4, T051) — both directions of CMD_READ_DEFINITION_VERSION.
//
// Ingress (`validateReadDefinitionVersion`) is the gate every inbound command
// passes at `sidebar-view-provider.handleInbound`. Egress
// (`isValidReadDefinitionVersionResponse`) is what the webview applies to
// `ack.result`, which arrives as `unknown` — and this command is the only place
// a definition body re-enters the webview outside the snapshot, so it is the
// only place that check can be made.
//
// FR-034 is enforced on both sides by the same device: a closed key set. The
// request admits exactly `kind`, `id`, `versionId` and the response exactly
// `body`, so a path smuggled into either envelope is refused rather than
// ignored. Refusing rather than stripping is this directory's standing rule —
// an envelope carrying a field this host does not know about was built against
// a different contract, and quietly dropping it lets the two drift.
//
// Nothing here inspects the definition body itself. The store keeps bodies
// verbatim (099 FR-010) and a shape check at this boundary would be a second,
// weaker validator sitting in front of the real one in `src/config/`.

import { CMD_READ_DEFINITION_VERSION, type SidebarCommand } from '../sidebar-ipc';
import type { ReadDefinitionVersionResponse } from '../sidebar-ipc/catalog-history';
import { CATALOG_KINDS } from '../catalog-store';
import { fail, hasUnexpectedKeys, ok, type IpcValidationResult } from './shared';

const ID_MAX = 64;
/** Version ids are `v<N>`; the bound is generous and exists only to cap the string. */
const VERSION_ID_MAX = 64;

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

export function validateReadDefinitionVersion(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('missing-payload', { type: CMD_READ_DEFINITION_VERSION, correlationId });
  }
  const value = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(value, ['kind', 'id', 'versionId'])) {
    return fail('unexpected-payload-fields', { type: CMD_READ_DEFINITION_VERSION, correlationId });
  }
  if (!CATALOG_KINDS.some((kind) => kind === value['kind'])) {
    return fail('invalid-payload-field', { type: CMD_READ_DEFINITION_VERSION, correlationId });
  }
  if (!isBoundedString(value['id'], ID_MAX)) {
    return fail('invalid-payload-field', { type: CMD_READ_DEFINITION_VERSION, correlationId });
  }
  if (!isBoundedString(value['versionId'], VERSION_ID_MAX)) {
    return fail('invalid-payload-field', { type: CMD_READ_DEFINITION_VERSION, correlationId });
  }
  return ok({
    type: CMD_READ_DEFINITION_VERSION,
    correlationId,
    payload: { kind: value['kind'], id: value['id'], versionId: value['versionId'] }
  } as SidebarCommand);
}

/**
 * The acknowledgement's result, before the panel renders it.
 *
 * A null or absent body is rejected rather than rendered, which is FR-012b: an
 * empty body is indistinguishable from a definition with no content, so a
 * failed read that fell through to one would look like a successful read of an
 * empty definition. An empty *object* is accepted — that is a real body, and
 * whether a definition ought to have content is not this validator's question.
 */
export function isValidReadDefinitionVersionResponse(
  value: unknown
): value is ReadDefinitionVersionResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  if (hasUnexpectedKeys(response, ['body'])) return false;
  const body = response['body'];
  return body !== null && typeof body === 'object' && !Array.isArray(body);
}
