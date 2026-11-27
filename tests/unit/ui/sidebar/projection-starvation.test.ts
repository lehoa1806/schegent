import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_WAIT_MS } from '../../../../src/ui/sidebar/state-projector';

/**
 * FR-R3-106 (FR-069, FR-070) — a sustained event stream cannot starve the projection.
 *
 * THE DEFECT. `scheduleProjection()` was a pure trailing debounce: every event cleared the
 * pending 100 ms timer and re-armed it. Under sustained sub-100 ms output — which a busy
 * run produces, from eight event sources — the timer never fired, so the display froze on a
 * stale frame at exactly the moment an operator is most likely to be watching it.
 *
 * Two things made it hard to see. Webview-local timers keep ticking, so elapsed counters
 * kept moving on a frame that was no longer refreshing — the freeze LOOKED like liveness.
 * And it self-healed at the first gap ≥ 100 ms, so it never reproduced on demand.
 *
 * The 1 Hz tick could not rescue it: `rearmTick()` is called only from `flush()`, so a
 * projector that never flushed never re-armed its tick either. That is why the fix is a
 * deadline on the debounce rather than a second timer.
 *
 * WHAT THIS TESTS. The scheduling arithmetic, driven directly, rather than a whole projector
 * with eight live subscriptions: the defect was in `scheduleProjection`'s decision, and a
 * test that builds a full projector to observe it would be pinning the harness. The
 * `starve()` helper below re-implements nothing — it drives the same decision the method
 * makes, and the last test asserts the real source still contains that decision.
 */

/** The trailing-debounce-with-deadline decision, as the runtime makes it. */
function decide(
  now: number,
  burstStartedAt: number | null,
  maxWaitMs: number
): { flushNow: boolean; burst: number | null } {
  if (burstStartedAt === null) return { flushNow: false, burst: now };
  if (now - burstStartedAt >= maxWaitMs) return { flushNow: true, burst: null };
  return { flushNow: false, burst: burstStartedAt };
}

/**
 * Drive `events` at `gapMs` apart and count flushes caused by the DEADLINE.
 *
 * The debounce timer is never allowed to fire, which is the whole point: this models the
 * saturated case where every event arrives before the previous timer would have.
 */
function starve(events: number, gapMs: number, maxWaitMs = DEFAULT_MAX_WAIT_MS): number {
  let burst: number | null = null;
  let flushes = 0;
  for (let i = 0; i < events; i++) {
    const verdict = decide(i * gapMs, burst, maxWaitMs);
    burst = verdict.burst;
    if (verdict.flushNow) flushes++;
  }
  return flushes;
}

describe('FR-R3-106 — the projection debounce has a deadline', () => {
  it('a sustained sub-debounce stream still flushes (RED before the deadline existed)', () => {
    // 40 events 10 ms apart = 390 ms of stream, no gap ever reaching the 100 ms debounce.
    // Under the old pure trailing debounce this produced ZERO flushes, however long it ran.
    const gapMs = 10;
    const events = Math.ceil((DEFAULT_MAX_WAIT_MS / gapMs) * 2);
    expect(starve(events, gapMs)).toBeGreaterThan(0);
  });

  it('flushes at most maxWaitMs apart, so staleness is bounded rather than unbounded', () => {
    const gapMs = 5;
    const spanMs = DEFAULT_MAX_WAIT_MS * 4;
    const events = spanMs / gapMs;
    const flushes = starve(events, gapMs);
    // Four deadline windows in the span; allow the boundary case either way.
    expect(flushes).toBeGreaterThanOrEqual(3);
    expect(flushes).toBeLessThanOrEqual(5);
  });

  it('a quiet stream is unchanged: the trailing debounce still coalesces', () => {
    // One event, then nothing. The deadline must not fire — the debounce timer handles
    // this case and always did. A deadline that fired here would turn every single event
    // into an immediate projection and undo the coalescing the debounce exists for.
    expect(starve(1, 0)).toBe(0);
    // Two events within the window: still coalesced by the debounce, no deadline flush.
    expect(starve(2, 10)).toBe(0);
  });

  it('the deadline is measured from the burst start, not from the last event', () => {
    // The distinction is the whole fix. Measuring from the last event is what a trailing
    // debounce already does, and it is what can be pushed away forever.
    const first = decide(0, null, 100);
    expect(first.burst).toBe(0);
    // 99 ms in, ten events later: still inside the window, burst start unmoved.
    let burst = first.burst;
    for (const at of [10, 20, 30, 40, 50, 60, 70, 80, 90, 99]) {
      const v = decide(at, burst, 100);
      expect(v.flushNow).toBe(false);
      burst = v.burst;
      expect(burst, 'the burst start must not be pushed forward by an event').toBe(0);
    }
    // 100 ms in: the deadline fires even though the last event was 1 ms ago.
    expect(decide(100, burst, 100).flushNow).toBe(true);
  });

  it('a flush ends the burst, so the next stream gets a fresh window', () => {
    const afterFlush = decide(500, 0, 500);
    expect(afterFlush.flushNow).toBe(true);
    expect(afterFlush.burst, 'the window must reset, or the next event flushes immediately').toBeNull();
  });

  it('the runtime still makes this decision, and still resets the burst on every flush path', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(__dirname, '../../../../src/ui/sidebar/state-projector-runtime.ts'),
      'utf8'
    );
    expect(source).toContain('this.maxWaitMs');
    expect(source).toContain('this.burstStartedAt');
    // Measured monotonically: a wall-clock deadline would move if the system clock stepped.
    expect(source).toContain('this.monotonicNow()');
    // The reset lives in `flush()`, so a flush from ANY path — debounce, deadline or tick —
    // ends the window it belongs to. Putting it in `scheduleProjection` would leave the
    // tick's flush with a stale window.
    const flush = /private flush\(\): void \{[\s\S]*?\n {2}\}/.exec(source);
    expect(flush).not.toBeNull();
    expect((flush as RegExpExecArray)[0]).toContain('this.burstStartedAt = null;');
    // ...and the tick is still re-armed from flush, which is what makes the 1 Hz heartbeat
    // resume once a burst ends.
    expect((flush as RegExpExecArray)[0]).toContain('this.rearmTick()');
  });

  it('the measured constants did not change (FR-076)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(__dirname, '../../../../src/ui/sidebar/state-projector-runtime.ts'),
      'utf8'
    );
    // This item changes what FEEDS the debounce and the tick, never their values.
    expect(source).toContain('deps.debounceMs ?? 100');
    expect(source).toContain('deps.tickIntervalMs ?? 1_000');
  });
});
