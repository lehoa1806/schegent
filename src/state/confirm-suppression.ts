// Feature 063 (FR-021) — persisted suppression set for per-action
// "don't ask again" preferences. Extracted from `workspace-state.ts`
// to keep that file under its 900-line cap; the actual memento I/O
// stays in `WorkspaceStateStore.{get,set}ConfirmSuppression`, which
// delegates the narrowing and merge logic to the helpers below.

import { ACTION_KEYS } from '../contracts/action-keys';

export const CONFIRM_SUPPRESSION_VERSION = 1 as const;

// Feature 193 (T037, FR-001/FR-009) — derived from the canonical
// `ACTION_KEYS` tuple, which is also the source the webview's `ActionKey`
// union mirrors (via `webview-ui/src/lib/generated/action-keys.ts`). This
// used to be an independently hand-written 11-entry set with a comment
// claiming a drift test enforced parity with the webview at
// `repo/test/unit/sidebar-ipc-action-key-drift.test.ts` — that file never
// existed. Deriving from the one canonical tuple removes the need for such
// a test: there is nothing left for it to keep in sync.
//
// Typed `ReadonlySet<string>` (not `ReadonlySet<ActionKey>`) so the existing
// `.has(actionKey)` call sites — which validate an untrusted `string` off
// the wire — keep compiling unchanged; only the set's contents are new.
//
// KNOWN RESIDUAL (code-review finding, iteration 5 — recorded, not fixed
// here). Widening from 11 to 18 keys newly admits a memento write for the two
// `NEVER_SUPPRESSIBLE` keys the old hand-written set happened to exclude,
// `settings.disable-confirmations` and `backend.grant-uncontained` (the third,
// `workspace.reset`, was always admitted). That floor — "no operator
// preference can silence this prompt" — is declared in exactly one place,
// `NEVER_SUPPRESSIBLE` in `webview-ui/src/lib/use-confirm.ts`, and this side
// owns the persisted state it would have to be enforced against. Nothing is
// silenced today: `use-confirm.ts` gates both the write (`settle`'s
// `&& suppressible`) and the read (`isSuppressed` inside `if (suppressible)`),
// so a persisted entry for one of the three is inert. It is inert only for as
// long as that one webview-side set stays correct.
//
// Deliberately not refused here: `tests/parity/action-key-parity.test.ts`
// pins "accepts and persists a suppression write for every one of the 18
// canonical keys" as this feature's intended behaviour, so a host-side floor
// is a contract decision (which set is canonical, and does the host mirror
// it) rather than a local fix — most likely a `NEVER_SUPPRESSIBLE_ACTION_KEYS`
// tuple beside `ACTION_KEYS` that both sides derive from, which the webview
// mirror's generator would also have to carry.
export const KNOWN_ACTION_KEYS: ReadonlySet<string> = new Set<string>(ACTION_KEYS);

// Shape of the persisted memento at `schegent.ui.confirmSuppression`.
// `version: 1` lets us migrate the persisted shape later without
// rewriting historical state.
export interface ConfirmSuppressionState {
  readonly version: typeof CONFIRM_SUPPRESSION_VERSION;
  readonly suppressedActionKeys: readonly string[];
}

const EMPTY: ConfirmSuppressionState = Object.freeze({
  version: CONFIRM_SUPPRESSION_VERSION,
  suppressedActionKeys: Object.freeze([] as string[])
});

// Narrow an arbitrary memento value into a `ConfirmSuppressionState`.
// Returns an empty state when missing or shape-invalid; callers treat
// absence as "no suppression". Defensive narrowing keeps a corrupt
// memento from breaking the confirmation flow at startup.
export function readConfirmSuppression(raw: unknown): ConfirmSuppressionState {
  if (raw === null || typeof raw !== 'object') return EMPTY;
  const value = raw as { version?: unknown; suppressedActionKeys?: unknown };
  if (value.version !== CONFIRM_SUPPRESSION_VERSION) return EMPTY;
  if (!Array.isArray(value.suppressedActionKeys)) return EMPTY;
  const keys = value.suppressedActionKeys.filter(
    (k): k is string => typeof k === 'string' && k.length > 0
  );
  return { version: CONFIRM_SUPPRESSION_VERSION, suppressedActionKeys: keys };
}

// Compute the next state after upserting a single action key. Idempotent:
// adding an already-suppressed key or removing an absent key returns an
// equivalent state. The action-key string MUST be validated against the
// closed ActionKey union by the caller (the `CMD_SET_CONFIRM_SUPPRESSION`
// handler) before this is invoked.
export function writeConfirmSuppression(
  current: ConfirmSuppressionState,
  actionKey: string,
  suppressed: boolean
): ConfirmSuppressionState {
  const set = new Set(current.suppressedActionKeys);
  if (suppressed) set.add(actionKey);
  else set.delete(actionKey);
  return {
    version: CONFIRM_SUPPRESSION_VERSION,
    suppressedActionKeys: [...set]
  };
}
