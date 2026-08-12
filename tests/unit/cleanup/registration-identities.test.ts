// Feature 091 T005 — contract C-03: registration identities carried
// forward verbatim.
//
// These four values are the contract with scheduled entries written by
// releases 014, 024, and 031. They were copied out of
// `src/wakeup/platforms/` before that directory was deleted, so there
// is no longer a second copy to diff against — this test IS the
// remaining guard. A refactor that "tidies" any of these literals
// orphans the entry cleanup exists to remove, on a machine whose
// operator will never see the mistake.
//
// Assert the literals directly. Comparing a constant to itself, or to
// a value derived from the same basename, would pass while the entry
// stayed behind.

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { LAUNCHD_LABEL, launchdPlistPath } from '../../../src/cleanup/schedulers/launchd-remove';
import { CRON_MARKER } from '../../../src/cleanup/schedulers/cron-remove';
import {
  SYSTEMD_UNIT_BASENAME,
  SYSTEMD_SERVICE,
  SYSTEMD_TIMER,
  systemdUserUnitDir
} from '../../../src/cleanup/schedulers/systemd-user-remove';
import { WINDOWS_TASK_NAME } from '../../../src/cleanup/schedulers/task-scheduler-remove';

describe('C-03 registration identities', () => {
  it('launchd label is com.schegent.wakeup', () => {
    expect(LAUNCHD_LABEL).toBe('com.schegent.wakeup');
  });

  it('launchd plist sits at ~/Library/LaunchAgents/<label>.plist', () => {
    expect(launchdPlistPath('/tmp/home')).toBe(
      '/tmp/home/Library/LaunchAgents/com.schegent.wakeup.plist'
    );
  });

  it('launchd plist path defaults to the real home directory', () => {
    expect(launchdPlistPath()).toBe(
      path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.schegent.wakeup.plist')
    );
  });

  it('cron marker is "# schegent-wakeup"', () => {
    expect(CRON_MARKER).toBe('# schegent-wakeup');
  });

  it('systemd unit names are schegent-wakeup.service and schegent-wakeup.timer', () => {
    expect(SYSTEMD_UNIT_BASENAME).toBe('schegent-wakeup');
    expect(SYSTEMD_SERVICE).toBe('schegent-wakeup.service');
    expect(SYSTEMD_TIMER).toBe('schegent-wakeup.timer');
  });

  it('systemd unit directory honours XDG_CONFIG_HOME, falling back to ~/.config', () => {
    const previous = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = '/tmp/xdg';
      expect(systemdUserUnitDir()).toBe('/tmp/xdg/systemd/user');

      delete process.env.XDG_CONFIG_HOME;
      expect(systemdUserUnitDir()).toBe(
        path.join(os.homedir(), '.config', 'systemd', 'user')
      );

      // An explicit override wins over both.
      expect(systemdUserUnitDir('/tmp/units')).toBe('/tmp/units');
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }
  });

  it('Windows task name is Schegent\\WakeUp', () => {
    expect(WINDOWS_TASK_NAME).toBe('Schegent\\WakeUp');
    // Guard the escaping specifically: `schtasks /TN` takes a
    // backslash-separated folder path, so a single-segment name would
    // address a different task.
    expect(WINDOWS_TASK_NAME.split('\\')).toEqual(['Schegent', 'WakeUp']);
  });
});
