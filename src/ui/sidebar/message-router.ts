import type { SidebarCommand } from './messages';
import { MUTATING_COMMAND_TYPES } from '../../contracts/sidebar-command-metadata';
import { HANDLERS } from './commands';
import { SECONDARY_REJECT, UNTRUSTED_REJECT } from './commands/constants';
import { ack } from './commands/handler-helpers';
import type { AckPoster, RouterDeps } from './commands/router-types';
import { MutationCommandExecutor } from './mutation-command-executor';

export type {
  AckPoster,
  PhaseOps,
  QueueOps,
  QueueRemover,
  RouterDeps
} from './commands/router-types';

export const MUTATING_COMMANDS: ReadonlySet<string> = new Set(MUTATING_COMMAND_TYPES);

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
 *   4. If the command mutates host state, add it to
 *      `MUTATING_COMMAND_REASONS` in `src/contracts/sidebar-command-metadata.ts`.
 */
export class MessageRouter {
  private readonly mutations: MutationCommandExecutor;

  constructor(
    private readonly deps: RouterDeps,
    mutations: MutationCommandExecutor = new MutationCommandExecutor()
  ) {
    this.mutations = mutations;
  }

  public async dispatch(command: SidebarCommand, postAck: AckPoster): Promise<void> {
    // Feature 019 BUG-001 (FR-021) — DEBUG every inbound operator IPC
    // command. Emitted before the primary-host gate so secondary-host
    // attempts are observable at DEBUG level too.
    this.deps.logger.debug('router: inbound', {
      type: command.type,
      correlationId: command.correlationId
    });
    if (this.isMutatingCommand(command.type)) {
      await this.mutations.execute(command.correlationId, postAck, async (captureAck) => {
        await this.dispatchValidated(command, captureAck);
      });
      return;
    }
    await this.dispatchValidated(command, postAck);
  }

  private async dispatchValidated(command: SidebarCommand, postAck: AckPoster): Promise<void> {
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
      if (!(await this.checkPrimary())) {
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

  /**
   * Feature FR-R3-003 (T300) — awaited, because the answer is now a read of the
   * fenced ownership record rather than of the `Memento` mirror. Fail-closed on
   * both a throw and a rejection: a window that cannot prove it holds primacy is
   * treated as not holding it, which is the same posture the acquisition path
   * takes.
   */
  private async checkPrimary(): Promise<boolean> {
    if (!this.deps.isPrimary) return true;
    try {
      return await this.deps.isPrimary();
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
