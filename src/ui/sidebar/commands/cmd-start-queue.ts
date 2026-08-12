// BUG-002 (FR-012a) — Start-Queue handler. Promotes the oldest pending
// task to in-flight by invoking `schegent.startQueue` (which delegates
// to `controller.drainQueuedWork()` → `AutoDrainCoordinator.drainIfIdle()`).
// The host command validates capacity, queue-paused state, and lock before
// promoting. Rejections surface as ack('rejected', ...) to the webview.
//
// Feature 065 — when the chooser commits a `StartQueueIntent` against
// `idle-pending`, the optional payload is threaded through so the host
// side can transition out of `idle-pending` (start now / arm a new
// schedule / cancel an existing schedule). Omission preserves the
// pre-feature semantics (drain whatever the queue allows). The
// `'operator-restart'` source literal is the only one accepted at the
// IPC boundary (see isCmdStartQueue validator).
//
// Feature 092 (T061, FR-034) — this is one of the four start-path
// entrances, so it carries the `queueId` the operator addressed. It is
// forwarded verbatim; this handler does not default it, because the one
// place that decides what "no queue named" means is the host command.
// Sending neither field still sends `undefined`, which is the pre-092
// wire shape byte for byte.
import type { StartQueueCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

export const handler: CommandHandler<StartQueueCommand> = async (ctx, command) => {
  const queueId = command.payload?.queueId;
  const startIntent = command.payload?.startIntent;
  const arg = queueId || startIntent
    ? { ...(queueId ? { queueId } : {}), ...(startIntent ? { startIntent } : {}) }
    : undefined;
  await exec(ctx, 'schegent.startQueue', arg);
  await ack(ctx, 'accepted');
};
