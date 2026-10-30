// Feature 251 (FR-R4-F04, contract T20, SC-010, FR-031, S1 to S4) — the evidence maintenance scheduler,
// on full fake timers and the `Scheduler` shape `lock.ts` uses.
//
// What it pins: one pass when it is armed and one per `EVIDENCE_MAINTENANCE_INTERVAL_MS`; a tick during
// a pass starts nothing and does not queue; an untrusted tick and a non-owner tick never call `runPass`,
// and trust is read before primacy; nothing runs after `dispose()`, including a late completion of a
// pass or of the primacy read; and a failing pass leaves the scheduler armed for the next tick.
//
// Why: the filing's finding (O-17) is that retention ran only at activation and at a Run's end, so an
// idle window kept expired evidence as long as it stayed open. Each "no pass" claim is paired with a
// control in which the same tick, with the gate open, does call `runPass`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { systemScheduler } from '../../../../src/state/lock';
import {
  createEvidenceMaintenanceScheduler,
  EVIDENCE_MAINTENANCE_INTERVAL_MS,
  type EvidenceMaintenanceDeps,
  type EvidenceMaintenanceReport,
  type EvidenceMaintenanceScheduler
} from '../../../../src/services/evidence-maintenance/evidence-maintenance-scheduler';

const EMPTY_REPORT: EvidenceMaintenanceReport = {
  transportFilesRemoved: 0,
  transportFilesCompacted: 0,
  sessionGroupsRemoved: 0,
  sessionBytesRemoved: 0
};

interface Fixture {
  readonly scheduler: EvidenceMaintenanceScheduler;
  readonly runPass: ReturnType<typeof vi.fn<() => Promise<EvidenceMaintenanceReport>>>;
  readonly isTrusted: ReturnType<typeof vi.fn<() => boolean>>;
  readonly hasPrimacy: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  readonly cleared: () => number;
}

/**
 * Arms a scheduler on the system scheduler, whose `setInterval` the fake timers replace.
 *
 * `setup` configures the mocks BEFORE the scheduler is armed, because the first pass starts at arming and
 * reads the gate then.
 */
function arm(
  setup: (mocks: Pick<Fixture, 'runPass' | 'isTrusted' | 'hasPrimacy'>) => void = () => undefined,
  overrides: Partial<EvidenceMaintenanceDeps> = {}
): Fixture {
  const runPass = vi.fn<() => Promise<EvidenceMaintenanceReport>>(async () => EMPTY_REPORT);
  const isTrusted = vi.fn<() => boolean>(() => true);
  const hasPrimacy = vi.fn<() => Promise<boolean>>(async () => true);
  setup({ runPass, isTrusted, hasPrimacy });
  let clearedCount = 0;
  const scheduler = createEvidenceMaintenanceScheduler({
    scheduler: {
      setInterval: (fn, ms) => {
        const handle = systemScheduler.setInterval(fn, ms);
        return {
          clear: () => {
            clearedCount += 1;
            handle.clear();
          }
        };
      }
    },
    isTrusted,
    hasPrimacy,
    runPass,
    ...overrides
  });
  return { scheduler, runPass, isTrusted, hasPrimacy, cleared: () => clearedCount };
}

/** A pass the test settles by hand, so a tick can land while it is in flight. */
function deferredPass(): {
  readonly runPass: () => Promise<EvidenceMaintenanceReport>;
  readonly calls: () => number;
  settle(): void;
} {
  let release: () => void = () => undefined;
  let callCount = 0;
  return {
    runPass: () => {
      callCount += 1;
      return new Promise<EvidenceMaintenanceReport>((resolve) => {
        release = () => resolve(EMPTY_REPORT);
      });
    },
    calls: () => callCount,
    settle: () => release()
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the interval (S1)', () => {
  it('is one hour', () => {
    expect(EVIDENCE_MAINTENANCE_INTERVAL_MS).toBe(3_600_000);
  });

  it('runs one pass when it is armed, and one per interval after', async () => {
    const { runPass, scheduler } = arm();

    await vi.advanceTimersByTimeAsync(0);
    expect(runPass).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(EVIDENCE_MAINTENANCE_INTERVAL_MS - 1);
    expect(runPass).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(runPass).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2 * EVIDENCE_MAINTENANCE_INTERVAL_MS);
    expect(runPass).toHaveBeenCalledTimes(4);
    expect(scheduler.state()).toBe('idle');
  });
});

describe('a tick during a pass (S3)', () => {
  it('starts nothing, does not queue, and the next interval after the pass runs again', async () => {
    const pass = deferredPass();
    const { scheduler } = arm(undefined, { runPass: pass.runPass });

    await vi.advanceTimersByTimeAsync(0);
    expect(pass.calls()).toBe(1);
    expect(scheduler.state()).toBe('in-flight');

    // Three intervals pass while the first pass is still running.
    await vi.advanceTimersByTimeAsync(3 * EVIDENCE_MAINTENANCE_INTERVAL_MS);
    expect(pass.calls(), 'a tick during a pass must not start another').toBe(1);

    pass.settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.state()).toBe('idle');
    expect(pass.calls(), 'the missed ticks are not queued behind the pass').toBe(1);

    await vi.advanceTimersByTimeAsync(EVIDENCE_MAINTENANCE_INTERVAL_MS);
    expect(pass.calls()).toBe(2);
  });
});

