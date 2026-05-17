// Feature 014 T033 — unit tests for the Linux systemd-user installer.
//
// What's covered here:
//   - `install()` writes a `.service` and `.timer` unit file into the
//     overridden config dir, then runs `systemctl --user daemon-reload`,
//     `enable`, and `restart` in that order.
//   - The service unit body carries `Type=oneshot`, the
//     `SCHEGENT_WAKEUP_HOME` Environment line, and the
//     `ExecStart=<node> <runner>` line.
//   - `buildTimerUnit` emits `OnCalendar=*-*-* HH:MM:00` for chronological
//     and `OnBootSec` + `OnUnitActiveSec` for periodic, with a 60s
//     defensive floor.
//   - `install()` throws when the final `systemctl restart` returns
//     non-zero.
//   - `uninstall()` runs `disable --now`, ENOENT-tolerantly deletes both
//     unit files, then runs `daemon-reload`.
//   - `inspect()` returns `registered:false` when the timer file is
//     absent OR when `is-enabled` reports non-zero; returns
//     `registered:true` with the parsed schedule when both succeed.
//   - `systemdUserUnitDir` honors `XDG_CONFIG_HOME` and falls back to
//     `~/.config`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  SystemdUserInstaller,
  SYSTEMD_SERVICE,
  SYSTEMD_TIMER,
  systemdUserUnitDir,
  buildServiceUnit,
  buildTimerUnit,
  parseScheduleFromTimer
} from '../../../../src/wakeup/platforms/systemd-user';
import type {
  CommandRunner,
  CommandResult,
  CommandRunOptions,
  InstallOptions
} from '../../../../src/wakeup/daemon-manager';
import type { PublishedBundle } from '../../../../src/wakeup/runner-bundle';

// ── Fake CommandRunner ──────────────────────────────────────────────────────

interface RecordedCall {
  cmd: string;
  args: readonly string[];
  opts: CommandRunOptions | undefined;
}

class FakeCommandRunner implements CommandRunner {
  public readonly calls: RecordedCall[] = [];
  private queues: Map<string, CommandResult[]> = new Map();

  enqueue(cmd: string, result: CommandResult): void {
    const q = this.queues.get(cmd) ?? [];
    q.push(result);
    this.queues.set(cmd, q);
  }

