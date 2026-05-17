// Feature 014 T032 — unit tests for the Linux cron fallback installer.
//
// What's covered here:
//   - `install()` reads existing crontab, strips any prior `# schegent-wakeup`
//     line (idempotent dedupe), appends the new entry, and pipes back via
//     `crontab -`.
//   - `install()` handles "no crontab yet" (exit-1 + empty stdout from
//     `crontab -l`) gracefully — treats it as empty body.
//   - `buildCronLine` emits the correct chronological (`M H * * *`) and
//     periodic (`*/N * * * *`) time specs, includes the
//     `SCHEGENT_WAKEUP_HOME=` inline env, the absolute node path, the
//     runner path, redirects stdout/stderr to /dev/null, and ends with
//     the canonical `# schegent-wakeup` marker.
//   - `stripOurEntry` removes only marker-tagged lines (round-trip safety).
//   - `extractOurLine` finds the tagged line.
//   - `parseScheduleFromCron` round-trips both schedule shapes.
//   - `uninstall()` rewrites the crontab without the marker line and is
//     a no-op when there's nothing to remove.
//   - `inspect()` returns `registered:false` when the marker is absent.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  LinuxCronInstaller,
  CRON_MARKER,
  buildCronLine,
  stripOurEntry,
  extractOurLine,
  parseScheduleFromCron
} from '../../../../src/wakeup/platforms/cron';
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
    if (cmd === 'crontab' && args[0] === '-l') {
      return { stdout: '', stderr: '', exitCode: 0 };
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

// Convenience: capture the body piped to `crontab -`.
function lastWriteBody(runner: FakeCommandRunner): string {
  const writes = runner.calls.filter(
    (c) => c.cmd === 'crontab' && c.args[0] === '-'
  );
  expect(writes.length).toBeGreaterThan(0);
  return writes[writes.length - 1].opts?.input ?? '';
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('LinuxCronInstaller', () => {
  let runner: FakeCommandRunner;
  let installer: LinuxCronInstaller;

  beforeEach(() => {
    runner = new FakeCommandRunner();
    installer = new LinuxCronInstaller(runner);
  });

  describe('install', () => {
    it('writes a fresh crontab containing only our entry when none exists', async () => {
      // `crontab -l` exits 1 (no crontab) → treated as empty.
      runner.enqueue('crontab', { stdout: '', stderr: '', exitCode: 1 });

      await installer.install(chronoOpts);

      const body = lastWriteBody(runner);
      expect(body.split('\n').filter((l) => l.length > 0)).toHaveLength(1);
      expect(body).toContain(CRON_MARKER);
    });

    it('appends our entry after existing user crontab entries', async () => {
      const existing = '# My existing job\n*/5 * * * * /usr/bin/echo hi\n';
      runner.enqueue('crontab', { stdout: existing, stderr: '', exitCode: 0 });

      await installer.install(chronoOpts);

      const body = lastWriteBody(runner);
      expect(body).toContain('# My existing job');
      expect(body).toContain('/usr/bin/echo hi');
      expect(body).toContain(CRON_MARKER);
    });

    it('strips any prior schegent-wakeup line before appending the new one (dedupe)', async () => {
      const existing = [
        '# user job',
        '0 1 * * * /usr/bin/backup.sh',
        '0 3 * * * STALE_HOME=/old node /old/runner.js >/dev/null 2>&1 # schegent-wakeup',
        ''
      ].join('\n');
      runner.enqueue('crontab', { stdout: existing, stderr: '', exitCode: 0 });

      await installer.install(chronoOpts);

      const body = lastWriteBody(runner);
      // The stale `# schegent-wakeup` line must NOT be present.
      const taggedLines = body.split('\n').filter((l) => l.includes(CRON_MARKER));
      expect(taggedLines).toHaveLength(1);
      expect(taggedLines[0]).not.toContain('STALE_HOME');
      expect(taggedLines[0]).toContain(HOME_DIR);

      // The unrelated user job must survive.
      expect(body).toContain('0 1 * * * /usr/bin/backup.sh');
    });

    it('reads via `crontab -l` then writes via `crontab -` with stdin input', async () => {
      await installer.install(chronoOpts);

      const cronCalls = runner.calls.filter((c) => c.cmd === 'crontab');
      expect(cronCalls[0].args).toEqual(['-l']);
      expect(cronCalls[1].args).toEqual(['-']);
      // The write must use stdin input, not args.
      expect(cronCalls[1].opts?.input).toBeDefined();
      expect(cronCalls[1].opts?.input).toContain(CRON_MARKER);
    });

    it('throws when `crontab -` write fails', async () => {
      runner.enqueue('crontab', { stdout: '', stderr: '', exitCode: 0 });  // -l
      runner.enqueue('crontab', { stdout: '', stderr: '  bad time spec', exitCode: 1 });  // -

      await expect(installer.install(chronoOpts)).rejects.toThrow(
        /crontab write failed: bad time spec/
      );
    });
  });

  describe('uninstall', () => {
    it('rewrites the crontab without the marker line', async () => {
      const existing = [
        '0 1 * * * /usr/bin/backup.sh',
        '0 4 * * * SCHEGENT_WAKEUP_HOME=/home/user/x node /home/user/x/runner.js >/dev/null 2>&1 # schegent-wakeup',
        ''
      ].join('\n');
      runner.enqueue('crontab', { stdout: existing, stderr: '', exitCode: 0 });

      await installer.uninstall();

      const body = lastWriteBody(runner);
      expect(body).not.toContain(CRON_MARKER);
      expect(body).toContain('/usr/bin/backup.sh');
    });

    it('is a no-op when the marker is not present (still writes back unchanged body)', async () => {
      const existing = '0 1 * * * /usr/bin/backup.sh\n';
      runner.enqueue('crontab', { stdout: existing, stderr: '', exitCode: 0 });

      await installer.uninstall();

      // Body written matches body read (modulo the stripped-zero-lines).
      const body = lastWriteBody(runner);
      expect(body).toBe(existing);
    });

    it('handles "no crontab yet" gracefully (empty stdout, exit 1)', async () => {
      runner.enqueue('crontab', { stdout: '', stderr: '', exitCode: 1 });
      // Subsequent write — crontab - with empty body — exits 0.
      await expect(installer.uninstall()).resolves.toBeUndefined();
    });
  });

  describe('inspect', () => {
    it('returns {registered:false, schedule:null} when no marker line exists', async () => {
      runner.enqueue('crontab', {
        stdout: '0 1 * * * /usr/bin/backup.sh\n',
        stderr: '',
        exitCode: 0
      });
      const state = await installer.inspect();
      expect(state).toEqual({ registered: false, schedule: null });
    });

    it('returns {registered:true, schedule:chronological} when marker has daily spec', async () => {
      const body = `9 30 * * * SCHEGENT_WAKEUP_HOME=/x /usr/bin/node /x/runner.js >/dev/null 2>&1 ${CRON_MARKER}\n`;
      // ↑ Note: this is intentionally swapped (minute=9, hour=30 is invalid).
      // Use a real valid value:
      const valid = `30 9 * * * SCHEGENT_WAKEUP_HOME=/x /usr/bin/node /x/runner.js >/dev/null 2>&1 ${CRON_MARKER}\n`;
      runner.enqueue('crontab', { stdout: valid, stderr: '', exitCode: 0 });

      const state = await installer.inspect();
      expect(state.registered).toBe(true);
      expect(state.schedule).toEqual({ kind: 'chronological', hour: 9, minute: 30 });

      // Silence unused-var lint (proves we authored the negative case).
      expect(body.length).toBeGreaterThan(0);
    });

    it('returns {registered:true, schedule:periodic} when marker has */N spec', async () => {
      const body = `*/15 * * * * SCHEGENT_WAKEUP_HOME=/x /usr/bin/node /x/runner.js >/dev/null 2>&1 ${CRON_MARKER}\n`;
      runner.enqueue('crontab', { stdout: body, stderr: '', exitCode: 0 });

      const state = await installer.inspect();
      expect(state.registered).toBe(true);
      expect(state.schedule).toEqual({ kind: 'periodic', everyMs: 15 * 60 * 1000 });
    });
  });
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('buildCronLine', () => {
  it('emits `M H * * *` for chronological schedules', () => {
    const line = buildCronLine('/usr/bin/node', chronoOpts);
    expect(line.split(/\s+/, 5).join(' ')).toBe('0 4 * * *');
  });

  it('emits `*/N * * * *` for periodic schedules', () => {
    const line = buildCronLine('/usr/bin/node', periodicOpts);
    expect(line.split(/\s+/, 5).join(' ')).toBe('*/15 * * * *');
  });

  it('floors periodic to at least 1 minute', () => {
    const opts: InstallOptions = {
      bundle: makeBundle(),
      schedule: { kind: 'periodic', everyMs: 30_000 }
    };
    const line = buildCronLine('/usr/bin/node', opts);
    expect(line).toMatch(/^\*\/1\s+\*\s+\*\s+\*\s+\*\s/);
  });

  it('inlines SCHEGENT_WAKEUP_HOME with the bundle home dir', () => {
    const line = buildCronLine('/usr/bin/node', chronoOpts);
    expect(line).toContain(`SCHEGENT_WAKEUP_HOME=${HOME_DIR}`);
  });

  it('uses the absolute node path and bundle.runnerPath', () => {
    const line = buildCronLine('/opt/homebrew/bin/node', chronoOpts);
    expect(line).toContain('/opt/homebrew/bin/node');
    expect(line).toContain(`${HOME_DIR}/runner.js`);
  });

  it('redirects stdout/stderr to /dev/null', () => {
    const line = buildCronLine('/usr/bin/node', chronoOpts);
    expect(line).toContain('>/dev/null 2>&1');
  });

  it('ends with the canonical marker so dedupe + extract can find it', () => {
    const line = buildCronLine('/usr/bin/node', chronoOpts);
    expect(line.endsWith(CRON_MARKER)).toBe(true);
  });
});

describe('stripOurEntry', () => {
  it('removes only lines containing the marker', () => {
    const body = [
      '# user job',
      '0 1 * * * /usr/bin/backup.sh',
      `0 4 * * * cmd ${CRON_MARKER}`,
      '0 5 * * * /usr/bin/other.sh'
    ].join('\n');
    const stripped = stripOurEntry(body);
    expect(stripped).not.toContain(CRON_MARKER);
    expect(stripped).toContain('# user job');
    expect(stripped).toContain('/usr/bin/backup.sh');
    expect(stripped).toContain('/usr/bin/other.sh');
  });

  it('returns input unchanged when no marker is present', () => {
    const body = '0 1 * * * /usr/bin/backup.sh\n';
    expect(stripOurEntry(body)).toBe(body);
  });

  it('removes multiple marker lines if duplicates exist', () => {
    const body = [
      `0 1 * * * foo ${CRON_MARKER}`,
      `0 2 * * * bar ${CRON_MARKER}`,
      'unrelated'
    ].join('\n');
    const stripped = stripOurEntry(body);
    const taggedRemaining = stripped
      .split('\n')
      .filter((l) => l.includes(CRON_MARKER));
    expect(taggedRemaining).toHaveLength(0);
    expect(stripped).toContain('unrelated');
  });
});

describe('extractOurLine', () => {
  it('returns the marker line when present', () => {
    const body = `# user job\n0 4 * * * cmd ${CRON_MARKER}\nunrelated`;
    expect(extractOurLine(body)).toBe(`0 4 * * * cmd ${CRON_MARKER}`);
  });

  it('returns null when absent', () => {
    expect(extractOurLine('# user job\n')).toBeNull();
  });
});

describe('parseScheduleFromCron', () => {
  it('parses chronological with `M H * * *`', () => {
    expect(parseScheduleFromCron('0 4 * * * cmd # schegent-wakeup')).toEqual({
      kind: 'chronological',
      hour: 4,
      minute: 0
    });
  });

  it('parses periodic with `*/N * * * *`', () => {
    expect(parseScheduleFromCron('*/15 * * * * cmd # schegent-wakeup')).toEqual({
      kind: 'periodic',
      everyMs: 15 * 60_000
    });
  });

  it('rejects malformed lines (no 5 fields)', () => {
    expect(parseScheduleFromCron('bad')).toBeNull();
  });

  it('rejects out-of-range hour/minute', () => {
    // 70 is not a valid minute.
    expect(parseScheduleFromCron('70 4 * * * cmd # schegent-wakeup')).toBeNull();
  });
});
