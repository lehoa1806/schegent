// Feature 033 T011 — Fixture-driven coverage of `parsePsOutput`.
//
// Pure parser; runs unconditionally on every platform (no `ps` invocation).

import { describe, it, expect } from 'vitest';
import { parsePsOutput, parseEtime } from '../../../src/telemetry/platform/platform-ps';

const PID = 12345;
const NOW = 1_700_000_000_000;

describe('Feature 033 — parsePsOutput', () => {
  it('parses a happy row with sleeping stat (S) and MM:SS etime', () => {
    const raw = ' 38.5 421384 S 01:23\n';
    const snap = parsePsOutput(raw, NOW, PID);
    expect(snap).not.toBeNull();
    expect(snap!.pid).toBe(PID);
    expect(snap!.cpuPercent).toBe(38.5);
    expect(snap!.memoryRssBytes).toBe(421384 * 1024);
    expect(snap!.status).toBe('sleeping');
    expect(snap!.uptimeMs).toBe(83_000); // 1*60 + 23 = 83s
    expect(snap!.sampledAt).toBe(new Date(NOW).toISOString());
  });

  it('maps R to active, S/I/D/T to sleeping, Z to zombie', () => {
    expect(parsePsOutput(' 1 100 R 00:01', NOW, PID)?.status).toBe('active');
    expect(parsePsOutput(' 1 100 S 00:01', NOW, PID)?.status).toBe('sleeping');
    expect(parsePsOutput(' 1 100 I 00:01', NOW, PID)?.status).toBe('sleeping');
    expect(parsePsOutput(' 1 100 D 00:01', NOW, PID)?.status).toBe('sleeping');
    expect(parsePsOutput(' 1 100 T 00:01', NOW, PID)?.status).toBe('sleeping');
    expect(parsePsOutput(' 1 100 Z 00:01', NOW, PID)?.status).toBe('zombie');
  });

  it('parses HH:MM:SS etime', () => {
    const raw = ' 5.0 10000 R 02:30:45\n';
    const snap = parsePsOutput(raw, NOW, PID);
    expect(snap?.uptimeMs).toBe(((2 * 60 + 30) * 60 + 45) * 1000);
  });

  it('parses D-HH:MM:SS etime', () => {
    const raw = ' 5.0 10000 R 1-02:30:45\n';
    const snap = parsePsOutput(raw, NOW, PID);
    const expected = (((1 * 24 + 2) * 60 + 30) * 60 + 45) * 1000;
    expect(snap?.uptimeMs).toBe(expected);
  });

  it('returns null on empty input', () => {
    expect(parsePsOutput('', NOW, PID)).toBeNull();
  });

  it('returns null on whitespace-only input', () => {
    expect(parsePsOutput('   \n\n  \n', NOW, PID)).toBeNull();
  });

  it('skips header-only output (returns null when only column names present)', () => {
    const raw = '%CPU RSS STAT ELAPSED\n';
    // Header tokens are non-numeric in column 0 — parser skips and falls
    // through to null.
    expect(parsePsOutput(raw, NOW, PID)).toBeNull();
  });

  it('returns null on missing columns', () => {
    expect(parsePsOutput(' 38.5 421384 S\n', NOW, PID)).toBeNull();
    expect(parsePsOutput(' 38.5 421384\n', NOW, PID)).toBeNull();
    expect(parsePsOutput(' 38.5\n', NOW, PID)).toBeNull();
  });

  it('returns null on non-numeric %cpu', () => {
    expect(parsePsOutput(' notanumber 421384 S 01:23\n', NOW, PID)).toBeNull();
  });

  it('returns null on non-numeric RSS', () => {
    expect(parsePsOutput(' 38.5 abc S 01:23\n', NOW, PID)).toBeNull();
  });

  it('returns null on negative %cpu', () => {
    expect(parsePsOutput(' -1.0 421384 S 01:23\n', NOW, PID)).toBeNull();
  });

  it('returns null on negative RSS', () => {
    expect(parsePsOutput(' 38.5 -1 S 01:23\n', NOW, PID)).toBeNull();
  });

  it('skips header line and parses subsequent data row', () => {
    const raw = '%CPU RSS STAT ELAPSED\n 12.3 99999 R 00:05\n';
    const snap = parsePsOutput(raw, NOW, PID);
    expect(snap?.cpuPercent).toBe(12.3);
    expect(snap?.memoryRssBytes).toBe(99999 * 1024);
    expect(snap?.status).toBe('active');
    expect(snap?.uptimeMs).toBe(5000);
  });

  it('produces a frozen snapshot', () => {
    const snap = parsePsOutput(' 38.5 421384 S 01:23\n', NOW, PID);
    expect(snap).not.toBeNull();
    expect(Object.isFrozen(snap!)).toBe(true);
  });
});

describe('Feature 033 — parseEtime', () => {
  it('parses MM:SS', () => {
    expect(parseEtime('01:23')).toBe(83_000);
    expect(parseEtime('00:00')).toBe(0);
    expect(parseEtime('59:59')).toBe(((59 * 60) + 59) * 1000);
  });

  it('parses HH:MM:SS', () => {
    expect(parseEtime('02:30:45')).toBe(((2 * 60 + 30) * 60 + 45) * 1000);
  });

  it('parses D-HH:MM:SS', () => {
    expect(parseEtime('1-02:30:45')).toBe((((1 * 24 + 2) * 60 + 30) * 60 + 45) * 1000);
  });

  it('returns null on empty / malformed input', () => {
    expect(parseEtime('')).toBeNull();
    expect(parseEtime('abc')).toBeNull();
    expect(parseEtime('1:2:3:4')).toBeNull();
    expect(parseEtime('1::2')).toBeNull();
  });

  it('returns null on negative components', () => {
    expect(parseEtime('-1-02:30:45')).toBeNull();
  });
});
