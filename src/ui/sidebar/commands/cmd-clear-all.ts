// Feature 063 — thin IPC handler for `CMD_CLEAR_ALL`. Delegates to the
// `schegent.clearAll` VS Code command which runs `runClearAll(...)` against
// the real workspace state. The handler shape matches `cmd-clear-completed.ts`
// (delegates via `ctx.deps.executeCommand`) — the orchestrator owns toast
// messaging, audit emission, and lock release. We just ack the IPC.
//
// Mutating-command registry: `CMD_CLEAR_ALL` is listed in
// `MUTATING_COMMANDS` (sidebar-ipc.ts) so the existing primary/trust
// gates run before this handler is dispatched.

import type { ClearAllCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

export const handler: CommandHandler<ClearAllCommand> = async (ctx) => {
  await exec(ctx, 'schegent.clearAll');
  await ack(ctx, 'accepted');
};
