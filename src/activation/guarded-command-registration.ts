// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT. This module is
// Phase A's enforcement site rather than a subject of the classification:
// registering a command performs nothing, and the check it installs runs at the
// point of effect on every invocation.

// FR-R3-136 (FR-003, FR-005, FR-006, FR-007) — the only place this extension
// registers a VS Code command.
//
// WHAT IT REPLACES. Thirty bare `vscode.commands.registerCommand` calls, none of
// which consulted Workspace Trust. VS Code's own guidance is explicit that
// contributed visibility is not authorization and that a registered command can be
// invoked programmatically by another extension or a task, so `enablement` clauses
// and palette `when` conditions would not have closed this even if the manifest
// had any — it has none.
//
// TWO LINES OF DEFENCE, FOR TWO DIFFERENT MISTAKES.
//
//   1. `ExtensionCommandId` — an id absent from both disposition maps does not
//      TYPE at the call site. This is the mistake that will actually happen: a new
//      command added in a hurry.
//   2. The runtime throw below — for the cast, the dynamically built id, and the
//      test that proves the mechanism is not vacuous. It throws at REGISTRATION,
//      not at invocation, so a mis-registered command breaks activation where a
//      test can see it rather than becoming a silently inert palette entry in
//      production.
//
// WHY THE TRUST READ IS A THUNK. FR-005 requires trust to be re-read at the point
// of effect, because a command survives its registration and can be invoked at any
// later time — including after `onDidGrantWorkspaceTrust` has fired. A boolean
// captured here would be the exact bug: correct at activation and wrong for the
// rest of the window's life. The thunk shape is also what
// `src/activation/sidebar-router-wiring.ts` already passes to the message router
// (`isTrusted: () => vscode.workspace.isTrusted`), so there is one idiom for this
// in the codebase rather than two.
//
// STAGE 1 SAFE, DELIBERATELY. `schegent.reset` is registered in Stage 1, before
// `ensureStage2()` and with no workspace folder necessarily open. This module
// therefore imports only the pure decision and the frozen disposition map — never
// a store, a lock, or anything from Stage 2 — so the guard is available at the
// first registration rather than at the first workspace-bound one.

import * as vscode from 'vscode';

import {
  requireDisposition,
  type ExtensionCommandId
} from '../contracts/entry-point-dispositions';
import { decideEntry, renderEntryRefusal } from '../state/entry-trust-decision';

export interface GuardedCommandDeps {
  /**
   * Reads `vscode.workspace.isTrusted`. A thunk, never a captured boolean —
   * see the module header.
   */
  readonly isWorkspaceTrusted: () => boolean;
  /** Where the operator sees the refusal. */
  readonly notifier: { warn(message: string): unknown };
  /** Where the refusal is recorded once, at info. */
  readonly logger: { info(message: string, context?: Record<string, unknown>): void };
}

/**
 * Register a command with its trust disposition enforced at the point of effect.
 *
 * A read-only id is registered unwrapped, so the read path pays nothing. A
 * mutating id is wrapped in a check that runs on every invocation and returns
 * `undefined` after warning the operator, rather than throwing — a refused
 * command is a declined action, not a fault, and `executeCommand` callers in the
 * webview and in tests read the absence of an effect.
 */
export function registerGuardedCommand<A extends readonly unknown[], R>(
  deps: GuardedCommandDeps,
  id: ExtensionCommandId,
  handler: (...args: A) => R
): vscode.Disposable {
  const entry = requireDisposition(id);

  if (entry.disposition === 'read-only') {
    return vscode.commands.registerCommand(id, handler);
  }

  return vscode.commands.registerCommand(id, (...args: A): R | undefined => {
    const decision = decideEntry({
      disposition: entry.disposition,
      workspaceTrusted: deps.isWorkspaceTrusted()
    });
    if (decision.allowed) return handler(...args);

    const message = renderEntryRefusal(id, entry.reason);
    void deps.notifier.warn(message);
    deps.logger.info('command refused: workspace not trusted', {
      commandId: id,
      reason: entry.reason,
      refusal: decision.reason
    });
    return undefined;
  });
}
