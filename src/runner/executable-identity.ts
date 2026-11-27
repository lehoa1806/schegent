// FR-R6-F09 (FR-008; research R8) & FR-R7-16 (16-16, FR-016) -- does the configured CLI resolve
// to something the spawn can start? Checked before any process starts, so an unresolved executable
// is a named refusal, not a spawn error.
//
// ONE RESOLVER. Delegates to `resolveExecutableCommand` in `src/lib/spawn-command.ts` so
// qualification, version probing, and actual launch always select the exact same resolved
// executable or refuse consistently across POSIX and Windows (rejecting explicit relative,
// drive-relative, and rooted-without-drive paths, empty/relative PATH entries, and non-spawnable
// Win32 shell shims).
//
// WHAT LEAVES. One closed word (`'resolved' | 'not-found' | 'not-executable'`). No path,
// directory, or PATH entry is returned, so none can reach a message or a log (NFR-005).

import type { ExecutableUnresolvedCause } from '../contracts/containment-qualification';
import {
  resolveExecutableCommand,
  type ExecutableAccessProbe
} from '../lib/spawn-command';

/** The spawnable extensions win32 tries without a shell (`shell: false`). */
export const DEFAULT_WIN32_PATHEXT = '.COM;.EXE';

type Probe = 'resolved' | ExecutableUnresolvedCause;

/**
 * `'resolved'` when `cliPath` names a program the spawn can start under `envOrPath` and `platform`,
 * else why not. Never throws.
 *
 * `envOrPath` accepts either the full child `ProcessEnv` (preferred, matching `spawnCommandFor`)
 * or a raw `PATH` string for callers/tests that pass only the `PATH` value.
 */
export async function resolveExecutable(
  cliPath: string,
  envOrPath: NodeJS.ProcessEnv | string | undefined,
  platform: NodeJS.Platform = process.platform,
  accessProbe?: ExecutableAccessProbe
): Promise<Probe> {
  const env: NodeJS.ProcessEnv =
    envOrPath === undefined
      ? {}
      : typeof envOrPath === 'string'
        ? { PATH: envOrPath }
        : envOrPath;
  const result = resolveExecutableCommand(cliPath, env, platform, accessProbe);
  if (result.ok) return 'resolved';
  return result.cause === 'not-executable' ? 'not-executable' : 'not-found';
}