  async run(
    cmd: string,
    args: readonly string[],
    opts?: CommandRunOptions
  ): Promise<CommandResult> {
    this.calls.push({ cmd, args, opts });
    const q = this.queues.get(cmd);
    if (q && q.length > 0) return q.shift()!;
    if ((cmd === 'which' || cmd === 'where.exe') && args[0] === 'node') {
      return { stdout: '/usr/bin/node\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

const HOME_DIR = '/home/user/.config/schegent/wakeup';

function makeBundle(): PublishedBundle {
  return {
    homeDir: HOME_DIR,
    runnerPath: `${HOME_DIR}/runner.js`,
    settingsPath: `${HOME_DIR}/settings.json`,
    workspaceRootsPath: `${HOME_DIR}/workspace-roots.json`
  };
}

const chronoOpts: InstallOptions = {
  bundle: makeBundle(),
  schedule: { kind: 'chronological', hour: 4, minute: 0 }
};

const periodicOpts: InstallOptions = {
  bundle: makeBundle(),
  schedule: { kind: 'periodic', everyMs: 15 * 60 * 1000 }
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe('SystemdUserInstaller', () => {
  let tempDir: string;
  let runner: FakeCommandRunner;
  let installer: SystemdUserInstaller;
  let servicePath: string;
  let timerPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'schegent-systemd-test-'));
    runner = new FakeCommandRunner();
    installer = new SystemdUserInstaller(runner, tempDir);
    servicePath = path.join(tempDir, SYSTEMD_SERVICE);
    timerPath = path.join(tempDir, SYSTEMD_TIMER);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  });

  describe('install', () => {
    it('writes both unit files into the override dir', async () => {
      await installer.install(chronoOpts);

      const serviceBody = await fs.readFile(servicePath, 'utf8');
      const timerBody = await fs.readFile(timerPath, 'utf8');
      expect(serviceBody).toContain('Type=oneshot');
      expect(timerBody).toContain('[Timer]');
    });

    it('issues daemon-reload → enable → restart in order', async () => {
      await installer.install(chronoOpts);

      const systemctlCalls = runner.calls.filter((c) => c.cmd === 'systemctl');
      expect(systemctlCalls.map((c) => c.args)).toEqual([
        ['--user', 'daemon-reload'],
        ['--user', 'enable', SYSTEMD_TIMER],
        ['--user', 'restart', SYSTEMD_TIMER]
      ]);
    });

    it('service unit contains SCHEGENT_WAKEUP_HOME Environment line', async () => {
      await installer.install(chronoOpts);
      const body = await fs.readFile(servicePath, 'utf8');
      expect(body).toContain(`Environment=SCHEGENT_WAKEUP_HOME=${HOME_DIR}`);
    });

    it('service unit ExecStart points at the resolved node and runner path', async () => {
      runner.enqueue('which', { stdout: '/opt/node\n', stderr: '', exitCode: 0 });
      runner.enqueue('where.exe', { stdout: '/opt/node\n', stderr: '', exitCode: 0 });

      await installer.install(chronoOpts);
      const body = await fs.readFile(servicePath, 'utf8');
      expect(body).toContain(`ExecStart=/opt/node ${HOME_DIR}/runner.js`);
    });

    it('timer unit emits OnCalendar for chronological schedules (zero-padded)', async () => {
      await installer.install({
        bundle: makeBundle(),
        schedule: { kind: 'chronological', hour: 4, minute: 7 }
      });
      const body = await fs.readFile(timerPath, 'utf8');
      expect(body).toContain('OnCalendar=*-*-* 04:07:00');
      expect(body).not.toContain('OnUnitActiveSec=');
    });

    it('timer unit emits OnBootSec + OnUnitActiveSec for periodic schedules', async () => {
      await installer.install(periodicOpts);
      const body = await fs.readFile(timerPath, 'utf8');
      expect(body).toContain('OnBootSec=900');
      expect(body).toContain('OnUnitActiveSec=900');
      expect(body).not.toContain('OnCalendar=');
    });

    it('timer unit Persistent=true so catch-up after missed boot works', async () => {
      await installer.install(chronoOpts);
      const body = await fs.readFile(timerPath, 'utf8');
      expect(body).toContain('Persistent=true');
    });

    it('timer unit WantedBy=timers.target so `enable` actually wires it up', async () => {
      await installer.install(chronoOpts);
      const body = await fs.readFile(timerPath, 'utf8');
      expect(body).toContain('WantedBy=timers.target');
    });

    it('throws when `systemctl restart` returns non-zero (with stderr)', async () => {
      // Order: daemon-reload (0), enable (0), restart (1)
      runner.enqueue('systemctl', { stdout: '', stderr: '', exitCode: 0 });
      runner.enqueue('systemctl', { stdout: '', stderr: '', exitCode: 0 });
      runner.enqueue('systemctl', {
        stdout: '',
        stderr: '  Failed to start.  ',
        exitCode: 1
      });

      await expect(installer.install(chronoOpts)).rejects.toThrow(
        /systemctl restart failed: Failed to start\./
      );
    });

    it('throws node-not-found-in-path when node resolution fails', async () => {
      const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
      runner.enqueue(cmd, { stdout: '', stderr: '', exitCode: 1 });
      await expect(installer.install(chronoOpts)).rejects.toThrow(
        /node-not-found-in-path/
      );
    });

    it('creates the unit directory if it does not exist', async () => {
      // Use a non-existent sub-path.
      const nested = path.join(tempDir, 'nested', 'systemd', 'user');
      const i = new SystemdUserInstaller(runner, nested);
      await i.install(chronoOpts);
      const stat = await fs.stat(nested);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('uninstall', () => {
    it('issues `disable --now` for the timer, then unlinks both files, then daemon-reload', async () => {
      await fs.writeFile(servicePath, 'old service', 'utf8');
      await fs.writeFile(timerPath, 'old timer', 'utf8');

      await installer.uninstall();

      const systemctlCalls = runner.calls.filter((c) => c.cmd === 'systemctl');
      expect(systemctlCalls.map((c) => c.args)).toEqual([
        ['--user', 'disable', '--now', SYSTEMD_TIMER],
        ['--user', 'daemon-reload']
      ]);
      await expect(fs.stat(servicePath)).rejects.toThrow();
      await expect(fs.stat(timerPath)).rejects.toThrow();
    });

    it('is ENOENT-tolerant — does not throw when neither unit file exists', async () => {
      await expect(installer.uninstall()).resolves.toBeUndefined();
    });

    it('tolerates `disable --now` failing (not-loaded variant)', async () => {
      runner.enqueue('systemctl', {
        stdout: '',
        stderr: 'Unit schegent-wakeup.timer not loaded.',
        exitCode: 1
      });
      // daemon-reload still 0.
      runner.enqueue('systemctl', { stdout: '', stderr: '', exitCode: 0 });

      await expect(installer.uninstall()).resolves.toBeUndefined();
    });

    it('rethrows non-ENOENT unlink errors', async () => {
      // Set up `service` as a directory so unlink fails with EISDIR/EPERM.
      await fs.mkdir(servicePath);

      await expect(installer.uninstall()).rejects.toThrow();
    });
  });

  describe('inspect', () => {
    it('returns {registered:false, schedule:null} when timer file is absent', async () => {
      const state = await installer.inspect();
      expect(state).toEqual({ registered: false, schedule: null });
      // `is-enabled` is NOT called when the timer file is missing.
      expect(runner.calls).toEqual([]);
    });

    it('returns {registered:false} when `is-enabled` returns non-zero', async () => {
      await fs.writeFile(
        timerPath,
        buildTimerUnit({ kind: 'chronological', hour: 4, minute: 0 }),
        'utf8'
      );
      runner.enqueue('systemctl', { stdout: 'disabled\n', stderr: '', exitCode: 1 });

      const state = await installer.inspect();
      expect(state).toEqual({ registered: false, schedule: null });
    });

    it('returns {registered:true, schedule:chronological} when timer exists and is-enabled passes', async () => {
      await fs.writeFile(
        timerPath,
        buildTimerUnit({ kind: 'chronological', hour: 4, minute: 0 }),
        'utf8'
      );
      runner.enqueue('systemctl', { stdout: 'enabled\n', stderr: '', exitCode: 0 });

      const state = await installer.inspect();
      expect(state.registered).toBe(true);
      expect(state.schedule).toEqual({
        kind: 'chronological',
        hour: 4,
        minute: 0
      });
    });

    it('returns {registered:true, schedule:periodic} for periodic timer', async () => {
      await fs.writeFile(
        timerPath,
        buildTimerUnit({ kind: 'periodic', everyMs: 60 * 60 * 1000 }),
        'utf8'
      );
      runner.enqueue('systemctl', { stdout: 'enabled\n', stderr: '', exitCode: 0 });

      const state = await installer.inspect();
      expect(state.registered).toBe(true);
      expect(state.schedule).toEqual({ kind: 'periodic', everyMs: 60 * 60 * 1000 });
    });
  });
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('systemdUserUnitDir', () => {
  let prevXdg: string | undefined;

  beforeEach(() => {
    prevXdg = process.env.XDG_CONFIG_HOME;
  });
  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  });

  it('honors XDG_CONFIG_HOME when set', () => {
    process.env.XDG_CONFIG_HOME = '/explicit/xdg';
    expect(systemdUserUnitDir()).toBe('/explicit/xdg/systemd/user');
  });

  it('falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
    delete process.env.XDG_CONFIG_HOME;
    const dir = systemdUserUnitDir();
    expect(dir.endsWith(path.join('.config', 'systemd', 'user'))).toBe(true);
  });

  it('returns the override path verbatim when provided', () => {
    expect(systemdUserUnitDir('/custom/dir')).toBe('/custom/dir');
  });
});

describe('buildServiceUnit', () => {
  it('emits Type=oneshot (single-fire pre-warm)', () => {
    const body = buildServiceUnit('/n', '/h', '/h/runner.js');
    expect(body).toContain('Type=oneshot');
    // Reject Type=simple / Type=forking — they would be incorrect.
    expect(body).not.toContain('Type=simple');
  });

  it('exports SCHEGENT_WAKEUP_HOME inline so cron-style env is preserved', () => {
    const body = buildServiceUnit('/n', '/h', '/h/runner.js');
    expect(body).toContain('Environment=SCHEGENT_WAKEUP_HOME=/h');
  });

  it('places ExecStart with absolute node path then runner path', () => {
    const body = buildServiceUnit('/usr/bin/node', '/h', '/h/runner.js');
    expect(body).toContain('ExecStart=/usr/bin/node /h/runner.js');
  });
});

describe('buildTimerUnit', () => {
  it('floors periodic to 60 seconds (defense-in-depth)', () => {
    const body = buildTimerUnit({ kind: 'periodic', everyMs: 30_000 });
    expect(body).toContain('OnBootSec=60');
    expect(body).toContain('OnUnitActiveSec=60');
  });

  it('does NOT carry both OnCalendar and OnUnitActiveSec', () => {
    const chrono = buildTimerUnit({ kind: 'chronological', hour: 4, minute: 0 });
    expect(chrono).toContain('OnCalendar=');
    expect(chrono).not.toContain('OnUnitActiveSec=');

    const periodic = buildTimerUnit({ kind: 'periodic', everyMs: 60 * 60 * 1000 });
    expect(periodic).toContain('OnUnitActiveSec=');
    expect(periodic).not.toContain('OnCalendar=');
  });
});

describe('parseScheduleFromTimer', () => {
  it('parses OnCalendar to chronological', () => {
    const body = 'OnCalendar=*-*-* 09:30:00';
    expect(parseScheduleFromTimer(body)).toEqual({
      kind: 'chronological',
      hour: 9,
      minute: 30
    });
  });

  it('parses OnUnitActiveSec to periodic (seconds → ms)', () => {
    expect(parseScheduleFromTimer('OnUnitActiveSec=900')).toEqual({
      kind: 'periodic',
      everyMs: 900_000
    });
  });

  it('returns null when neither field is present', () => {
    expect(parseScheduleFromTimer('[Timer]\nPersistent=true\n')).toBeNull();
  });
});
