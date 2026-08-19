// FR-R3-008 (T381) — the write bound, which is the whole reason this class
// exists.
//
// The acceptance criterion is stated as a rate rather than a count: 10,000 stdout
// lines inside one interval must produce a number of persisted writes bounded by
// *elapsed time over the interval*, not by the line count. That phrasing is what
// the tests below assert, because the failure mode it guards against —
// forwarding per line — passes any assertion written as "fewer than 10,000
// writes" while still being DATA-01's write amplification. So the checks pin the
// exact bound `1 + floor(elapsed / intervalMs)`, and one of them holds the clock
// still so the only admissible answer is one.
//
// Separate from `claude-cli-monitor.test.ts` for the same reason the transport
// test is: that file owns the state machine, and this property is about a
// downstream rate.

import { describe, it, expect } from 'vitest';
import {
  ACTIVITY_COALESCE_INTERVAL_MS,
  ActivityCoalescer,
  type RunActivityObservation
} from '../../../src/monitor/activity-coalescer';

const INTERVAL = 1_000;

function makeCoalescer(intervalMs: number = INTERVAL): {
  coalescer: ActivityCoalescer;
  flushed: RunActivityObservation[];
  advance: (ms: number) => void;
  monotonic: () => number;
} {
  let elapsed = 0;
  const flushed: RunActivityObservation[] = [];
  const coalescer = new ActivityCoalescer({
    monotonicNow: () => 5_000 + elapsed,
    recorder: { record: (observation) => flushed.push(observation) },
    intervalMs
  });
  return {
    coalescer,
    flushed,
    advance: (ms: number) => {
      elapsed += ms;
    },
    monotonic: () => 5_000 + elapsed
  };
}

function observation(runId: string, at: number, stdoutLines: number): RunActivityObservation {
  return { runId, at, stdoutLines, stderrLines: 0 };
}

/** The bound the acceptance criterion names, spelled once. */
function permittedWrites(elapsedMs: number, intervalMs: number): number {
  return 1 + Math.floor(elapsedMs / intervalMs);
}

