// Feature 063 (FR-021) — persisted suppression set for per-action
// "don't ask again" preferences. Extracted from `workspace-state.ts`
// to keep that file under its 900-line cap; the actual memento I/O
// stays in `WorkspaceStateStore.{get,set}ConfirmSuppression`, which
// delegates the narrowing and merge logic to the helpers below.

export const CONFIRM_SUPPRESSION_VERSION = 1 as const;

// Host-side mirror of the webview's `ActionKey` union (action-copy.ts).
// The drift test at
// `repo/test/unit/sidebar-ipc-action-key-drift.test.ts` (T046 lint)
// asserts the two sets stay in sync — adding a key here without
// adding it to the webview (or vice versa) fails the build.
export const KNOWN_ACTION_KEYS: ReadonlySet<string> = new Set<string>([
  'queue.clean-all',
  'queue.clear-done',
  'queue.remove-item',
  'queue.cancel-item',
  'queue.pause',
  'queue.resume',
  'run.retry-phase-now',
  'run.restart-canceled',
  'run.modify-task',
  'history.rerun',
  'workspace.reset'
]);

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
