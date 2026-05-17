// Feature 014 T030 — unit tests for the macOS launchd installer.
//
// What's covered here:
//   - `install()` resolves node via `which node`, writes the plist to
//     `~/Library/LaunchAgents/com.schegent.wakeup.plist` (overridden via
//     `homeOverride`), unloads any prior plist (idempotent), then loads
//     the new one with `launchctl load -w <plist>`.
//   - The plist body carries the canonical Label, an absolute node path,
//     the bundle.runnerPath, the SCHEGENT_WAKEUP_HOME env var, and the
//     correct schedule block for chronological vs periodic schedules.
//   - `install()` throws when `launchctl load` returns non-zero.
//   - `uninstall()` runs `launchctl unload` then deletes the plist, and
//     is ENOENT-tolerant (no throw when the plist is already missing).
//   - `inspect()` returns `registered:false` when the file is absent OR
//     when `launchctl list` reports non-zero exit; returns `registered:
//     true` with the parsed schedule when both checks pass.
//
// Everything is in-memory + a temp dir: no real `launchctl` invocations.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  LaunchdInstaller,
  LAUNCHD_LABEL,
  buildPlist,
  parseScheduleFromPlist
} from '../../../../src/wakeup/platforms/launchd';
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

interface CannedResult extends CommandResult {}

class FakeCommandRunner implements CommandRunner {
  public readonly calls: RecordedCall[] = [];
  // Per-cmd queues of canned results. When a queue is empty, default to
  // exit-0 with empty stdout/stderr. `which node` defaults to /usr/bin/node.
  private queues: Map<string, CannedResult[]> = new Map();

