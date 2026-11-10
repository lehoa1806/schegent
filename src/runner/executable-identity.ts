// FR-R6-F09 (FR-008; research R8) -- does the configured CLI resolve to something the spawn can
// start? Checked before any process starts, so an unresolved executable is a named refusal, not a
// spawn error.
//
// RULES. A value with a path separator is checked as given. A bare name is searched along PATH in
// order; on win32 the PATHEXT extensions are tried too. A hit must be a regular file with execute
// permission (on win32, existence). A non-executable hit does not end the search: a later PATH
// entry may hold the real program, as the shell would find it.
//
// WHAT LEAVES. One closed word. No path, directory or PATH entry is returned, so none can reach a
// message or a log (NFR-005).

import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutableUnresolvedCause } from '../contracts/containment-qualification';

/** The extensions win32 tries when PATHEXT is unset. */
export const DEFAULT_WIN32_PATHEXT = '.COM;.EXE;.BAT;.CMD';

type Probe = 'resolved' | ExecutableUnresolvedCause;

function hasSeparator(value: string, platform: NodeJS.Platform): boolean {
  return value.includes('/') || (platform === 'win32' && value.includes('\\'));
}

async function probe(candidate: string, platform: NodeJS.Platform): Promise<Probe> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return 'not-executable';
    if (platform !== 'win32') await access(candidate, constants.X_OK);
    return 'resolved';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'not-found' : 'not-executable';
  }
}

function namesFor(name: string, platform: NodeJS.Platform, pathExt: string): readonly string[] {
  if (platform !== 'win32') return [name];
  const extensions = pathExt.split(';').filter((ext) => ext.length > 0);
  return [name, ...extensions.map((ext) => `${name}${ext}`)];
}

/**
 * `'resolved'` when `cliPath` names a program the spawn can start, else why not. Never throws.
 * `envPath` is the PATH the spawn will see; `pathExt` matters on win32 only.
 */
export async function resolveExecutable(
  cliPath: string,
  envPath: string | undefined,
  platform: NodeJS.Platform,
  pathExt: string = DEFAULT_WIN32_PATHEXT
): Promise<Probe> {
  if (cliPath.length === 0) return 'not-found';
  if (hasSeparator(cliPath, platform)) return probe(cliPath, platform);

  const delimiter = platform === 'win32' ? ';' : ':';
  const directories = (envPath ?? '').split(delimiter).filter((entry) => entry.length > 0);
  let sawUnexecutable = false;
  for (const directory of directories) {
    for (const name of namesFor(cliPath, platform, pathExt)) {
      const result = await probe(join(directory, name), platform);
      if (result === 'resolved') return result;
      if (result === 'not-executable') sawUnexecutable = true;
    }
  }
  return sawUnexecutable ? 'not-executable' : 'not-found';
}
