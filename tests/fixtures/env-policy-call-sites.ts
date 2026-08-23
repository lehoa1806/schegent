// FR-R3-049 — the production invocation sites the environment-policy gates share.
//
// This exists so the parity test and the `tests/lint` guard can cross-check each
// other's coverage WITHOUT one test file importing the other. Importing a
// `*.test.ts` module from another test file re-registers its suites inside the
// importer, so every case runs twice and the importer inherits the imported
// file's global hooks — the same "duplication is only visible when you count"
// defect `suite-invoked-once.test.ts` exists for, one level down.
//
// Deliberately holds no `src/` import: it is a list of names, so neither gate
// pulls production modules in through the cross-check.

/**
 * The host components that spawn a backend CLI through `runner.invoke` on their
 * own initiative.
 *
 * Scoped to `.invoke` deliberately, because that is what the guard can see. The
 * backend capability probe in `src/activation/backend-wiring.ts` also spawns a
 * CLI on its own initiative, but it calls `buildSpawnEnv` directly rather than
 * invoking a runner, so it is outside both gates -- recorded as a residual on the
 * item rather than silently implied to be covered by a list of three.
 */
export const ENV_POLICY_CALL_SITES = [
  'phase runner',
  'session compactor',
  'credit watchdog poll'
] as const;

/** How many call sites both gates must cover, so neither can shrink silently. */
export const PARITY_CALL_SITE_COUNT = ENV_POLICY_CALL_SITES.length;