describe('FR-R3-008 — activity is coalesced, not forwarded per line', () => {
  it('forwards exactly one observation for 10,000 lines inside a single interval', () => {
    const c = makeCoalescer();

    for (let line = 1; line <= 10_000; line += 1) {
      c.coalescer.note(observation('run-1', 1_700_000_000_000, line));
    }

    // The clock never moved, so `1 + floor(0 / interval)` is one. Not "a few",
    // and emphatically not 10,000.
    expect(c.flushed.length, 'one leading-edge flush and nothing else').toBe(1);
    expect(c.flushed.length).toBe(permittedWrites(0, INTERVAL));
    expect(c.flushed[0]!.stdoutLines, 'the flush is the first observation, on its leading edge').toBe(1);
  });

  it('bounds writes by elapsed time over the interval, independent of line count', () => {
    const c = makeCoalescer();
    const totalElapsed = 10 * INTERVAL;
    // 10,000 lines spread across ten intervals — a thousand lines per interval,
    // each of which may contribute at most one write.
    for (let line = 1; line <= 10_000; line += 1) {
      c.coalescer.note(observation('run-1', 1_700_000_000_000 + line, line));
      if (line % 1_000 === 0) c.advance(INTERVAL);
    }

    expect(c.flushed.length).toBeLessThanOrEqual(permittedWrites(totalElapsed, INTERVAL));
    // And the same run at a hundred times the line rate is bounded identically,
    // which is the "not by line count" half of the criterion.
    const dense = makeCoalescer();
    for (let line = 1; line <= 1_000_000; line += 1) {
      dense.coalescer.note(observation('run-1', 1_700_000_000_000 + line, line));
      if (line % 100_000 === 0) dense.advance(INTERVAL);
    }
    expect(dense.flushed.length).toBeLessThanOrEqual(permittedWrites(totalElapsed, INTERVAL));
    expect(dense.flushed.length).toBe(c.flushed.length);
  });

  it('drops an observation inside the interval rather than deferring it', () => {
    const c = makeCoalescer();

    c.coalescer.note(observation('run-1', 1_000, 1));
    c.coalescer.note(observation('run-1', 1_100, 2));
    c.advance(INTERVAL - 1);
    c.coalescer.note(observation('run-1', 1_200, 3));

    // Nothing is scheduled, so nothing arrives late: crossing the boundary with
    // no further output produces no write at all.
    expect(c.flushed.map((o) => o.stdoutLines), 'dropped, not buffered').toEqual([1]);
    c.advance(1);
    expect(c.flushed.length, 'no timer fires on its own').toBe(1);
  });

  it('flushes the next observation once the interval has passed, carrying the newer counters', () => {
    const c = makeCoalescer();

    c.coalescer.note(observation('run-1', 1_000, 1));
    c.advance(INTERVAL);
    c.coalescer.note(observation('run-1', 2_000, 400));

    expect(c.flushed.map((o) => [o.at, o.stdoutLines])).toEqual([
      [1_000, 1],
      [2_000, 400]
    ]);
  });

  it('meters each run independently, so a chatty run cannot starve a quiet one', () => {
    const c = makeCoalescer();

    c.coalescer.note(observation('chatty', 1_000, 1));
    for (let line = 2; line <= 5_000; line += 1) {
      c.coalescer.note(observation('chatty', 1_000, line));
    }
    c.coalescer.note(observation('quiet', 1_050, 1));

    expect(c.flushed.map((o) => o.runId), 'the second run flushes on its own leading edge').toEqual([
      'chatty',
      'quiet'
    ]);
  });

  it('reopens a run window on forget, so the next invocation flushes immediately', () => {
    const c = makeCoalescer();

    c.coalescer.note(observation('run-1', 1_000, 1));
    c.coalescer.note(observation('run-1', 1_100, 2));
    expect(c.flushed.length).toBe(1);

    // `onStart` resets the counters, so an invocation that inherited the previous
    // phase's window would report nothing for up to a full interval.
    c.coalescer.forget('run-1');
    c.coalescer.note(observation('run-1', 1_200, 1));
    expect(c.flushed.map((o) => o.stdoutLines)).toEqual([1, 1]);
  });

  it('forgets every window on dispose', () => {
    const c = makeCoalescer();
    c.coalescer.note(observation('run-1', 1_000, 1));
    c.coalescer.dispose();
    c.coalescer.note(observation('run-1', 1_100, 2));
    expect(c.flushed.length).toBe(2);
  });

  it('carries no line content and no path in the shape it forwards', () => {
    const c = makeCoalescer();
    c.coalescer.note(observation('run-1', 1_000, 7));

    // The persisted-shape half of the acceptance criterion, asserted at the seam
    // that produces it: a timestamp and two counters, nothing else.
    expect(Object.keys(c.flushed[0]!).sort()).toEqual([
      'at',
      'runId',
      'stderrLines',
      'stdoutLines'
    ]);
  });

  it('defaults to an interval inside the freshness bands the projection reads', () => {
    // 15 s keeps a streaming Run inside `computeFreshness`'s 30 s `live` band
    // across a reload, and two intervals still sit under the monitor's 90 s stall
    // threshold. A default that drifted above either would make the coalescing
    // itself look like a slowdown.
    expect(ACTIVITY_COALESCE_INTERVAL_MS).toBe(15_000);
    expect(ACTIVITY_COALESCE_INTERVAL_MS).toBeLessThan(30_000);
    expect(2 * ACTIVITY_COALESCE_INTERVAL_MS).toBeLessThan(90_000);

    const c = makeCoalescer(ACTIVITY_COALESCE_INTERVAL_MS);
    c.coalescer.note(observation('run-1', 1_000, 1));
    c.advance(ACTIVITY_COALESCE_INTERVAL_MS - 1);
    c.coalescer.note(observation('run-1', 2_000, 2));
    expect(c.flushed.length, 'one millisecond short of the default interval').toBe(1);
    c.advance(1);
    c.coalescer.note(observation('run-1', 3_000, 3));
    expect(c.flushed.length).toBe(2);
  });
});
