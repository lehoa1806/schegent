// FR-R3-010 — egress response validator for CMD_RESOLVE_AUDIT_POINTER.
// Inbound request validation is generated in `src/contracts/generated/validators/history-evidence.ts`.

import type { ResolveAuditPointerResponse } from '../sidebar-ipc';

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
