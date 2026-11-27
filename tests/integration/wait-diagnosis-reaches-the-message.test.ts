import { describe, expect, it } from 'vitest';
import { drainUntil } from './concurrent-run-harness';

/**
 * FR-R3-097 — the diagnosis has to reach the failure text.
 *
 * The classifier's verdicts are pinned in `tests/unit/build/wait-diagnosis.test.ts`.
 * What that cannot show is that a real exhausted `drainUntil` carries the verdict:
 * a diagnosis computed and dropped is the same defect as a warning built and
 * discarded, which this tree has already shipped once (feature 107, FR-030).
 *
 * BOTH cases are induced DETERMINISTICALLY and need no machine load. Starvation is
 * a process that cannot get scheduled, so blocking the event loop synchronously
 * inside the polled predicate reproduces exactly the condition the diagnosis is
 * about — the loop's own rounds become expensive — without depending on what else
 * the CPU happens to be doing. A test for a load diagnosis that itself needed load
 * would be the defect this whole item is about.
 */
describe('FR-R3-097 — drainUntil names WHY it gave up', () => {
  it('carries a verdict and its numbers when the condition never settles', async () => {
    // ASSERTS THE WIRING, NOT THE VERDICT, and the distinction is this item's own
    // subject. An earlier version of this test asserted `STALLED` here. It passed
    // alone and failed inside the full 757-file suite, because a healthy loop's
    // round cost rises with load and the classifier — correctly — stopped calling
    // it healthy. That is exactly the defect FR-R3-097 exists to remove: an
    // assertion whose answer depends on what else the machine is doing.
    //
    // Which verdict each ratio produces is pinned deterministically in
    // `tests/unit/build/wait-diagnosis.test.ts`, over a pure function. What this
    // file owns is that a real exhausted `drainUntil` carries the diagnosis at
    // all — a verdict computed and dropped is the built-and-discarded defect this
    // tree already shipped once (feature 107, FR-030).
    const error = await drainUntil(() => false, 'a condition that never becomes true', 300).then(
      () => null,
      (e: unknown) => e as Error
    );
    if (error === null) throw new Error('drainUntil must reject when the condition never settles');
    expect(error.message).toContain('a condition that never becomes true');
    expect(error.message).toMatch(/STARVED|STALLED|UNCLEAR/);
    expect(error.message).toMatch(/\d+ round\(s\) in \d+ms/);
    expect(error.message).toContain('ms per round');
  });

  it('reports STARVED when the poll loop could not get scheduled', async () => {
    // 40ms of synchronous work per round against a ~1ms floor. This is what an
    // unscheduled process looks like from the inside, and it is reproducible on
    // an idle machine.
    const blockForty = (): boolean => {
      const until = Date.now() + 40;
      while (Date.now() < until) {
        /* deliberately synchronous: this is the starvation being reproduced */
      }
      return false;
    };
    const error = await drainUntil(blockForty, 'a starved wait', 300).then(
      () => null,
      (e: unknown) => e as Error
    );
    if (error === null) throw new Error('drainUntil must reject when the condition never settles');
    // Safe to assert the verdict in THIS direction, and only this one: 40ms of
    // blocking against a ~1ms floor is 40x on an idle machine, and load can only
    // push it higher. The healthy case has no such one-sided bound, which is why
    // the test above asserts the wiring instead.
    expect(error.message).toContain('STARVED');
    expect(error.message).toContain('idle machine');
    expect(error.message).not.toContain('STALLED');
  });

  it('still returns without a diagnosis when the wait succeeds', async () => {
    // The diagnosis is failure-path only: a passing wait must not pay for it, and
    // must not print anything.
    let settled = false;
    setTimeout(() => {
      settled = true;
    }, 10);
    await expect(drainUntil(() => settled, 'a condition that settles', 5_000)).resolves.toBeUndefined();
  });
});
