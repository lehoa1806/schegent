// Feature 091 T006 — contract C-02: every scheduler removal operation
// is idempotent, identity-scoped, total, and independent.
//
// The four guarantees are asserted against all four modules, so a
// module added or rewritten later cannot quietly satisfy three of them.
// Nothing here touches a real `launchctl` / `systemctl` / `crontab` /
// `schtasks`: the injected runner records arguments and returns canned
// results, and filesystem work happens in a temp dir.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { remove as removeLaunchd, LAUNCHD_LABEL } from '../../../src/cleanup/schedulers/launchd-remove';
import {
  remove as removeSystemd,
  SYSTEMD_SERVICE,
  SYSTEMD_TIMER
} from '../../../src/cleanup/schedulers/systemd-user-remove';
import { remove as removeCron, CRON_MARKER } from '../../../src/cleanup/schedulers/cron-remove';
import {
  remove as removeTaskScheduler,
  WINDOWS_TASK_NAME
} from '../../../src/cleanup/schedulers/task-scheduler-remove';
import {
  describeFailure,
  type CommandResult,
  type CommandRunOptions,
  type CommandRunner,
  type SchedulerRemovalDeps
} from '../../../src/cleanup/schedulers/types';

// ── Fake CommandRunner ──────────────────────────────────────────────────────

interface RecordedCall {
  cmd: string;
  args: readonly string[];
  opts: CommandRunOptions | undefined;
}

class FakeCommandRunner implements CommandRunner {
  public readonly calls: RecordedCall[] = [];
  private readonly queues = new Map<string, CommandResult[]>();
  /** When set, every `run()` rejects — the "throwing dependency" case. */
  public throwEverything = false;
  /** Overrides what `throwEverything` throws. */
  public throwValue: unknown = undefined;
  /** Mutable stand-in for the user's crontab. */
  public crontab = '';
  /** Mutable stand-in for the Windows Task Scheduler registry. */
  public readonly scheduledTasks = new Set<string>();

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
    if (this.throwEverything) {
      throw this.throwValue ?? new Error(`spawn ${cmd} ENOENT at /Users/someone/secret/path`);
    }
    const q = this.queues.get(cmd);
    if (q && q.length > 0) return q.shift()!;

