// Feature 091 T008 — Linux systemd-user removal.
//
// Ports ONLY the uninstall path of the deleted
// `src/wakeup/platforms/systemd-user.ts`. Unit names and the unit
// directory resolution are copied byte-for-byte (contract C-03).

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultCommandRunner } from './command-runner';
import { describeFailure, type SchedulerAttempt, type SchedulerRemovalDeps } from './types';

/** Verbatim from `src/wakeup/platforms/systemd-user.ts` (contract C-03). */
export const SYSTEMD_UNIT_BASENAME = 'schegent-wakeup';
export const SYSTEMD_SERVICE = `${SYSTEMD_UNIT_BASENAME}.service`;
export const SYSTEMD_TIMER = `${SYSTEMD_UNIT_BASENAME}.timer`;

export function systemdUserUnitDir(dirOverride?: string): string {
  if (dirOverride) return dirOverride;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'systemd', 'user');
}

/**
 * Disable the timer, unlink both units, then reload the daemon.
 *
 * Idempotent: `systemctl --user disable --now` on an unknown unit exits
 * non-zero but harmlessly, so its exit code is ignored exactly as the
 * replaced module did; ENOENT on either unlink means that unit was
 * already gone. Identity-scoped: only the two named unit files are
 * unlinked — the unit directory itself and every other unit in it are
 * left untouched. Total: never throws (contract C-02).
 */
export async function remove(deps: SchedulerRemovalDeps = {}): Promise<SchedulerAttempt> {
  const runner = deps.runner ?? defaultCommandRunner();
  const dir = systemdUserUnitDir(deps.unitDir);

  try {
    await runner.run('systemctl', ['--user', 'disable', '--now', SYSTEMD_TIMER]);

    let removedAny = false;
    for (const name of [SYSTEMD_TIMER, SYSTEMD_SERVICE]) {
      try {
        await fs.unlink(path.join(dir, name));
        removedAny = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }

    await runner.run('systemctl', ['--user', 'daemon-reload']);

    return {
      scheduler: 'systemd-user',
      result: removedAny ? 'removed' : 'absent'
    };
  } catch (err) {
    return { scheduler: 'systemd-user', result: 'failed', reason: describeFailure(err) };
  }
}
