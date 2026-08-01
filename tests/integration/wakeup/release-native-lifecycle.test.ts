import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DaemonManager,
  defaultCommandRunner,
  type CommandRunner,
  type DaemonInstaller
} from '../../../src/wakeup/daemon-manager';
import { InvocationLog, type InvocationRecord } from '../../../src/wakeup/invocation-log';
import { detectPlatform, type WakeUpPlatform } from '../../../src/wakeup/platform-detect';
import { LaunchdInstaller } from '../../../src/wakeup/platforms/launchd';
import { WindowsTaskInstaller } from '../../../src/wakeup/platforms/task-scheduler';
import { SystemdUserInstaller } from '../../../src/wakeup/platforms/systemd-user';
import { LinuxCronInstaller } from '../../../src/wakeup/platforms/cron';

const OPTED_IN = process.env.SCHEGENT_INTEGRATION_TESTS === '1';
const SUPPORTED = ['darwin', 'win32', 'linux'].includes(process.platform);
const SHOULD_RUN = OPTED_IN && SUPPORTED;
const TEST_TOKEN = `qualification-${process.pid}`;
const LAUNCHD_LABEL = `com.schegent.wakeup.${TEST_TOKEN}`;
const WINDOWS_TASK = `Schegent\\WakeUp-${TEST_TOKEN}`;
const SYSTEMD_BASENAME = `schegent-wakeup-${TEST_TOKEN}`;
const CRON_MARKER = `# schegent-wakeup-${TEST_TOKEN}`;
const FIRE_WAIT_MS = 90_000;

interface Harness {
  readonly tempRoot: string;
  readonly homeDir: string;
  readonly sourceRunnerPath: string;
  readonly platform: WakeUpPlatform;
  readonly runner: CommandRunner;
  readonly manager: DaemonManager;
}

function standInRunner(platform: WakeUpPlatform): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = process.env.SCHEGENT_WAKEUP_HOME;
if (!home) process.exit(2);
fs.mkdirSync(home, { recursive: true });
const rec = {
  timestamp: new Date().toISOString(),
  platform: '${platform}',
  pid: process.pid,
  lockAcquired: true,
  ephemeralCwd: path.join(os.tmpdir(), 'schegent-primer-session', '${TEST_TOKEN}'),
  cwdInsideWorkspace: false,
  envScrubbed: true,
  claudeExitCode: 0,
  durationMs: 0,
  triggerSource: 'scheduled',
  status: 'succeeded'
};
fs.appendFileSync(path.join(home, 'invocations.log'), JSON.stringify(rec) + '\\n', 'utf8');
`;
}

function createInstaller(
  platform: WakeUpPlatform,
  runner: CommandRunner
): DaemonInstaller {
  switch (platform) {
    case 'darwin':
      return new LaunchdInstaller(runner, undefined, LAUNCHD_LABEL);
    case 'win32':
      return new WindowsTaskInstaller(runner, WINDOWS_TASK);
    case 'linux-systemd':
      return new SystemdUserInstaller(runner, undefined, SYSTEMD_BASENAME);
    case 'linux-cron':
      return new LinuxCronInstaller(runner, CRON_MARKER);
  }
}

function setup(): Harness {
  const tempRoot = mkdtempSync(join(tmpdir(), 'schegent-wakeup-qualification-'));
  const homeDir = join(tempRoot, 'wakeup-home');
  const sourceRunnerPath = join(tempRoot, 'runner.js');
  const platform = detectPlatform();
  writeFileSync(sourceRunnerPath, standInRunner(platform), 'utf8');
  const runner = defaultCommandRunner();
  const manager = new DaemonManager({
    installerFactory: (selected, commandRunner) =>
      createInstaller(selected, commandRunner),
    commandRunner: runner,
    platform: () => platform
  });
  return { tempRoot, homeDir, sourceRunnerPath, platform, runner, manager };
}

async function triggerNative(harness: Harness): Promise<void> {
  switch (harness.platform) {
    case 'darwin':
      await harness.runner.run('launchctl', ['start', LAUNCHD_LABEL]);
      return;
    case 'win32':
      await harness.runner.run('schtasks', ['/Run', '/TN', WINDOWS_TASK]);
      return;
    case 'linux-systemd':
      await harness.runner.run('systemctl', ['--user', 'start', `${SYSTEMD_BASENAME}.service`]);
      return;
    case 'linux-cron':
      // cron has no portable "run this installed entry now" command.
      // The one-minute schedule below is allowed to fire naturally.
      return;
  }
}

async function waitForRecord(homeDir: string): Promise<InvocationRecord | null> {
  const log = new InvocationLog(homeDir);
  const deadline = Date.now() + FIRE_WAIT_MS;
  while (Date.now() < deadline) {
    const records = await log.read(10);
    if (records.length > 0) return records.at(-1) ?? null;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return null;
}

async function waitForRegistration(
  manager: DaemonManager,
  expected: boolean,
  deadlineMs = 10_000
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if ((await manager.inspect()).registered === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

describe.skipIf(!SHOULD_RUN)('Feature 080 — native WakeUp release lifecycle', () => {
  let harness: Harness;

  beforeAll(() => {
    harness = setup();
  });

  afterAll(async () => {
    if (!harness) return;
    await harness.manager.uninstall().catch(() => undefined);
    rmSync(harness.tempRoot, { recursive: true, force: true });
  });

  it('installs, fires through the native scheduler, records isolation, and uninstalls', async () => {
    await harness.manager.apply({
      settings: {
        enabled: true,
        schedulerType: 'periodic',
        chronologicalTime: '04:00',
        periodicInterval: 'Every 1m',
        model: 'runner-default'
      },
      workspaceRoots: [],
      sourceRunnerPath: harness.sourceRunnerPath,
      homeDir: harness.homeDir
    });

    expect(await waitForRegistration(harness.manager, true)).toBe(true);
    await triggerNative(harness);

    const record = await waitForRecord(harness.homeDir);
    expect(record).not.toBeNull();
    expect(record!.lockAcquired).toBe(true);
    expect(record!.cwdInsideWorkspace).toBe(false);
    expect(record!.ephemeralCwd).toContain(TEST_TOKEN);

    await harness.manager.uninstall();
    expect(await waitForRegistration(harness.manager, false)).toBe(true);
  }, FIRE_WAIT_MS + 30_000);
});

describe.skipIf(SHOULD_RUN)('Feature 080 — native WakeUp release lifecycle (skipped)', () => {
  it.skip(
    `requires a supported host and SCHEGENT_INTEGRATION_TESTS=1 (platform=${process.platform}, opted-in=${OPTED_IN})`,
    () => undefined
  );
});
