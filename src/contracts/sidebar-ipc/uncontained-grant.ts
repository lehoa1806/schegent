// FR-R3-144 (T015, D-2) — the uncontained-backend grant wire contract.
//
// Lives in a sub-module for the reason `run-launcher.ts` and `process-yaml.ts`
// state in their own headers: the barrel is at its LOC ceiling and only the five
// mandatory registration edits belong there — the constant, its `COMMAND_TYPES`
// membership, the `SidebarCommand` union member, the discriminator guard and its
// `COMMAND_GUARDS` row. The payload shape and its predicate are what this file is.
//
// The command grants or revokes ONE backend's uncontained posture. Mutating: it
// writes `schegent.backend.uncontainedBackends` at application scope, the setting
// that decides whether a backend with no OS-enforced bound may spawn at all.
//
// A command of its own rather than a key inside `CMD_SAVE_GENERAL_SETTINGS`. That
// command is a batched draft save of a `KEY_SPECS` map; this is a per-id
// read-modify-write of a security grant, and the two failure modes must not be
// shared — an unrelated rejected field in a draft must not be able to take a grant
// down with it, and a partial save must not leave the operator unsure which half
// landed. `services/uncontained-grant-writer.ts` carries the rest of that
// argument.

import type { CMD_SET_UNCONTAINED_BACKEND_GRANT, CommandBase } from '../sidebar-ipc';
import { isBackendRunnerKind, type BackendRunnerKind } from '../backend-kinds';
// Type-only, which is what keeps `contracts` a leaf layer: the projection's
// vocabulary is the policy module's, and restating `'os-enforced' | 'none'` here
// as a literal would be a second declaration of one classification. The
// dependency-direction gate forbids a VALUE import in this direction and admits
// this one for exactly that reason (`tests/lint/dependency-direction.test.ts:94`).
import type {
  BackendContainment,
  BackendContainmentMechanism
} from '../../services/backend-containment-policy';

/**
 * One backend, one direction.
 *
 * `kind` is `BackendRunnerKind` rather than a spelled-out union of the three ids.
 * The spelled-out union is the shape this whole item exists to stop spreading —
 * `PingBackendCommand` in the barrel still carries one, and is left as it stands
 * because correcting it is not this item's scope — so a fourth backend added to
 * `SUPPORTED_BACKENDS` must not need a fourth edit here to be sayable.
 *
 * `granted` is the STATE asked for, not a verb. A `{ revoke: true }` shaped
 * payload needs the reader to hold two negations at once to know what an absent
 * field means; a boolean state has one meaning, and the handler reports the state
 * that holds afterwards in the same vocabulary.
 */
export interface SetUncontainedBackendGrantPayload {
  readonly kind: BackendRunnerKind;
  readonly granted: boolean;
}

export interface SetUncontainedBackendGrantCommand
  extends CommandBase<typeof CMD_SET_UNCONTAINED_BACKEND_GRANT> {
  readonly payload: SetUncontainedBackendGrantPayload;
}

/**
 * Shape only. Whether the grant is MEANINGFUL — `codex` carries an OS-enforced
 * bound, so the list does not govern it — is a policy question answered once, by
 * `services/backend-containment-policy.ts`. A second answer here would be a second
 * authority for it, and the two would part company the first time a backend's
 * containment mechanism changed.
 *
 * Membership of `kind` is `isBackendRunnerKind`'s answer rather than a spelled-out
 * comparison, for the reason the payload docblock gives. The exact-arity check
 * refuses a payload carrying anything extra, so an unexpected field cannot ride
 * along beside a valid grant.
 */
export function isSetUncontainedBackendGrantPayload(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (Object.keys(payload).length !== 2) return false;
  const { kind, granted } = payload as { kind?: unknown; granted?: unknown };
  return isBackendRunnerKind(kind) && typeof granted === 'boolean';
}

// -- The projection (host -> webview) ----------------------------------------

