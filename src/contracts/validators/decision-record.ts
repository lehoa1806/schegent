// FR-R5-F19 (feature 278) — egress response validator for CMD_OPEN_DECISION_RECORD.
// Inbound request validation is generated in `src/contracts/generated/validators/history-evidence.ts`.

import { DECISION_RECORD_OUTCOMES } from '../decision-record';

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
