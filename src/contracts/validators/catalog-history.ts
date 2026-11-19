// Feature 101 (US4, T051) — egress response validator for CMD_READ_DEFINITION_VERSION.
// Inbound request validation is generated in `src/contracts/generated/validators/catalog.ts`.

import type { ReadDefinitionVersionResponse } from '../sidebar-ipc/catalog-history';
import { hasUnexpectedKeys } from './shared';

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
