import {
  CMD_RESOLVE_AUDIT_POINTER,
  type ResolveAuditPointerResponse,
  type SidebarCommand
} from '../sidebar-ipc';
import {
  QUEUE_ID_MAX,
  fail,
  hasUnexpectedKeys,
  ok,
  type IpcValidationResult
} from './shared';

// FR-R3-010 — the drill-down request carries one identifier and nothing else.
// The bound is the same `QUEUE_ID_MAX` every other identifier on this boundary
// uses; a run id the host minted is far shorter, and matching the shared bound
// keeps one number to reason about rather than a per-command table.
//
// This validator does not check that the run exists. Existence is state, not
// shape, and the handler answers it with `unknown-run` — a validator that
// refused an unknown id would report a stale history row as a malformed message.
export function validateResolveAuditPointer(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type: CMD_RESOLVE_AUDIT_POINTER, correlationId });
  }
  const value = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(value, ['runId'])) {
    return fail('unexpected-payload-fields', { type: CMD_RESOLVE_AUDIT_POINTER, correlationId });
  }
  const runId = value['runId'];
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > QUEUE_ID_MAX) {
    return fail('invalid-runId', { type: CMD_RESOLVE_AUDIT_POINTER, correlationId });
  }
  return ok({
    type: CMD_RESOLVE_AUDIT_POINTER,
    correlationId,
    payload: { runId }
  } as SidebarCommand);
}

// FR-R3-010 — the response the webview must trust before rendering. Validated
// arm by arm on `outcome`, because the whole point of the union is that the
// three "no evidence" answers are rendered differently from `failure` (T411).
// A helper that only checked `typeof outcome === 'string'` would let a
// malformed ack fall through to whichever arm the renderer tested last, which
// is how "the log was rotated" starts presenting as "something went wrong".
export function isValidResolveAuditPointerResponse(
  value: unknown
): value is ResolveAuditPointerResponse {
  if (value === null || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  switch (response['outcome']) {
    case 'resolved':
      if (typeof response['runId'] !== 'string') return false;
      if (typeof response['truncated'] !== 'boolean') return false;
      if (typeof response['parseWarnings'] !== 'number') return false;
      return Array.isArray(response['entries']) && response['entries'].every(isValidEvidenceEntry);
    case 'evidence-expired':
    case 'no-evidence-recorded':
      return typeof response['runId'] === 'string';
    case 'unaddressable':
      return true;
    case 'failure':
      // A closed set, checked as one. The reason reaches a message the operator
      // reads, so an unrecognised token must not be rendered verbatim — that is
      // the seam an adapter's own error text would come through.
      return (
        response['reason'] === 'unknown-run' ||
        response['reason'] === 'corpus-unreadable' ||
        response['reason'] === 'internal-error'
      );
    default:
      return false;
  }
}

function isValidEvidenceEntry(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['id'] === 'string' &&
    typeof entry['timestamp'] === 'string' &&
    typeof entry['eventType'] === 'string' &&
    typeof entry['phase'] === 'string' &&
    typeof entry['iteration'] === 'number' &&
    typeof entry['outcome'] === 'string'
  );
}
