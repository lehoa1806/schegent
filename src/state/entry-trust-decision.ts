// FR-R3-136 (FR-001, FR-005) — may this entry point cause an effect in this
// window? As a pure function.
//
// WHY PURE, AND WHY HERE. This codebase has settled the argument twice already —
// once in `judgeBackendContainment`'s docblock, once when `FR-R3-126` extracted
// `capability-trust-decision.ts` out of `capability-trust-resolver.ts`: "a pure
// function ... so the decision is testable without a workspace, a CLI, or a spawn
// — and so both the admission check and the spawn-time check read the same answer
// instead of each implementing it." The same reasoning holds for a third time, and
// harder, because FR-R3-136 exists precisely because two enforcement points
// disagreed: the sidebar router refused mutating IPC while the command surface
// refused nothing.
//
// DELIBERATELY TRIVIAL. There is one input pair and one branch. That is the point:
// this is the single place a second condition can ever be added, so a later "and
// the window holds primacy" or "and the capability is allowed" lands once instead
// of at thirty call sites. It is NOT worth collapsing into a boolean expression at
// each caller — that is exactly the arrangement this feature is repairing.
//
// NO CACHING, BY CONSTRUCTION. The function takes `workspaceTrusted` as an
// argument, so it cannot hold a stale answer; freshness is the caller's obligation
// and the callers read `vscode.workspace.isTrusted` at the point of effect. This
// mirrors invariant I-1 of `capability-trust-resolver.ts` ("no caching — every
// public call re-reads `isTrusted`"), and FR-005 needs the same property for a
// specific reason: a registered command can be invoked programmatically at any
// time, including long after registration and after trust has been granted.
//
// There is no revoke case to handle. VS Code exposes `onDidGrantWorkspaceTrust`
// and no revoke event — trust is monotonic within a window's lifetime — so
// "re-read, never cache" is the whole of FR-005 (spec C1).

import type { EntryDisposition } from '../contracts/entry-point-dispositions';

export interface EntryTrustInputs {
  /** The entry's declared disposition, from `entry-point-dispositions.ts`. */
  readonly disposition: EntryDisposition;
  /** `vscode.workspace.isTrusted`, read by the caller at the point of effect. */
  readonly workspaceTrusted: boolean;
}

/**
 * The one reason this decision refuses. A named union rather than a string so a
 * refusal cannot be assembled ad hoc at a call site, and so a second reason —
 * were one ever added — would be a compile error everywhere the reason is
 * rendered rather than a new string appearing in one message.
 */
export type EntryRefusalReason = 'workspace-untrusted';

export type EntryTrustDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: EntryRefusalReason };

/**
 * Whether an entry point may proceed.
 *
 * A read-only entry always may: the manifest's `limited` claim promises state,
 * history, audit and log reads keep working in an untrusted window, and
 * `FR-R3-126` shipped that view deliberately. A mutating entry may only when the
 * workspace is trusted.
 */
export function decideEntry(inputs: EntryTrustInputs): EntryTrustDecision {
  if (inputs.disposition === 'read-only') return { allowed: true };
  if (inputs.workspaceTrusted) return { allowed: true };
  return { allowed: false, reason: 'workspace-untrusted' };
}

/**
 * The operator-facing refusal text.
 *
 * Kept beside the decision so every refusal in this feature reads the same,
 * and so the message names the reason from the disposition map rather than
 * restating what the command does — a refusal that says "queue enqueue is not
 * available" tells the operator which of their actions was declined, which the
 * command id alone does not.
 */
export function renderEntryRefusal(id: string, reason: string): string {
  return (
    `Schegent: ${id} is unavailable because this workspace is not trusted (${reason}). ` +
    'Trust the folder to enable it; state, history, audit and log views remain available.'
  );
}
