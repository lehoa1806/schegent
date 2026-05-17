import type { SidebarCommand } from './messages';
import {
  CMD_CANCEL,
  CMD_CLEAR_COMPLETED,
  CMD_CLEAR_FAILED,
  CMD_CLEAR_PHASE_BREAKPOINT,
  CMD_DISABLE_PHASE,
  CMD_ENABLE_PHASE,
  CMD_MODIFY_TASK,
  CMD_MOVE_QUEUE_ITEM_DOWN,
  CMD_MOVE_QUEUE_ITEM_UP,
  CMD_PAUSE_PHASE,
  CMD_PAUSE_QUEUE,
  CMD_REMOVE_QUEUE_ITEM,
  CMD_REMOVE_TASK_PHASE,
  CMD_REORDER_TASK,
  CMD_RERUN_FROM_HISTORY,
  CMD_RESET,
  CMD_RESTART_CANCELED_TASK,
  CMD_RESTART_PHASE,
  CMD_RESUME,
  CMD_RESUME_PHASE,
  CMD_RESUME_QUEUE,
  CMD_RETRY_ACTIVE_RUN,
  CMD_RETRY_PHASE_NOW,
  CMD_RETRY_QUEUE_ITEM,
  CMD_SAVE_GENERAL_SETTINGS,
  CMD_SAVE_MODELS,
  CMD_SAVE_PHASES,
  CMD_SAVE_PIPELINES,
  CMD_SAVE_WAKEUP_SETTINGS,
  CMD_SET_PHASE_BREAKPOINT,
  CMD_SKIP_PHASE,
  CMD_START,
  CMD_WAKE_UP_NOW
} from './messages';
import { HANDLERS } from './commands';
import { SECONDARY_REJECT, UNTRUSTED_REJECT } from './commands/constants';
import { ack } from './commands/handler-helpers';
import type { AckPoster, RouterDeps } from './commands/router-types';

export type {
  AckPoster,
  PhaseOps,
  QueueOps,
  QueueRemover,
  RouterDeps
} from './commands/router-types';

export const MUTATING_COMMANDS: ReadonlySet<string> = new Set([
  CMD_REMOVE_QUEUE_ITEM,
  CMD_RETRY_QUEUE_ITEM,
  CMD_MOVE_QUEUE_ITEM_UP,
  CMD_MOVE_QUEUE_ITEM_DOWN,
  CMD_CLEAR_COMPLETED,
  CMD_CLEAR_FAILED,
  CMD_PAUSE_QUEUE,
  CMD_RESUME_QUEUE,
  CMD_RERUN_FROM_HISTORY,
  CMD_RETRY_ACTIVE_RUN,
  CMD_START,
  CMD_CANCEL,
  CMD_RESUME,
  CMD_RESET,
  CMD_RETRY_PHASE_NOW,
  CMD_PAUSE_PHASE,
  CMD_RESUME_PHASE,
  CMD_RESTART_PHASE,
  CMD_SKIP_PHASE,
  CMD_DISABLE_PHASE,
  CMD_ENABLE_PHASE,
  CMD_REMOVE_TASK_PHASE,
  // Feature 030 — removed the seven multi-queue mutation commands from the
  // gate (enumerated by name in the lint regression at
  // `tests/lint/no-multi-queue-commands.test.ts`). Single-queue mode keeps
  // reorder + modify.
  CMD_MODIFY_TASK,
  CMD_REORDER_TASK,
  // Feature 014 — Wake up settings save. Primary-host gate must reject
  // secondary-window attempts.
  CMD_SAVE_WAKEUP_SETTINGS,
  CMD_WAKE_UP_NOW,
  // Feature 056 Track 1 (FR-001..FR-005) — Catalog and general-settings
  // saves write VS Code configuration / workspace state and MUST be
  // primary-only. Closes the F-001 documentation-vs-implementation drift.
  CMD_SAVE_GENERAL_SETTINGS,
  CMD_SAVE_MODELS,
  CMD_SAVE_PHASES,
  CMD_SAVE_PIPELINES,
  // Feature 017 — BUG-001. Operator-driven restart of a canceled task.
  CMD_RESTART_CANCELED_TASK,
  // Feature 028 — future-phase breakpoint mutations (US2). Primary-host gate
  // must reject secondary-window attempts.
  CMD_SET_PHASE_BREAKPOINT,
  CMD_CLEAR_PHASE_BREAKPOINT
]);

