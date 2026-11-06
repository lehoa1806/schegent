import type { CMD_OPEN_DECISION_RECORD, CommandBase } from '../sidebar-ipc';
import type { DecisionRecordOutcome } from '../decision-record';

// FR-R5-F19 (feature 278, T19.1) — the sidebar's "open the decision record" request.
//
// A blocked row's operator opens the feature's `decisions.md` from the row. The request NAMES THE ROW
// and nothing else: no path, no text, no note. The host finds the row's Run in this window's own state,
// reads the record under the trusted workspace root and shows it in a read-only document. The answer
// carries an outcome and no path and no record text, so the wire holds neither.
//
// Read-only for the router: it starts no process and writes no state, file or audit row, so it stays
// out of `MUTATING_COMMANDS`. Because the router's trust gate does not run for it, the handler refuses
// itself in an untrusted workspace (`workspace-not-trusted`).
export { type DecisionRecordOutcome };

export interface OpenDecisionRecordRequest {
  readonly rowId: string;
}

export interface OpenDecisionRecordCommand extends CommandBase<typeof CMD_OPEN_DECISION_RECORD> {
  readonly payload: OpenDecisionRecordRequest;
}

export interface OpenDecisionRecordResponse {
  readonly outcome: DecisionRecordOutcome;
}
