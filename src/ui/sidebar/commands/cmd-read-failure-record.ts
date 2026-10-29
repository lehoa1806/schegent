import type { ReadFailureRecordCommand, ReadFailureRecordResponse } from '../messages';
import { historyErrorCode } from '../../../services/history/error-code';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

// FR-R4-F15 (feature 243, contract Q4) — "Show last error" reads the row's newest failure record.
//
// Read-only: it MUST stay out of `MUTATING_COMMANDS`, and it takes no primacy gate, no trust gate and
// no confirmation. It reads a Run's own failure record, which a failed Run wrote about itself, and
// mutates nothing; a secondary window is entitled to it exactly as it is to the history description.
// No path crosses the wire: the request carries two identifiers and the response carries none.
//
// `none`, `expired`, `unavailable` and `malformed` ack as **accepted**. They are true answers to the
// question asked (the Run recorded nothing, retention removed the record, the host cannot say, the
// file could not be read), and the panel gives each its own sentence. Acking them as rejected would
// route a true answer through the webview's error path, the conflation `cmd-resolve-history-
// description.ts` records for its own `missing` and `unreadable` arms.
const INTERNAL_ERROR: ReadFailureRecordResponse = { outcome: 'failure', reason: 'internal-error' };

export const handler: CommandHandler<ReadFailureRecordCommand> = async (ctx, command) => {
  const read = ctx.deps.readFailureRecord;
  if (read === undefined) {
    await ack(ctx, 'rejected', 'internal-error', INTERNAL_ERROR);
    return;
  }

  let answer: ReadFailureRecordResponse;
  try {
    answer = await read({ queueId: command.payload.queueId, taskId: command.payload.taskId });
  } catch (err) {
    // The code, never the caught message or the identifiers: a filesystem error quotes the absolute
    // path it was addressing, and the queue and task ids name an operator's work.
    ctx.deps.logger.warn(`sidebar router: failure record read failed: ${historyErrorCode(err)}`);
    await ack(ctx, 'rejected', 'internal-error', INTERNAL_ERROR);
    return;
  }

  // The service answers `unknown-row` rather than the validator: a pair that names no row in this
  // window is stale state, not a malformed message.
  if (answer.outcome === 'failure') {
    await ack(ctx, 'rejected', answer.reason, answer);
    return;
  }
  await ack(ctx, 'accepted', undefined, answer);
};
