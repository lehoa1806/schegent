import { describe, it, expect, vi } from 'vitest';
import { TelemetrySamplerImpl } from '../../../src/telemetry/telemetry-sampler';
import type { TelemetrySnapshot } from '../../../src/telemetry/telemetry-snapshot';

/**
 * FR-R3-081 (T1083, T1084) — every concurrent run is sampled.
 *
 * The sampler sampled ONE pid: `start()` returned early with `already-sampling`
 * whenever a second run spawned, and `stop()` halted the sole sampler. At the
 * default concurrency cap of 1 that is correct and complete. Above it, every run
 * after the first was unsampled — so the one instrument that could answer this
 * item's aggregate question went blind exactly when the aggregate became a
 * question, and an admission-control mechanism argued from it would have been
 * argued from a measurement of one run.
 *
 * The ordering in the item is deliberate and this is why: the sampler comes
 * BEFORE the measurement, and the measurement before the mechanism.
 */
const snapshot = (pid: number): TelemetrySnapshot =>
  Object.freeze({
    pid,
    status: 'active' as const,
    cpuPercent: 1,
    memoryRssBytes: 1_000 + pid,
    uptimeMs: 10,
    sampledAt: '2026-08-25T00:00:00.000Z'
  });

function samplerFor(pids: readonly number[]) {
  const sampled: number[] = [];
  const warnings: string[] = [];
  const sampler = new TelemetrySamplerImpl({
    shellOutFn: async (pid: number) => {
      sampled.push(pid);
      return pids.includes(pid) ? snapshot(pid) : null;
    },
    logger: { warn: (message: string) => warnings.push(message) },
    intervalMs: 5,
    onSample: () => undefined
  });
  return { sampler, sampled, warnings };
}

describe('FR-R3-081 — the sampler covers every concurrent run', () => {
  it('samples a second run rather than declining it', async () => {
    const { sampler, sampled } = samplerFor([101, 202]);
    sampler.start(101, Date.now());
    sampler.start(202, Date.now());

    await vi.waitFor(() => {
      expect(sampled).toContain(101);
      expect(sampled).toContain(202);
    });
    sampler.dispose();
  });

  it('holds one series per run, each with its own numbers', async () => {
    const { sampler } = samplerFor([1, 2, 3]);
    for (const pid of [1, 2, 3]) sampler.start(pid, Date.now());

    await vi.waitFor(() => {
      const byPid = sampler.currentByPid();
      expect([...byPid.keys()].sort()).toEqual([1, 2, 3]);
      // Each series is its OWN child's, not a copy of the projected one.
      expect(byPid.get(2)?.memoryRssBytes).toBe(1_002);
      expect(byPid.get(3)?.memoryRssBytes).toBe(1_003);
    });
    sampler.dispose();
  });

  it('leaves no run after the first unsampled at the maximum cap', async () => {
    // Twenty, which is `schegent.queue.globalConcurrencyCap`'s maximum and the
    // load the measurement this item requires is taken under.
    const pids = Array.from({ length: 20 }, (_, i) => 500 + i);
    const { sampler } = samplerFor(pids);
    for (const pid of pids) sampler.start(pid, Date.now());

    await vi.waitFor(() => {
      expect(sampler.currentByPid().size).toBe(20);
      for (const pid of pids) expect(sampler.currentByPid().get(pid)).not.toBeNull();
    });
    sampler.dispose();
  }, 20_000);

  it('keeps `already-sampling` for the case it was actually about', async () => {
    // The same child announced twice is a caller bug, and it is a different
    // thing from a second child — which is what the old early-return conflated.
    const { sampler, warnings } = samplerFor([7]);
    sampler.start(7, Date.now());
    sampler.start(7, Date.now());
    expect(warnings.join('\n')).toContain('already-sampling');
    sampler.dispose();
  });

  it('stops one run without stopping the others', async () => {
    const { sampler } = samplerFor([11, 22]);
    sampler.start(11, Date.now());
    sampler.start(22, Date.now());
    await vi.waitFor(() => expect(sampler.currentByPid().size).toBe(2));

    sampler.stop({ signal: null, pid: 11 });
    expect([...sampler.currentByPid().keys()]).toEqual([22]);
    sampler.dispose();
  });

  it('stops the projected run when no pid is named, so the old call site still works', async () => {
    // The single-run call site passes no pid, and with one child there is
    // exactly one series to stop.
    const { sampler } = samplerFor([33]);
    sampler.start(33, Date.now());
    await vi.waitFor(() => expect(sampler.currentByPid().size).toBe(1));
    sampler.stop({ signal: null });
    expect(sampler.currentByPid().size).toBe(0);
    sampler.dispose();
  });
});
