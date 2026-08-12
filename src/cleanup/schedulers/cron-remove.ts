// Feature 091 T009 — Linux cron removal.
//
// Ports ONLY the uninstall path of the deleted
// `src/wakeup/platforms/cron.ts`. The marker is copied byte-for-byte
// (contract C-03).
//
// The crontab is operator-owned shared state, so this module is the
// most identity-sensitive of the four: it rewrites a file that may
// contain entries nothing to do with this product. Only lines carrying
// the marker are dropped; every other line — including whitespace and
// comments — is preserved byte-for-byte (contract C-02 guarantee 2).

import { defaultCommandRunner } from './command-runner';
import {
  describeFailure,
  type CommandRunner,
  type SchedulerAttempt,
  type SchedulerRemovalDeps
} from './types';

/** Verbatim from `src/wakeup/platforms/cron.ts` (contract C-03). */
export const CRON_MARKER = '# schegent-wakeup';

export function stripOurEntry(body: string, marker = CRON_MARKER): string {
  return body
    .split('\n')
    .filter((l) => !l.includes(marker))
    .join('\n');
}

async function readCrontab(runner: CommandRunner): Promise<string> {
  const r = await runner.run('crontab', ['-l']);
  // Exit 1 with empty stdout is "no crontab for this user" on most
  // distros — an absent crontab, not an error.
  if (r.exitCode !== 0) return '';
  return r.stdout;
}

/**
 * Remove the marked line from the user's crontab.
 *
 * Idempotent: a crontab with no marked line is left byte-for-byte
 * unchanged and reports `absent` without a write, so a second call is
 * indistinguishable from the first. Total: never throws (contract
 * C-02).
 */
export async function remove(deps: SchedulerRemovalDeps = {}): Promise<SchedulerAttempt> {
  const runner = deps.runner ?? defaultCommandRunner();

  try {
    const current = await readCrontab(runner);
    if (!current.includes(CRON_MARKER)) {
      // Nothing of ours is present. Deliberately do NOT write the
      // crontab back: a no-op rewrite would still be a destructive
      // operation against operator-owned state.
      return { scheduler: 'cron', result: 'absent' };
    }

    const updated = stripOurEntry(current);
    const r = await runner.run('crontab', ['-'], { input: updated });
    if (r.exitCode !== 0) {
      throw new Error(`crontab write failed: ${r.stderr.trim() || r.exitCode}`);
    }

    return { scheduler: 'cron', result: 'removed' };
  } catch (err) {
    return { scheduler: 'cron', result: 'failed', reason: describeFailure(err) };
  }
}
