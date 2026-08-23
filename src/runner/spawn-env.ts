import type { InvocationRequest } from './invocation-result';

export type ProcessEnvironmentMode = 'inherit' | 'minimal' | 'allowlist';

export interface ProcessEnvironmentPolicy {
  readonly mode: ProcessEnvironmentMode;
  readonly inheritProcessEnv: boolean;
  readonly processEnvAllowlist?: readonly string[];
}

export const PROCESS_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Non-secret bootstrap variables needed for executable lookup, home/config
 * discovery, temporary files, locale handling, and the Windows runtime.
 * `LC_*` variables are also copied dynamically.
 */
export const REQUIRED_PROCESS_ENV_NAMES: readonly string[] = Object.freeze([
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC'
]);

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

/** Resolve the new mode while preserving the legacy boolean opt-out. */
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

/**
 * FR-R3-049 (M-11) — the one place that says how an invocation gets its policy.
 *
 * Before this existed, the three internal invokers each wrote the same
 * conditional spread by hand:
 *
 *     ...(policy.inheritProcessEnv === false ? { inheritProcessEnv: false } : {}),
 *     ...(policy.processEnvAllowlist !== undefined ? { processEnvAllowlist: … } : {}),
 *
 * Two of them did. The credit watchdog wrote neither, and because all three
 * request fields are OPTIONAL that omission compiled, read exactly like its
 * siblings, and sent the automatic `/status` poll the complete `process.env` --
 * including the credentials an operator's allowlist exists to withhold.
 *
 * The duplication is why the omission was invisible: with no single place that
 * says how a policy reaches a request, a reader comparing the watchdog to the
 * other two sees three plausible request literals rather than one missing
 * argument. So this function is not tidying -- it is the thing whose absence hid
 * the defect, and it is what lets a test assert the mapping by calling the same
 * code production calls instead of restating it and drifting.
 */
export function policyRequestFields(
  // Anything that carries a policy: a resolved `ProcessEnvironmentPolicy`, or the
  // controller inputs that already hold the same two fields. Normalising both
  // into request fields is the point -- otherwise a caller holding inputs has to
  // synthesise a policy object to hand to a helper that immediately takes it
  // apart again, which is how the awkward first version of this read.
  source: { readonly inheritProcessEnv?: boolean; readonly processEnvAllowlist?: readonly string[] }
): Pick<InvocationRequest, 'inheritProcessEnv' | 'processEnvAllowlist'> {
  return {
    ...(source.inheritProcessEnv === false ? { inheritProcessEnv: false } : {}),
    ...(source.processEnvAllowlist !== undefined
      ? { processEnvAllowlist: source.processEnvAllowlist }
      : {})
  };
}

export function buildSpawnEnv(
  request: Pick<InvocationRequest, 'env' | 'inheritProcessEnv' | 'processEnvAllowlist'>
): NodeJS.ProcessEnv {
  const overlay = request.env ?? {};
  if (request.processEnvAllowlist !== undefined) {
    const approved = new Set([
      ...REQUIRED_PROCESS_ENV_NAMES,
      ...sanitizeProcessEnvAllowlist(request.processEnvAllowlist)
    ]);
    const selected: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (approved.has(name) || name.startsWith('LC_')) {
        selected[name] = value;
      }
    }
    return { ...selected, ...overlay };
  }
  if (request.inheritProcessEnv === false) {
    return { ...overlay };
  }
  // FR-R3-049 — a COPY on both arms. The second used to return `process.env`
  // itself, handing a spawn the live environment object: anything mutating what
  // it received would mutate the host's own environment. Nothing does today,
  // which is exactly why it would have gone unnoticed. Identity changes here;
  // contents do not.
  return { ...process.env, ...overlay };
}
