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
  /**
   * `process.kill(pid, 0)`. Returns `true` when a process holds that id, `false` when none does
   * (`ESRCH`), and throws when the OS will not say (`EPERM` or any other error).
   */
  readonly exists: (pid: number) => boolean;
  /** Epoch ms at which `pid` started, or `null` when it cannot be determined. */
  readonly startedAtMs: (pid: number) => Promise<number | null>;
  /**
   * FR-R4-F06 (P5, P6) — `process.kill(-pgid, 0)`. True when a member of the group can be
   * signalled. False on `ESRCH`. Throws on `EPERM` or any other error. Signal 0 only: nothing
   * in liveness code delivers a real signal (FR-017).
   */
  readonly groupExists: (pgid: number) => boolean;
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
    // The probe throws only when it cannot answer; "no such process" is answered as `false`.
    // The main case is EPERM: a process with that id exists and belongs to someone else — which
    // is itself evidence that the pid has been recycled, since our own child would be ours.
    // Treated as unanswerable rather than alive: refusing a resume on someone else's
    // process is the false positive this whole design exists to avoid.
    return 'unanswerable';
  }
  if (!exists) return leaderAbsentVerdict(identity, probe);

  const observed = await probe.startedAtMs(identity.pid);
  if (observed === null) {
    // The pid exists but we cannot establish WHICH process it is. Reporting `alive` here
    // would reintroduce the recycled-pid false positive through the back door.
    return 'unanswerable';
  }
  return startTimesMatch(identity.startedAtMs, observed) ? 'alive' : 'dead';
}

/**
 * The leader's pid is free. That alone does not say the Run's tree is gone: a helper in the
 * leader's process group may outlive it (FR-R4-F06, data-model section 4, rows 7 to 9).
 *
 * Asked ONLY here. A recycled leader pid (it exists with a different start time) proves the
 * group `pgid` ended, because a group id is not reused while the group has members, and the
 * group that answers for it now would be a stranger's.
 */
function leaderAbsentVerdict(identity: SpawnIdentity, probe: LivenessProbe): LivenessVerdict {
  try {
    return probe.groupExists(identity.pgid) ? 'orphaned-group' : 'dead';
  } catch {
    // EPERM: a member exists that the host may not signal. It cannot be called `dead`
    // (something answers) nor `orphaned-group` (it may not be this Run's), so it is the
    // honest `unanswerable`, which `RESUME_ON` permits, as it does for a pid probe that throws.
    return 'unanswerable';
  }
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
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // Only ESRCH means gone. Every other error, EPERM first, means the OS will not say,
        // which `checkLiveness` records as `unanswerable`.
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw error;
      }
    },
    groupExists: (pgid: number): boolean => {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch (error) {
        // Only ESRCH means no member is left; everything else, EPERM first, is "will not say".
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw error;
      }
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
