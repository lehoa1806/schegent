import {
  CMD_RESOLVE_HISTORY_DESCRIPTION,
  type ResolveHistoryDescriptionResponse,
  type SidebarCommand
} from '../sidebar-ipc';
import {
  QUEUE_ID_MAX,
  fail,
  hasUnexpectedKeys,
  ok,
  type IpcValidationResult
} from './shared';

// FR-R3-071 — one identifier and nothing else, on the same `QUEUE_ID_MAX`
// bound every other identifier on this boundary uses. As with the evidence
// drill-down, existence is state rather than shape: an unknown run id is the
// handler's `unknown-run`, not a malformed message, or a stale history row
// would be reported to the operator as a protocol error.
export function validateResolveHistoryDescription(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type: CMD_RESOLVE_HISTORY_DESCRIPTION, correlationId });
  }
  const value = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(value, ['runId'])) {
    return fail('unexpected-payload-fields', {
      type: CMD_RESOLVE_HISTORY_DESCRIPTION,
      correlationId
    });
  }
  const runId = value['runId'];
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > QUEUE_ID_MAX) {
    return fail('invalid-runId', { type: CMD_RESOLVE_HISTORY_DESCRIPTION, correlationId });
  }
  return ok({
    type: CMD_RESOLVE_HISTORY_DESCRIPTION,
    correlationId,
    payload: { runId }
  } as SidebarCommand);
}

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
