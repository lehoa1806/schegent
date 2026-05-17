// Feature 033 T013 — TelemetrySampler lifecycle, scheduling, and WARN dedup.
//
// All shell-out calls go through the injected `shellOutFn`; no real `ps`
// invocation. Uses Vitest fake timers to deterministically step through
// the 2s tick cadence.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelemetrySamplerImpl } from '../../../src/telemetry/telemetry-sampler';
import type { TelemetrySnapshot } from '../../../src/telemetry/telemetry-snapshot';

const PID = 12345;
const STARTED_AT = 1_700_000_000_000;
const INTERVAL_MS = 2000;

function makeSnap(at: number, overrides: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot {
  return Object.freeze({
    pid: PID,
    status: 'active',
    cpuPercent: 42.0,
    memoryRssBytes: 100 * 1024,
    uptimeMs: at - STARTED_AT,
    sampledAt: new Date(at).toISOString(),
    ...overrides
  });
}

function makeLogger() {
  return {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    sanitize: vi.fn((s: string | null | undefined) => String(s ?? ''))
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(STARTED_AT);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Feature 033 — TelemetrySampler lifecycle', () => {
  it('start() schedules an immediate first sample via microtask, then interval ticks', async () => {
    const samples: Array<TelemetrySnapshot | null> = [];
    const shellOut = vi.fn(async (_pid: number) => makeSnap(Date.now()));
    const sampler = new TelemetrySamplerImpl({
      shellOutFn: shellOut,
      logger: makeLogger() as never,
      intervalMs: INTERVAL_MS,
      now: () => Date.now(),
      onSample: (snap) => samples.push(snap)
    });

    sampler.start(PID, STARTED_AT);

    // First sample arrives on the microtask boundary. Drain microtasks
    // without advancing the fake clock so only the microtask runs.
    // The tick is async: outer queueMicrotask → await shellOutFn → emit.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(shellOut).toHaveBeenCalledTimes(1);
    expect(samples.length).toBeGreaterThanOrEqual(1);

    // Advance 2s → second tick from setInterval.
    vi.advanceTimersByTime(INTERVAL_MS);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(shellOut).toHaveBeenCalledTimes(2);

    // Advance another 2s → third tick.
    vi.advanceTimersByTime(INTERVAL_MS);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(shellOut).toHaveBeenCalledTimes(3);

    sampler.dispose();
  });

  it('start() while already sampling is a NO-OP and WARNs once', async () => {
    const shellOut = vi.fn(async (_pid: number) => makeSnap(Date.now()));
    const logger = makeLogger();
    const sampler = new TelemetrySamplerImpl({
      shellOutFn: shellOut,
      logger: logger as never,
      intervalMs: INTERVAL_MS,
      now: () => Date.now(),
      onSample: () => {}
    });

    sampler.start(PID, STARTED_AT);
    // Drain microtasks (first sample only — no fake clock advance).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(shellOut).toHaveBeenCalledTimes(1);

    // Second start() — should not spawn another sample.
    sampler.start(PID, STARTED_AT);
    await Promise.resolve();
    await Promise.resolve();
    expect(shellOut).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    sampler.dispose();
  });

  it('stop({signal: null}) synthesizes "exited" final sample then null', async () => {
    const samples: Array<TelemetrySnapshot | null> = [];
    const shellOut = vi.fn(async (_pid: number) => makeSnap(Date.now(), { cpuPercent: 12.5, memoryRssBytes: 200_000 }));
    const sampler = new TelemetrySamplerImpl({
      shellOutFn: shellOut,
      logger: makeLogger() as never,
      intervalMs: INTERVAL_MS,
      now: () => Date.now(),
      onSample: (s) => samples.push(s)
    });

    sampler.start(PID, STARTED_AT);
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    // Take one live sample.
    expect(samples.length).toBeGreaterThanOrEqual(1);
    const liveSamples = samples.filter((s) => s !== null) as TelemetrySnapshot[];
    expect(liveSamples.length).toBeGreaterThanOrEqual(1);

    // Advance clock so synthesizeExitSample's `now - startedAt` is nonzero.
    vi.setSystemTime(STARTED_AT + 5_000);

    samples.length = 0;
    sampler.stop({ signal: null });
    await Promise.resolve();
    await Promise.resolve();

    // Final sample carries status: 'exited' and lastLive numeric fields.
    const finalSample = samples.find((s) => s !== null) as TelemetrySnapshot;
    expect(finalSample).toBeDefined();
    expect(finalSample.status).toBe('exited');
    expect(finalSample.cpuPercent).toBe(12.5);
    expect(finalSample.memoryRssBytes).toBe(200_000);

    // Followed by null to clear the projection.
    expect(samples.some((s) => s === null)).toBe(true);
  });

  it('stop({signal: "SIGTERM"}) synthesizes "killed" final sample', async () => {
    const samples: Array<TelemetrySnapshot | null> = [];
    const shellOut = vi.fn(async (_pid: number) => makeSnap(Date.now()));
    const sampler = new TelemetrySamplerImpl({
      shellOutFn: shellOut,
      logger: makeLogger() as never,
      intervalMs: INTERVAL_MS,
      now: () => Date.now(),
      onSample: (s) => samples.push(s)
    });

    sampler.start(PID, STARTED_AT);
    await vi.runOnlyPendingTimersAsync();

    samples.length = 0;
    sampler.stop({ signal: 'SIGTERM' });
    await Promise.resolve();
    await Promise.resolve();

    const finalSample = samples.find((s) => s !== null) as TelemetrySnapshot;
    expect(finalSample.status).toBe('killed');
  });

  it('stop() while not sampling is a NO-OP (no synthesized sample)', async () => {
    const samples: Array<TelemetrySnapshot | null> = [];
    const shellOut = vi.fn(async (_pid: number) => makeSnap(Date.now()));
    const sampler = new TelemetrySamplerImpl({
      shellOutFn: shellOut,
      logger: makeLogger() as never,
      intervalMs: INTERVAL_MS,
      now: () => Date.now(),
      onSample: (s) => samples.push(s)
    });

    sampler.stop({ signal: null });
    await Promise.resolve();
    expect(samples).toEqual([]);
  });

  it('current() returns the last live sample, or null when not sampling', async () => {
    const shellOut = vi.fn(async (_pid: number) => makeSnap(Date.now(), { cpuPercent: 75 }));
    const sampler = new TelemetrySamplerImpl({
      shellOutFn: shellOut,
      logger: makeLogger() as never,
      intervalMs: INTERVAL_MS,
      now: () => Date.now(),
      onSample: () => {}
    });

    expect(sampler.current()).toBeNull();

    sampler.start(PID, STARTED_AT);
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    const c = sampler.current();
    expect(c).not.toBeNull();
    expect(c!.cpuPercent).toBe(75);
  });

  it('dispose() calls stop() and is idempotent', async () => {
    const samples: Array<TelemetrySnapshot | null> = [];
    const shellOut = vi.fn(async (_pid: number) => makeSnap(Date.now()));
    const sampler = new TelemetrySamplerImpl({
      shellOutFn: shellOut,
      logger: makeLogger() as never,
      intervalMs: INTERVAL_MS,
      now: () => Date.now(),
      onSample: (s) => samples.push(s)
    });

    sampler.start(PID, STARTED_AT);
    await vi.runOnlyPendingTimersAsync();

    samples.length = 0;
    sampler.dispose();
    await Promise.resolve();

    // Final sample emitted by stop() via dispose() path.
    const callsAfter1 = shellOut.mock.calls.length;

    // Idempotent: second dispose triggers nothing.
    sampler.dispose();
    await Promise.resolve();
    expect(shellOut.mock.calls.length).toBe(callsAfter1);
  });

  it('shellOutFn returning null emits status: "unavailable" sample and continues ticking', async () => {
    const samples: Array<TelemetrySnapshot | null> = [];
    const shellOut = vi.fn(async (_pid: number) => null);
    const sampler = new TelemetrySamplerImpl({
      shellOutFn: shellOut,
      logger: makeLogger() as never,
      intervalMs: INTERVAL_MS,
      now: () => Date.now(),
      onSample: (s) => samples.push(s)
    });

    sampler.start(PID, STARTED_AT);
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    const unavail = samples.find((s) => s !== null) as TelemetrySnapshot;
    expect(unavail).toBeDefined();
    expect(unavail.status).toBe('unavailable');
    expect(unavail.cpuPercent).toBeNull();
    expect(unavail.memoryRssBytes).toBeNull();
    expect(unavail.uptimeMs).toBeNull();

    // Second tick still fires.
    samples.length = 0;
    vi.advanceTimersByTime(INTERVAL_MS);
    await vi.runOnlyPendingTimersAsync();
    expect(shellOut.mock.calls.length).toBeGreaterThanOrEqual(2);

    sampler.dispose();
  });

  it('WARN is deduplicated per (pid, errorClass) within a single start() lifetime', async () => {
    const logger = makeLogger();
    const shellOut = vi.fn(async (_pid: number) => null);
    const sampler = new TelemetrySamplerImpl({
      shellOutFn: shellOut,
      logger: logger as never,
      intervalMs: INTERVAL_MS,
      now: () => Date.now(),
      onSample: () => {}
    });

    sampler.start(PID, STARTED_AT);
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    // First failure → one WARN.
    const warnsAfter1 = logger.warn.mock.calls.length;

    // Several more failures → still only one WARN for the same class.
    vi.advanceTimersByTime(INTERVAL_MS);
    await vi.runOnlyPendingTimersAsync();
    vi.advanceTimersByTime(INTERVAL_MS);
    await vi.runOnlyPendingTimersAsync();

    expect(logger.warn.mock.calls.length).toBe(warnsAfter1);

    sampler.dispose();
  });

  it('sampler does NOT throw when onSample callback throws — wraps in try/catch and WARNs', async () => {
    const logger = makeLogger();
    const shellOut = vi.fn(async (_pid: number) => makeSnap(Date.now()));
    const sampler = new TelemetrySamplerImpl({
      shellOutFn: shellOut,
      logger: logger as never,
      intervalMs: INTERVAL_MS,
      now: () => Date.now(),
      onSample: () => {
        throw new Error('callback failed');
      }
    });

    sampler.start(PID, STARTED_AT);
    // Should NOT throw out of the microtask drain.
    await expect(vi.runOnlyPendingTimersAsync()).resolves.not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(logger.warn).toHaveBeenCalled();

    sampler.dispose();
  });
});
