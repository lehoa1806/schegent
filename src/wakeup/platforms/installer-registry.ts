// Feature 014 — Installer registry.
//
// Maps a detected WakeUpPlatform → concrete DaemonInstaller. This is the
// single switchboard the DaemonManager consults; everything else stays
// platform-agnostic and unit-testable behind the injected CommandRunner.

import type { WakeUpPlatform } from '../platform-detect';
import type { DaemonInstaller, CommandRunner } from '../daemon-manager';
import { LaunchdInstaller } from './launchd';
import { WindowsTaskInstaller } from './task-scheduler';
import { LinuxCronInstaller } from './cron';
import { SystemdUserInstaller } from './systemd-user';

export function installerFactory(
  platform: WakeUpPlatform,
  runner: CommandRunner
): DaemonInstaller {
  switch (platform) {
    case 'darwin':
      return new LaunchdInstaller(runner);
    case 'win32':
      return new WindowsTaskInstaller(runner);
    case 'linux-systemd':
      return new SystemdUserInstaller(runner);
    case 'linux-cron':
      return new LinuxCronInstaller(runner);
  }
}
