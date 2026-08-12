// Feature 091 T016 — FR-011, contract C-06: cleanup cannot affect
// startup, and SC-008's 5 s budget.
//
// The containment claim is the important one. Cleanup shells out to
// `launchctl` / `systemctl` / `crontab` / `schtasks` and unlinks files —
// four ways for a machine the operator controls to fail during
// activation. So the test does not merely check the happy path stays
// quiet: it forces EVERY scheduler operation and EVERY filesystem call
// to throw and asserts activation still completes.

import { describe, it, expect, beforeEach } from 'vitest';
import { runWakeUpCleanup } from '../../../src/cleanup/wakeup-cleanup';
import { readCleanupRecord } from '../../../src/cleanup/cleanup-record';
import {
  createHarness,
  fixedRemovers,
  throwingFs,
  throwingRemovers,
  VirtualClock,
  RecordingLogger,
  type Harness
} from './cleanup-harness';

/**
 * Worst modelled latency per operation, in milliseconds.
 *
 * These model a *slow* machine, not a *hung* one. A hung binary is
 * bounded separately by `COMMAND_TIMEOUT_MS` (10 s) in
 * `schedulers/command-runner.ts`; research R-05 deliberately declined a
 * total-run timeout because awaiting one "converts a cleanup problem
 * into a startup problem", so SC-008's budget is a claim about normal
 * operation on a loaded machine.
 */
const WORST_COMMAND_MS = 1_000;
const WORST_UNLINK_MS = 50;
const SC_008_BUDGET_MS = 5_000;

/** Commands issued per scheduler, from the removal modules. */
const COMMANDS_PER_SCHEDULER = {
  launchd: 1, // launchctl bootout
  'systemd-user': 2, // systemctl disable --now, systemctl daemon-reload
  cron: 2, // crontab -l, crontab -
  'task-scheduler': 1 // schtasks /Delete
} as const;

