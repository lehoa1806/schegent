// Review gap GC-24 (2026-11-12) & FR-R7-16 (16-16, FR-016) -- single platform-aware executable
// resolver shared by containment qualification, CLI version probing, and subprocess launches.
//
// On win32, libuv searches the current directory before PATH for a bare name, and on POSIX an
// empty or relative PATH entry searches the child's cwd; explicit relative paths (`./foo`,
// `..\foo.exe`, `C:foo.exe`, `\foo.exe`) likewise resolve against host or child cwd. Every agent
// CLI, probe, and git spawn shares this resolver so qualification and launch select the exact
// same resolved absolute executable or refuse consistently regardless of host vs child cwd.
//
// A leaf module: runners, services, and `src/lib` itself all call it, and a leaf layer may not
// value-import the runner layer (FR-R3-110). Zero `vscode` imports (hard rule 13).
//
// WHAT LEAVES. The resolved absolute path of the executable on both POSIX and win32, or a typed
// failure / `ENOENT`/`EACCES` error naming no directory or operator path.

import { accessSync, constants, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/** The extensions libuv tries for a bare win32 name: it can start only these without a shell. */
const WIN32_SPAWNABLE_EXTENSIONS = ['.com', '.exe'] as const;
const WIN32_SHELL_ONLY_EXTENSIONS: ReadonlySet<string> = new Set(['.cmd', '.bat']);
const WIN32_DRIVE_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;
const WIN32_UNC_ABSOLUTE_RE = /^\\\\[^\\/]+\\[^\\/]+/;

export type ExecutableResolutionFailure = 'not-found' | 'not-executable' | 'invalid-path';

export type ExecutableResolutionResult =
  | { readonly ok: true; readonly resolvedPath: string }
  | { readonly ok: false; readonly cause: ExecutableResolutionFailure };

export type ExecutableAccessProbe = (
  candidate: string,
  platform: NodeJS.Platform
) => 'resolved' | 'not-found' | 'not-executable';

function isStrictWin32Absolute(value: string): boolean {
  return WIN32_DRIVE_ABSOLUTE_RE.test(value) || WIN32_UNC_ABSOLUTE_RE.test(value);
}

function isExplicitPath(command: string, platform: NodeJS.Platform): boolean {
  if (command === '.' || command === '..') return true;
  if (platform === 'win32') {
    return command.includes('/') || command.includes('\\') || command.includes(':');
  }
  return command.includes('/');
}

/**
 * True when `command` is empty, NUL-bearing, or an explicit relative, drive-relative (`C:foo`),
 * or rooted-without-drive (`\foo`) path that must be refused on `platform`.
 */
export function isInvalidExecutablePath(
  command: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (command.length === 0 || command.includes('\0')) return true;
  if (!isExplicitPath(command, platform)) return false;
  return platform === 'win32' ? !isStrictWin32Absolute(command) : !posix.isAbsolute(command);
}

/** PATH as the spawn will see it. win32 environment names are case-insensitive. */
function pathValueOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return env.PATH ?? '';
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  return key === undefined ? '' : (env[key] ?? '');
}

/** A local change detector for upgrades between observation and spawn. Never persisted or logged. */
export function executableFileStamp(resolvedPath: string): string | null {
  try {
    const file = statSync(resolvedPath, { bigint: true });
    return file.isFile() ? [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':') : null;
  } catch {
    return null;
  }
}

export function assertExecutableUnchanged(resolvedPath: string, expected: string | undefined): void {
  if (expected !== undefined && executableFileStamp(resolvedPath) !== expected) {
    throw new Error('Backend executable changed after admission. Retry to verify its version.');
  }
}

function defaultAccessProbe(
  candidate: string,
  platform: NodeJS.Platform
): 'resolved' | 'not-found' | 'not-executable' {
  try {
    const info = statSync(candidate);
    if (!info.isFile()) return 'not-executable';
    if (platform !== 'win32') {
      accessSync(candidate, constants.X_OK);
    }
    return 'resolved';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'not-found' : 'not-executable';
  }
}

function win32BareCandidateNames(command: string): readonly string[] {
  const ext = win32.extname(command);
  const lowerExt = ext.toLowerCase();
  const direct =
    ext.length > 0 && !WIN32_SHELL_ONLY_EXTENSIONS.has(lowerExt) ? [command] : [];
  return [
    ...direct,
    ...WIN32_SPAWNABLE_EXTENSIONS.map((suffix) => `${command}${suffix}`)
  ];
}