    // Default crontab semantics: `-l` reads, `-` writes.
    if (cmd === 'crontab' && args[0] === '-l') {
      if (this.crontab === '') return { stdout: '', stderr: '', exitCode: 1 };
      return { stdout: this.crontab, stderr: '', exitCode: 0 };
    }
    if (cmd === 'crontab' && args[0] === '-') {
      this.crontab = opts?.input ?? '';
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    // schtasks semantics: deleting a registered task exits 0; deleting an
    // unknown one exits non-zero. Modelling the registry rather than
    // canning a result is what makes the idempotence assertion real —
    // a queue that runs dry would report success forever.
    if (cmd === 'schtasks' && args[0] === '/Delete') {
      const nameIdx = args.indexOf('/TN');
      const name = nameIdx >= 0 ? (args[nameIdx + 1] ?? '') : '';
      if (this.scheduledTasks.delete(name)) {
        return { stdout: 'SUCCESS: The scheduled task was successfully deleted.', stderr: '', exitCode: 0 };
      }
      return {
        stdout: '',
        stderr: 'ERROR: The system cannot find the file specified.',
        exitCode: 1
      };
    }

    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

// ── Per-scheduler harness ───────────────────────────────────────────────────

interface Harness {
  readonly name: string;
  readonly run: (deps: SchedulerRemovalDeps) => Promise<{ scheduler: string; result: string; reason?: string }>;
  /** Put a registered entry in place so removal has something to remove. */
  readonly seed: (runner: FakeCommandRunner, root: string) => Promise<void>;
  /** Put a foreign entry in place that MUST survive removal. */
  readonly seedForeign: (runner: FakeCommandRunner, root: string) => Promise<void>;
  /** Assert the foreign entry is still intact. */
  readonly expectForeignSurvives: (runner: FakeCommandRunner, root: string) => Promise<void>;
  /** Extra deps pointing the module at the temp root. */
  readonly deps: (root: string) => SchedulerRemovalDeps;
}

const FOREIGN_CRON_LINE = '0 3 * * * /usr/local/bin/backup.sh # nightly-backup';

const HARNESSES: readonly Harness[] = [
  {
    name: 'launchd',
    run: (deps) => removeLaunchd(deps),
    deps: (root) => ({ homeDir: root }),
    seed: async (_runner, root) => {
      const dir = path.join(root, 'Library', 'LaunchAgents');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${LAUNCHD_LABEL}.plist`), '<plist/>', 'utf8');
    },
    seedForeign: async (_runner, root) => {
      const dir = path.join(root, 'Library', 'LaunchAgents');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'com.example.other.plist'), 'FOREIGN', 'utf8');
    },
    expectForeignSurvives: async (_runner, root) => {
      const body = await fs.readFile(
        path.join(root, 'Library', 'LaunchAgents', 'com.example.other.plist'),
        'utf8'
      );
      expect(body).toBe('FOREIGN');
    }
  },
  {
    name: 'systemd-user',
    run: (deps) => removeSystemd(deps),
    deps: (root) => ({ unitDir: root }),
    seed: async (_runner, root) => {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, SYSTEMD_TIMER), '[Timer]', 'utf8');
      await fs.writeFile(path.join(root, SYSTEMD_SERVICE), '[Service]', 'utf8');
    },
    seedForeign: async (_runner, root) => {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, 'other-tool.timer'), 'FOREIGN', 'utf8');
    },
    expectForeignSurvives: async (_runner, root) => {
      expect(await fs.readFile(path.join(root, 'other-tool.timer'), 'utf8')).toBe('FOREIGN');
    }
  },
  {
    name: 'cron',
    run: (deps) => removeCron(deps),
    deps: () => ({}),
    seed: async (runner) => {
      runner.crontab = `${FOREIGN_CRON_LINE}\n*/5 * * * * node runner.js ${CRON_MARKER}\n`;
    },
    seedForeign: async (runner) => {
      runner.crontab = `${FOREIGN_CRON_LINE}\n`;
    },
    expectForeignSurvives: async (runner) => {
      expect(runner.crontab).toContain(FOREIGN_CRON_LINE);
    }
  },
  {
    name: 'task-scheduler',
    run: (deps) => removeTaskScheduler(deps),
    deps: () => ({}),
    seed: async (runner) => {
      runner.scheduledTasks.add(WINDOWS_TASK_NAME);
    },
    seedForeign: async (runner) => {
      runner.scheduledTasks.add('OtherVendor\\NightlyBackup');
    },
    expectForeignSurvives: async (runner) => {
      expect(runner.scheduledTasks.has('OtherVendor\\NightlyBackup')).toBe(true);
      // The only lever schtasks offers is `/TN`; assert we never
      // addressed anything else.
      for (const call of runner.calls) {
        expect(call.args).toContain('/TN');
        expect(call.args).toContain(WINDOWS_TASK_NAME);
      }
    }
  }
];

// ── Tests ───────────────────────────────────────────────────────────────────

describe('C-02 scheduler removal contract', () => {
  let root: string;
  let runner: FakeCommandRunner;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'schegent-cleanup-contract-'));
    runner = new FakeCommandRunner();
  });

  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  for (const h of HARNESSES) {
    describe(h.name, () => {
      it('guarantee 1 (idempotent): a second call is indistinguishable from the first', async () => {
        await h.seed(runner, root);
        const first = await h.run({ runner, ...h.deps(root) });
        expect(first.result).toBe('removed');

        const second = await h.run({ runner, ...h.deps(root) });
        expect(second.result).toBe('absent');

        // And a third, to prove `absent` is stable rather than a
        // one-shot transition.
        const third = await h.run({ runner, ...h.deps(root) });
        expect(third).toEqual(second);
      });

      it('guarantee 1 (idempotent): removing nothing reports absent, never failed', async () => {
        const attempt = await h.run({ runner, ...h.deps(root) });
        expect(attempt.result).toBe('absent');
        expect(attempt.reason).toBeUndefined();
      });

      it('guarantee 2 (identity-scoped): a foreign entry survives', async () => {
        await h.seedForeign(runner, root);
        await h.run({ runner, ...h.deps(root) });
        await h.expectForeignSurvives(runner, root);
      });

      it('guarantee 3 (total): a throwing dependency yields failed and never propagates', async () => {
        runner.throwEverything = true;
        const attempt = await h.run({ runner, ...h.deps(root) });
        expect(attempt.result).toBe('failed');
        expect(typeof attempt.reason).toBe('string');
      });

      it('guarantee 3 (total): the reason carries no stack trace and stays short', async () => {
        runner.throwEverything = true;
        const attempt = await h.run({ runner, ...h.deps(root) });
        const reason = attempt.reason ?? '';
        expect(reason).not.toMatch(/\n/);
        expect(reason).not.toMatch(/\bat\s+\S+\s+\(/); // stack frame shape
        expect(reason.length).toBeLessThanOrEqual(200);
      });

      it('guarantee 3 (total): the reason carries no filesystem path', async () => {
        // Node embeds the offending path verbatim in an ErrnoException
        // message, so dropping the stack alone is not enough — the
        // operator's home directory would land in a stored record
        // (contract C-01 guarantee 4).
        const err = new Error(
          `EACCES: permission denied, unlink '${path.join(root, 'Library', 'secret.plist')}'`
        ) as NodeJS.ErrnoException;
        err.code = 'EACCES';
        runner.throwValue = err;
        runner.throwEverything = true;

        const attempt = await h.run({ runner, ...h.deps(root) });
        const reason = attempt.reason ?? '';
        expect(reason).not.toContain(root);
        expect(reason).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\/);
        expect(reason).toContain('<path>');
      });

      it('always reports its own scheduler name', async () => {
        const attempt = await h.run({ runner, ...h.deps(root) });
        expect(attempt.scheduler).toBe(h.name);
      });
    });
  }

  describe('describeFailure path elision', () => {
    it('elides POSIX, home-relative, and Windows paths', () => {
      expect(
        describeFailure(new Error("EACCES: permission denied, unlink '/Users/someone/x.plist'"))
      ).toBe("EACCES: permission denied, unlink '<path>'");
      expect(describeFailure(new Error('cannot read ~/Library/LaunchAgents/a.plist'))).toBe(
        'cannot read <path>'
      );
      expect(describeFailure(new Error('cannot read C:\\Users\\someone\\a.xml'))).toBe(
        'cannot read <path>'
      );
    });

    it('leaves a scheduler identity that merely contains slashes intact', () => {
      // `gui/501/com.schegent.wakeup` is a launchd service target, not a
      // path. Eliding it would discard the only diagnostic detail the
      // log line carries.
      expect(
        describeFailure(new Error('launchctl bootout gui/501/com.schegent.wakeup failed: 1'))
      ).toBe('launchctl bootout gui/501/com.schegent.wakeup failed: 1');
    });

    it('leaves path-free messages byte-for-byte unchanged', () => {
      expect(describeFailure(new Error('crontab write failed: 1'))).toBe(
        'crontab write failed: 1'
      );
      expect(describeFailure('systemctl --user daemon-reload exited 1')).toBe(
        'systemctl --user daemon-reload exited 1'
      );
    });
  });

  it('guarantee 4 (independent): one scheduler failing does not affect its siblings', async () => {
    // cron is wired to fail; launchd and systemd are seeded normally.
    // Each module gets its own runner, which is the structural reason
    // independence holds — assert the observable consequence anyway.
    const failing = new FakeCommandRunner();
    failing.throwEverything = true;
    const healthy = new FakeCommandRunner();

    await HARNESSES[0].seed(healthy, root);

    const [cron, launchd] = await Promise.all([
      removeCron({ runner: failing }),
      removeLaunchd({ runner: healthy, homeDir: root })
    ]);

    expect(cron.result).toBe('failed');
    expect(launchd.result).toBe('removed');
  });

  it('cron leaves every unmarked line byte-for-byte unchanged', async () => {
    const before = [
      '# operator comment',
      FOREIGN_CRON_LINE,
      `*/5 * * * * node runner.js ${CRON_MARKER}`,
      '@reboot /usr/local/bin/other',
      ''
    ].join('\n');
    runner.crontab = before;

    const attempt = await removeCron({ runner });
    expect(attempt.result).toBe('removed');

    const expected = before
      .split('\n')
      .filter((l) => !l.includes(CRON_MARKER))
      .join('\n');
    expect(runner.crontab).toBe(expected);
  });

  it('cron performs no write at all when nothing of ours is present', async () => {
    runner.crontab = `${FOREIGN_CRON_LINE}\n`;
    const attempt = await removeCron({ runner });

    expect(attempt.result).toBe('absent');
    // A no-op rewrite is still a destructive operation against
    // operator-owned state — assert `crontab -` was never invoked.
    expect(runner.calls.some((c) => c.cmd === 'crontab' && c.args[0] === '-')).toBe(false);
  });

  it('launchd unloads before unlinking, so launchd never holds a vanished plist', async () => {
    await HARNESSES[0].seed(runner, root);
    await removeLaunchd({ runner, homeDir: root });

    expect(runner.calls[0].cmd).toBe('launchctl');
    expect(runner.calls[0].args).toEqual([
      'unload',
      path.join(root, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
    ]);
  });

  it('systemd reloads the daemon after unlinking both units', async () => {
    await HARNESSES[1].seed(runner, root);
    await removeSystemd({ runner, unitDir: root });

    const shapes = runner.calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    expect(shapes).toEqual([
      `systemctl --user disable --now ${SYSTEMD_TIMER}`,
      'systemctl --user daemon-reload'
    ]);
    await expect(fs.stat(path.join(root, SYSTEMD_TIMER))).rejects.toThrow();
    await expect(fs.stat(path.join(root, SYSTEMD_SERVICE))).rejects.toThrow();
  });

  it('task-scheduler reads a non-zero schtasks exit as absent, not failed', async () => {
    // Deleting a task that does not exist exits non-zero. Reporting
    // `failed` here would warn every operator who never enabled
    // Wake-up, against FR-014.
    expect(runner.scheduledTasks.has(WINDOWS_TASK_NAME)).toBe(false);
    const attempt = await removeTaskScheduler({ runner });
    expect(attempt.result).toBe('absent');
  });
});
