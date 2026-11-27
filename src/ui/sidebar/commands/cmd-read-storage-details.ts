import type { ReadStorageDetailsCommand, ReadStorageDetailsResponse } from '../messages';
import { historyErrorCode } from '../../../services/history/error-code';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

// FR-R6-F05 (FR-021, contract surfaces-and-wiring.md §5) — the sidebar reads storage pressure and
// one inventory page.
//
// Read-only: it MUST stay out of `MUTATING_COMMANDS`, and it takes no primacy gate, no trust gate and
// no confirmation. The reader computes a projection of the lifecycle records and the last scan
// checkpoint; it repairs, sweeps, migrates and probes nothing (C7), so an untrusted workspace and a
// secondary window are entitled to it. No path crosses the wire: the request carries an opaque
// cursor and the response carries opaque ids, sizes and counts.
//
// The answer is the reader's `LifecycleResult` unchanged, so the headless API and this handler give
// the same value for the same state (SC-009). A refusal acks `rejected` with its code as the reason.
const UNAVAILABLE: ReadStorageDetailsResponse = {
  ok: false,
  refusal: { code: 'unavailable', message: 'storage details are unavailable in this window' }
};

export const handler: CommandHandler<ReadStorageDetailsCommand> = async (ctx, command) => {
  const reader = ctx.deps.storageDetails;
  if (reader === undefined) {
    await ack(ctx, 'rejected', 'unavailable', UNAVAILABLE);
    return;
  }

  let answer: ReadStorageDetailsResponse;
  try {
    answer = reader.read(command.payload.cursor);
  } catch (err) {
    // The code, never the caught message: a store error can quote the database path it addressed.
    ctx.deps.logger.warn(`sidebar router: storage details read failed: ${historyErrorCode(err)}`);
    await ack(ctx, 'rejected', 'unavailable', UNAVAILABLE);
    return;
  }

  if (!answer.ok) {
    await ack(ctx, 'rejected', answer.refusal.code, answer);
    return;
  }
  await ack(ctx, 'accepted', undefined, answer);
};
