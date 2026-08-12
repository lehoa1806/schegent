// Feature 091 T007 — macOS launchd removal.
//
// Ports ONLY the uninstall path of the deleted
// `src/wakeup/platforms/launchd.ts`. There is deliberately no install,
// update, or reconcile code here: this module exists to withdraw an
// entry a previous release registered, never to create one.
//
// The label is copied byte-for-byte from the module being replaced. A
// changed value orphans the very entry cleanup exists to remove
// (contract C-03).

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultCommandRunner } from './command-runner';
import { describeFailure, type SchedulerAttempt, type SchedulerRemovalDeps } from './types';

/** Verbatim from `src/wakeup/platforms/launchd.ts` (contract C-03). */
export const LAUNCHD_LABEL = 'com.schegent.wakeup';

export function launchdPlistPath(homeOverride?: string): string {
  const home = homeOverride ?? os.homedir();
  return path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

/**
 * Unload the agent and delete its plist.
 *
 * Idempotent: `launchctl unload` on an unregistered label is a no-op we
 * ignore the exit code of, and a missing plist reports `absent`.
 * Identity-scoped: only the plist named by `LAUNCHD_LABEL` is touched.
 * Total: never throws (contract C-02).
 */
export async function remove(deps: SchedulerRemovalDeps = {}): Promise<SchedulerAttempt> {
  const runner = deps.runner ?? defaultCommandRunner();
  const plist = launchdPlistPath(deps.homeDir);

  try {
    // Ordering matters: unload before unlink, so launchd is not left
    // holding a job whose plist has vanished.
    await runner.run('launchctl', ['unload', plist]);

    try {
      await fs.unlink(plist);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Nothing was registered by this machine's earlier releases.
        return { scheduler: 'launchd', result: 'absent' };
      }
      throw err;
    }

    return { scheduler: 'launchd', result: 'removed' };
  } catch (err) {
    return { scheduler: 'launchd', result: 'failed', reason: describeFailure(err) };
  }
}
