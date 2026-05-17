// Feature 033 T012 — Fixture-driven coverage of `parsePowerShellOutput`.
//
// Pure parser; runs unconditionally on every platform.

import { describe, it, expect } from 'vitest';
import { parsePowerShellOutput } from '../../../src/telemetry/platform/platform-windows';

const PID = 12345;
const NOW = 1_700_000_000_000;
const UPTIME = 30_000;

describe('Feature 033 — parsePowerShellOutput', () => {
  it('parses a happy row with CPU + WorkingSet + Status=Running', () => {
    const raw = '12.34 43210496 Running\n';
    const snap = parsePowerShellOutput(raw, NOW, PID, UPTIME);
    expect(snap).not.toBeNull();
    expect(snap!.pid).toBe(PID);
    expect(snap!.cpuPercent).toBe(12.34);
    expect(snap!.memoryRssBytes).toBe(43_210_496);
    expect(snap!.status).toBe('active');
    expect(snap!.uptimeMs).toBe(UPTIME);
  });

  it('maps Status=Running to active; missing status to active (Get-Process only returns live procs)', () => {
    const running = parsePowerShellOutput('12.34 43210496 Running', NOW, PID, UPTIME);
    expect(running?.status).toBe('active');

    // Missing Status column → defaults to Running → active.
    const noStatus = parsePowerShellOutput('12.34 43210496', NOW, PID, UPTIME);
    expect(noStatus?.status).toBe('active');
  });

  it('maps non-Running status to sleeping', () => {
    const snap = parsePowerShellOutput('1.0 1000 Stopped', NOW, PID, UPTIME);
    expect(snap?.status).toBe('sleeping');
  });

  it('returns null on empty output', () => {
    expect(parsePowerShellOutput('', NOW, PID, UPTIME)).toBeNull();
  });

  it('returns null on "Cannot find a process" error text', () => {
    const raw = 'Get-Process : Cannot find a process with the process identifier 99999.';
    expect(parsePowerShellOutput(raw, NOW, PID, UPTIME)).toBeNull();
  });

  it('returns null on arbitrary text', () => {
    expect(parsePowerShellOutput('hello world', NOW, PID, UPTIME)).toBeNull();
    expect(parsePowerShellOutput('not a real row', NOW, PID, UPTIME)).toBeNull();
  });

  it('skips dash-separator lines in PowerShell table output', () => {
    const raw = '----        ---------- ------\n12.34 43210496 Running\n';
    const snap = parsePowerShellOutput(raw, NOW, PID, UPTIME);
    expect(snap).not.toBeNull();
    expect(snap?.cpuPercent).toBe(12.34);
  });

  it('returns null on negative CPU', () => {
    expect(parsePowerShellOutput('-1.0 43210496 Running', NOW, PID, UPTIME)).toBeNull();
  });

  it('returns null on negative WorkingSet', () => {
    expect(parsePowerShellOutput('12.34 -1 Running', NOW, PID, UPTIME)).toBeNull();
  });

  it('returns null on non-numeric CPU', () => {
    expect(parsePowerShellOutput('abc 43210496 Running', NOW, PID, UPTIME)).toBeNull();
  });

  it('produces a frozen snapshot', () => {
    const snap = parsePowerShellOutput('12.34 43210496 Running', NOW, PID, UPTIME);
    expect(snap).not.toBeNull();
    expect(Object.isFrozen(snap!)).toBe(true);
  });

  it('preserves the uptime passed by caller', () => {
    const snap = parsePowerShellOutput('12.34 43210496 Running', NOW, PID, 99_999);
    expect(snap?.uptimeMs).toBe(99_999);
  });

  it('passes through null uptime when caller has no startedAt baseline', () => {
    const snap = parsePowerShellOutput('12.34 43210496 Running', NOW, PID, null);
    expect(snap?.uptimeMs).toBeNull();
  });
});
