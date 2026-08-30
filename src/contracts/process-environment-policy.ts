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
 */
export function resolveProcessEnvironmentPolicy(input: {
  readonly inheritEnvironment: boolean;
  readonly mode: unknown;
  readonly allowlist: unknown;
}): ProcessEnvironmentPolicy {
  if (!input.inheritEnvironment || input.mode === 'minimal') {
    return Object.freeze({ mode: 'minimal', inheritProcessEnv: false });
  }
  if (input.mode === 'allowlist') {
    return Object.freeze({
      mode: 'allowlist',
      inheritProcessEnv: false,
      processEnvAllowlist: sanitizeProcessEnvAllowlist(input.allowlist)
    });
  }
  return Object.freeze({ mode: 'inherit', inheritProcessEnv: true });
}