/**
 * Sidebar IPC message router. Decomposed into per-command handler files
 * under `./commands/`; this class owns the primary-host gate, the
 * mutating-command set, the handler-not-found path, and the top-level
 * try/catch that translates handler throws into sanitized rejection acks.
 *
 * Adding a new command:
 *   1. Add the CMD_ constant + interface in `src/contracts/sidebar-ipc.ts`.
 *   2. Create the per-command handler file in `./commands/cmd-<name>.ts`.
 *   3. Wire it into `./commands/index.ts`.
 *   4. If the command mutates host state, add it to MUTATING_COMMANDS above.
 */
export class MessageRouter {
  constructor(private readonly deps: RouterDeps) {}

  public async dispatch(command: SidebarCommand, postAck: AckPoster): Promise<void> {
    // Feature 019 BUG-001 (FR-021) — DEBUG every inbound operator IPC
    // command. Emitted before the primary-host gate so secondary-host
    // attempts are observable at DEBUG level too.
    this.deps.logger.debug('router: inbound', {
      type: command.type,
      correlationId: command.correlationId
    });
    const ctx = {
      deps: this.deps,
      postAck,
      correlationId: command.correlationId
    };
    if (this.isMutatingCommand(command.type)) {
      // Workspace-trust gate: reject mutating commands when VS Code reports
      // the workspace is untrusted. The check runs BEFORE the primary-host
      // gate so a malicious untrusted workspace cannot probe for primary
      // status; either rejection surfaces the same operator affordance.
      if (!this.checkTrusted()) {
        this.deps.logger.warn('router: rejected by workspace-trust gate', {
          type: command.type,
          correlationId: command.correlationId
        });
        if (this.deps.notifyWarning) {
          this.deps.notifyWarning(
            'Workspace is not trusted. Commands that modify settings are disabled'
          );
        }
        await ack(ctx, 'rejected', UNTRUSTED_REJECT);
        return;
      }
      if (!this.checkPrimary()) {
        // Feature 019 BUG-001 (FR-021) — WARN BEFORE the ack so the
        // runtime-log line lands even if the ack-post throws. WARN (not
        // DEBUG) because this is the operator's only diagnostic surface
        // for the otherwise-silent rejection of a mutating command.
        this.deps.logger.warn('router: rejected by primary-host gate', {
          type: command.type,
          correlationId: command.correlationId
        });
        if (this.deps.notifyWarning) {
          this.deps.notifyWarning(
            'Another window holds the workspace lock. Commands are disabled'
          );
        }
        await ack(ctx, 'rejected', SECONDARY_REJECT);
        return;
      }
    }
    const handler = HANDLERS.get(command.type);
    if (!handler) return;
    try {
      await handler(ctx, command);
    } catch (err) {
      const reason = this.deps.logger.sanitize((err as Error).message ?? 'unknown error');
      this.deps.logger.warn(`sidebar router: ${command.type} failed: ${reason}`);
      await ack(ctx, 'rejected', reason);
    }
  }

  private isMutatingCommand(type: string): boolean {
    return MUTATING_COMMANDS.has(type);
  }

  private checkPrimary(): boolean {
    if (!this.deps.isPrimary) return true;
    try {
      return this.deps.isPrimary();
    } catch {
      return false;
    }
  }

  /**
   * Workspace-trust gate. Fail-closed: a missing callback is treated as
   * untrusted so a deps-wiring regression on the host cannot silently
   * disable this defense-in-depth gate. Tests that exercise mutating
   * commands MUST wire `isTrusted: () => true` explicitly; the lint
   * test in `tests/lint/message-router-trust-wiring.test.ts` enforces
   * the convention. Any non-`true` return (including a thrown
   * exception) is also treated as untrusted.
   */
  private checkTrusted(): boolean {
    if (!this.deps.isTrusted) {
      this.deps.logger.warn(
        'router: workspace-trust callback missing — rejecting mutating command (fail-closed)'
      );
      return false;
    }
    try {
      return this.deps.isTrusted() === true;
    } catch {
      return false;
    }
  }
}

/**
 * Feature 012 T050 — module-level helper so the MUTATING_COMMANDS
 * pinned-list regression test can assert each command is still gated
 * without instantiating a router. Mirrors the private method on
 * `MessageRouter` exactly.
 */
export function isMutatingCommand(type: string): boolean {
  return MUTATING_COMMANDS.has(type);
}
