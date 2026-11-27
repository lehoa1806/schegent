// FR-R3-071 — egress response validator for CMD_RESOLVE_HISTORY_DESCRIPTION.
// Inbound request validation is generated in `src/contracts/generated/validators/history-evidence.ts`.

import type { ResolveHistoryDescriptionResponse } from '../sidebar-ipc';

// FR-R3-071 — validated arm by arm, because the arms are rendered differently:
// `resolved`/`legacy` replace what the operator is about to submit, while
// `missing`/`unreadable` leave the honest preview in place. A helper that only
// checked `typeof outcome === 'string'` would let a malformed ack fall through
// to whichever arm the renderer tested last — and on this command that means
// seeding a launcher with a `description` field that was never validated.
export function isValidResolveHistoryDescriptionResponse(
  value: unknown
): value is ResolveHistoryDescriptionResponse {
  if (value === null || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  switch (response['outcome']) {
    case 'resolved':
    case 'legacy':
      return typeof response['runId'] === 'string' && typeof response['description'] === 'string';
    case 'missing':
    case 'unreadable':
      return typeof response['runId'] === 'string';
    case 'failure':
      // A closed set, checked as one: the reason reaches operator-facing text,
      // so an unrecognised token must never be rendered verbatim.
      return response['reason'] === 'unknown-run' || response['reason'] === 'internal-error';
    default:
      return false;
  }
}
