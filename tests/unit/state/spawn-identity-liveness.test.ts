import { describe, expect, it } from 'vitest';
import { checkLiveness, type LivenessProbe } from '../../../src/services/process-liveness';
import {
  RESUME_ON,
  START_TIME_TOLERANCE_MS,
  startTimesMatch,
  type SpawnIdentity
} from '../../../src/contracts/spawn-identity';

/**
 * FR-R3-103 (FR-044, FR-045) — a recycled pid does not read as alive, and a platform that
 * cannot answer does not read as dead.
 *
 * THE FALSE POSITIVE THIS PREVENTS. A bare `kill(pid, 0)` against a recycled pid answers
 * "alive" about an unrelated process, and the consequence is refusing to resume a Run that is
 * genuinely abandoned — permanently, because nothing ever clears it. Pids recycle fast on a
 * busy machine, and the machine is busy precisely when a host crashed mid-phase. So the pid
 * is half the check and the recorded start time is the other half.
 *
 * THE FALSE NEGATIVE IT ALSO PREVENTS. Reporting `dead` when the check simply could not run
 * would let activation resume into a live orphan — the exact race this item exists to close —
 * while the audit trail said the tree was gone. `unanswerable` is its own verdict for that
 * reason, and `RESUME_ON` includes it as a recorded decision rather than a conflation.
 */
const identity = (over: Partial<SpawnIdentity> = {}): SpawnIdentity => ({
  pid: 4242,
  pgid: 4242,
  startedAtMs: 1_700_000_000_000,
  ...over
});

const probe = (over: Partial<LivenessProbe> = {}): LivenessProbe => ({
  platform: 'darwin',
  exists: () => true,
  startedAtMs: async () => 1_700_000_000_000,
  ...over
});

describe('FR-R3-103 — liveness is decided by the identity, not by the pid', () => {
  it('alive: the pid exists and its start time matches what was recorded', async () => {
    expect(await checkLiveness(identity(), probe())).toBe('alive');
  });

  it('dead: no process holds that pid', async () => {
    expect(await checkLiveness(identity(), probe({ exists: () => false }))).toBe('dead');
  });

  it('dead: the pid exists but started at a DIFFERENT time — a recycled pid', async () => {
    // The false positive a bare signal probe produces. The process is real, the pid matches,
    // and it is not our child.
    const verdict = await checkLiveness(
      identity({ startedAtMs: 1_700_000_000_000 }),
      probe({ startedAtMs: async () => 1_700_000_000_000 + 60_000 })
    );
    expect(verdict, 'a recycled pid must not read as alive').toBe('dead');
  });

  it('a recycled pid is refused in both directions of the clock', async () => {
    for (const skewMs of [-60_000, -10_000, 10_000, 60_000]) {
      const verdict = await checkLiveness(
        identity(),
        probe({ startedAtMs: async () => 1_700_000_000_000 + skewMs })
      );
      expect(verdict, `skew ${skewMs} must read as dead`).toBe('dead');
    }
  });

  it('tolerates the small skew between the host clock and the OS report', async () => {
    // The recorded value is `Date.now()` just before spawn returns; the observed one comes
    // from the OS at a slightly different instant and often at coarser resolution. A check
    // demanding equality would call every live process dead.
    for (const skewMs of [0, 500, START_TIME_TOLERANCE_MS, -START_TIME_TOLERANCE_MS]) {
      const verdict = await checkLiveness(
        identity(),
        probe({ startedAtMs: async () => 1_700_000_000_000 + skewMs })
      );
      expect(verdict, `skew ${skewMs} is within tolerance`).toBe('alive');
    }
    // ...and one millisecond past the tolerance is not.
    expect(
      await checkLiveness(
        identity(),
        probe({ startedAtMs: async () => 1_700_000_000_000 + START_TIME_TOLERANCE_MS + 1 })
      )
    ).toBe('dead');
  });

  it('unrecorded: a Run persisted before this field existed', async () => {
    expect(await checkLiveness(undefined, probe())).toBe('unrecorded');
  });

  it('unanswerable: the pid exists but its start time cannot be read', async () => {
    // Reporting `alive` here would reintroduce the recycled-pid false positive through the
    // back door, and `dead` would be a claim the evidence does not support.
    expect(await checkLiveness(identity(), probe({ startedAtMs: async () => null }))).toBe(
      'unanswerable'
    );
  });

  it('unanswerable: the probe throws, which means the pid belongs to someone else', async () => {
    // EPERM is evidence of recycling, not of our child being alive.
    const verdict = await checkLiveness(
      identity(),
      probe({
        exists: () => {
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        }
      })
    );
    expect(verdict).toBe('unanswerable');
  });

  it('unanswerable on Windows, and it does not even probe', async () => {
    // `detached` is false there, so the recorded pgid is not a probeable group, and the
    // job-object gap means a surviving descendant would not be found anyway. FR-R3-054's
    // rule: claim no more than the evidence supports.
    let probed = false;
    const verdict = await checkLiveness(
      identity(),
      probe({
        platform: 'win32',
        exists: () => {
          probed = true;
          return true;
        }
      })
    );
    expect(verdict).toBe('unanswerable');
    expect(probed, 'no probe should run where its answer would not mean anything').toBe(false);
  });

  it('only ALIVE blocks a resume; the other three permit it, by recorded decision', () => {
    expect([...RESUME_ON].sort()).toEqual(['dead', 'unanswerable', 'unrecorded']);
    expect(RESUME_ON).not.toContain('alive');
  });

  it('NON-VACUITY: the tolerance helper is what decides, and it can say no', () => {
    expect(startTimesMatch(1_000_000, 1_000_000)).toBe(true);
    expect(startTimesMatch(1_000_000, 1_000_000 + START_TIME_TOLERANCE_MS + 1)).toBe(false);
  });
});
