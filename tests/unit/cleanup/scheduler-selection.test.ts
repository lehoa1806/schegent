// Feature 091 T013 — contract C-04, FR-007a: scheduler selection is a
// pure function of the operating-system family.
//
// The Linux case is the whole point. The probe that chose a scheduler at
// install time may answer differently now — a machine that had
// `systemctl` when the entry was written may not have it today, or the
// reverse — so a probe-driven selection would walk straight past the
// entry cleanup exists to remove. Attempting both unconditionally is
// cheap precisely because each operation is idempotent.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { selectSchedulers } from '../../../src/cleanup/wakeup-cleanup';

describe('C-04 scheduler selection', () => {
  it('darwin attempts launchd', () => {
    expect(selectSchedulers('darwin')).toEqual(['launchd']);
  });

  it('win32 attempts task-scheduler', () => {
    expect(selectSchedulers('win32')).toEqual(['task-scheduler']);
  });

  it('linux attempts systemd-user AND cron, unconditionally', () => {
    expect(selectSchedulers('linux')).toEqual(['systemd-user', 'cron']);
  });

  it('an unsupported platform attempts nothing', () => {
    for (const platform of ['aix', 'freebsd', 'openbsd', 'sunos', 'android', '', 'Linux']) {
      expect(selectSchedulers(platform)).toEqual([]);
    }
  });

  it('is pure — the same platform yields the same answer every time', () => {
    const first = selectSchedulers('linux');
    const second = selectSchedulers('linux');
    expect(second).toEqual(first);
    // And selecting another platform in between changes nothing.
    selectSchedulers('darwin');
    expect(selectSchedulers('linux')).toEqual(first);
  });

  it('consults no capability probe, stored installer choice, or binary presence', () => {
    // Selection is one `switch` over `process.platform`, so the
    // guarantee is structural: assert the module contains no construct
    // that could reach a probe. A functional test cannot prove the
    // absence of a lookup that is never exercised on this platform.
    const source = fs.readFileSync(
      path.join(__dirname, '../../../src/cleanup/wakeup-cleanup.ts'),
      'utf8'
    );

    const forbidden: ReadonlyArray<readonly [string, RegExp]> = [
      ['a capability probe', /\bprobe\b/i],
      ['a which/command lookup', /\bwhich\b|\bcommand -v\b/],
      ['an installer registry', /installerFactory|installer-registry/],
      ['a stored installer choice', /installedScheduler|schedulerChoice|preferredScheduler/],
      ['a binary presence check', /existsSync|accessSync|\.access\(/],
      ['a configuration read', /getConfiguration|workspace\.getConfiguration/]
    ];

    for (const [label, pattern] of forbidden) {
      expect(pattern.test(source), `selection must not consult ${label}`).toBe(false);
    }
  });

  it('names every scheduler exactly once across all platforms', () => {
    const all = [
      ...selectSchedulers('darwin'),
      ...selectSchedulers('win32'),
      ...selectSchedulers('linux')
    ];
    expect([...all].sort()).toEqual(['cron', 'launchd', 'systemd-user', 'task-scheduler']);
  });
});
