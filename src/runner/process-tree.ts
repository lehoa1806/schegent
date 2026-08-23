import { spawn, type ChildProcess } from 'node:child_process';

/**
 * FR-R3-054 (H-05) — own the backend process tree, not just the direct child.
 *
 * The escalation ladder called `child.kill(signal)`, which signals one process.
 * No `detached`, process group, `setsid` or Job Object existed anywhere in `src`.
 * A CLI tool that forks a helper therefore survived cancel, timeout, aggressive
 * pause and deactivation, and could keep mutating the workspace after Schegent
 * had recorded a terminal state -- racing rollback, retry, recovery and the next
 * phase.
 *
 * Demonstrated in `tests/unit/runner/process-tree.test.ts`: a grandchild
 * appending to a sentinel file keeps appending after the direct child is
 * SIGKILLed.
 */

/**
 * Spawn options that give the backend its own process group, so the whole tree
 * can be signalled at once.
 *
 * POSIX: `detached: true` makes the child a process group leader, and
 * `process.kill(-pid, …)` then reaches every descendant. The parent still awaits
 * it -- `unref()` is deliberately NOT called, because the goal is to OWN the
 * tree, not to disown the child.
 *
 * Windows: there is no process group to create. `detached` there controls
 * console allocation, not lifetime, and asking for it would suggest a guarantee
 * that does not exist. The tree is reached with `taskkill /T` instead, which is
 * the well-audited equivalent named in the requirement; a real Job Object with
 * kill-on-close needs a native binding and is stated as follow-on rather than
 * implied here.
 */
export function processTreeSpawnOptions(): { readonly detached: boolean } {
  return { detached: process.platform !== 'win32' };
}

/**
 * Signal the child's whole tree, preserving the caller's escalation ladder.
 *
 * Signals the group AND the direct child. Not a fallback -- both, every time.
 * A child with no group of its own (an injected double, or a path this migration
 * has not reached) must still receive the signal, and a real child already
 * reaped via its group simply reports ESRCH for the second one.
 */
export async function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals
): Promise<void> {
  const pid = child.pid;

  // The GROUP first, where there is one. Best-effort by design: a child spawned
  // without `detached` -- an injected double, or a path not yet migrated -- has no
  // group of its own, and `process.kill(-pid)` there fails rather than doing
  // something surprising.
  if (pid !== undefined) {
    if (process.platform === 'win32') {
      await killWindowsTree(pid, signal);
    } else {
      try {
        // Negative pid means "the group whose leader is pid".
        process.kill(-pid, signal);
      } catch {
        /* no group, already gone, or not ours -- the direct signal below stands */
      }
    }
  }

  // The direct child, ALWAYS, and not only as a fallback. Signalling a process
  // already killed via its group throws ESRCH and is swallowed, so this costs
  // nothing there -- while omitting it broke every runner test whose fake child
  // has no real group, and would equally break a real child spawned by a path
  // this migration has not reached.
  try {
    child.kill(signal);
  } catch {
    /* already exited */
  }
}

/**
 * Whether the tree is gone. This is what lets a phase finalize honestly: a
 * terminal state recorded while descendants are still running is a terminal
 * state that lies.
 *
 * Signal 0 checks for existence without delivering anything. On Windows there is
 * no group to probe, so this answers only for the direct child and callers must
 * treat a `true` there as "the child is gone", not "the tree is".
 */
export function processTreeIsGone(child: ChildProcess): boolean {
  const pid = child.pid;
  if (pid === undefined) return true;
  const target = process.platform === 'win32' ? pid : -pid;
  try {
    process.kill(target, 0);
    return false;
  } catch (error) {
    // EPERM means it exists and is not ours -- still not gone.
    return errnoOf(error) !== 'EPERM';
  }
}

/**
 * `taskkill /T` walks the child tree by parent-pid. `/F` is used only for the
 * final, non-graceful step: a SIGTERM-equivalent request is sent without it so a
 * CLI that handles shutdown still gets the chance to.
 */
async function killWindowsTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  const args = ['/pid', String(pid), '/T'];
  if (signal === 'SIGKILL') args.push('/F');
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill', args, { stdio: 'ignore', shell: false });
    killer.once('exit', () => resolve());
    killer.once('error', () => resolve());
  });
}

function errnoOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
}
