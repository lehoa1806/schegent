// Feature 014 T019 — macOS launchd installer.
//
// Label: com.schegent.wakeup
// Plist: ~/Library/LaunchAgents/com.schegent.wakeup.plist
//
// Install steps:
//   1. Resolve absolute path to `node` via `which node` (PATH-independent at fire).
//   2. Write plist atomically (write tmp → rename).
//   3. `launchctl unload` (idempotent) the previous plist if any.
//   4. `launchctl load -w <plist>`.
//
// Uninstall is idempotent: unload then unlink, both ENOENT-tolerant.

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

export const LAUNCHD_LABEL = 'com.schegent.wakeup';

function plistPath(homeOverride?: string, label = LAUNCHD_LABEL): string {
  const home = homeOverride ?? os.homedir();
  return path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

export class LaunchdInstaller implements DaemonInstaller {
  constructor(
    private readonly runner: CommandRunner,
    private readonly homeOverride?: string,
    private readonly label = LAUNCHD_LABEL
  ) {}

  async install(opts: InstallOptions): Promise<void> {
    const nodePath = await resolveNodePath(this.runner);
    const plist = plistPath(this.homeOverride, this.label);
    await fs.mkdir(path.dirname(plist), { recursive: true });
    const body = buildPlist(nodePath, opts, this.label);
    const tmp = `${plist}.tmp.${process.pid}`;
    await fs.writeFile(tmp, body, 'utf8');
    // Idempotent reload: unload any existing first; failure is fine.
    await this.runner.run('launchctl', ['unload', plist]);
    await fs.rename(tmp, plist);
    const r = await this.runner.run('launchctl', ['load', '-w', plist]);
    if (r.exitCode !== 0) {
      throw new Error(`launchctl load failed: ${r.stderr.trim() || r.exitCode}`);
    }
  }

  async uninstall(): Promise<void> {
    const plist = plistPath(this.homeOverride, this.label);
    await this.runner.run('launchctl', ['unload', plist]);
    try {
      await fs.unlink(plist);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async inspect(): Promise<DaemonState> {
    const plist = plistPath(this.homeOverride, this.label);
    let body: string;
    try {
      body = await fs.readFile(plist, 'utf8');
    } catch {
      return { registered: false, schedule: null };
    }
    const listResult = await this.runner.run('launchctl', ['list', this.label]);
    if (listResult.exitCode !== 0) {
      return { registered: false, schedule: null };
    }
    return { registered: true, schedule: parseScheduleFromPlist(body) };
  }
}

export function buildPlist(
  nodePath: string,
  opts: InstallOptions,
  label = LAUNCHD_LABEL
): string {
  const { bundle, schedule } = opts;
  const scheduleBlock = schedule.kind === 'chronological'
    ? `<key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${schedule.hour}</integer>
    <key>Minute</key><integer>${schedule.minute}</integer>
  </dict>`
    : `<key>StartInterval</key><integer>${Math.floor((schedule.everyMs ?? 0) / 1000)}</integer>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(bundle.runnerPath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SCHEGENT_WAKEUP_HOME</key>
    <string>${escapeXml(bundle.homeDir)}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  ${scheduleBlock}
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
`;
}

export function parseScheduleFromPlist(plist: string): NormalizedSchedule | null {
  const intervalMatch = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist);
  if (intervalMatch) {
    return { kind: 'periodic', everyMs: Number.parseInt(intervalMatch[1], 10) * 1000 };
  }
  const calMatch = /<key>StartCalendarInterval<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plist);
  if (calMatch) {
    const hourMatch = /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/.exec(calMatch[1]);
    const minuteMatch = /<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/.exec(calMatch[1]);
    if (hourMatch && minuteMatch) {
      return {
        kind: 'chronological',
        hour: Number.parseInt(hourMatch[1], 10),
        minute: Number.parseInt(minuteMatch[1], 10)
      };
    }
  }
  return null;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
