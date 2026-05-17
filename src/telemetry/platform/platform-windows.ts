// Feature 033 — Windows platform adapter for the telemetry sampler.
//
// Shells out to `powershell.exe Get-Process -Id <PID>` with `shell: false`
// and parses the output into a `TelemetrySnapshot`. Pure parser is exposed
// for unit tests; `windowsShellOut` wraps it with the spawn + timeout
// logic.
//
// This module has NO `vscode` import.

import type { TelemetrySnapshot } from '../telemetry-snapshot';
import type { ShellOutFn } from './platform-ps';

const SPAWN_TIMEOUT_MS = 1000;

/**
 * Pure parser for `powershell.exe Get-Process -Id <PID> | Select-Object
 * CPU,WorkingSet,Status` output. The default PowerShell table format is
 * approximately:
 *
 *    CPU       WorkingSet Status
 *    ---       ---------- ------
 *    12.34       43210496 Running
 *
 * Returns null on malformed input or empty/error output. The `Status`
 * column may be absent on older Windows builds; in that case we default
 * to `'active'` since `Get-Process` only returns rows for running
 * processes (a missing process produces an error, not an empty row).
 *
 * - `CPU` is total CPU-seconds consumed by the process. We surface this
 *   value verbatim on `cpuPercent` — operators reading the field
 *   understand it as "CPU time used so far" on Windows; per FR-014 the
 *   field is reported with platform semantics. Negative values are
 *   clamped to 0 by the projector.
 * - `WorkingSet` is reported in bytes by PowerShell — no unit
 *   conversion needed.
 *
 * Uptime is computed by the caller (the runner's `started` event time).
 * The parser returns `uptimeMs: null` and lets the sampler fill in.
 */
export function parsePowerShellOutput(
  rawText: string,
  now: number,
  pid: number,
  uptimeMs: number | null
): TelemetrySnapshot | null {
  if (typeof rawText !== 'string') return null;
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  if (/Cannot find a process/i.test(trimmed)) return null;
  // PowerShell table output uses header → separator (dashes) → data.
  // Look for the first data line whose first column parses as a number.
  const lines = trimmed.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  for (const line of lines) {
    if (/^-+/.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const cpu = Number.parseFloat(parts[0]);
    const workingSet = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(cpu) || !Number.isFinite(workingSet)) continue;
    if (cpu < 0 || workingSet < 0) continue;
    const statusRaw = parts.length >= 3 ? parts[2] : 'Running';
    const status: TelemetrySnapshot['status'] =
      statusRaw.toLowerCase() === 'running' ? 'active' : 'sleeping';
    return Object.freeze({
      pid,
      status,
      cpuPercent: cpu,
      memoryRssBytes: workingSet,
      uptimeMs,
      sampledAt: new Date(now).toISOString()
    });
  }
  return null;
}

/**
 * Spawn `powershell.exe` and return the parsed `TelemetrySnapshot`, or
 * null on any non-success path. Never throws.
 *
 * The sampler's `start(pid, startedAt)` lifetime carries the
 * `startedAt` value via a closure; the Windows adapter takes a second
 * argument via `createWindowsShellOut(startedAt)`. The exported
 * `windowsShellOut` defaults to "uptime computed from spawn time"
 * which is wrong for long-lived processes — callers SHOULD construct
 * via `createWindowsShellOut`.
 */
export function createWindowsShellOut(startedAt: number): ShellOutFn {
  return async (pid: number): Promise<TelemetrySnapshot | null> => {
    const { spawn } = await import('child_process');
    return new Promise<TelemetrySnapshot | null>((resolve) => {
      let child;
      let settled = false;
      let stdout = '';
      const finalize = (value: TelemetrySnapshot | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        child = spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `Get-Process -Id ${pid} | Select-Object CPU,WorkingSet,Status | Format-Table -HideTableHeaders`
          ],
          { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }
        );
      } catch {
        finalize(null);
        return;
      }
      const timer = setTimeout(() => {
        try {
          child?.kill('SIGTERM');
        } catch {
          // ignore
        }
        finalize(null);
      }, SPAWN_TIMEOUT_MS);
      timer.unref?.();
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.on('error', () => {
        clearTimeout(timer);
        finalize(null);
      });
      child.on('exit', (code: number | null) => {
        clearTimeout(timer);
        if (code !== 0) {
          finalize(null);
          return;
        }
        const now = Date.now();
        finalize(parsePowerShellOutput(stdout, now, pid, Math.max(0, now - startedAt)));
      });
    });
  };
}

/**
 * Default Windows adapter — captures the import time as the startedAt
 * baseline. Real wiring should build the adapter per-spawn via
 * `createWindowsShellOut(Date.now())`.
 */
export const windowsShellOut: ShellOutFn = createWindowsShellOut(Date.now());
