/**
 * FR-R3-143 (T034) — how the three process-environment settings combine into one
 * policy, stated once, in the layer both sides of the IPC boundary may read.
 *
 * WHY IT MOVED. The fold lived in `src/runner/spawn-env.ts`, which is correct for
 * the host and unreachable for the webview: `tests/lint/webview-host-import-direction.test.ts`
 * permits the webview to VALUE-import `src/contracts/` and nothing else, because
 * everything a webview imports for real ships into the untrusted bundle. So a
 * settings surface that wants to tell an operator what their three inputs actually
 * resolve to had exactly two options — import the runner (blocked, and rightly), or
 * restate the precedence rules in Svelte.
 *
 * The second option is the one that matters. The precedence here is not obvious:
 * a `false` legacy boolean silently overrides BOTH the mode and the allowlist, and
 * returns a policy with no `processEnvAllowlist` field at all. A restatement that
 * got that backwards would not fail any test — it would just tell operators their
 * allowlist is in force while the spawn forwards nothing. This module exists so the
 * surface calls the same function the spawn calls.
 *
 * WHAT IS NOT HERE. `REQUIRED_PROCESS_ENV_NAMES` and `buildSpawnEnv` stay in
 * `spawn-env.ts`: they read `process.env` and describe a spawn, not an agreement.
 * A contract that reads the host's environment is not a contract.
 *
 * No I/O, no `vscode`, no imports — a leaf, per `tests/lint/architecture-layers.ts`.
 */

/**
 * The closed set, in the order the settings UI offers it.
 *
 * Declared as the tuple and the type derived from it, rather than a union written
 * beside a list: a fourth mode added to one and not the other is the drift this
 * shape makes unrepresentable. `SETTINGS_SCHEMA['schegent.cli.environmentMode'].enum`
 * reads this array, so `package.json` parity keeps checking the same values.
 */
export const PROCESS_ENVIRONMENT_MODES = Object.freeze([
  'inherit',
  'minimal',
  'allowlist'
] as const);

export type ProcessEnvironmentMode = (typeof PROCESS_ENVIRONMENT_MODES)[number];

export interface ProcessEnvironmentPolicy {
  readonly mode: ProcessEnvironmentMode;
  readonly inheritProcessEnv: boolean;
  /**
   * Present only in `allowlist` mode. Its ABSENCE is meaningful downstream:
   * `buildSpawnEnv` branches on `processEnvAllowlist !== undefined` first, so a
   * policy without this field forwards no ambient variable at all.
   */
  readonly processEnvAllowlist?: readonly string[];
}

/**
 * A legal environment variable name.
 *
 * The source string is the declaration and the RegExp is derived, because
 * `SETTINGS_SCHEMA['schegent.cli.environmentAllowlist'].itemPattern` is a string
 * (it mirrors `package.json`) while every caller here needs a RegExp. Two spellings
 * of one rule, not two rules.
 */
export const PROCESS_ENV_NAME_PATTERN_SOURCE = '^[A-Za-z_][A-Za-z0-9_]*$';

export const PROCESS_ENV_NAME_PATTERN = new RegExp(PROCESS_ENV_NAME_PATTERN_SOURCE);

/** Stores and accepts names only; invalid names and duplicates are ignored. */
export function sanitizeProcessEnvAllowlist(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze([
    ...new Set(
      value.filter(
        (name): name is string =>
          typeof name === 'string' && PROCESS_ENV_NAME_PATTERN.test(name)
      )
    )
  ]);
}

/**
 * Resolve the new mode while preserving the legacy boolean opt-out.
 *
 * The first branch is the one worth reading twice: `inheritEnvironment: false`
 * wins over any mode, and drops the allowlist rather than applying it.
 *
 * FR-R4-F06 (FR-001, FR-002) -- ONLY the exact string `'inherit'` inherits.
 * This used to be the fall-through: every value that was not `'minimal'` or
 * `'allowlist'`, a typo included, resolved to `inherit`, so a mistyped safety
 * setting forwarded every credential in the host environment. The settings tab
 * already showed `allowlist` for such a value (it substitutes the shipped default
 * on read), so the tab and the spawn disagreed. A missing value, `null`, a
 * non-string, an unknown string, `'Inherit'` and `' inherit'` now resolve to the
 * allowlist default, the same value an explicit `'allowlist'` gives. The compare
 * is strict and case-sensitive on purpose: a typo must never widen.
 */
export function resolveProcessEnvironmentPolicy(input: {
  readonly inheritEnvironment: boolean;
  readonly mode: unknown;
  readonly allowlist: unknown;
}): ProcessEnvironmentPolicy {
  if (!input.inheritEnvironment || input.mode === 'minimal') {
    return Object.freeze({ mode: 'minimal', inheritProcessEnv: false });
  }
  if (input.mode === 'inherit') {
    return Object.freeze({ mode: 'inherit', inheritProcessEnv: true });
  }
  return Object.freeze({
    mode: 'allowlist',
    inheritProcessEnv: false,
    processEnvAllowlist: sanitizeProcessEnvAllowlist(input.allowlist)
  });
}

/**
 * FR-R4-F06 (FR-004, FR-005) -- the policy a consumer assumes when none was handed
 * to it: the shipped default, `allowlist` with an empty list. It is the value
 * `resolveProcessEnvironmentPolicy` returns for a missing setting, so an absent
 * policy fails in the safe direction.
 */
export const SHIPPED_DEFAULT_POLICY: ProcessEnvironmentPolicy = Object.freeze({
  mode: 'allowlist',
  inheritProcessEnv: false,
  processEnvAllowlist: Object.freeze([]) as readonly string[]
});

/**
 * FR-R4-F06 (FR-005) -- a string that changes exactly when the policy's effect on a
 * child's environment changes: the mode and the sorted allowlist NAMES.
 *
 * Names only, and it reads no environment. A fingerprint built from the built
 * environment, or a hash of it, would put the values the allowlist exists to
 * withhold into a cache key. The version probe keys its cache by path plus this
 * string, so a policy change is a different key and not a stale hit.
 */
export function policyFingerprint(policy: ProcessEnvironmentPolicy): string {
  return `${policy.mode}:${[...(policy.processEnvAllowlist ?? [])].sort().join(',')}`;
}
