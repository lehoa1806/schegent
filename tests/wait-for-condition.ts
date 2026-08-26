// FR-R3-114 row 3 — the deadline-bounded wait the hermetic unit tier did not have.
//
// THE DEFECT THIS REPLACES. Eleven tests in the unit tier slept a fixed duration — 130 ms, 150 ms,
// 250 ms — and then asserted. `tests/lint/waits-are-bounded-by-time.test.ts` could not see them:
// it matched counted-poll LOOPS, and a bare `setTimeout` is not a loop. So the load-sensitivity
// class `FR-R3-097` removed from the integration harnesses walked straight back in through the
// tier that claims hermeticity.
//
// A fixed sleep is wrong in both directions at once. Too short on a loaded machine and the test
// fails for a reason that has nothing to do with the code; long enough to be safe there and every
// run pays that cost forever. `state-projector.test.ts` slept 130 ms for a 100 ms debounce — a 30%
// margin against an unbounded scheduler delay.
//
// WHAT THIS DOES INSTEAD. Polls the condition, returns the moment it holds, and gives up on a
// DEADLINE with a message naming the elapsed time and the round count. Fast machines get faster
// tests; slow machines get correct ones; a genuine hang reports how long it actually waited.
//
// WHAT IT IS NOT FOR. A wait that is genuinely about elapsed wall clock — letting a retention age
// threshold pass, letting a fake process take the time its fixture says it takes — has no
// condition to poll and must not use this. Those are exempted BY NAME in the waits gate, each with
// its reason, rather than converted into a poll for a condition that was never the point.

const POLL_INTERVAL_MS = 5;
const DEFAULT_TIMEOUT_MS = 2_000;

export interface WaitForOptions {
  /** The bound. Reaching it is a failure, not a result. */
  readonly timeoutMs?: number;
  /** What the caller was waiting for, quoted in the failure. */
  readonly label?: string;
}

/**
 * Wait until `condition()` returns true, or fail at the deadline.
 *
 * The failure names the elapsed time AND the number of polls, because those two numbers together
 * distinguish a starved process from a stalled one — the distinction `FR-R3-097` found inverted in
 * three places when only one of them was reported.
 */
export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  options: WaitForOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = options.label ?? 'condition';
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let rounds = 0;
  for (;;) {
    rounds += 1;
    if (await condition()) return;
    if (Date.now() >= deadline) {
      const elapsed = Date.now() - startedAt;
      throw new Error(
        `waitForCondition: ${label} did not hold within ${timeoutMs} ms ` +
          `(waited ${elapsed} ms across ${rounds} poll(s), ~${(elapsed / rounds).toFixed(2)} ms per poll). ` +
          'A high poll count with a full elapsed budget is a stalled subject; a low one is a starved process.'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
