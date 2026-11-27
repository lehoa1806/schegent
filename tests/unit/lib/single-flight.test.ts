import { describe, expect, it } from 'vitest';

import { singleFlight } from '../../../src/lib/single-flight';

// Review gap GC-03 (2026-11-12) — `ensureStage2` checked `if (stage2) return` and then awaited a long
// `wireStage2`, so a folder change or a reset that arrived mid-wiring wired a second Stage 2: two lock
// managers, two store handles, two heartbeats. `singleFlight` is the guard it now goes through.
describe('singleFlight', () => {
  it('shares one in-flight run between concurrent callers', async () => {
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const guarded = singleFlight(async () => {
      calls += 1;
      await held;
    });

    const first = guarded();
    const second = guarded();
    release();
    await Promise.all([first, second]);

    expect(calls).toBe(1);
  });

  it('runs again once the previous run has settled, resolved or rejected', async () => {
    let calls = 0;
    const guarded = singleFlight(async () => {
      calls += 1;
      if (calls === 1) throw new Error('first run failed');
    });

    await expect(guarded()).rejects.toThrow('first run failed');
    await guarded();

    expect(calls).toBe(2);
  });
});
