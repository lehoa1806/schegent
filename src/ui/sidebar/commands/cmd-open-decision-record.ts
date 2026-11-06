import type { OpenDecisionRecordCommand, OpenDecisionRecordResponse } from '../messages';
import { historyErrorCode } from '../../../services/history/error-code';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

// FR-R5-F19 (feature 278, T19.1, contract decision-record-open.md) — "Open decision record" on a row.
//
// Read-only: it stays out of `MUTATING_COMMANDS` and takes no primacy gate. It also takes no router
// trust gate, so the opener refuses itself in an untrusted workspace (`workspace-not-trusted`); the
// record is a file in the workspace and an untrusted workspace's files are not read on a click.
//
// All nine outcomes ack as **accepted**: each is a true answer (no record yet, over the size bound, a
// refused symlink, the workspace is not trusted) and the panel gives each its own sentence. Only a
// missing opener or a throw is `rejected`, and a throw is logged by code, never by row id, path or
// message. The request carries one row id and the response carries an outcome, so no path and no record
// text crosses the wire.
const INTERNAL_ERROR_REASON = 'internal-error';

export const handler: CommandHandler<OpenDecisionRecordCommand> = async (ctx, command) => {
  const open = ctx.deps.openDecisionRecord;
  if (open === undefined) {
    await ack(ctx, 'rejected', INTERNAL_ERROR_REASON);
    return;
  }

  let answer: OpenDecisionRecordResponse;
  try {
    answer = await open({ rowId: command.payload.rowId });
  } catch (err) {
    ctx.deps.logger.warn(`sidebar router: decision record open failed: ${historyErrorCode(err)}`);
    await ack(ctx, 'rejected', INTERNAL_ERROR_REASON);
    return;
  }
  await ack(ctx, 'accepted', undefined, answer);
};
