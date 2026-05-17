// Feature 014 T031 — unit tests for the Windows Task Scheduler installer.
//
// What's covered here:
//   - `install()` resolves node via `where.exe node`, writes a `.cmd`
//     wrapper next to runner.js, then runs `schtasks /Delete` (idempotent
//     reset) followed by `schtasks /Create`.
//   - `buildScheduleArgs` emits the correct `/SC` + `/ST` (daily) or
//     `/SC HOURLY|MINUTE /MO N` (periodic, picking the whole-hour
//     branch when divisible).
//   - `buildWrapper` writes CRLF line endings and quotes the node path
//     + runner path so spaces in usernames work.
//   - `install()` throws when the final `schtasks /Create` fails.
//   - `uninstall()` deletes the task and tolerates the "task not found"
//     non-zero exit (no throw).
//   - `inspect()` returns `registered:false` when `/Query` fails and
//     `registered:true` with the parsed schedule when it succeeds.
//
// Everything is in-memory + a temp dir: no real `schtasks.exe` calls.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  WindowsTaskInstaller,
  WINDOWS_TASK_NAME,
  buildScheduleArgs,
  buildWrapper,
  parseScheduleFromQuery
} from '../../../../src/wakeup/platforms/task-scheduler';
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
    // `resolveNodePath` calls `where.exe` on Windows or `which` on POSIX.
    // Tests run on whichever platform `process.platform` reports — return
    // a canned node path for both so the call ordering assertions work
    // regardless of where the suite executes.
    if ((cmd === 'where.exe' || cmd === 'which') && args[0] === 'node') {
      return { stdout: 'C:\\Program Files\\nodejs\\node.exe\r\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

// `resolveNodePath` is platform-dependent; mirror its choice here so
// call-sequence assertions remain valid on macOS / Linux CI.
const NODE_RESOLVER_CMD = process.platform === 'win32' ? 'where.exe' : 'which';

function makeBundle(homeDir: string): PublishedBundle {
  return {
    homeDir,
    runnerPath: path.join(homeDir, 'runner.js'),
    settingsPath: path.join(homeDir, 'settings.json'),
    workspaceRootsPath: path.join(homeDir, 'workspace-roots.json')
  };
}

function makeChronoOpts(homeDir: string, hour = 4, minute = 0): InstallOptions {
  return {
    bundle: makeBundle(homeDir),
    schedule: { kind: 'chronological', hour, minute }
  };
}

function makePeriodicOpts(homeDir: string, everyMs: number): InstallOptions {
  return {
    bundle: makeBundle(homeDir),
    schedule: { kind: 'periodic', everyMs }
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('WindowsTaskInstaller', () => {
  let tempHome: string;
  let runner: FakeCommandRunner;
  let installer: WindowsTaskInstaller;
  let wrapperPath: string;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(tmpdir(), 'schegent-task-scheduler-test-'));
    runner = new FakeCommandRunner();
    installer = new WindowsTaskInstaller(runner);
    wrapperPath = path.join(tempHome, 'wakeup.cmd');
  });

  afterEach(() => {
    try {
      rmSync(tempHome, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  });

  describe('install', () => {
    it('writes the .cmd wrapper, then deletes prior task, then creates new', async () => {
      await installer.install(makeChronoOpts(tempHome));

      // Wrapper file exists.
      const body = await fs.readFile(wrapperPath, 'utf8');
      expect(body).toContain('@echo off');

      // Command sequence: where.exe|which → schtasks /Delete → schtasks /Create.
      const callTypes = runner.calls.map((c) => `${c.cmd} ${c.args[0]}`);
      expect(callTypes).toEqual([
        `${NODE_RESOLVER_CMD} node`,
        'schtasks /Delete',
        'schtasks /Create'
      ]);
    });

    it('passes the canonical task name `Schegent\\WakeUp` on /Delete and /Create', async () => {
      await installer.install(makeChronoOpts(tempHome));
      const schtasksCalls = runner.calls.filter((c) => c.cmd === 'schtasks');
      expect(schtasksCalls[0].args).toEqual(['/Delete', '/TN', WINDOWS_TASK_NAME, '/F']);
      expect(schtasksCalls[1].args).toContain('/TN');
      expect(schtasksCalls[1].args).toContain(WINDOWS_TASK_NAME);
    });

    it('passes the wrapper.cmd path as /TR and ends args with /F', async () => {
      await installer.install(makeChronoOpts(tempHome));
      const createCall = runner.calls.filter((c) => c.cmd === 'schtasks')[1];
      const trIdx = createCall.args.indexOf('/TR');
      expect(trIdx).toBeGreaterThan(-1);
      expect(createCall.args[trIdx + 1]).toBe(wrapperPath);
      expect(createCall.args[createCall.args.length - 1]).toBe('/F');
    });

    it('emits /SC DAILY /ST HH:MM for a chronological schedule (with zero-pad)', async () => {
      await installer.install(makeChronoOpts(tempHome, 4, 5));
      const createCall = runner.calls.filter((c) => c.cmd === 'schtasks')[1];
      expect(createCall.args).toContain('/SC');
      expect(createCall.args).toContain('DAILY');
      expect(createCall.args).toContain('/ST');
      expect(createCall.args).toContain('04:05');
    });

    it('emits /SC HOURLY /MO N for whole-hour periodic schedules', async () => {
      await installer.install(makePeriodicOpts(tempHome, 4 * 60 * 60 * 1000));
      const createCall = runner.calls.filter((c) => c.cmd === 'schtasks')[1];
      expect(createCall.args).toContain('HOURLY');
      const moIdx = createCall.args.indexOf('/MO');
      expect(createCall.args[moIdx + 1]).toBe('4');
      expect(createCall.args).not.toContain('MINUTE');
    });

    it('emits /SC MINUTE /MO N for sub-hour or non-whole-hour periodic schedules', async () => {
      await installer.install(makePeriodicOpts(tempHome, 15 * 60 * 1000));
      const createCall = runner.calls.filter((c) => c.cmd === 'schtasks')[1];
      expect(createCall.args).toContain('MINUTE');
      const moIdx = createCall.args.indexOf('/MO');
      expect(createCall.args[moIdx + 1]).toBe('15');
      expect(createCall.args).not.toContain('HOURLY');
    });

    it('throws when the final `schtasks /Create` fails (stderr included)', async () => {
      // First schtasks call (delete) succeeds, second (create) fails.
      runner.enqueue('schtasks', { stdout: '', stderr: '', exitCode: 0 });
      runner.enqueue('schtasks', {
        stdout: '',
        stderr: '  ERROR: Access is denied.  ',
        exitCode: 1
      });

      await expect(installer.install(makeChronoOpts(tempHome))).rejects.toThrow(
        /schtasks \/Create failed: ERROR: Access is denied\./
      );
    });

    it('tolerates a failing pre-delete (no prior task registered)', async () => {
      // The pre-delete exits 1 ("task not found"); create still succeeds.
      runner.enqueue('schtasks', {
        stdout: '',
        stderr: 'ERROR: The system cannot find the file specified.',
        exitCode: 1
      });
      runner.enqueue('schtasks', { stdout: '', stderr: '', exitCode: 0 });

      await expect(installer.install(makeChronoOpts(tempHome))).resolves.toBeUndefined();
    });

    it('throws node-not-found-in-path when node resolution fails', async () => {
      runner.enqueue(NODE_RESOLVER_CMD, { stdout: '', stderr: '', exitCode: 1 });
      await expect(installer.install(makeChronoOpts(tempHome))).rejects.toThrow(
        /node-not-found-in-path/
      );
    });
  });

  describe('uninstall', () => {
    it('issues `schtasks /Delete /TN <name> /F`', async () => {
      await installer.uninstall();
      expect(runner.calls).toEqual([
        {
          cmd: 'schtasks',
          args: ['/Delete', '/TN', WINDOWS_TASK_NAME, '/F'],
          opts: undefined
        }
      ]);
    });

    it('silently tolerates `schtasks /Delete` failing (idempotent uninstall)', async () => {
      // schtasks returns exit-1 when the task does not exist; uninstall
      // must not throw.
      runner.enqueue('schtasks', {
        stdout: '',
        stderr: 'ERROR: The system cannot find the file specified.',
        exitCode: 1
      });
      await expect(installer.uninstall()).resolves.toBeUndefined();
    });
  });

  describe('inspect', () => {
    it('returns {registered:false, schedule:null} when /Query fails', async () => {
      runner.enqueue('schtasks', { stdout: '', stderr: 'not found', exitCode: 1 });
      const state = await installer.inspect();
      expect(state).toEqual({ registered: false, schedule: null });
    });

    it('returns {registered:true, schedule:chronological} for daily /Query output', async () => {
      runner.enqueue('schtasks', {
        stdout: [
          'TaskName: \\Schegent\\WakeUp',
          'Status: Ready',
          'Schedule Type: Daily',
          'Start Time: 4:00:00 AM',
          'Repeat: Every: Disabled'
        ].join('\r\n'),
        stderr: '',
        exitCode: 0
      });

      const state = await installer.inspect();
      expect(state.registered).toBe(true);
      expect(state.schedule).toEqual({ kind: 'chronological', hour: 4, minute: 0 });
    });

    it('returns {registered:true, schedule:periodic} for hourly /Query output', async () => {
      runner.enqueue('schtasks', {
        stdout: [
          'TaskName: \\Schegent\\WakeUp',
          'Schedule Type: Hourly',
          'Start Time: 0:00:00',
          'Repeat: Every: 4 Hour'
        ].join('\r\n'),
        stderr: '',
        exitCode: 0
      });

      const state = await installer.inspect();
      expect(state.registered).toBe(true);
      expect(state.schedule).toEqual({ kind: 'periodic', everyMs: 4 * 60 * 60 * 1000 });
    });
  });
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('buildScheduleArgs', () => {
  it('zero-pads hour and minute under 10', () => {
    expect(buildScheduleArgs({ kind: 'chronological', hour: 4, minute: 7 })).toEqual([
      '/SC',
      'DAILY',
      '/ST',
      '04:07'
    ]);
  });

  it('prefers HOURLY for periods divisible by 1h', () => {
    expect(
      buildScheduleArgs({ kind: 'periodic', everyMs: 3 * 60 * 60 * 1000 })
    ).toEqual(['/SC', 'HOURLY', '/MO', '3']);
  });

  it('falls back to MINUTE for non-whole-hour periods', () => {
    expect(
      buildScheduleArgs({ kind: 'periodic', everyMs: 90 * 60 * 1000 })
    ).toEqual(['/SC', 'MINUTE', '/MO', '90']);
  });

  it('floors to at least one minute', () => {
    // 30_000 ms = 0.5 minute → floored to 1 minute (defensive; the
    // settings parser already rejects sub-1m via its 1-minute floor).
    expect(buildScheduleArgs({ kind: 'periodic', everyMs: 30_000 })).toEqual([
      '/SC',
      'MINUTE',
      '/MO',
      '1'
    ]);
  });
});

describe('buildWrapper', () => {
  it('uses CRLF line endings (Windows .cmd convention)', () => {
    const wrapper = buildWrapper(
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Users\\foo bar\\home',
      'C:\\Users\\foo bar\\home\\runner.js'
    );
    expect(wrapper.split('\r\n').length).toBeGreaterThan(1);
    expect(wrapper).not.toMatch(/[^\r]\n/);
  });

  it('quotes both node path and runner path so spaces in usernames work', () => {
    const wrapper = buildWrapper(
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Users\\foo bar\\home',
      'C:\\Users\\foo bar\\home\\runner.js'
    );
    expect(wrapper).toContain('"C:\\Program Files\\nodejs\\node.exe"');
    expect(wrapper).toContain('"C:\\Users\\foo bar\\home\\runner.js"');
  });

  it('sets SCHEGENT_WAKEUP_HOME before invoking node', () => {
    const wrapper = buildWrapper(
      'C:\\node.exe',
      'C:\\home',
      'C:\\home\\runner.js'
    );
    const lines = wrapper.split('\r\n').filter((l) => l.length > 0);
    // Order matters — set must come before the node invocation.
    const setIdx = lines.findIndex((l) => l.startsWith('set SCHEGENT_WAKEUP_HOME='));
    const nodeIdx = lines.findIndex((l) => l.includes('node.exe'));
    expect(setIdx).toBeGreaterThan(-1);
    expect(nodeIdx).toBeGreaterThan(-1);
    expect(setIdx).toBeLessThan(nodeIdx);
  });
});

describe('parseScheduleFromQuery', () => {
  it('returns null when no Schedule Type field is present', () => {
    expect(parseScheduleFromQuery('TaskName: foo\r\nStatus: Ready')).toBeNull();
  });

  it('parses daily schedule with leading-zero start time', () => {
    const stdout = 'Schedule Type: Daily\r\nStart Time: 09:30:00';
    expect(parseScheduleFromQuery(stdout)).toEqual({
      kind: 'chronological',
      hour: 9,
      minute: 30
    });
  });

  it('parses Minute periodic schedule and converts to ms', () => {
    const stdout = 'Schedule Type: Minute\r\nRepeat: Every: 15 Minute';
    expect(parseScheduleFromQuery(stdout)).toEqual({
      kind: 'periodic',
      everyMs: 15 * 60 * 1000
    });
  });
});
