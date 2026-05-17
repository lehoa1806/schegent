// Feature 014 T022 — Linux systemd-user installer.
//
// Unit files: $XDG_CONFIG_HOME/systemd/user/{schegent-wakeup.service,
// schegent-wakeup.timer}, falling back to ~/.config/systemd/user.
//
// Install steps:
//   1. Resolve absolute node path via `which node`.
//   2. Write service + timer units atomically (write tmp → rename).
//   3. `systemctl --user daemon-reload`.
//   4. `systemctl --user enable schegent-wakeup.timer`.
//   5. `systemctl --user restart schegent-wakeup.timer`.
//
// Uninstall: `systemctl --user disable --now schegent-wakeup.timer` then
// unlink both files (ENOENT-tolerant), then `daemon-reload`.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  DaemonInstaller,
  InstallOptions,
  DaemonState,
  CommandRunner
} from '../daemon-manager';
import type { NormalizedSchedule } from '../schedule-spec';
import { resolveNodePath } from './node-resolver';

export const SYSTEMD_UNIT_BASENAME = 'schegent-wakeup';
export const SYSTEMD_SERVICE = `${SYSTEMD_UNIT_BASENAME}.service`;
export const SYSTEMD_TIMER = `${SYSTEMD_UNIT_BASENAME}.timer`;

export function systemdUserUnitDir(dirOverride?: string): string {
  if (dirOverride) return dirOverride;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'systemd', 'user');
}

export class SystemdUserInstaller implements DaemonInstaller {
  constructor(
    private readonly runner: CommandRunner,
    private readonly dirOverride?: string
  ) {}

  async install(opts: InstallOptions): Promise<void> {
    const nodePath = await resolveNodePath(this.runner);
    const dir = systemdUserUnitDir(this.dirOverride);
    await fs.mkdir(dir, { recursive: true });

    const servicePath = path.join(dir, SYSTEMD_SERVICE);
    const timerPath = path.join(dir, SYSTEMD_TIMER);
    const serviceBody = buildServiceUnit(nodePath, opts.bundle.homeDir, opts.bundle.runnerPath);
    const timerBody = buildTimerUnit(opts.schedule);

    await atomicWrite(servicePath, serviceBody);
    await atomicWrite(timerPath, timerBody);

    await this.runner.run('systemctl', ['--user', 'daemon-reload']);
    await this.runner.run('systemctl', ['--user', 'enable', SYSTEMD_TIMER]);
    const r = await this.runner.run('systemctl', ['--user', 'restart', SYSTEMD_TIMER]);
    if (r.exitCode !== 0) {
      throw new Error(`systemctl restart failed: ${r.stderr.trim() || r.exitCode}`);
    }
  }

  async uninstall(): Promise<void> {
    // disable --now both stops and disables the timer. We ignore the exit
    // code: not-found / not-loaded variants are non-zero but harmless here.
    await this.runner.run('systemctl', ['--user', 'disable', '--now', SYSTEMD_TIMER]);
    const dir = systemdUserUnitDir(this.dirOverride);
    for (const name of [SYSTEMD_TIMER, SYSTEMD_SERVICE]) {
      try {
        await fs.unlink(path.join(dir, name));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    await this.runner.run('systemctl', ['--user', 'daemon-reload']);
  }

  async inspect(): Promise<DaemonState> {
    const dir = systemdUserUnitDir(this.dirOverride);
    const timerPath = path.join(dir, SYSTEMD_TIMER);
    let timerBody: string;
    try {
      timerBody = await fs.readFile(timerPath, 'utf8');
    } catch {
      return { registered: false, schedule: null };
    }
    const enabled = await this.runner.run('systemctl', ['--user', 'is-enabled', SYSTEMD_TIMER]);
    if (enabled.exitCode !== 0) {
      return { registered: false, schedule: null };
    }
    return { registered: true, schedule: parseScheduleFromTimer(timerBody) };
  }
}

async function atomicWrite(target: string, body: string): Promise<void> {
  const tmp = `${target}.tmp.${process.pid}`;
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, target);
}

export function buildServiceUnit(nodePath: string, homeDir: string, runnerPath: string): string {
  return `[Unit]
Description=Schegent wake-up pre-warmer

[Service]
Type=oneshot
Environment=SCHEGENT_WAKEUP_HOME=${homeDir}
ExecStart=${nodePath} ${runnerPath}
`;
}

export function buildTimerUnit(s: NormalizedSchedule): string {
  const header = `[Unit]
Description=Schegent wake-up pre-warmer timer

[Timer]
Unit=${SYSTEMD_SERVICE}
Persistent=true
`;
  const tail = `
[Install]
WantedBy=timers.target
`;
  if (s.kind === 'chronological') {
    const hh = String(s.hour ?? 0).padStart(2, '0');
    const mm = String(s.minute ?? 0).padStart(2, '0');
    return `${header}OnCalendar=*-*-* ${hh}:${mm}:00
${tail}`;
  }
  // 60s floor matches the systemd-user minimum useful frequency. The
  // schedule-spec normalizer already enforces a 1-minute lower bound at
  // settings-write time; this is defense-in-depth.
  const everySec = Math.max(60, Math.floor((s.everyMs ?? 0) / 1000));
  return `${header}OnBootSec=${everySec}
OnUnitActiveSec=${everySec}
${tail}`;
}

export function parseScheduleFromTimer(body: string): NormalizedSchedule | null {
  const onCalendar = /OnCalendar=\*-\*-\*\s+(\d{1,2}):(\d{2}):(\d{2})/.exec(body);
  if (onCalendar) {
    return {
      kind: 'chronological',
      hour: Number.parseInt(onCalendar[1], 10),
      minute: Number.parseInt(onCalendar[2], 10)
    };
  }
  const onActive = /OnUnitActiveSec=(\d+)/.exec(body);
  if (onActive) {
    return { kind: 'periodic', everyMs: Number.parseInt(onActive[1], 10) * 1000 };
  }
  return null;
}
