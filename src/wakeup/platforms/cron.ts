// Feature 014 T021 — Linux cron installer (fallback when systemd-user
// is unavailable).
//
// Strategy: edit the user's crontab via `crontab -l` + `crontab -`.
// Our entry is identified by the trailing `# schegent-wakeup` marker;
// uninstall/install scrubs the marker first, then re-appends.
//
// Install steps:
//   1. Resolve absolute node path via `which node`.
//   2. Read existing crontab (`crontab -l`). Exit-1 with empty stdout
//      means "no crontab yet" — treat as empty.
//   3. Strip any line containing our marker.
//   4. Append our entry.
//   5. Pipe the new body to `crontab -`.

import type {
  DaemonInstaller,
  InstallOptions,
  DaemonState,
  CommandRunner
} from '../daemon-manager';
import type { NormalizedSchedule } from '../schedule-spec';
import { resolveNodePath } from './node-resolver';

export const CRON_MARKER = '# schegent-wakeup';

export class LinuxCronInstaller implements DaemonInstaller {
  constructor(
    private readonly runner: CommandRunner,
    private readonly marker = CRON_MARKER
  ) {}

  async install(opts: InstallOptions): Promise<void> {
    const nodePath = await resolveNodePath(this.runner);
    const current = await readCrontab(this.runner);
    const withoutOurs = stripOurEntry(current, this.marker);
    const ourLine = buildCronLine(nodePath, opts, this.marker);
    const updated = withoutOurs.length > 0
      ? `${withoutOurs.replace(/\s+$/, '')}\n${ourLine}\n`
      : `${ourLine}\n`;
    await writeCrontab(this.runner, updated);
  }

  async uninstall(): Promise<void> {
    const current = await readCrontab(this.runner);
    const withoutOurs = stripOurEntry(current, this.marker);
    await writeCrontab(this.runner, withoutOurs);
  }

  async inspect(): Promise<DaemonState> {
    const current = await readCrontab(this.runner);
    const line = extractOurLine(current, this.marker);
    if (!line) return { registered: false, schedule: null };
    return { registered: true, schedule: parseScheduleFromCron(line) };
  }
}

export function buildCronLine(
  nodePath: string,
  opts: InstallOptions,
  marker = CRON_MARKER
): string {
  const s = opts.schedule;
  let timeSpec: string;
  if (s.kind === 'chronological') {
    timeSpec = `${s.minute} ${s.hour} * * *`;
  } else {
    const minutes = Math.max(1, Math.floor((s.everyMs ?? 0) / 60_000));
    timeSpec = `*/${minutes} * * * *`;
  }
  // Inline SCHEGENT_WAKEUP_HOME — cron does not source the user's shell rc,
  // so PATH and other env are deliberately minimal. The node binary is an
  // absolute path; the runner does its own env scrub.
  const env = `SCHEGENT_WAKEUP_HOME=${opts.bundle.homeDir}`;
  return `${timeSpec} ${env} ${nodePath} ${opts.bundle.runnerPath} >/dev/null 2>&1 ${marker}`;
}

async function readCrontab(runner: CommandRunner): Promise<string> {
  const r = await runner.run('crontab', ['-l']);
  // exit 1 + empty stdout = "no crontab for this user" on most distros.
  if (r.exitCode !== 0) return '';
  return r.stdout;
}

async function writeCrontab(runner: CommandRunner, body: string): Promise<void> {
  const r = await runner.run('crontab', ['-'], { input: body });
  if (r.exitCode !== 0) {
    throw new Error(`crontab write failed: ${r.stderr.trim() || r.exitCode}`);
  }
}

export function stripOurEntry(body: string, marker = CRON_MARKER): string {
  return body
    .split('\n')
    .filter((l) => !l.includes(marker))
    .join('\n');
}

export function extractOurLine(body: string, marker = CRON_MARKER): string | null {
  const line = body.split('\n').find((l) => l.includes(marker));
  return line ?? null;
}

export function parseScheduleFromCron(line: string): NormalizedSchedule | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const minute = parts[0];
  const hour = parts[1];
  if (/^\*\/\d+$/.test(minute)) {
    const m = Number.parseInt(minute.slice(2), 10);
    if (Number.isFinite(m) && m > 0) {
      return { kind: 'periodic', everyMs: m * 60_000 };
    }
  }
  const m = Number.parseInt(minute, 10);
  const h = Number.parseInt(hour, 10);
  if (
    Number.isFinite(m) && Number.isFinite(h)
    && m >= 0 && m < 60
    && h >= 0 && h < 24
  ) {
    return { kind: 'chronological', hour: h, minute: m };
  }
  return null;
}
