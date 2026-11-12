// Review gap GC-24 (2026-11-12) -- the command to hand `spawn`/`execFile` for a program name.
//
// On win32, libuv searches the current directory before PATH for a bare name, and the host spawns
// agent CLIs and git with the workspace as the cwd: a `claude.exe` or `git.exe` committed to a
// repository would run in place of the installed one. npm installs CLIs as `.cmd` shims, which
// libuv does not try, so the planted file would win even with the real CLI installed.
//
// A leaf module: runners, services and `src/lib` itself all spawn git, and a leaf layer may not
// value-import the runner layer (FR-R3-110).
//
// WHAT LEAVES. The command unchanged, or on win32 the absolute path of the PATH hit, for `spawn` to
// start and nothing else. A miss throws an `ENOENT` error whose message names no directory.

import { statSync } from 'node:fs';
import { extname, join } from 'node:path';

/** The extensions libuv tries for a bare win32 name: it can start only these without a shell. */
const WIN32_SPAWNABLE_EXTENSIONS = ['.com', '.exe'] as const;

function hasSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

/** PATH as the spawn will see it. win32 environment names are case-insensitive. */
function win32PathOf(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  return key === undefined ? '' : (env[key] ?? '');
}

function isRegularFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * The command to hand `spawn`/`execFile` for `command`.
 *
 * On win32 a bare name is resolved along PATH only, trying the name as given when it has an
 * extension and then `.com` and `.exe`, as libuv does, and the absolute path is returned. A miss
 * throws an `ENOENT` error that names no directory. A name with a separator, and any name on
 * another platform (where a bare name never resolves from the cwd), is returned unchanged.
 *
 * @param env the environment the child will receive; libuv searches that PATH.
 */
export function spawnCommandFor(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== 'win32' || hasSeparator(command)) return command;
  const names = [
    ...(extname(command).length > 0 ? [command] : []),
    ...WIN32_SPAWNABLE_EXTENSIONS.map((ext) => `${command}${ext}`)
  ];
  const directories = win32PathOf(env)
    .split(';')
    .filter((entry) => entry.length > 0);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isRegularFile(candidate)) return candidate;
    }
  }
  const error: NodeJS.ErrnoException = new Error(`spawn ${command} ENOENT: not found on PATH`);
  error.code = 'ENOENT';
  throw error;
}
