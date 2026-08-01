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
  return request.env ? { ...process.env, ...overlay } : process.env;
}
