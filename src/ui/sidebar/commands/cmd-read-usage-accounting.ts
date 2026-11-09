import type { ReadUsageAccountingCommand, ReadUsageAccountingResponse } from '../messages';
import { queryUsageAccounting } from '../../../headless/usage-accounting-api';
import { historyErrorCode } from '../../../services/history/error-code';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

// FR-R6-F06 (T029, contracts/surfaces-and-wiring.md section 4) — the sidebar reads one
// revision-pinned page of usage accounting.
//
// Read-only: it MUST stay out of `MUTATING_COMMANDS`, and it takes no primacy gate, no trust gate and
// no confirmation. The reader ingests, corrects and imports nothing.
//
// The query goes through the same validator the headless API uses, so an invalid query gets the
// same `invalid-query` answer on both surfaces (clarification 6). A refusal acks `rejected` with its
// code as the reason.
const STORE_UNAVAILABLE: ReadUsageAccountingResponse = { ok: false, refusal: { code: 'store-unavailable' } };
const STORE_ERROR: ReadUsageAccountingResponse = { ok: false, refusal: { code: 'store-error' } };

export const handler: CommandHandler<ReadUsageAccountingCommand> = async (ctx, command) => {
  const reader = ctx.deps.usageAccounting;
  if (reader === undefined) {
    await ack(ctx, 'rejected', 'store-unavailable', STORE_UNAVAILABLE);
    return;
  }

  let answer: ReadUsageAccountingResponse;
  try {
    answer = queryUsageAccounting(reader, command.payload.query);
  } catch (err) {
    // The code, never the caught message: a store error can quote the database path it addressed.
    ctx.deps.logger.warn(`sidebar router: usage accounting read failed: ${historyErrorCode(err)}`);
    await ack(ctx, 'rejected', 'store-error', STORE_ERROR);
    return;
  }

  if (!answer.ok) {
    await ack(ctx, 'rejected', answer.refusal.code, answer);
    return;
  }
  await ack(ctx, 'accepted', undefined, answer);
};
