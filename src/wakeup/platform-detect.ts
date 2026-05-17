// Feature 014 — OS platform detection and Linux mechanism probe.
//
// Returns one of four platforms the daemon-manager installs into:
//   - darwin         → launchd
//   - win32          → Windows Task Scheduler
//   - linux-systemd  → systemd-user (preferred when available)
//   - linux-cron     → cron fallback (no usable systemd-user session)
//
// R-03: prefer systemd-user if it works, fallback to cron. The probe
// is "does `systemctl --user list-units` exit 0 within ~2 seconds".
// Failure modes (no systemd, no user session DBus, container without
// /run/user/<uid>/) all degrade gracefully to cron.

import { spawnSync } from 'node:child_process';

export type WakeUpPlatform = 'darwin' | 'win32' | 'linux-systemd' | 'linux-cron';

/**
 * Choose the daemon mechanism for the current host. Pure for darwin /
 * win32; performs one bounded subprocess probe on Linux. Callers may
 * cache the result per-process; the host probes once at activation
 * time so the Settings UI can render its mechanism label.
 *
 * The two arguments are dependency-injection seams for unit tests
 * (default values preserve production semantics).
 */
export function detectPlatform(
  platform: NodeJS.Platform = process.platform,
  probeSystemd: () => boolean = probeSystemdUser
): WakeUpPlatform {
  if (platform === 'darwin') return 'darwin';
  if (platform === 'win32') return 'win32';
  if (platform === 'linux') {
    return probeSystemd() ? 'linux-systemd' : 'linux-cron';
  }
  // Unsupported platforms (aix, freebsd, openbsd, sunos, …) fall through
  // to cron. The installer surfaces a clear error when the cron binary
  // is also missing, rather than silently no-op'ing.
  return 'linux-cron';
}

function probeSystemdUser(): boolean {
  try {
    const result = spawnSync(
      'systemctl',
      ['--user', 'list-units', '--no-pager', '--no-legend'],
      { timeout: 2000, stdio: ['ignore', 'ignore', 'ignore'] }
    );
    return result.status === 0;
  } catch {
    return false;
  }
}
