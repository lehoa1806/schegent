// BUG-002 (FR-012a) — Start-Queue handler. Promotes the oldest pending
// task to in-flight by invoking `schegent.startQueue` (which delegates
// to `controller.drainQueuedWork()` → `AutoDrainCoordinator.drainIfIdle()`).
// The host command validates capacity, queue-paused state, and lock before
// promoting. Rejections surface as ack('rejected', ...) to the webview.
import type { StartQueueCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

export const handler: CommandHandler<StartQueueCommand> = async (ctx) => {
  await exec(ctx, 'schegent.startQueue');
  await ack(ctx, 'accepted');
};
