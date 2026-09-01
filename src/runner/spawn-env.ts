import type { InvocationRequest } from './invocation-result';
import { sanitizeProcessEnvAllowlist } from '../contracts/process-environment-policy';

// FR-R3-143 (T034) — the policy fold moved to `src/contracts/process-environment-policy.ts`
// so the settings surface can call it instead of restating it; see that file for why.
// Re-exported here because eight host modules and three test files import these
// names from this path, and a boundary move that rewrites fourteen import lines is
// a boundary move nobody can review.
export {
  PROCESS_ENVIRONMENT_MODES,
  PROCESS_ENV_NAME_PATTERN,
  PROCESS_ENV_NAME_PATTERN_SOURCE,
  resolveProcessEnvironmentPolicy,
  sanitizeProcessEnvAllowlist
} from '../contracts/process-environment-policy';
export type {
  ProcessEnvironmentMode,
  ProcessEnvironmentPolicy
} from '../contracts/process-environment-policy';

/**
 * Non-secret bootstrap variables needed for executable lookup, home/config
 * discovery, account identity, temporary files, locale handling, and the
 * Windows runtime. `LC_*` variables are also copied dynamically.
 *
 * ACCOUNT IDENTITY IS BOOTSTRAP, NOT CONVENIENCE. `USER`/`LOGNAME`/`USERNAME`
 * were absent until 2026-08-31, and the omission read as harmless because
 * `HOME` was present: a child could still find `~/.claude`, so its settings,
 * plugins and skills all loaded correctly. What it could NOT do was
 * authenticate. The Claude CLI resolves its OAuth credential from the macOS
 * login Keychain, and that lookup identifies the account by `USER`; with the
 * name stripped it finds no credential at all and exits in ~87ms with
 * `Not logged in - Please run /login`.
 *
 * That message names a remedy which does not apply -- the machine IS logged in,
 * and logging in again changes nothing -- so the failure was attributed to an
 * expired session rather than to the spawn environment. Since `allowlist` with
 * an empty list is the SHIPPED DEFAULT, this made the default configuration
 * unable to authenticate on macOS.
 *
 * The general rule this encodes: a name is bootstrap when the CLI cannot start
 * WORKING without it, which is not the same as cannot start. An outage that
 * presents as a credential problem is the most expensive shape this list has.
 */
export const REQUIRED_PROCESS_ENV_NAMES: readonly string[] = Object.freeze([
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'USER',
  'LOGNAME',
  'USERNAME',
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
