// Feature 091 T010 — Windows Task Scheduler removal.
//
// Ports ONLY the uninstall path of the deleted
// `src/wakeup/platforms/task-scheduler.ts`. The task name is copied
// byte-for-byte (contract C-03).

import { defaultCommandRunner } from './command-runner';
import { describeFailure, type SchedulerAttempt, type SchedulerRemovalDeps } from './types';

/** Verbatim from `src/wakeup/platforms/task-scheduler.ts` (contract C-03). */
export const WINDOWS_TASK_NAME = 'Schegent\\WakeUp';

/**
 * `schtasks /Delete /TN <name> /F`.
 *
 * Idempotent: deleting a task that does not exist exits non-zero, which
 * the replaced module already treated as success. That exit code is the
 * only signal available, so it is read as `absent` rather than
 * `failed` — the operator-visible end state (no task registered) is
 * identical either way, and reporting `failed` here would produce a
 * warning on every machine that never enabled Wake-up, against FR-014.
 * Identity-scoped: `/TN` names exactly one task. Total: never throws
 * (contract C-02).
 */
export async function remove(deps: SchedulerRemovalDeps = {}): Promise<SchedulerAttempt> {
  const runner = deps.runner ?? defaultCommandRunner();

  try {
    const r = await runner.run('schtasks', ['/Delete', '/TN', WINDOWS_TASK_NAME, '/F']);
    return {
      scheduler: 'task-scheduler',
      result: r.exitCode === 0 ? 'removed' : 'absent'
    };
  } catch (err) {
    return { scheduler: 'task-scheduler', result: 'failed', reason: describeFailure(err) };
  }
}