describe('the gate per tick (S2)', () => {
  it('does not run an untrusted tick, and does not read primacy for it', async () => {
    const { runPass, isTrusted, hasPrimacy } = arm((mocks) => mocks.isTrusted.mockReturnValue(false));

    await vi.advanceTimersByTimeAsync(2 * EVIDENCE_MAINTENANCE_INTERVAL_MS);

    expect(isTrusted, 'the gate is read each tick').toHaveBeenCalled();
    expect(runPass).not.toHaveBeenCalled();
    expect(hasPrimacy, 'trust is read before primacy').not.toHaveBeenCalled();
  });

  it('does not run a tick for a window that is not the owner', async () => {
    const { runPass, hasPrimacy } = arm((mocks) => mocks.hasPrimacy.mockResolvedValue(false));

    await vi.advanceTimersByTimeAsync(2 * EVIDENCE_MAINTENANCE_INTERVAL_MS);

    expect(hasPrimacy).toHaveBeenCalled();
    expect(runPass).not.toHaveBeenCalled();
  });

  it('runs again as soon as trust and primacy are both held (the control)', async () => {
    const { runPass, isTrusted, hasPrimacy } = arm((mocks) => mocks.isTrusted.mockReturnValue(false));
    await vi.advanceTimersByTimeAsync(EVIDENCE_MAINTENANCE_INTERVAL_MS);
    expect(runPass).not.toHaveBeenCalled();

    isTrusted.mockReturnValue(true);
    hasPrimacy.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(EVIDENCE_MAINTENANCE_INTERVAL_MS);
    expect(runPass).not.toHaveBeenCalled();

    hasPrimacy.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(EVIDENCE_MAINTENANCE_INTERVAL_MS);
    expect(runPass).toHaveBeenCalledTimes(1);
  });

  it('returns to idle when the primacy read fails, and tries again at the next tick', async () => {
    const { runPass, scheduler } = arm((mocks) => mocks.hasPrimacy.mockRejectedValueOnce(new Error('lease read failed')));

    await vi.advanceTimersByTimeAsync(0);
    expect(runPass).not.toHaveBeenCalled();
    expect(scheduler.state()).toBe('idle');

    await vi.advanceTimersByTimeAsync(EVIDENCE_MAINTENANCE_INTERVAL_MS);
    expect(runPass).toHaveBeenCalledTimes(1);
  });
});

describe('disposal (S4)', () => {
  it('clears the interval, so no later tick runs a pass', async () => {
    const { runPass, scheduler, cleared } = arm();
    await vi.advanceTimersByTimeAsync(0);
    expect(runPass).toHaveBeenCalledTimes(1);

    scheduler.dispose();
    expect(scheduler.state()).toBe('disposed');
    expect(cleared()).toBe(1);

    await vi.advanceTimersByTimeAsync(5 * EVIDENCE_MAINTENANCE_INTERVAL_MS);
    expect(runPass).toHaveBeenCalledTimes(1);
  });

  it('lets a pass in flight finish, and its completion starts nothing', async () => {
    const pass = deferredPass();
    const { scheduler } = arm(undefined, { runPass: pass.runPass });
    await vi.advanceTimersByTimeAsync(0);
    expect(pass.calls()).toBe(1);

    scheduler.dispose();
    pass.settle();
    await vi.advanceTimersByTimeAsync(2 * EVIDENCE_MAINTENANCE_INTERVAL_MS);

    expect(scheduler.state()).toBe('disposed');
    expect(pass.calls()).toBe(1);
  });

  it('does not run a pass whose primacy read completes after disposal', async () => {
    let answer: (owner: boolean) => void = () => undefined;
    const { runPass, scheduler, hasPrimacy } = arm((mocks) =>
      mocks.hasPrimacy.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          })
      )
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(hasPrimacy, 'the primacy read is pending').toHaveBeenCalled();

    scheduler.dispose();
    answer(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(runPass).not.toHaveBeenCalled();
  });

  it('is safe to call twice', () => {
    const { scheduler, cleared } = arm();
    scheduler.dispose();
    scheduler.dispose();
    expect(cleared()).toBe(1);
  });
});

describe('a failing pass', () => {
  it('is survived: the scheduler returns to idle and the next tick runs a pass', async () => {
    const { runPass, scheduler } = arm((mocks) => mocks.runPass.mockRejectedValueOnce(new Error('the pass failed')));

    await vi.advanceTimersByTimeAsync(0);
    expect(runPass).toHaveBeenCalledTimes(1);
    expect(scheduler.state()).toBe('idle');

    await vi.advanceTimersByTimeAsync(EVIDENCE_MAINTENANCE_INTERVAL_MS);
    expect(runPass).toHaveBeenCalledTimes(2);
  });
});