  enqueue(cmd: string, result: CannedResult): void {
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
    if (q && q.length > 0) {
      return q.shift()!;
    }
    if (cmd === 'which' && args[0] === 'node') {
      return { stdout: '/usr/bin/node\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeBundle(homeDir: string): PublishedBundle {
  return {
    homeDir,
    runnerPath: path.join(homeDir, 'runner.js'),
    settingsPath: path.join(homeDir, 'settings.json'),
    workspaceRootsPath: path.join(homeDir, 'workspace-roots.json')
  };
}

function makeChronoOpts(homeDir: string): InstallOptions {
  return {
    bundle: makeBundle(homeDir),
    schedule: { kind: 'chronological', hour: 4, minute: 0 }
  };
}

function makePeriodicOpts(homeDir: string, everyMs: number): InstallOptions {
  return {
    bundle: makeBundle(homeDir),
    schedule: { kind: 'periodic', everyMs }
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('LaunchdInstaller', () => {
  let tempHome: string;
  let runner: FakeCommandRunner;
  let installer: LaunchdInstaller;
  let plistPath: string;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(tmpdir(), 'schegent-launchd-test-'));
    runner = new FakeCommandRunner();
    installer = new LaunchdInstaller(runner, tempHome);
    plistPath = path.join(tempHome, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  });

  afterEach(() => {
    try {
      rmSync(tempHome, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  });

  describe('install', () => {
    it('resolves node, unloads prior, then loads new plist (idempotent reapply)', async () => {
      await installer.install(makeChronoOpts(tempHome));

      // `which node` first, then `launchctl unload`, then `launchctl load -w`.
      expect(runner.calls.map((c) => `${c.cmd} ${c.args.join(' ')}`)).toEqual([
        'which node',
        `launchctl unload ${plistPath}`,
        `launchctl load -w ${plistPath}`
      ]);
    });

    it('writes a plist containing the canonical Label', async () => {
      await installer.install(makeChronoOpts(tempHome));
      const body = await fs.readFile(plistPath, 'utf8');
      expect(body).toContain(`<key>Label</key>`);
      expect(body).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    });

    it('writes the resolved node absolute path into ProgramArguments', async () => {
      runner.enqueue('which', {
        stdout: '/opt/homebrew/bin/node\n',
        stderr: '',
        exitCode: 0
      });
      await installer.install(makeChronoOpts(tempHome));
      const body = await fs.readFile(plistPath, 'utf8');
      expect(body).toContain('<string>/opt/homebrew/bin/node</string>');
    });

    it('writes the bundle.runnerPath into ProgramArguments', async () => {
      await installer.install(makeChronoOpts(tempHome));
      const body = await fs.readFile(plistPath, 'utf8');
      expect(body).toContain(`<string>${path.join(tempHome, 'runner.js')}</string>`);
    });

    it('writes SCHEGENT_WAKEUP_HOME env var pointing at bundle.homeDir', async () => {
      await installer.install(makeChronoOpts(tempHome));
      const body = await fs.readFile(plistPath, 'utf8');
      expect(body).toContain('<key>SCHEGENT_WAKEUP_HOME</key>');
      expect(body).toContain(`<string>${tempHome}</string>`);
    });

    it('writes PATH env var on the canonical macOS bin search list', async () => {
      await installer.install(makeChronoOpts(tempHome));
      const body = await fs.readFile(plistPath, 'utf8');
      // The PATH ensures `claude` (typically a Homebrew install) is on
      // the runner's PATH at fire time.
      expect(body).toContain('<key>PATH</key>');
      expect(body).toContain(
        '<string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>'
      );
    });

    it('emits StartCalendarInterval with Hour/Minute for a chronological schedule', async () => {
      await installer.install({
        bundle: makeBundle(tempHome),
        schedule: { kind: 'chronological', hour: 13, minute: 30 }
      });
      const body = await fs.readFile(plistPath, 'utf8');
      expect(body).toContain('<key>StartCalendarInterval</key>');
      expect(body).toMatch(/<key>Hour<\/key><integer>13<\/integer>/);
      expect(body).toMatch(/<key>Minute<\/key><integer>30<\/integer>/);
      expect(body).not.toContain('<key>StartInterval</key>');
    });

    it('emits StartInterval in seconds for a periodic schedule', async () => {
      // 15 minutes = 900_000 ms = 900 seconds
      await installer.install(makePeriodicOpts(tempHome, 15 * 60 * 1000));
      const body = await fs.readFile(plistPath, 'utf8');
      expect(body).toContain('<key>StartInterval</key><integer>900</integer>');
      expect(body).not.toContain('<key>StartCalendarInterval</key>');
    });

    it('sets RunAtLoad to false so install does NOT fire immediately', async () => {
      await installer.install(makeChronoOpts(tempHome));
      const body = await fs.readFile(plistPath, 'utf8');
      // Plist <false/> is the canonical false; fail the test on either
      // <true/> or a missing key.
      expect(body).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
      expect(body).not.toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    });

    it('silences runner stdout/stderr by redirecting to /dev/null', async () => {
      await installer.install(makeChronoOpts(tempHome));
      const body = await fs.readFile(plistPath, 'utf8');
      expect(body).toContain('<key>StandardOutPath</key><string>/dev/null</string>');
      expect(body).toContain('<key>StandardErrorPath</key><string>/dev/null</string>');
    });

    it('tolerates a failing prior `unload` (idempotent reapply)', async () => {
      // First call to launchctl is the pre-`unload` — simulate an error
      // (no prior plist registered). Second call is the load — must
      // succeed for install to complete.
      runner.enqueue('launchctl', { stdout: '', stderr: 'not loaded', exitCode: 1 });
      runner.enqueue('launchctl', { stdout: '', stderr: '', exitCode: 0 });

      await expect(installer.install(makeChronoOpts(tempHome))).resolves.toBeUndefined();
    });

    it('throws when `launchctl load` fails (with stderr in the message)', async () => {
      // unload exits 0 (queue position 1), load exits 1 (queue position 2).
      runner.enqueue('launchctl', { stdout: '', stderr: '', exitCode: 0 });
      runner.enqueue('launchctl', {
        stdout: '',
        stderr: '  permission denied  ',
        exitCode: 1
      });

      await expect(installer.install(makeChronoOpts(tempHome))).rejects.toThrow(
        /launchctl load failed: permission denied/
      );
    });

    it('throws `node-not-found-in-path` when `which node` fails', async () => {
      runner.enqueue('which', { stdout: '', stderr: '', exitCode: 1 });
      await expect(installer.install(makeChronoOpts(tempHome))).rejects.toThrow(
        /node-not-found-in-path/
      );
    });

    it('creates the LaunchAgents directory if it does not exist', async () => {
      // Pre-condition: directory does not exist yet.
      await expect(
        fs.stat(path.join(tempHome, 'Library', 'LaunchAgents'))
      ).rejects.toThrow();

      await installer.install(makeChronoOpts(tempHome));

      const stat = await fs.stat(path.join(tempHome, 'Library', 'LaunchAgents'));
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('uninstall', () => {
    it('unloads the plist then deletes it', async () => {
      // Pre-seed the plist file so unlink is exercised.
      await fs.mkdir(path.dirname(plistPath), { recursive: true });
      await fs.writeFile(plistPath, '<plist/>', 'utf8');

      await installer.uninstall();

      expect(runner.calls).toEqual([
        { cmd: 'launchctl', args: ['unload', plistPath], opts: undefined }
      ]);
      await expect(fs.stat(plistPath)).rejects.toThrow();
    });

    it('is ENOENT-tolerant — does not throw when plist is already missing', async () => {
      // No file pre-seeded; both unload and unlink may "fail".
      await expect(installer.uninstall()).resolves.toBeUndefined();
    });

    it('rethrows non-ENOENT unlink errors', async () => {
      // Set up plist as a *directory* so unlink fails with EISDIR (or
      // EPERM on macOS). Either way: not ENOENT.
      await fs.mkdir(path.dirname(plistPath), { recursive: true });
      await fs.mkdir(plistPath);

      await expect(installer.uninstall()).rejects.toThrow();
    });
  });

  describe('inspect', () => {
    it('returns {registered:false, schedule:null} when plist is absent', async () => {
      const state = await installer.inspect();
      expect(state).toEqual({ registered: false, schedule: null });
      // Importantly, `launchctl list` is NOT called when the file is
      // missing — the file check short-circuits.
      expect(runner.calls).toEqual([]);
    });

    it('returns {registered:false} when `launchctl list` exits non-zero', async () => {
      // Pre-seed a valid plist body so the fs read succeeds.
      await fs.mkdir(path.dirname(plistPath), { recursive: true });
      await fs.writeFile(plistPath, buildPlist('/usr/bin/node', makeChronoOpts(tempHome)), 'utf8');

      runner.enqueue('launchctl', { stdout: '', stderr: '', exitCode: 1 });

      const state = await installer.inspect();
      expect(state).toEqual({ registered: false, schedule: null });
      expect(runner.calls).toEqual([
        { cmd: 'launchctl', args: ['list', LAUNCHD_LABEL], opts: undefined }
      ]);
    });

    it('returns {registered:true, schedule:chronological} when plist + list both pass', async () => {
      await fs.mkdir(path.dirname(plistPath), { recursive: true });
      await fs.writeFile(plistPath, buildPlist('/usr/bin/node', makeChronoOpts(tempHome)), 'utf8');
      // `launchctl list <label>` exits 0 when registered.
      runner.enqueue('launchctl', { stdout: '', stderr: '', exitCode: 0 });

      const state = await installer.inspect();
      expect(state.registered).toBe(true);
      expect(state.schedule).toEqual({
        kind: 'chronological',
        hour: 4,
        minute: 0
      });
    });

    it('returns {registered:true, schedule:periodic} when periodic plist is registered', async () => {
      await fs.mkdir(path.dirname(plistPath), { recursive: true });
      await fs.writeFile(
        plistPath,
        buildPlist('/usr/bin/node', makePeriodicOpts(tempHome, 60 * 60 * 1000)),
        'utf8'
      );
      runner.enqueue('launchctl', { stdout: '', stderr: '', exitCode: 0 });

      const state = await installer.inspect();
      expect(state.registered).toBe(true);
      expect(state.schedule).toEqual({ kind: 'periodic', everyMs: 60 * 60 * 1000 });
    });
  });
});

// ── Pure helpers (no fs / no runner) ────────────────────────────────────────

describe('buildPlist', () => {
  it('xml-escapes special characters in nodePath and runnerPath', () => {
    const body = buildPlist('/path/with & special <chars> "quoted"', {
      bundle: {
        homeDir: '/home/<test>',
        runnerPath: '/path/runner & extra.js',
        settingsPath: '/home/<test>/settings.json',
        workspaceRootsPath: '/home/<test>/workspace-roots.json'
      },
      schedule: { kind: 'chronological', hour: 4, minute: 0 }
    });
    expect(body).toContain(
      '<string>/path/with &amp; special &lt;chars&gt; &quot;quoted&quot;</string>'
    );
    expect(body).toContain('<string>/path/runner &amp; extra.js</string>');
    expect(body).toContain('<string>/home/&lt;test&gt;</string>');
  });
});

describe('parseScheduleFromPlist', () => {
  it('returns null for a plist body with no schedule block', () => {
    expect(parseScheduleFromPlist('<plist/>')).toBeNull();
  });

  it('parses chronological schedule from StartCalendarInterval', () => {
    const body = `<dict>
      <key>StartCalendarInterval</key>
      <dict>
        <key>Hour</key><integer>9</integer>
        <key>Minute</key><integer>15</integer>
      </dict>
    </dict>`;
    expect(parseScheduleFromPlist(body)).toEqual({
      kind: 'chronological',
      hour: 9,
      minute: 15
    });
  });

  it('parses periodic schedule from StartInterval (seconds → ms)', () => {
    const body = `<dict>
      <key>StartInterval</key><integer>900</integer>
    </dict>`;
    expect(parseScheduleFromPlist(body)).toEqual({
      kind: 'periodic',
      everyMs: 900 * 1000
    });
  });
});
