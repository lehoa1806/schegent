// FR-R5-F19 (feature 278, T19.1, FR-003) — "Open decision record" IPC helper. The SINGLE call site for
// `CMD_OPEN_DECISION_RECORD`.
//
// Components MUST NOT import the command constant or call `postCommand` for it directly: they route
// through `openDecisionRecord()` below. Read-only, so it takes no `useConfirm` gate. The request names the
// row and nothing else; the host answers with one of nine outcomes on the ack and no path or record text.
// Every outcome has a specific sentence here, and a refusal the host's own gate gives (an untrusted
// workspace, a secondary window) goes through the shared refusal text.

import { CMD_OPEN_DECISION_RECORD, type DecisionRecordOutcome } from './messages';
import { boundaryRefusalText } from './boundary-refusal-text';
import { postCommand } from './vscode-api';
import { snapshotStore } from './snapshot-store.svelte';
import { isValidOpenDecisionRecordResponse } from '../../../src/contracts/validators/decision-record';

const ACK_TIMEOUT_MS = 5000;

/** What one request ended as: the host's outcome, a refusal reason, or no answer in time. */
export type OpenDecisionRecordResult =
  | { readonly kind: 'outcome'; readonly outcome: DecisionRecordOutcome }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'unknown' };

/** One sentence per outcome. `opened` is the only one that says the record is on screen. */
export const DECISION_RECORD_OUTCOME_TEXT: Readonly<Record<DecisionRecordOutcome, string>> = Object.freeze({
  opened: 'The decision record is open in a read-only document.',
  'row-not-found': 'This window no longer holds that queue row, so its decision record cannot be opened.',
  'no-record': 'This work has no decision record yet.',
  'outside-root': 'The recorded feature directory is not inside this workspace, so nothing was opened.',
  'symlink-refused': 'The decision record is reached through a symbolic link, so it was not opened.',
  'too-large': 'The decision record is larger than the size this view will open.',
  'not-a-file': 'The decision record path is not a regular file, so nothing was opened.',
  unreadable: 'The decision record could not be read. Check the Schegent log.',
  'workspace-not-trusted': 'The workspace is not trusted, so the decision record cannot be opened.'
});

/** The sentence a result is shown as. Total: every result has one. */
export function decisionRecordResultText(result: OpenDecisionRecordResult): string {
  switch (result.kind) {
    case 'outcome':
      return DECISION_RECORD_OUTCOME_TEXT[result.outcome];
    case 'refused':
      return boundaryRefusalText(result.reason);
    default:
      return 'The host has not answered yet, so it is not known whether the record opened.';
  }
}

/** Posts the request for `rowId` and resolves with the validated result. Never rejects. */
export function openDecisionRecord(rowId: string): Promise<OpenDecisionRecordResult> {
  return new Promise<OpenDecisionRecordResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finalise = (result: OpenDecisionRecordResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (unsubscribe !== null) {
        try {
          unsubscribe();
        } catch {
          // one-shot listener errors must not leak
        }
        unsubscribe = null;
      }
      resolve(result);
    };

    const correlationId = postCommand(CMD_OPEN_DECISION_RECORD, { rowId }).correlationId;
    snapshotStore.markPending(correlationId);
    unsubscribe = snapshotStore.onceAck(correlationId, (ack) => {
      if (isValidOpenDecisionRecordResponse(ack.result)) {
        finalise({ kind: 'outcome', outcome: ack.result.outcome });
        return;
      }
      finalise(
        ack.status === 'rejected'
          ? { kind: 'refused', reason: ack.reason ?? 'command-dispatch-failed' }
          : { kind: 'refused', reason: 'command-result-unrecognized' }
      );
    });

    timer = setTimeout(() => {
      finalise({ kind: 'unknown' });
    }, ACK_TIMEOUT_MS);
  });
}
