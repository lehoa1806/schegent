// Feature 091 T017 — FR-010, FR-012, plan D-03: retry until it works,
// but tell the operator only once.
//
// The split matters. Retrying forever with a message each time would
// nag an operator whose machine genuinely cannot be cleaned; giving up
// after one message would strand a live scheduled entry with no
// in-product path to removing it. So the two lifecycles are decoupled:
// the ATTEMPT repeats while the outcome is non-terminal, and the
// MESSAGE fires once, gated on `notifiedAt` rather than on the outcome.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  runWakeUpCleanup,
  CLEANUP_FAILURE_MESSAGE,
  CLEANUP_FAILURE_ACTION
} from '../../../src/cleanup/wakeup-cleanup';
import { readCleanupRecord, CLEANUP_RECORD_KEY } from '../../../src/cleanup/cleanup-record';
import {
  createHarness,
  fixedRemovers,
  emptyFs,
  FakeMemento,
  RecordingLogger,
  RecordingNotifier
} from './cleanup-harness';
import type { SchedulerAttempt } from '../../../src/cleanup/schedulers/types';

/**
 * One machine across many VS Code starts: the store, logger, and
 * notifier persist while the scheduler behaviour changes underneath.
 */
class Machine {
  readonly store = new FakeMemento();
  readonly logger = new RecordingLogger();
  readonly notifier = new RecordingNotifier();
  private launchdResult: SchedulerAttempt = {
    scheduler: 'launchd',
    result: 'failed',
    reason: 'launchctl bootout failed: 1'
  };
  public launchdCalls = 0;

  setLaunchd(result: SchedulerAttempt): void {
    this.launchdResult = result;
  }

  async start(): Promise<void> {
    const { deps } = createHarness({
      store: this.store,
      logger: this.logger,
      notifier: this.notifier,
      fs: emptyFs,
      removers: {
        launchd: async () => {
          this.launchdCalls += 1;
          return this.launchdResult;
        }
      }
    });
    await runWakeUpCleanup(deps);
  }
}

describe('FR-010/FR-012 retry-and-notify lifecycle', () => {
  let machine: Machine;

  beforeEach(() => {
    machine = new Machine();
  });

  it('first start fails, emits exactly one warning carrying exactly one action', async () => {
    await machine.start();

    expect(machine.notifier.calls).toEqual([
      { message: CLEANUP_FAILURE_MESSAGE, action: CLEANUP_FAILURE_ACTION }
    ]);

    const record = readCleanupRecord(machine.store);
    expect(record?.outcome).toBe('failed');
    expect(record?.attemptCount).toBe(1);
    expect(record?.notifiedAt).toBeDefined();
  });

  it('second start retries the removal but emits no second message', async () => {
    await machine.start();
    await machine.start();

    expect(machine.launchdCalls).toBe(2);
    expect(machine.notifier.calls).toHaveLength(1);
    expect(readCleanupRecord(machine.store)?.attemptCount).toBe(2);
  });

  it('third start succeeds and becomes terminal', async () => {
    await machine.start();
    await machine.start();

    machine.setLaunchd({ scheduler: 'launchd', result: 'removed' });
    await machine.start();

    const record = readCleanupRecord(machine.store);
    expect(record?.outcome).toBe('succeeded');
    expect(record?.attemptCount).toBe(3);
    // Carried forward, never restamped — the operator was told once.
    expect(record?.notifiedAt).toBeDefined();
  });

  it('fourth start attempts nothing at all', async () => {
    await machine.start();
    await machine.start();
    machine.setLaunchd({ scheduler: 'launchd', result: 'removed' });
    await machine.start();

    const callsBefore = machine.launchdCalls;
    const writesBefore = machine.store.writes.length;

    await machine.start();

    expect(machine.launchdCalls).toBe(callsBefore);
    expect(machine.store.writes).toHaveLength(writesBefore);
    expect(readCleanupRecord(machine.store)?.attemptCount).toBe(3);
  });

  it('emits exactly one message across ten consecutive failing starts', async () => {
    for (let i = 0; i < 10; i++) await machine.start();

    expect(machine.launchdCalls).toBe(10);
    expect(machine.notifier.calls).toHaveLength(1);
    expect(readCleanupRecord(machine.store)?.attemptCount).toBe(10);
  });

  it('writes a warn line on every failing start, so support can see the history', async () => {
    await machine.start();
    await machine.start();

    const warnings = machine.logger.lines.filter((l) => l.level === 'warn');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.message).toContain('wakeup-cleanup: failed');
    expect(warnings[0]?.message).toContain('attempt=1');
    expect(warnings[1]?.message).toContain('attempt=2');
  });

  describe('the message itself (contract C-07, SC-009)', () => {
    it('names the removal, carries no stack trace and no path', async () => {
      await machine.start();
      const { message } = machine.notifier.calls[0]!;

      expect(message).toContain('Wake-up has been removed');
      expect(message).toContain('manual removal steps');
      expect(message).not.toMatch(/\bat\s+\w+\s+\(/); // stack frame
      expect(message).not.toMatch(/\/Users\/|\/home\/|C:\\/);
      expect(message).not.toContain('launchctl');
    });

    it('carries exactly one action, and choosing it opens the upgrade note', async () => {
      const notifier = new RecordingNotifier();
      notifier.chooseAction = true;
      const store = new FakeMemento();
      const harness = createHarness({
        store,
        notifier,
        fs: emptyFs,
        removers: fixedRemovers('failed', 'launchctl bootout failed: 1')
      });

      await runWakeUpCleanup(harness.deps);

      expect(notifier.calls).toHaveLength(1);
      expect(notifier.calls[0]?.action).toBe(CLEANUP_FAILURE_ACTION);
      expect(harness.upgradeNoteOpens()).toBe(1);
    });

    it('does not open the note when the operator dismisses the message', async () => {
      const harness = createHarness({
        fs: emptyFs,
        removers: fixedRemovers('failed', 'launchctl bootout failed: 1')
      });
      harness.notifier.chooseAction = false;

      await runWakeUpCleanup(harness.deps);

      expect(harness.notifier.calls).toHaveLength(1);
      expect(harness.upgradeNoteOpens()).toBe(0);
    });
  });

  describe('a run that recovers before the operator ever sees a message', () => {
    it('still notifies on the first failure — the message is not deferred', async () => {
      await machine.start();
      expect(machine.notifier.calls).toHaveLength(1);
    });
  });

  describe('a corrupted record re-arms the whole lifecycle', () => {
    it('an unparseable record is treated as absent, so cleanup retries and may notify again', async () => {
      await machine.start();
      expect(machine.notifier.calls).toHaveLength(1);

      // Something wrote garbage over the marker.
      await machine.store.update(CLEANUP_RECORD_KEY, { version: 99, outcome: 'ok' });

      await machine.start();

      // A second message is acceptable here and the alternative is
      // worse: honouring an unreadable marker would strand a live entry.
      expect(machine.notifier.calls).toHaveLength(2);
      expect(readCleanupRecord(machine.store)?.attemptCount).toBe(1);
    });
  });

  it('never writes a scheduler reason into the message', async () => {
    machine.setLaunchd({
      scheduler: 'launchd',
      result: 'failed',
      reason: 'launchctl bootout gui/501/com.schegent.wakeup failed: 1'
    });
    await machine.start();

    expect(machine.notifier.calls[0]?.message).toBe(CLEANUP_FAILURE_MESSAGE);
    // The detail belongs in the runtime log, not on the operator's screen.
    const warn = machine.logger.lines.find((l) => l.level === 'warn');
    expect(warn?.message).toContain('launchctl bootout');
  });
});
