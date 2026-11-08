import type { SidebarCommand } from './messages';
import type { CommandAuthority } from '../../contracts/sidebar-command-metadata';
import {
  MUTATING_COMMAND_TYPES,
  commandAuthorityOf
} from '../../contracts/sidebar-command-metadata';
import { HANDLERS } from './commands';
import { SECONDARY_REJECT, UNTRUSTED_REJECT } from './commands/constants';
import { ack, ackCommandOutcome, DISPATCH_FAILED_REASON } from './commands/handler-helpers';
import { failed } from '../../contracts/command-outcome';
import { describeFailure } from '../../lib/errors';
import type { HandlerContext } from './commands/handler-contract';
import { isWindowPrimary } from './commands/primacy-gate';
import type { AckPoster, RouterDeps } from './commands/router-types';
import { MutationCommandExecutor } from './mutation-command-executor';

export type {
  AckPoster,
  PhaseOps,
  QueueOps,
  RouterDeps
} from './commands/router-types';

export const MUTATING_COMMANDS: ReadonlySet<string> = new Set(MUTATING_COMMAND_TYPES);

/**
 * Sidebar IPC message router. Decomposed into per-command handler files
 * under `./commands/`; this class owns the gate decision (read from
 * `COMMAND_AUTHORITY`: trust, then primary-host, for a gated command), the
 * handler-not-found path, and the top-level try/catch that translates a handler
 * throw into one fixed `command-dispatch-failed` acknowledgement.
 *
 * Adding a new command (FR-R4-F05, the one recipe; every other mention points here):
 *   1. Add the CMD_ constant to `src/contracts/sidebar-ipc.ts`, and its entry in
 *      `COMMAND_TYPES`.
 *   2. Add the interface and the `SidebarCommand` union member there.
 *   3. Add the validator in `src/contracts/runtime-validators.ts`.
 *   4. Create the handler file `./commands/cmd-<name>.ts`.
 *   5. Register it in `./commands/index.ts`.
 *   6. Declare its authority in `COMMAND_AUTHORITY`
 *      (`src/contracts/sidebar-command-metadata.ts`). REQUIRED for every command,
 *      gated or read-only, with a reason: an omitted entry is a `tsc` error. A
 *      command that starts a process, writes persisted state, writes a file or
 *      appends an audit row is `gated`; `readOnly`'s reason says why none applies.
 *   7. Run `npm run contracts:generate` and review the diff. The generated contract
 *      output is fed by `COMMAND_TYPES`, and `npm run contracts:check` fails until it is
 *      regenerated (`docs/operations/contract-generation.md`).
 *   8. If it is gated, add it to `PINNED_MUTATING_COMMANDS` and move the count that pin
 *      states (`tests/unit/ui/sidebar/mutating-commands-pinned-list.test.ts`). The list
 *      is hand-written on purpose: a command dropped from the gate must not vanish from
 *      both sides at once.
 *   9. Add its row to `docs/reference/api-and-cli.md`
 *      (`tests/lint/webview-command-reference-parity.test.ts` fails without it), and
 *      correct the counts that page states: the gated, read-only and total command
 *      counts (`tests/lint/asserted-counts.test.ts`; fix the sentence, then `stated`).
 *  10. Add the webview helper in its family module; a component never imports the
 *      CMD_ constant.
 *  11. Add the tests.
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
    // FR-R4-F05 (C4) — the one decision, read once from the declaration. A type
    // the table does not hold is `gated` and `serialized` (fail-closed).
    const authority = commandAuthorityOf(command.type);
    if (authority.authority === 'read-only') {
      await this.dispatchValidated(command, postAck, authority);
      return;
    }
    await this.mutations.execute(
      command.correlationId,
      postAck,
      async (captureAck) => {
        await this.dispatchValidated(command, captureAck, authority);
      },
      { serialize: authority.execution === 'serialized' }
    );
  }

  private async dispatchValidated(
    command: SidebarCommand,
    postAck: AckPoster,
    authority: CommandAuthority
  ): Promise<void> {
    // FR-R4-F05 (F1) — remembers whether anything was posted for this command, so the
    // catch-all below sends one fixed ack when none was and none when one was.
    let acknowledged = false;
    const ctx: HandlerContext = {
      deps: this.deps,
      postAck: (ack) => {
        acknowledged = true;
        return postAck(ack);
      },
      correlationId: command.correlationId
    };
    if (authority.authority === 'gated') {
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
    if (!handler) {
      this.deps.logger.warn('sidebar router: missing command handler', {
        type: command.type,
        correlationId: command.correlationId
      });
      await ackCommandOutcome(ctx, failed(DISPATCH_FAILED_REASON));
      return;
    }
    try {
      await handler(ctx, command);
    } catch (err) {
      await this.reportHandlerFailure(command, ctx, err, acknowledged);
    }
  }

  /**
   * FR-R4-F05 (FR-011 to FR-014; contract F, F1 to F5) — the one place a handler's throw
   * is answered. The detail goes to the log, bounded and sanitized, with the command type
   * and correlation id; the operator gets `command-dispatch-failed` and nothing of what was
   * thrown. A handler that already acked is not answered twice: the first ack is the
   * answer, and a second would contradict it.
   *
   * It cannot throw. It runs in a catch block, a thrown value can be `null` or an object
   * whose `message` getter throws, and a logger or a transport can fail too; whichever
   * happens, the webview's own timeout reports an unanswered command.
   */
  private async reportHandlerFailure(
    command: SidebarCommand,
    ctx: HandlerContext,
    thrown: unknown,
    acknowledged: boolean
  ): Promise<void> {
    try {
      this.deps.logger.warn('sidebar router: command failed', {
        type: command.type,
        correlationId: command.correlationId,
        error: describeFailure(thrown, (value) => this.deps.logger.sanitize(value))
      });
      if (acknowledged) return;
      await ackCommandOutcome(ctx, failed(DISPATCH_FAILED_REASON));
    } catch {
      // Nothing is left to tell anyone: the log or the ack transport itself failed.
    }
  }

  /**
   * Feature FR-R3-003 (T300) — awaited, because the answer is now a read of the
   * fenced ownership record rather than of the `Memento` mirror.
   *
   * FR-R3-024 (FR-001, FR-004) — delegates to the one primacy predicate, in
   * `commands/primacy-gate.ts`. The docblock previously claimed a fail-closed
   * posture the body did not implement: an absent callback returned `true`, so
   * this gate admitted every mutating command while `checkTrusted` below
   * rejected on the identical wiring mistake. All three failure paths —
   * absent callback, throw, non-`true` return — now refuse, and the predicate
   * names each one.
   */
  private async checkPrimary(): Promise<boolean> {
    return isWindowPrimary(this.deps);
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
 * without instantiating a router. FR-R4-F05 & FR-R5-F31: the router itself
 * no longer asks this question; `dispatch` reads `commandAuthorityOf` from
 * `COMMAND_AUTHORITY` (single source of truth).
 */
export function isMutatingCommand(type: string): boolean {
  return MUTATING_COMMANDS.has(type);
}
