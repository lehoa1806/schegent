// FR-R3-089 — backend *identity* lives here; backend *construction* lives in
// `src/runner/backend-runner-factory.ts`.
//
// WHY THEY ARE SEPARATE
//
// Before this module existed, eight modules across `config/` and `services/`
// imported `SUPPORTED_BACKENDS` from the factory to obtain a backend enum —
// validators that only need to know *which backend names exist* depended on the
// module that knows *how to build one*. The visible symptom was a runtime cycle
// between `services/backend-containment-policy.ts` and the factory:
// `containmentByBackend()` iterates `SUPPORTED_BACKENDS` at runtime, so the
// import is a value import, not a type-only one. It resolved lazily and had no
// runtime failure mode — verified, not assumed — which is why this was filed at
// Low severity as a placement finding rather than a defect.
//
// The rule the move establishes: **a module that needs to know the set of
// backends must not, by that fact alone, pull in the code that spawns one.**
// `tests/lint/backend-kind-placement.test.ts` keeps it true, and forbids a
// re-export hub as well — a barrel everything imports from is the same coupling
// with a different filename.
//
// This module imports nothing on purpose. It is a leaf, in the same shape as the
// reset-transaction literals that `contracts/audit-events.ts` already reuses
// rather than restates.
//
// ADDING A BACKEND still means three edits, and only the first is here:
//   1. extend the union and the frozen list below, and the `package.json` enum;
//   2. implement `BackendRunner` in `src/runner/<your>-cli.ts`;
//   3. add a `case` to `createBackendRunner`.

export type BackendRunnerKind = 'claude' | 'codex' | 'agy';

/**
 * Every backend, in a fixed order.
 *
 * The order is observable: `containmentByBackend()` builds its Map from this
 * array, and settings enumerations project it. Frozen so a caller cannot reorder
 * it in place.
 */
export const SUPPORTED_BACKENDS: ReadonlyArray<BackendRunnerKind> = Object.freeze([
  'claude',
  'codex',
  'agy'
]);

/** The backend a workspace gets when `schegent.backend.runner` is unset. */
export const DEFAULT_BACKEND: BackendRunnerKind = 'claude';

export function isBackendRunnerKind(value: unknown): value is BackendRunnerKind {
  return typeof value === 'string' &&
    (SUPPORTED_BACKENDS as ReadonlyArray<string>).includes(value);
}
