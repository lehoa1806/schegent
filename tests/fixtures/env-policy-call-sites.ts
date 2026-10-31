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
 * The host components that spawn a configured backend CLI on their own initiative.
 *
 * The first three go through `runner.invoke`, which is what the `.invoke(` scan in
 * `invocations-forward-env-policy.test.ts` can see. FR-R4-F06 (FR-006) added the two
 * probes: the backend capability probe in `src/activation/backend-wiring.ts` calls
 * `buildSpawnEnv` directly rather than invoking a runner, and the CLI version probe
 * in `src/runner/cli-version-probe.ts` took no environment at all. Both were outside
 * the `.invoke(` scan, which is why the first was recorded here as a residual and the
 * second was not seen. The importer census in that gate now covers them.
 */
export const ENV_POLICY_CALL_SITES = [
  'phase runner',
  'session compactor',
  'credit watchdog poll',
  'cli version probe',
  'backend capability probe'
] as const;

/** How many call sites both gates must cover, so neither can shrink silently. */
export const PARITY_CALL_SITE_COUNT = ENV_POLICY_CALL_SITES.length;

/** How many of those sites originate through `.invoke(`, the part the `.invoke(` scan counts. */
export const INVOKE_CALL_SITE_COUNT = 3;
