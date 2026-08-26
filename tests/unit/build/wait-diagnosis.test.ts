import { describe, expect, it } from 'vitest';
import {
  diagnoseWait,
  HEALTHY_RATIO,
  IMMEDIATE_ROUND_FLOOR_MS,
  STARVED_RATIO
} from '../../integration/wait-diagnosis';

/**
 * FR-R3-097 — the discriminator the tree believed it already had.
 *
 * Two harnesses and `tests/lint/waits-are-bounded-by-time.test.ts` all said that
 * keeping the round count beside an elapsed-time bound is what tells a starved
 * wait from a stalled one. None of them said what a healthy ratio is, and the one
 * time the rule was applied it produced the opposite answer — the case pinned
 * below by name.
 *
 * The classifier is PURE, which is the point: every verdict is asserted with no
 * load, no timing and no flakiness. A diagnosis of load that can only be tested
 * under load is a diagnosis nobody can trust.
 */
describe('FR-R3-097 — starved, stalled, or honestly unclear', () => {
  it('classifies the 2026-08-23 incident figure as a FULL-SPEED loop', () => {
    // The reason this item exists in the form it does. `"gave up after 10000ms
    // and 7644 round(s)"` was read as proof of starvation in the amendment
    // comment, in `driver-harness.ts` and in the lint gate. It is 1.31ms per
    // round against a ~1ms floor: the poller was fine. Whatever went wrong on
    // that day, the round count was not evidence for it.
    const d = diagnoseWait({ elapsedMs: 10_000, rounds: 7644 });
    expect(d.verdict).toBe('stalled');
    expect(d.msPerRound).toBeCloseTo(1.31, 2);
    expect(d.text).toContain('ran at full speed');
  });

  it('classifies a genuinely starved wait, and says re-running may help', () => {
    // 25s deadline, 42 rounds: ~595ms to complete a round whose floor is 1ms.
    // A process that cannot get scheduled for half a second at a time is not
    // measuring the code.
    const d = diagnoseWait({ elapsedMs: 25_000, rounds: 42 });
    expect(d.verdict).toBe('starved');
    expect(d.ratio).toBeGreaterThan(STARVED_RATIO);
    expect(d.text).toContain('was not being scheduled');
    expect(d.text).toContain('idle machine');
  });

  it('classifies a stalled wait, and says re-running will NOT help', () => {
    const d = diagnoseWait({ elapsedMs: 25_000, rounds: 20_000 });
    expect(d.verdict).toBe('stalled');
    expect(d.ratio).toBeLessThan(HEALTHY_RATIO);
    expect(d.text).toContain('Re-running will not help');
  });

  it('refuses to classify the band between, rather than guessing', () => {
    // The measured middle: forty CPU workers on ten cores produced 2.23-2.34ms
    // per round, which lands HERE and not in `starved` — correctly, because the
    // suite passed at that load. Reporting it as starvation would excuse a real
    // failure; reporting it as a stall would blame the code for the machine.
    const d = diagnoseWait({ elapsedMs: 25_000, rounds: 11_000 });
    expect(d.verdict).toBe('unclear');
    expect(d.text).toContain('Not classified rather than guessed');
  });

  it('boundaries are inclusive on both named ratios', () => {
    // Exactly at a threshold must land in the confident bucket, not the band —
    // otherwise the band silently widens by a rounding error.
    expect(diagnoseWait({ elapsedMs: 3_000, rounds: 1_000 }).verdict).toBe('starved');
    expect(diagnoseWait({ elapsedMs: 1_600, rounds: 1_000 }).verdict).toBe('stalled');
  });

  it('takes the loop’s OWN floor, because loops do not all yield the same way', () => {
    // A loop that sleeps 25ms has a 25ms floor. Judged against the 1ms default it
    // would report every healthy wait as starved by 25x — a diagnosis worse than
    // none, since it would tell people to ignore real failures.
    const sleepy = { elapsedMs: 25_000, rounds: 950, floorMs: 25 };
    expect(diagnoseWait(sleepy).verdict).toBe('stalled');
    expect(diagnoseWait({ ...sleepy, floorMs: IMMEDIATE_ROUND_FLOOR_MS }).verdict).toBe('starved');
  });

  it('says so when there is nothing to measure', () => {
    const d = diagnoseWait({ elapsedMs: 25_000, rounds: 0 });
    expect(d.verdict).toBe('unclear');
    expect(d.text).toContain('no poll rounds');
  });
});
