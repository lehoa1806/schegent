import type { CMD_READ_FAILURE_RECORD, CommandBase } from '../sidebar-ipc';
import type { FailureRecordV1 } from '../failure-record';

// FR-R4-F15 (feature 243, contract Q1) — the sidebar's half of "Show last error".
//
// A failed Run leaves a bounded record on disk that outlives its row. The "Show last error" region
// asks for it by NAMING THE ROW, not a file: the request carries a queue id and a task id, the host
// finds the row in the requesting window's own state, reads that Run's newest record, and answers on
// the ack. Neither direction carries a path. The response's record is already redacted, stripped of
// control characters, path-free and bounded by the host's writer; the webview validates it again with
// the shared record validator before it renders anything, and renders it as text only.
//
// Read-only: it MUST stay out of `MUTATING_COMMANDS`, and it takes no primacy or trust gate, because
// reading a Run's own failure diagnostics changes nothing, and a secondary window is entitled to it as
// it is to the history description.
export interface ReadFailureRecordRequest {
  readonly queueId: string;
  readonly taskId: string;
}

export interface ReadFailureRecordCommand extends CommandBase<typeof CMD_READ_FAILURE_RECORD> {
  readonly payload: ReadFailureRecordRequest;
}

/**
 * The five answers about a row, plus the failure arm the boundary needs.
 *
 * `none`, `expired`, `unavailable` and `malformed` are ANSWERS, not refusals: the Run recorded nothing,
 * retention removed the record, the host cannot say, or the newest file could not be read. They ack as
 * `accepted`, and the panel gives each its own sentence, because "it aged out" and "something broke"
 * are different facts and the same word would put a true answer on the error path. `recordCount` is
 * the number of records the Run has on disk, at least 1 where it appears.
 */
export type ReadFailureRecordResponse =
  | {
      readonly outcome: 'available';
      readonly queueId: string;
      readonly taskId: string;
      readonly record: FailureRecordV1;
      readonly recordCount: number;
    }
  | {
      readonly outcome: 'none' | 'expired' | 'unavailable';
      readonly queueId: string;
      readonly taskId: string;
    }
  | {
      readonly outcome: 'malformed';
      readonly queueId: string;
      readonly taskId: string;
      readonly recordCount: number;
    }
  | { readonly outcome: 'failure'; readonly reason: 'unknown-row' | 'internal-error' };
