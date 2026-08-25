import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { waitForChildCompletion, STDIO_CLOSE_GRACE_MS } from '../../../src/runner/child-completion';
import { signalProcessTree, processTreeSpawnOptions } from '../../../src/runner/process-tree';

/**
 * FR-R3-083 (T1165-T1167) / FR-R3-054 §5 — is the stdio-close grace still
 * load-bearing now that cancellation owns the process group?
 *
 * `FR-R3-054` §5 recorded that it did not revisit this: "descendant survival is
 * what it exists to tolerate, and it may now be tolerating something that no longer
 * happens." That is a measurement, not an argument, and this file is the
 * measurement. Its honest outcome may be "keep it" — deleting a bounded wait on an
 * assumption is how a bounded wait becomes an unbounded one.
 *
 * WHAT WAS MEASURED, 2026-08-25, on darwin/arm64
 *
 * Two paths, and they answer differently. That difference is the finding.
 *
 *   - NORMAL COMPLETION. The child exits on its own and a descendant still holds
 *     the inherited pipe. Nothing signals the group on this path -- `terminate()`
 *     is not involved -- so the descendant keeps the write end open and `'close'`
 *     never arrives. The grace expires and bounds the wait. STILL LOAD-BEARING.
 *
 *   - AFTER A TREE KILL, WITH THE CHILD SPAWNED AS A GROUP LEADER. The group is
 *     signalled, the descendant dies with it, its write end closes, and `'close'`
 *     arrives inside the grace. The grace does not expire. REDUNDANT ON THIS PATH.
 *
 * So the grace is kept, and `child-completion.ts` now says which of the two it is
 * for. Removing it because the cancellation path no longer needs it would have
 * unbounded the path that still does -- which is the ordinary one, on every run
 * that finishes normally.
 *
 * TWO WRONG TURNS, KEPT BECAUSE EACH IS ITSELF A FINDING
 *
 *   1. The first version awaited `waitForChildCompletion` AFTER killing the tree,
 *      and hung for the full 15 s. `'exit'` and `'close'` are one-shot: a waiter
 *      attached to an already-dead child never settles. Production attaches it
 *      before the child can exit, and that ordering is a real precondition of the
 *      helper rather than an accident of how it is called.
 *
 *   2. The second version spawned WITHOUT `processTreeSpawnOptions()`, so the child
 *      led no group, `process.kill(-pid)` reached nothing, only the direct child
 *      died, the grandchild kept the pipe, and the grace expired. That is a correct
 *      observation of the wrong arrangement -- and it is also exactly what would
 *      happen in production if a spawn path ever omitted those options. The group
 *      kill degrades SILENTLY to a direct-child kill. It is why
 *      `signalProcessTree` signals the group AND the child rather than choosing,
 *      and it is why the grace is not safe to delete on the strength of the tree
 *      work alone.
 */
/**
 * THE GRANDCHILD REAPS ITSELF, AND THAT IS NOT OPTIONAL.
 *
 * The first version of this fixture spawned `setInterval(()=>{},1000)` with no
 * self-timeout, in a test whose whole point is that the child is killed WITHOUT
 * reaching the grandchild. Fourteen orphans accumulated across a few suite runs,
 * each spinning a 1 s timer; the machine slowed enough that unrelated integration
 * tests began timing out, and the suite's own wall clock went from 33 s to 121 s.
 * The failures looked like flakes in whichever suites happened to be timing-
 * sensitive -- the exact misreading `tests/global-temp-root.ts` records for a
 * saturated `$TMPDIR`.
 *
 * So: every process this fixture creates exits on its own within
 * `SELF_REAP_MS`, whatever the test does or fails to do. Cleanup below is the
 * primary mechanism; this is the backstop that makes a cleanup bug cost seconds
 * instead of a machine.
 */
const SELF_REAP_MS = 20_000;

