// Feature 033 — macOS / Linux platform adapter for the telemetry sampler.
//
// Shells out to `ps -o %cpu,rss,stat,etime -p <PID>` with `shell: false`
// and parses the output into a `TelemetrySnapshot`. Pure parser is exposed
// for unit tests; `psShellOut` wraps it with the spawn + timeout logic.
//
// This module has NO `vscode` import.

import type { TelemetrySnapshot, TelemetryStatus } from '../telemetry-snapshot';

export type ShellOutFn = (pid: number) => Promise<TelemetrySnapshot | null>;

const SPAWN_TIMEOUT_MS = 1000;

/**
 * Map the `stat` column from `ps` to our closed `TelemetryStatus` union.
 *
 * `ps` `stat` letters (BSD/Linux):
 *   R = running
 *   S = interruptible sleep
 *   I = idle (kernel thread)
 *   D = uninterruptible sleep
 *   Z = zombie
 *   T = stopped (operator or debug session paused)
 *
 * Multi-character `stat` strings carry leading-letter semantics; we look
 * at the first character only.
 */
function mapStat(stat: string): TelemetryStatus {
  const ch = stat.charAt(0).toUpperCase();
  switch (ch) {
    case 'R':
      return 'active';
    case 'S':
    case 'I':
    case 'D':
    case 'T':
      return 'sleeping';
    case 'Z':
      return 'zombie';
    default:
      return 'unavailable';
  }
}

/**
 * Parse a `ps` `etime` value into milliseconds.
 *
 * `etime` formats:
 *   MM:SS
 *   HH:MM:SS
 *   D-HH:MM:SS
 *
 * Returns null on parse failure.
 */
export function parseEtime(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  let days = 0;
  let rest = trimmed;
  const dashIdx = rest.indexOf('-');
  if (dashIdx >= 0) {
    const dPart = rest.substring(0, dashIdx);
    days = Number.parseInt(dPart, 10);
    if (!Number.isFinite(days) || days < 0) return null;
    rest = rest.substring(dashIdx + 1);
  }
  const parts = rest.split(':').map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (parts.length === 3) {
    [hours, minutes, seconds] = parts;
  } else if (parts.length === 2) {
    [minutes, seconds] = parts;
  } else {
    return null;
  }
  const total = ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
  return total * 1000;
}

/**
 * Pure parser for `ps -o %cpu,rss,stat,etime -p <PID>` output. Returns
 * null on any malformed input. Header lines are skipped; the first
 * matching data row is returned.
 *
 * @param rawText  stdout of the `ps` invocation.
 * @param now      current epoch ms (for the `sampledAt` field).
 * @param pid      the queried pid (echoed back into the snapshot).
 */
export function parsePsOutput(
  rawText: string,
  now: number,
  pid: number
): TelemetrySnapshot | null {
  if (typeof rawText !== 'string') return null;
  const lines = rawText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  for (const line of lines) {
    // Skip header lines ("%CPU RSS STAT ELAPSED" or similar). A header
    // line contains the column names — none of those tokens parse as a
    // float in the first column.
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const cpuRaw = parts[0];
    const rssRaw = parts[1];
    const statRaw = parts[2];
    // `etime` is the LAST whitespace-separated token; join everything
    // after parts[2] in case the stat token had no trailing whitespace.
    const etimeRaw = parts.slice(3).join(' ');
    const cpu = Number.parseFloat(cpuRaw);
    const rssKb = Number.parseInt(rssRaw, 10);
    if (!Number.isFinite(cpu) || !Number.isFinite(rssKb)) continue;
    if (cpu < 0 || rssKb < 0) continue;
    const status = mapStat(statRaw);
    const uptimeMs = parseEtime(etimeRaw);
    if (uptimeMs === null) continue;
    return Object.freeze({
      pid,
      status,
      cpuPercent: cpu,
      memoryRssBytes: rssKb * 1024,
      uptimeMs,
      sampledAt: new Date(now).toISOString()
    });
  }
  return null;
}

/**
 * Spawn `ps` and return the parsed `TelemetrySnapshot`, or null on any
 * non-success path (spawn-failed, non-zero exit, parse-failed, no-rows,
 * timeout). Never throws.
 */
export const psShellOut: ShellOutFn = async (pid: number): Promise<TelemetrySnapshot | null> => {
  // Defer require so unit-test importers don't pay the cost of loading
  // child_process when only the parsers are needed.
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
      child = spawn('ps', ['-o', '%cpu,rss,stat,etime', '-p', String(pid)], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
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
      finalize(parsePsOutput(stdout, Date.now(), pid));
    });
  });
};
