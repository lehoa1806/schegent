/**
 * FR-R3-097 — tell a STARVED wait from a STALLED one, with a reference point.
 *
 * THE CLAIM THIS REPLACES. Two harnesses and one lint gate say, in comments,
 * that keeping the round count beside an elapsed-time bound "is what lets a
 * reader tell those apart" — and none of them says what a healthy ratio is. The
 * one time the rule was applied, it gave the opposite answer: the 2026-08-23
 * incident quotes `"gave up after 10000ms and 7644 round(s)"` and reads 7,644
 * rounds as proof of starvation. That is **1.31 ms per round**, and an unstarved
 * round on this loop costs ~1.2 ms. The poller was running at full speed. The
 * number was right there and the inference from it was backwards, because there
 * was nothing to compare it against.
 *
 * THE REFERENCE POINT, derived rather than chosen. A round yields with
 * `setImmediate` and then `setTimeout(…, 0)`, and Node clamps a zero timeout to
 * one millisecond. So the floor is ~1 ms **by construction**, not by taste.
 * Measured on 2026-08-26, 10-core darwin: 1.24 ms/round idle, and 2.23–2.34
 * ms/round with forty CPU workers running (1-minute load average 36–43).
 *
 * WHAT THE RATIO MEANS. A wait that blows a 25 s deadline when it normally
 * settles in under a second needs roughly a thirty-fold slowdown. A starved
 * poller shows that in its own round cost; a stalled one sits at the floor while
 * the condition never becomes true. The band between is small and real, and it
 * is reported as **unclear** rather than guessed — a diagnosis that is confident
 * in both directions is how the wrong inference above got made.
 *
 * WHAT IT CANNOT SEE. This measures whether the process was being SCHEDULED, so
 * it detects CPU starvation. Work blocked on a saturated disk while the CPU is
 * free polls at the floor and reads as `stalled`. Stated rather than papered
 * over: a diagnosis is only worth having if its blind spot is known.
 */

/** Node clamps `setTimeout(fn, 0)` to one millisecond. The floor is this. */
export const IMMEDIATE_ROUND_FLOOR_MS = 1;

/** A round costing at least this multiple of the floor: the process was not being scheduled. */
export const STARVED_RATIO = 3;

/** A round costing at most this multiple: the loop ran at full speed. */
export const HEALTHY_RATIO = 1.6;

export type WaitVerdict = 'starved' | 'stalled' | 'unclear';

export interface WaitDiagnosis {
  readonly verdict: WaitVerdict;
  /** Observed wall-clock cost of one poll round. */
  readonly msPerRound: number;
  /** That cost against the loop's own floor. */
  readonly ratio: number;
  /** One sentence naming the verdict, its numbers, and what to do about it. */
  readonly text: string;
}

/**
 * Classify one exhausted wait. Pure over its inputs, so every verdict is
 * exercised without load, without timing and without flakiness — which is the
 * whole reason the classification lives here rather than inline in a harness.
 *
 * `floorMs` is the loop's OWN cheapest possible round: `IMMEDIATE_ROUND_FLOOR_MS`
 * for a `setImmediate` + `setTimeout(0)` pair, or the sleep length for a loop
 * that sleeps. A shared constant would misjudge every loop that does not yield
 * the same way.
 */
export function diagnoseWait(input: {
  readonly elapsedMs: number;
  readonly rounds: number;
  readonly floorMs?: number;
}): WaitDiagnosis {
  const floorMs = input.floorMs ?? IMMEDIATE_ROUND_FLOOR_MS;
  if (input.rounds <= 0 || floorMs <= 0 || !Number.isFinite(input.elapsedMs)) {
    return {
      verdict: 'unclear',
      msPerRound: Number.NaN,
      ratio: Number.NaN,
      text:
        'UNCLEAR: the wait completed no poll rounds, so there is nothing to compare ' +
        'against the floor. Treat this as an unclassified failure.'
    };
  }
  const msPerRound = input.elapsedMs / input.rounds;
  const ratio = msPerRound / floorMs;
  const numbers =
    `${input.rounds} round(s) in ${input.elapsedMs}ms = ${msPerRound.toFixed(2)}ms per round, ` +
    `${ratio.toFixed(1)}x the ~${floorMs}ms an unstarved round costs`;

  if (ratio >= STARVED_RATIO) {
    return {
      verdict: 'starved',
      msPerRound,
      ratio,
      text:
        `STARVED: ${numbers}. This process was not being scheduled — the machine was busy, ` +
        'and the wait measures that rather than the code. Re-run on an idle machine before ' +
        'reading this as a defect.'
    };
  }
  if (ratio <= HEALTHY_RATIO) {
    return {
      verdict: 'stalled',
      msPerRound,
      ratio,
      text:
        `STALLED: ${numbers}. The poll loop ran at full speed and the condition never became ` +
        'true, so this is the code and not the machine. Re-running will not help.'
    };
  }
  return {
    verdict: 'unclear',
    msPerRound,
    ratio,
    text:
      `UNCLEAR: ${numbers} — between the ${HEALTHY_RATIO}x that means a healthy loop and the ` +
      `${STARVED_RATIO}x that means a starved one. Not classified rather than guessed. ` +
      'Re-run on an idle machine: if it passes, the machine was the cause.'
  };
}
