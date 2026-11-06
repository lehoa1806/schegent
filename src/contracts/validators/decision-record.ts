import { CMD_OPEN_DECISION_RECORD, type SidebarCommand } from '../sidebar-ipc';
import { DECISION_RECORD_OUTCOMES } from '../decision-record';
import { isRecordIdentifier } from './failure-record';
import { fail, hasUnexpectedKeys, ok, type IpcValidationResult } from './shared';

// FR-R5-F19 (feature 278, contract decision-record-open) — one identifier and nothing else. A row
// that exists is state, not shape: a well-formed id that names no row is the handler's `row-not-found`,
// so a stale id is not reported as a protocol error. A value that is not an identifier at all
// (`../x`, `a/b`, `C:\x`, `%2e%2e`) is refused here and never reaches a filesystem call.
export function validateOpenDecisionRecord(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const context = { type: CMD_OPEN_DECISION_RECORD, correlationId };
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('missing-payload', context);
  }
  const value = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(value, ['rowId'])) return fail('unexpected-payload-fields', context);
  const { rowId } = value;
  if (!isRecordIdentifier(rowId)) return fail('invalid-rowId', context);
  return ok({ ...context, payload: { rowId } } as SidebarCommand);
}

/** The webview's gate before it reads an answer: a closed outcome and no other field. */
export function isValidOpenDecisionRecordResponse(
  value: unknown
): value is { readonly outcome: (typeof DECISION_RECORD_OUTCOMES)[number] } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys.at(0) !== 'outcome') return false;
  const outcome: unknown = (value as Record<string, unknown>)['outcome'];
  return typeof outcome === 'string' && (DECISION_RECORD_OUTCOMES as readonly string[]).includes(outcome);
}