function isWin32ShellOnlyExtension(command: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && WIN32_SHELL_ONLY_EXTENSIONS.has(win32.extname(command).toLowerCase());
}

/**
 * Resolve `command` using the child's effective `env` and target `platform`.
 *
 * - Rejects empty strings, NUL bytes, and explicit relative / drive-relative / rooted-without-drive
 *   paths as `{ ok: false, cause: 'invalid-path' }`.
 * - Explicit strictly-absolute paths are probed directly without consulting `PATH`, except Win32
 *   shell-only `.cmd`/`.bat` shims which are refused as `'not-executable'` because `shell: false`
 *   cannot spawn them.
 * - Bare names are searched ONLY across strictly-absolute `PATH` entries (empty and relative
 *   entries are ignored so neither host nor child cwd is ever searched).
 * - On POSIX, requires a regular file with `X_OK`; on Win32, requires a regular file matching
 *   spawnable `[...(extname ? [name] : []), `${name}.com`, `${name}.exe`]`.
 * - Returns the resolved absolute path on both POSIX and Win32.
 */
export function resolveExecutableCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  accessProbe: ExecutableAccessProbe = defaultAccessProbe
): ExecutableResolutionResult {
  if (isInvalidExecutablePath(command, platform)) {
    return { ok: false, cause: 'invalid-path' };
  }

  if (isExplicitPath(command, platform)) {
    if (isWin32ShellOnlyExtension(command, platform)) {
      return { ok: false, cause: 'not-executable' };
    }
    const hit = accessProbe(command, platform);
    return hit === 'resolved'
      ? { ok: true, resolvedPath: command }
      : { ok: false, cause: hit };
  }

  const rawPath = pathValueOf(env, platform);
  const isWin32 = platform === 'win32';
  const delimiter = isWin32 ? ';' : ':';
  const directories = rawPath
    .split(delimiter)
    .filter((entry) =>
      entry.length > 0 && (isWin32 ? isStrictWin32Absolute(entry) : posix.isAbsolute(entry))
    );
  const names = isWin32 ? win32BareCandidateNames(command) : [command];
  let sawUnexecutable = false;

  for (const directory of directories) {
    for (const name of names) {
      const candidate = isWin32 ? win32.join(directory, name) : posix.join(directory, name);
      const hit = accessProbe(candidate, platform);
      if (hit === 'resolved') {
        return { ok: true, resolvedPath: candidate };
      }
      if (hit === 'not-executable') {
        sawUnexecutable = true;
      }
    }
  }

  return { ok: false, cause: sawUnexecutable ? 'not-executable' : 'not-found' };
}

/**
 * The resolved absolute executable path to hand `spawn`/`execFile` for `command`.
 *
 * Delegates to {@link resolveExecutableCommand} so qualification, version probing, and child
 * launches agree on both POSIX and Win32. Refuses relative paths, relative/empty `PATH` entries,
 * and unresolved commands by throwing an `ENOENT` or `EACCES` error naming no directory.
 *
 * @param env the environment the child will receive; searched instead of host `process.env`.
 */
export function spawnCommandFor(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  accessProbe?: ExecutableAccessProbe
): string {
  if (isInvalidExecutablePath(command, platform)) {
    const error: NodeJS.ErrnoException = new Error(
      'spawn ENOENT: relative or invalid executable path refused'
    );
    error.code = 'ENOENT';
    throw error;
  }
  if (isExplicitPath(command, platform)) {
    if (isWin32ShellOnlyExtension(command, platform)) {
      const error: NodeJS.ErrnoException = new Error(
        'spawn EACCES: shell-only executable refused'
      );
      error.code = 'EACCES';
      throw error;
    }
    return command;
  }
  const result = resolveExecutableCommand(command, env, platform, accessProbe);
  if (result.ok) return result.resolvedPath;
  const code = result.cause === 'not-executable' ? 'EACCES' : 'ENOENT';
  const detail = result.cause === 'not-executable' ? 'not executable' : 'not found on PATH';
  const error: NodeJS.ErrnoException = new Error(`spawn ${code}: ${detail}`);
  error.code = code;
  throw error;
}
