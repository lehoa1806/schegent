// Feature 014 — Shared node-binary resolver for all 4 installers.
//
// launchd / Task Scheduler / cron / systemd-user units all hard-code
// an absolute path to a `node` binary so they don't depend on the
// scheduler's PATH. We resolve at install time via `which` (posix) or
// `where.exe` (Windows).

import type { CommandRunner } from '../daemon-manager';

export async function resolveNodePath(runner: CommandRunner): Promise<string> {
  const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = await runner.run(cmd, ['node']);
  if (result.exitCode !== 0) {
    throw new Error('node-not-found-in-path');
  }
  const first = result.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!first) throw new Error('node-not-found-in-path');
  return first.trim();
}
