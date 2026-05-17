// Feature 014 T020 — Windows Task Scheduler installer.
//
// Task name: Schegent\WakeUp
//
// Install steps:
//   1. Resolve absolute node path via `where.exe node`.
//   2. Write a small `wakeup.cmd` wrapper next to runner.js so env vars
//      (specifically `SCHEGENT_WAKEUP_HOME`) can be set — schtasks /TR
//      itself does not directly support environment variables.
//   3. `schtasks /Delete /TN <name> /F`  (idempotent reset)
//   4. `schtasks /Create /TN <name> /TR <wrapper> ...`

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  DaemonInstaller,
  InstallOptions,
  DaemonState,
  CommandRunner
} from '../daemon-manager';
import type { NormalizedSchedule } from '../schedule-spec';
import { resolveNodePath } from './node-resolver';

export const WINDOWS_TASK_NAME = 'Schegent\\WakeUp';

export class WindowsTaskInstaller implements DaemonInstaller {
  constructor(private readonly runner: CommandRunner) {}

  async install(opts: InstallOptions): Promise<void> {
    const nodePath = await resolveNodePath(this.runner);
    const wrapperPath = path.join(opts.bundle.homeDir, 'wakeup.cmd');
    const wrapperBody = buildWrapper(nodePath, opts.bundle.homeDir, opts.bundle.runnerPath);
    const tmp = `${wrapperPath}.tmp.${process.pid}`;
    await fs.writeFile(tmp, wrapperBody, 'utf8');
    await fs.rename(tmp, wrapperPath);

    // Idempotent reset: delete any prior task with the same name.
    await this.runner.run('schtasks', ['/Delete', '/TN', WINDOWS_TASK_NAME, '/F']);

    const args = buildScheduleArgs(opts.schedule);
    const r = await this.runner.run(
      'schtasks',
      ['/Create', '/TN', WINDOWS_TASK_NAME, '/TR', wrapperPath, ...args, '/F']
    );
    if (r.exitCode !== 0) {
      throw new Error(`schtasks /Create failed: ${r.stderr.trim() || r.exitCode}`);
    }
  }

  async uninstall(): Promise<void> {
    // /F = force; deleting a non-existent task yields a non-zero exit
    // code, which we silently accept (idempotent).
    await this.runner.run('schtasks', ['/Delete', '/TN', WINDOWS_TASK_NAME, '/F']);
  }

  async inspect(): Promise<DaemonState> {
    const r = await this.runner.run(
      'schtasks',
      ['/Query', '/TN', WINDOWS_TASK_NAME, '/V', '/FO', 'LIST']
    );
    if (r.exitCode !== 0) return { registered: false, schedule: null };
    return { registered: true, schedule: parseScheduleFromQuery(r.stdout) };
  }
}

export function buildWrapper(nodePath: string, homeDir: string, runnerPath: string): string {
  // CRLF line endings + quoted paths so spaces in user names work.
  return `@echo off\r\nset SCHEGENT_WAKEUP_HOME=${homeDir}\r\n"${nodePath}" "${runnerPath}"\r\n`;
}

export function buildScheduleArgs(s: NormalizedSchedule): readonly string[] {
  if (s.kind === 'chronological') {
    const hh = String(s.hour ?? 0).padStart(2, '0');
    const mm = String(s.minute ?? 0).padStart(2, '0');
    return ['/SC', 'DAILY', '/ST', `${hh}:${mm}`];
  }
  const everyMs = s.everyMs ?? 0;
  const isWholeHours = everyMs >= 60 * 60 * 1000 && everyMs % (60 * 60 * 1000) === 0;
  if (isWholeHours) {
    const hours = Math.floor(everyMs / (60 * 60 * 1000));
    return ['/SC', 'HOURLY', '/MO', String(hours)];
  }
  const minutes = Math.max(1, Math.floor(everyMs / 60_000));
  return ['/SC', 'MINUTE', '/MO', String(minutes)];
}

export function parseScheduleFromQuery(out: string): NormalizedSchedule | null {
  const startTime = /Start Time:\s+(\d{1,2}):(\d{2}):(\d{2})/.exec(out);
  const scheduleType = /Schedule Type:\s+(\S+)/.exec(out);
  if (!scheduleType) return null;
  if (scheduleType[1] === 'Daily' && startTime) {
    return {
      kind: 'chronological',
      hour: Number.parseInt(startTime[1], 10),
      minute: Number.parseInt(startTime[2], 10)
    };
  }
  if (scheduleType[1] === 'Hourly' || scheduleType[1] === 'Minute') {
    const repeat = /Repeat: Every:\s+(\d+)\s+(Hour|Minute)/i.exec(out);
    if (repeat) {
      const n = Number.parseInt(repeat[1], 10);
      const unit = repeat[2].toLowerCase();
      const ms = unit === 'hour' ? n * 60 * 60 * 1000 : n * 60_000;
      return { kind: 'periodic', everyMs: ms };
    }
  }
  return null;
}