const GRANDCHILD_HOLDS_PIPE =
  "const {spawn}=require('child_process');" +
  // The grandchild inherits stdout/stderr and outlives the child, so the pipe's
  // write end stays open after the child exits. This is the arrangement the grace
  // exists for.
  `spawn(process.execPath,['-e','setInterval(()=>{},1000);setTimeout(()=>process.exit(0),${SELF_REAP_MS})'],{stdio:'inherit'});` +
  'setTimeout(()=>process.exit(0),100);';

/** Every child this file spawns, so `afterEach` can reap the whole tree. */
const spawned: import('node:child_process').ChildProcess[] = [];

function spawnTree(): import('node:child_process').ChildProcess {
  // ALWAYS a group leader, in both tests. In the normal-completion test that is
  // not a change to the measurement -- nothing signals the group while the
  // measurement is running -- it is what makes the group reachable at cleanup.
  // Without it `signalProcessTree` has no group to kill and the grandchild is
  // orphaned, which is how the leak above happened.
  const child = spawn(process.execPath, ['-e', GRANDCHILD_HOLDS_PIPE], {
    stdio: 'pipe',
    ...processTreeSpawnOptions()
  });
  spawned.push(child);
  return child;
}

afterEach(async () => {
  for (const child of spawned.splice(0)) {
    await signalProcessTree(child, 'SIGKILL');
  }
});

describe('the stdio-close grace, re-measured against the tree (FR-R3-083)', () => {
  it('still expires on the NORMAL completion path, where the group is not signalled', async () => {
    // The load-bearing case. `terminate()` is not called here, so nothing signals
    // the group and the descendant keeps the pipe open. Without the grace this
    // await would not settle until the grandchild happened to exit.
    const child = spawnTree();
    const started = Date.now();
    const completion = await waitForChildCompletion(child, true, 300);
    const elapsed = Date.now() - started;

    expect(completion.stdioCloseTimedOut).toBe(true);
    expect(completion.exitCode).toBe(0);
    // Bounded by the grace, not by the grandchild's lifetime -- it is still alive.
    expect(elapsed).toBeLessThan(3_000);
    // Reaped by `afterEach`, which kills the GROUP. An inline `signalProcessTree`
    // here would look like cleanup and reach only the direct child on a
    // non-detached spawn -- which is precisely the leak this fixture caused once.
  }, 15_000);

  it('does not expire after the tree is killed, because the pipe holder dies too', async () => {
    // The redundant case, and the reason FR-R3-054 §5 suspected the grace might be
    // tolerating something that no longer happens. It was half right: on THIS path
    // it is, and on the path above it is not.
    // `spawnTree()` spawns the way production spawns: `processTreeSpawnOptions()`
    // makes the child a group leader, which is what gives `signalProcessTree` a
    // group to reach. Without it the second version of this test killed only the
    // direct child, the grandchild kept the pipe, and the grace expired -- a
    // correct observation of the WRONG arrangement.
    const child = spawnTree();
    // The waiter is attached FIRST, which is how production uses it: `'exit'` and
    // `'close'` are one-shot events, so a waiter attached after the child is gone
    // never settles at all. The first version of this test killed the tree and then
    // awaited, and it hung for the full 15 s -- a finding about the helper's
    // contract rather than about the grace, and worth recording as one.
    const pending = waitForChildCompletion(child, true, 3_000);
    await new Promise((r) => setTimeout(r, 200));
    await signalProcessTree(child, 'SIGKILL');

    const completion = await pending;
    // `'close'` arrived rather than the grace expiring: the descendant went with
    // the group, so no one is holding the write end.
    expect(completion.stdioCloseTimedOut).toBe(false);
  }, 15_000);

  it('keeps a grace that is actually bounded', () => {
    // Non-vacuity for the two above: a grace of zero, or an unbounded one, would
    // make either assertion meaningless. This pins that the shipped default is a
    // real, finite number rather than something that happens to work in a test.
    expect(STDIO_CLOSE_GRACE_MS).toBeGreaterThan(0);
    expect(Number.isFinite(STDIO_CLOSE_GRACE_MS)).toBe(true);
  });
});
