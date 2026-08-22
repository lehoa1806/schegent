import * as fs from 'node:fs/promises';

/**
 * Remove a test scratch directory, tolerating a run that is still writing to it.
 *
 * WHY THIS EXISTS. Removing a temp root while a Run is live races that Run's
 * audit append, its raw transcript, and its session write. Node's recursive `rm`
 * lists a directory, unlinks what it found, then `rmdir`s it; a file created
 * between the listing and the rmdir makes that last step fail with `ENOTEMPTY`
 * (or `EBUSY` / `EACCES`, platform depending). `force: true` does NOT help — it
 * suppresses "already gone", not "something arrived".
 *
 * This is a teardown race, not a defect in what was tested: the assertions have
 * already passed by the time it fires. Several suites assert that something
 * *starts* and deliberately do not wait for it to finish, so a run still writing
 * at teardown is the behaviour under test rather than a leak.
 *
 * WHY IT IS SHARED. On 2026-08-23 this race had been solved independently in six
 * different ways across nine files:
 *
 *   - `maxRetries: 10` (correct)
 *   - `maxRetries: 10, retryDelay: 50` (correct)
 *   - a hand-rolled `for (attempt < 3)` loop with a 25ms sleep, copy-pasted
 *     byte-identically into three files — 75ms of tolerance, which is not enough
 *     under load
 *   - a bare `rm` with no retry at all
 *   - `.catch(() => undefined)`, which does not tolerate the race so much as
 *     hide it: a genuinely failed cleanup becomes invisible, and leaked temp
 *     roots accumulate silently. That matters more than it looks — a leftover
 *     `.tmp/` from a crashed run got packaged into the VSIX the same day, and
 *     was caught by the packaging allowlist rather than by anything here.
 *
 * Nine files rediscovering one race is what a missing helper looks like.
 *
 * WHY IT STILL THROWS. `maxRetries` covers a directory that is *transiently*
 * busy. A cleanup that fails for 500ms is not transient, and swallowing that
 * would trade a loud test failure for a silent disk leak. If this throws, the
 * question to ask is what is still holding the directory open — not how to
 * suppress it.
 */
export async function removeTempRoot(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
