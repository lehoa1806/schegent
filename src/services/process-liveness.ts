// FR-R3-103 (FR-042, FR-045) — is the process tree this Run recorded still alive?
//
// WHY THIS IS NOT `kill(pid, 0)`. Pids are recycled, and on a busy machine they are recycled
// quickly. A bare signal probe against a recycled pid answers "alive" about a process that
// has nothing to do with this Run, and the consequence is refusing to resume a Run that is
// genuinely abandoned — permanently, because the false positive never clears. So the probe is
// only half the check: the recorded start timestamp is what makes the answer about *that*
// process.
//
// THE PLATFORM SPLIT, and why it is honest rather than convenient. On POSIX the start time is
// read from `ps -o lstart=`, which every mainstream implementation carries. Where it cannot be
// read the verdict is `unanswerable`, NOT `dead` — a platform that cannot answer must not be
// recorded as having answered. `RESUME_ON` includes `unanswerable`, so behaviour is unchanged
// where the check cannot run; what changes is that the audit trail says which case applied.
//
// FR-R3-054's discipline: claim no more than the evidence supports. On Windows `detached` is
// false and the job-object gap is a stated permanent limit, so this returns `unanswerable`
// there rather than pretending a group probe means the same thing.
import { execFile } from 'node:child_process';
import type { LivenessVerdict, SpawnIdentity } from '../contracts/spawn-identity';
import { startTimesMatch } from '../contracts/spawn-identity';

/** The seams: injected so tests never signal a real process. */
export interface LivenessProbe {
  /** `process.kill(pid, 0)` — true when a process with that id exists. */
  readonly exists: (pid: number) => boolean;
  /** Epoch ms at which `pid` started, or `null` when it cannot be determined. */
  readonly startedAtMs: (pid: number) => Promise<number | null>;
  readonly platform: string;
}

export async function checkLiveness(
  identity: SpawnIdentity | undefined,
  probe: LivenessProbe
): Promise<LivenessVerdict> {
  // A Run persisted before FR-R3-103, or one whose child was already reaped.
  if (identity === undefined) return 'unrecorded';

  // Windows: `detached` is false there, so the recorded pgid is not a group this can probe,
  // and the job-object gap means a surviving descendant would not be found anyway. Saying
  // `unanswerable` is the honest verdict; a `dead` here would be a claim the evidence does
  // not support, which is the FR-R3-054 rule.
  if (probe.platform === 'win32') return 'unanswerable';

  let exists: boolean;
  try {
    exists = probe.exists(identity.pid);
  } catch {
    // EPERM means a process with that id exists and belongs to someone else — which is
    // itself evidence that the pid has been recycled, since our own child would be ours.
    // Treated as unanswerable rather than alive: refusing a resume on someone else's
    // process is the false positive this whole design exists to avoid.
    return 'unanswerable';
  }
  if (!exists) return 'dead';

  const observed = await probe.startedAtMs(identity.pid);
  if (observed === null) {
    // The pid exists but we cannot establish WHICH process it is. Reporting `alive` here
    // would reintroduce the recycled-pid false positive through the back door.
    return 'unanswerable';
  }
  return startTimesMatch(identity.startedAtMs, observed) ? 'alive' : 'dead';
}

/**
 * The default probe.
 *
 * `ps -o lstart=` rather than `/proc`: it works on macOS and Linux alike, and this project
 * verifies on one platform, so reaching for a Linux-only interface would mean shipping a path
 * nobody here can exercise.
 */
export function createLivenessProbe(): LivenessProbe {
  return {
    platform: process.platform,
    exists: (pid: number): boolean => {
      process.kill(pid, 0);
      return true;
    },
    startedAtMs: async (pid: number): Promise<number | null> =>
      new Promise((resolve) => {
        execFile('ps', ['-o', 'lstart=', '-p', String(pid)], (error, stdout) => {
          if (error !== null) {
            resolve(null);
            return;
          }
          const parsed = Date.parse(stdout.trim());
          resolve(Number.isFinite(parsed) ? parsed : null);
        });
      })
  };
}