/**
 * FR-R3-144 (T020, T048, D-4, A-2) — whether this backend's grant is in force.
 *
 * THREE states, not a boolean, and the third is the reason this type exists.
 * `codex` is `os-enforced`, so it never appears in `resolveUncontainedGrant`'s
 * granted set even when an operator has listed it by hand — which means `false`
 * would have meant both "refused" and "needs no grant". Those have opposite
 * remedies: the first is fixed by granting, the second by understanding that
 * there is nothing to grant. A surface given one word for both would send an
 * operator to tick a box that must not exist.
 *
 * `not-required` is DERIVED from `containmentOf`, never stored. A backend that
 * gains a containment mechanism becomes `not-required` on the next projection
 * with no migration, and one that loses it becomes answerable again.
 */
export type BackendGrantState = 'granted' | 'not-granted' | 'not-required';

/**
 * One backend's containment posture, as the host projects it.
 *
 * Every field is DERIVED at compose time from
 * `services/backend-containment-policy.ts` — `containmentByBackend()`,
 * `mechanismOf()` and `resolveUncontainedGrant()`. None is stored, and the webview
 * computes none of them: that is what `tests/lint/webview-posture-derivation.test.ts`
 * (T024) enforces. The projection therefore cannot disagree with the enforcement,
 * because the refusal at spawn time reads the same three functions.
 *
 * `mechanism` is carried beside `containment` even though one derives from the
 * other, because they answer different operator questions: `containment` is
 * whether a bound exists, `mechanism` is what the bound IS. A surface that can
 * only say "contained" cannot tell an operator why `codex` differs from `claude`.
 */
export interface BackendPosture {
  readonly kind: BackendRunnerKind;
  readonly containment: BackendContainment;
  readonly mechanism: BackendContainmentMechanism;
  readonly grant: BackendGrantState;
  /**
   * The policy module's own sentence about this backend's entry in the grant
   * setting, when that entry grants nothing — today, an `already-contained`
   * listing of a backend that carries an OS-enforced bound.
   *
   * Carried verbatim rather than restated, for the reason every other surface in
   * this feature carries it verbatim: one authority for the rule, one wording on
   * every surface. Absent in the ordinary case.
   */
  readonly problem?: string;
  /**
   * FR-R3-144 (T033, T035) — what a spawn of this backend would be refused WITH,
   * word for word: `judgeBackendContainment`'s own `message`, present exactly when
   * `grant` is `not-granted` and absent otherwise.
   *
   * It is projected rather than composed in the webview because the webview cannot
   * reach the policy module at all — `tests/lint/webview-host-import-direction.test.ts`
   * forbids a VALUE import from `src/services/`, and rightly: the sentence names the
   * setting, the exact value to add, the scope of the grant, and the removed key it
   * replaced. A surface that re-typed any of those would be a second wording of one
   * rule, and the copy is the one that goes stale — an operator would read a
   * remedy that no longer works, having done exactly what the screen told them.
   *
   * It is also what the grant confirmation says before writing (FR-007). The
   * operator is asked to accept a specific consequence, so they are shown the
   * enforcement's own statement of that consequence and not a paraphrase of it.
   */
  readonly refusal?: string;
}

/**
 * Problems in the grant setting that belong to NO backend row.
 *
 * The typo case: `settings.json` holds `"claud"`, which names nothing, so there is
 * no posture for it to hang off. FR-R3-125 decided such an entry must not stop the
 * extension and must instead be reported — and until this projection there was
 * nowhere to report it, so it was only ever written to the log. An operator who
 * mistyped a backend id has no reason to read a log; they have every reason to
 * look at the tab that shows the list.
 *
 * Separate from `BackendPosture.problem` rather than a fourth `grant` state,
 * because it is not a fact ABOUT a backend — it is a fact about the setting's
 * contents. Empty in the ordinary case.
 */
export type BackendGrantEntryProblems = readonly string[];