describe('C-06 activation containment', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  describe('with every operation hostile', () => {
    const hostile = (): Harness =>
      createHarness({
        platform: 'linux',
        removers: throwingRemovers(),
        fs: throwingFs
      });

    it('resolves rather than rejecting', async () => {
      await expect(runWakeUpCleanup(hostile().deps)).resolves.toBeUndefined();
    });

    it('lets an activation sequence run to completion around it', async () => {
      // Models `extension.ts`: cleanup is dispatched fire-and-forget and
      // the activation function returns without awaiting it.
      const steps: string[] = [];
      const activate = (): { ready: boolean } => {
        steps.push('register-commands');
        void runWakeUpCleanup(hostile().deps); // never awaited
        steps.push('activation-complete');
        return { ready: true };
      };

      const result = activate();

      expect(result.ready).toBe(true);
      expect(steps).toEqual(['register-commands', 'activation-complete']);
    });

    it('produces no unhandled rejection', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        void runWakeUpCleanup(hostile().deps);
        // Let every microtask and one macrotask turn drain.
        await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
      expect(unhandled).toEqual([]);
    });

    it('still records the failure so the next start retries', async () => {
      const h = hostile();
      await runWakeUpCleanup(h.deps);

      const record = readCleanupRecord(h.store);
      expect(record?.outcome).toBe('failed');
      expect(record?.attemptCount).toBe(1);
      // Both Linux schedulers were attempted — one throwing must not
      // stop its sibling (contract C-02 guarantee 4).
      expect(record?.schedulers.map((s) => s.scheduler)).toEqual(['systemd-user', 'cron']);
    });

    it('survives a logger that throws on every call', async () => {
      const brokenLogger = new RecordingLogger();
      brokenLogger.info = (): never => {
        throw new Error('log sink closed');
      };
      brokenLogger.warn = (): never => {
        throw new Error('log sink closed');
      };

      const h = createHarness({
        platform: 'linux',
        removers: throwingRemovers(),
        fs: throwingFs,
        logger: brokenLogger
      });

      await expect(runWakeUpCleanup(h.deps)).resolves.toBeUndefined();
    });

    it('survives a notification surface that rejects', async () => {
      const h = hostile();
      h.notifier.warn = async (): Promise<string | undefined> => {
        throw new Error('window closed');
      };

      await expect(runWakeUpCleanup(h.deps)).resolves.toBeUndefined();
      // The failure is still recorded even though the message could not
      // be shown.
      expect(readCleanupRecord(h.store)?.outcome).toBe('failed');
    });

    it('survives a store whose write rejects', async () => {
      const h = hostile();
      h.deps.store.update = async (): Promise<void> => {
        throw new Error('globalState write failed');
      };

      await expect(runWakeUpCleanup(h.deps)).resolves.toBeUndefined();
    });

    it('survives a store whose read throws', async () => {
      const h = hostile();
      h.deps.store.get = (): never => {
        throw new Error('globalState unavailable');
      };

      await expect(runWakeUpCleanup(h.deps)).resolves.toBeUndefined();
    });
  });

  describe('is never awaited on the activation path', () => {
    it('activation returns before a slow cleanup settles', async () => {
      let settled = false;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const h = createHarness({
        removers: {
          launchd: async () => {
            await gate;
            return { scheduler: 'launchd', result: 'removed' };
          }
        }
      });

      const pending = runWakeUpCleanup(h.deps).then(() => {
        settled = true;
      });

      // The activation path continues immediately: cleanup is still
      // blocked on its first scheduler call.
      await Promise.resolve();
      expect(settled).toBe(false);

      release();
      await pending;
      expect(settled).toBe(true);
    });
  });

  describe('SC-008 — the run settles within 5 s of modelled time', () => {
    it('holds on linux, the worst platform (two schedulers, four commands)', async () => {
      const clock = new VirtualClock();
      const h = createHarness({
        platform: 'linux',
        now: clock.now,
        removers: {
          'systemd-user': async () => {
            await clock.delay(COMMANDS_PER_SCHEDULER['systemd-user'] * WORST_COMMAND_MS);
            return { scheduler: 'systemd-user', result: 'removed' };
          },
          cron: async () => {
            await clock.delay(COMMANDS_PER_SCHEDULER.cron * WORST_COMMAND_MS);
            return { scheduler: 'cron', result: 'removed' };
          }
        },
        fs: {
          unlink: async () => {
            await clock.delay(WORST_UNLINK_MS);
          }
        }
      });

      await runWakeUpCleanup(h.deps);

      // 4 commands x 1000 ms + 3 unlinks x 50 ms = 4150 ms.
      expect(clock.elapsedMs()).toBe(4_150);
      expect(clock.elapsedMs()).toBeLessThanOrEqual(SC_008_BUDGET_MS);
    });

    it('holds on darwin and win32 with room to spare', async () => {
      for (const platform of ['darwin', 'win32'] as const) {
        const clock = new VirtualClock();
        const scheduler = platform === 'darwin' ? 'launchd' : 'task-scheduler';
        const h = createHarness({
          platform,
          now: clock.now,
          removers: {
            [scheduler]: async () => {
              await clock.delay(WORST_COMMAND_MS);
              return { scheduler, result: 'removed' as const };
            }
          },
          fs: {
            unlink: async () => {
              await clock.delay(WORST_UNLINK_MS);
            }
          }
        });

        await runWakeUpCleanup(h.deps);
        expect(clock.elapsedMs()).toBe(1_150);
        expect(clock.elapsedMs()).toBeLessThanOrEqual(SC_008_BUDGET_MS);
      }
    });

    it('the worst-case command count is bounded at four, so the budget is structural', () => {
      // The bound holds because the number of operations is fixed by the
      // platform table, not by anything on the operator's machine. If a
      // fifth command ever appears on one platform, this arithmetic —
      // and the budget — changes.
      const worstPlatformCommands =
        COMMANDS_PER_SCHEDULER['systemd-user'] + COMMANDS_PER_SCHEDULER.cron;
      expect(worstPlatformCommands).toBe(4);
      expect(worstPlatformCommands * WORST_COMMAND_MS + 3 * WORST_UNLINK_MS).toBeLessThanOrEqual(
        SC_008_BUDGET_MS
      );
    });

    it('a terminal record short-circuits with no modelled time at all', async () => {
      const clock = new VirtualClock();
      const h = createHarness({
        platform: 'linux',
        now: clock.now,
        removers: {
          'systemd-user': async () => {
            await clock.delay(WORST_COMMAND_MS);
            return { scheduler: 'systemd-user', result: 'removed' };
          }
        }
      });

      await runWakeUpCleanup(h.deps);
      const afterFirst = clock.elapsedMs();

      await runWakeUpCleanup(h.deps);
      expect(clock.elapsedMs()).toBe(afterFirst);
    });
  });

  describe('the quiet path stays quiet', () => {
    it('a machine that never enabled Wake-up sees no message and no log line', async () => {
      const h = createHarness({ removers: fixedRemovers('absent') });
      await runWakeUpCleanup(h.deps);

      expect(h.notifier.calls).toEqual([]);
      expect(h.logger.lines).toEqual([]);
      expect(readCleanupRecord(h.store)?.outcome).toBe('skipped');
    });

    it('an unsupported platform attempts nothing and records skipped', async () => {
      const h = createHarness({ platform: 'freebsd' });
      await runWakeUpCleanup(h.deps);

      const record = readCleanupRecord(h.store);
      expect(record?.outcome).toBe('skipped');
      expect(record?.schedulers).toEqual([]);
      expect(h.notifier.calls).toEqual([]);
    });
  });

  it('the happy path writes one info line and no message', async () => {
    await runWakeUpCleanup(harness.deps);

    expect(harness.notifier.calls).toEqual([]);
    expect(harness.logger.lines).toHaveLength(1);
    expect(harness.logger.lines[0]?.level).toBe('info');
    expect(harness.logger.lines[0]?.message).toContain('wakeup-cleanup: succeeded');
  });
});
