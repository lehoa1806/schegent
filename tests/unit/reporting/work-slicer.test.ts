// FR-R6-F11 T021 — the work slicer (research R9).
//
// WHAT THIS PINS:
//   - every item is visited once, in order;
//   - it yields once a slice has used `sliceMs` of the injected monotonic clock, and records each
//     slice's duration;
//   - an aborted signal ends `cancelled` at the next yield, or before any work;
//   - the deadline ends `limited` with the configured reason.

import { describe, expect, it } from 'vitest';
import { createWorkSlicer } from '../../../src/services/reporting/work-slicer';

interface FakeClock {
  now: () => number;
  advance: (ms: number) => void;
}

function fakeClock(): FakeClock {
  let current = 0;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    }
  };
}

const ITEMS: readonly number[] = Array.from({ length: 10 }, (_unused, index) => index);

describe('FR-R6-F11 T021 — work slicer', () => {
  it('visits every item once, in order, yielding after each full slice', async () => {
    const clock = fakeClock();
    let yields = 0;
    const slicer = createWorkSlicer({
      monotonicMs: clock.now,
      deadlineAtMs: 1_000,
      yieldNow: () => {
        yields += 1;
        return Promise.resolve();
      }
    });
    const seen: number[] = [];
    const result = await slicer.forEach(ITEMS, (item) => {
      seen.push(item);
      clock.advance(3);
    });
    expect(result).toEqual({ ok: true, value: undefined });
    expect(seen).toEqual([...ITEMS]);
    expect(yields).toBe(3);
    expect(slicer.sliceDurations()).toEqual([9, 9, 9, 3]);
  });

  it('ends cancelled at the next yield once the signal aborts', async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    const slicer = createWorkSlicer({
      monotonicMs: clock.now,
      deadlineAtMs: 1_000,
      signal: controller.signal,
      yieldNow: () => Promise.resolve()
    });
    const seen: number[] = [];
    const result = await slicer.forEach(ITEMS, (item) => {
      seen.push(item);
      clock.advance(4);
      if (item === 0) {
        controller.abort();
      }
    });
    expect(result).toEqual({ ok: false, outcome: 'cancelled' });
    expect(seen).toEqual([0, 1]);
  });

  it('does no work when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const slicer = createWorkSlicer({ monotonicMs: () => 0, deadlineAtMs: 1_000, signal: controller.signal });
    let visits = 0;
    const result = await slicer.forEach(ITEMS, () => {
      visits += 1;
    });
    expect(result).toEqual({ ok: false, outcome: 'cancelled' });
    expect(visits).toBe(0);
  });

  it('ends limited with deadline-exceeded, or the configured reason, at the deadline', async () => {
    const clock = fakeClock();
    const slicer = createWorkSlicer({ monotonicMs: clock.now, deadlineAtMs: 20, yieldNow: () => Promise.resolve() });
    const result = await slicer.forEach(ITEMS, () => {
      clock.advance(5);
    });
    expect(result).toEqual({ ok: false, outcome: 'limited', limit: 'deadline-exceeded' });

    const exportClock = fakeClock();
    const exportSlicer = createWorkSlicer({
      monotonicMs: exportClock.now,
      deadlineAtMs: 20,
      deadlineLimit: 'export-time',
      yieldNow: () => Promise.resolve()
    });
    const exportResult = await exportSlicer.forEach(ITEMS, () => {
      exportClock.advance(5);
    });
    expect(exportResult).toEqual({ ok: false, outcome: 'limited', limit: 'export-time' });
  });

  it('yields on the real event loop by default and finishes an empty list at once', async () => {
    const idle = createWorkSlicer({ monotonicMs: () => 0, deadlineAtMs: 1_000 });
    expect(await idle.forEach([], () => undefined)).toEqual({ ok: true, value: undefined });
    expect(idle.sliceDurations()).toEqual([]);

    const clock = fakeClock();
    const slicer = createWorkSlicer({ monotonicMs: clock.now, deadlineAtMs: 1_000 });
    const result = await slicer.forEach([1, 2], () => {
      clock.advance(10);
    });
    expect(result).toEqual({ ok: true, value: undefined });
    expect(slicer.sliceDurations()).toEqual([10, 10]);
  });
});
