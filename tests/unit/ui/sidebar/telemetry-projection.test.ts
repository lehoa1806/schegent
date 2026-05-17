// Feature 033 T007 — StateProjector.updateTelemetry covers:
//   (a) sanitize is called exactly once on `status`;
//   (b) negative cpuPercent clamps to 0;
//   (c) negative memoryRssBytes clamps to 0;
//   (d) synthesizeExitSample(signal: null) returns status: 'exited';
//   (e) synthesizeExitSample(signal: 'SIGTERM') returns status: 'killed';
//   (f) lastLive === null ⇒ numeric fields are null;
//   (g) frozen projection rejects mutation in strict mode.

import { describe, expect, it, vi } from 'vitest';
import { StateProjector } from '../../../../src/ui/sidebar/state-projector';
import {
  synthesizeExitSample,
  type TelemetrySnapshot
} from '../../../../src/telemetry/telemetry-snapshot';

function makeProjector(sanitize: (s: string) => string) {
  const logger = {
    warn: vi.fn(),
    debug: vi.fn(),
    sanitize: vi.fn((s: string | null | undefined) => sanitize(String(s ?? '')))
  };
  const projector = new StateProjector({ logger });
  return { projector, logger };
}

function sampleAt(ms: number): TelemetrySnapshot {
  return {
    pid: 12345,
    status: 'active',
    cpuPercent: 42.5,
    memoryRssBytes: 314_572_800,
    uptimeMs: 5_000,
    sampledAt: new Date(ms).toISOString()
  };
}

describe('Feature 033 — StateProjector.updateTelemetry', () => {
  it('sanitizes the status string exactly once', () => {
    const sanitize = vi.fn((s: string) => s);
    const { projector, logger } = makeProjector(sanitize);
    projector.updateTelemetry(sampleAt(Date.now()));
    const snap = projector.project();
    expect(snap.telemetry).not.toBeNull();
    expect(logger.sanitize).toHaveBeenCalledTimes(1);
    expect(logger.sanitize).toHaveBeenCalledWith('active');
  });

  it('clamps negative cpuPercent to 0', () => {
    const { projector } = makeProjector((s) => s);
    projector.updateTelemetry({
      ...sampleAt(Date.now()),
      cpuPercent: -10
    });
    const snap = projector.project();
    expect(snap.telemetry?.cpuPercent).toBe(0);
  });

  it('clamps negative memoryRssBytes to 0', () => {
    const { projector } = makeProjector((s) => s);
    projector.updateTelemetry({
      ...sampleAt(Date.now()),
      memoryRssBytes: -1024
    });
    const snap = projector.project();
    expect(snap.telemetry?.memoryRssBytes).toBe(0);
  });

  it('propagates null when called with null and clears on next project', () => {
    const { projector } = makeProjector((s) => s);
    projector.updateTelemetry(sampleAt(Date.now()));
    projector.updateTelemetry(null);
    const snap = projector.project();
    expect(snap.telemetry).toBeNull();
  });

  it('freezes the projected telemetry record', () => {
    const { projector } = makeProjector((s) => s);
    projector.updateTelemetry(sampleAt(Date.now()));
    const snap = projector.project();
    expect(snap.telemetry).not.toBeNull();
    expect(Object.isFrozen(snap.telemetry)).toBe(true);
    expect(() => {
      (snap.telemetry as unknown as { pid: number }).pid = 999;
    }).toThrow();
  });
});

describe('Feature 033 — synthesizeExitSample helper', () => {
  it('returns status "exited" when signal is null', () => {
    const sample = synthesizeExitSample({
      pid: 100,
      signal: null,
      startedAt: 0,
      now: 5_000,
      lastLive: { cpuPercent: 12.5, memoryRssBytes: 200_000 }
    });
    expect(sample.status).toBe('exited');
    expect(sample.cpuPercent).toBe(12.5);
    expect(sample.memoryRssBytes).toBe(200_000);
    expect(sample.uptimeMs).toBe(5_000);
  });

  it('returns status "killed" when signal is SIGTERM', () => {
    const sample = synthesizeExitSample({
      pid: 100,
      signal: 'SIGTERM',
      startedAt: 0,
      now: 5_000,
      lastLive: { cpuPercent: 12.5, memoryRssBytes: 200_000 }
    });
    expect(sample.status).toBe('killed');
  });

  it('returns null numeric fields when lastLive is null', () => {
    const sample = synthesizeExitSample({
      pid: 100,
      signal: null,
      startedAt: 0,
      now: 5_000,
      lastLive: null
    });
    expect(sample.cpuPercent).toBeNull();
    expect(sample.memoryRssBytes).toBeNull();
    expect(sample.uptimeMs).toBe(5_000);
  });

  it('clamps uptimeMs to 0 when now < startedAt', () => {
    const sample = synthesizeExitSample({
      pid: 100,
      signal: null,
      startedAt: 1_000,
      now: 500,
      lastLive: null
    });
    expect(sample.uptimeMs).toBe(0);
  });

  it('produces a frozen record', () => {
    const sample = synthesizeExitSample({
      pid: 100,
      signal: null,
      startedAt: 0,
      now: 5_000,
      lastLive: null
    });
    expect(Object.isFrozen(sample)).toBe(true);
  });
});
