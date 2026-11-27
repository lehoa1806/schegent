import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RetryCoordinator,
  type DeadlineTimer,
  type RetryCoordinatorDeps
} from '../../../src/services/retry-coordinator';
import type { UnattendedWakeup } from '../../../src/services/unattended-eligibility';

/**
 * Feature 093 (T045) — per-queue delayed-retry deadlines, and FR-R4-F02 (spec 240, US2; contract U5
 * G16 to G20; FR-007 to FR-010) — on the coordinator's OWN timer.
 *
 * REWRITTEN BY FEATURE 240. The deadlines used to be multiplexed onto the credit watchdog's one
 * `setTimeout` through `pauseAndPoll`, so a delayed retry and a credit poll shared a handle, a
 * `skipStatusCheck` flag crossed between them, and the watchdog's `polling` guard dropped a second
 * fire while the first resume was still running. The coordinator now arms a `DeadlineTimer` of its
 * own for the earliest entry, and a fire hands each claimed queue to `onBackoffElapsed` as a
 * `backoff-elapsed` wakeup without awaiting it. These cases keep what the earlier ones pinned (N
 * logical deadlines on one physical handle, and FR-024's addressing: a lifecycle control affects only
 * the queue it names), restated against the timer, and add the contract's.
 */

const NOW = 1_000_000;

interface Handle {
  readonly at: number;
  readonly fn: () => void;
  cleared: boolean;
  fired: boolean;
}

/** A timer double on the test's clock: it fires only when the clock is advanced to its time. */
class FakeDeadlineTimer implements DeadlineTimer {
  public readonly handles: Handle[] = [];
  constructor(private readonly clock: { now: number }) {}

  set(fn: () => void, delayMs: number): { clear(): void } {
    const handle: Handle = { at: this.clock.now + delayMs, fn, cleared: false, fired: false };
    this.handles.push(handle);
    return {
      clear: () => {
        handle.cleared = true;
      }
    };
  }

  /** The handles that are armed right now, earliest first. */
  armed(): Handle[] {
    return this.handles.filter((h) => !h.cleared && !h.fired).sort((a, b) => a.at - b.at);
  }

  /** The delays the armed handles will fire after, relative to the clock. */
  armedIn(): number[] {
    return this.armed().map((h) => h.at - this.clock.now);
  }

  advance(ms: number): void {
    this.clock.now += ms;
    for (;;) {
      const due = this.armed().find((h) => h.at <= this.clock.now);
      if (due === undefined) return;
      due.fired = true;
      due.fn();
    }
  }
}

let clock: { now: number };
let timer: FakeDeadlineTimer;
let wakeups: UnattendedWakeup[];
let warnCalls: string[];

function makeCoordinator(
  opts: { onBackoffElapsed?: (w: UnattendedWakeup) => unknown } = {}
): RetryCoordinator {
  const deps = {
    store: {} as RetryCoordinatorDeps['store'],
    queue: {} as RetryCoordinatorDeps['queue'],
    statusBar: { update: vi.fn() } as unknown as RetryCoordinatorDeps['statusBar'],
    notifier: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as unknown as RetryCoordinatorDeps['notifier'],
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn((msg: string) => {
        warnCalls.push(msg);
      }),
      error: vi.fn()
    } as unknown as RetryCoordinatorDeps['logger'],
    auditWriter: null as unknown as RetryCoordinatorDeps['auditWriter'],
    getRetryCap: () => 3,
    persistTransition: async (_prev: never, next: never) => next,
    clock: () => clock.now,
    timer,
    onBackoffElapsed:
      opts.onBackoffElapsed ??
      ((w: UnattendedWakeup) => {
        wakeups.push(w);
      })
  } as unknown as RetryCoordinatorDeps;
  return new RetryCoordinator(deps);
}

beforeEach(() => {
  clock = { now: NOW };
  timer = new FakeDeadlineTimer(clock);
  wakeups = [];
  warnCalls = [];
});

describe('RetryCoordinator — per-queue delayed-retry deadlines on its own timer (U5 G16)', () => {
  describe('armDelayedRetry', () => {
    it('arms one timer for a single queue, at its delay', async () => {
      const coordinator = makeCoordinator();

      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 60_000);

      expect(timer.armedIn()).toEqual([60_000]);
      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(true);
    });

    it('keeps the earlier deadline armed when a later one is added', async () => {
      const coordinator = makeCoordinator();

      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 60_000);
      await coordinator.armDelayedRetry('queue-b', 'transient_error', 600_000);

      // B is later, so the one physical timer stays pointed at A.
      expect(timer.armedIn()).toEqual([60_000]);
      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(true);
      expect(coordinator.hasPendingDelayedRetry('queue-b')).toBe(true);
    });

    it('re-points the timer when a shorter deadline arrives, and never leaves two armed', async () => {
      const coordinator = makeCoordinator();

      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 600_000);
      await coordinator.armDelayedRetry('queue-b', 'transient_error', 30_000);

      expect(timer.armedIn()).toEqual([30_000]);
      // A is still owed its retry; it is simply not the one armed right now.
      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(true);
    });

    it('records the deadline with no watchdog anywhere: it is the coordinator\'s own timer', async () => {
      const coordinator = makeCoordinator();

      await coordinator.armDelayedRetry('queue-a', 'transient_error', 60_000);

      expect(warnCalls).toEqual([]);
      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(true);
    });
  });

  describe('a fire (G17, G20)', () => {
    it('claims only entries whose time has come, and calls onBackoffElapsed once per claimed queue', async () => {
      const coordinator = makeCoordinator();
      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 30_000);
      await coordinator.armDelayedRetry('queue-b', 'transient_error', 600_000);

      timer.advance(30_000);

      expect(wakeups).toEqual([{ cause: 'backoff-elapsed', queueId: 'queue-a', deadline: NOW + 30_000 }]);
      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(false);
      // B is mid-backoff: A's fire does not resume it.
      expect(coordinator.hasPendingDelayedRetry('queue-b')).toBe(true);
    });

    it('re-arms the earliest remaining deadline before returning', async () => {
      const coordinator = makeCoordinator();
      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 30_000);
      await coordinator.armDelayedRetry('queue-b', 'transient_error', 600_000);

      timer.advance(30_000);

      expect(timer.armedIn()).toEqual([570_000]);
    });

    it('calls onBackoffElapsed in deadline order when several deadlines have elapsed', async () => {
      const coordinator = makeCoordinator();
      await coordinator.armDelayedRetry('queue-late', 'rate_limit', 20_000);
      await coordinator.armDelayedRetry('queue-early', 'transient_error', 10_000);
      await coordinator.armDelayedRetry('queue-last', 'rate_limit', 30_000);

      timer.advance(60_000);

      expect(wakeups.map((w) => w.queueId)).toEqual(['queue-early', 'queue-late', 'queue-last']);
    });

    it('never awaits a Run: a callback that never settles does not hold the fire, and the next deadline still fires', async () => {
      const stuck = new Promise<void>(() => undefined);
      const calls: string[] = [];
      const coordinator = makeCoordinator({
        onBackoffElapsed: (w) => {
          calls.push(w.queueId);
          return stuck;
        }
      });
      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 10_000);
      await coordinator.armDelayedRetry('queue-b', 'rate_limit', 20_000);

      timer.advance(10_000);
      timer.advance(10_000);

      expect(calls).toEqual(['queue-a', 'queue-b']);
    });

    it('fires each deadline once, at or after its time, never early', async () => {
      const coordinator = makeCoordinator();
      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 30_000);

      timer.advance(29_999);
      expect(wakeups).toEqual([]);
      timer.advance(1);
      expect(wakeups).toHaveLength(1);
      timer.advance(120_000);
      expect(wakeups).toHaveLength(1);
    });

    it('a timer that fires before the clock has reached the deadline claims nothing and re-arms for the rest', async () => {
      const coordinator = makeCoordinator();
      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 30_000);
      const early = timer.armed()[0]!;

      // The platform timer woke early; the clock still reads before the deadline.
      early.fired = true;
      early.fn();

      expect(wakeups).toEqual([]);
      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(true);
      expect(timer.armedIn()).toEqual([30_000]);
    });

    it('observes a callback that rejects, logs one line with no error text, and keeps the later deadline armed', async () => {
      const coordinator = makeCoordinator({
        onBackoffElapsed: () => Promise.reject(new Error('secret failure text'))
      });
      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 10_000);
      await coordinator.armDelayedRetry('queue-b', 'rate_limit', 90_000);

      timer.advance(10_000);
      await new Promise((resolve) => setImmediate(resolve));

      expect(timer.armedIn()).toEqual([80_000]);
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0]).not.toContain('secret failure text');
    });

    it('survives a callback that throws synchronously', async () => {
      const coordinator = makeCoordinator({
        onBackoffElapsed: () => {
          throw new Error('boom');
        }
      });
      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 10_000);
      await coordinator.armDelayedRetry('queue-b', 'rate_limit', 20_000);

      expect(() => timer.advance(10_000)).not.toThrow();
      expect(timer.armedIn()).toEqual([10_000]);
    });
  });

  describe('re-arming (G18)', () => {
    it('after every armDelayedRetry the armed handle is the minimum of the map', async () => {
      const coordinator = makeCoordinator();
      for (const [queue, delay] of [['a', 500_000], ['b', 200_000], ['c', 800_000], ['d', 100_000]] as const) {
        await coordinator.armDelayedRetry(`queue-${queue}`, 'rate_limit', delay);
      }
      expect(timer.armedIn()).toEqual([100_000]);
    });

    it('after a cancel it points at the next-earliest, or is cleared when the map is empty', async () => {
      const coordinator = makeCoordinator();
      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 30_000);
      await coordinator.armDelayedRetry('queue-b', 'transient_error', 600_000);

      coordinator.cancelPendingTimer('queue-a');
      expect(timer.armedIn()).toEqual([600_000]);

      coordinator.cancelPendingTimer('queue-b');
      expect(timer.armedIn()).toEqual([]);
    });

    it('after a reported admission outcome it recomputes the earliest remaining deadline', async () => {
      const coordinator = makeCoordinator();
      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 30_000);
      // Lose the armed handle, as a refused admission or a failed resume could leave it.
      timer.armed()[0]!.cleared = true;
      expect(timer.armedIn()).toEqual([]);

      coordinator.noteAdmissionOutcome();

      expect(timer.armedIn()).toEqual([30_000]);
    });
  });

  describe('cancelPendingTimer (G19)', () => {
    it('drops only the named queue and re-arms the next-earliest (FR-024), synchronously', async () => {
      const coordinator = makeCoordinator();
      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 30_000);
      await coordinator.armDelayedRetry('queue-b', 'transient_error', 600_000);

      const returned = coordinator.cancelPendingTimer('queue-a');

      expect(returned).toBeUndefined();
      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(false);
      expect(coordinator.hasPendingDelayedRetry('queue-b')).toBe(true);
      expect(timer.armedIn()).toEqual([600_000]);
    });

    it('leaves the armed deadline alone when a queue with no deadline cancels', async () => {
      const coordinator = makeCoordinator();
      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 30_000);
      const before = timer.armed()[0];

      coordinator.cancelPendingTimer('queue-c');

      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(true);
      expect(timer.armed()[0]).toBe(before);
    });

    it('a canceled queue never fires, and a sibling still does', async () => {
      const coordinator = makeCoordinator();
      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 10_000);
      await coordinator.armDelayedRetry('queue-b', 'rate_limit', 20_000);

      coordinator.cancelPendingTimer('queue-a');
      timer.advance(60_000);

      expect(wakeups.map((w) => w.queueId)).toEqual(['queue-b']);
    });

    it('clears every deadline in the window-wide form', async () => {
      const coordinator = makeCoordinator();
      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 30_000);
      await coordinator.armDelayedRetry('queue-b', 'transient_error', 600_000);

      coordinator.cancelPendingTimer();

      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(false);
      expect(coordinator.hasPendingDelayedRetry('queue-b')).toBe(false);
      expect(timer.armedIn()).toEqual([]);
    });
  });

  describe('claimElapsedDelayedRetries', () => {
    it('returns only the queues whose deadline has passed and re-arms the rest', async () => {
      const coordinator = makeCoordinator();
      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 30_000);
      await coordinator.armDelayedRetry('queue-b', 'transient_error', 600_000);

      clock.now += 30_000;
      const due = coordinator.claimElapsedDelayedRetries();

      expect(due).toEqual(['queue-a']);
      expect(coordinator.hasPendingDelayedRetry('queue-b')).toBe(true);
      expect(timer.armedIn()).toEqual([570_000]);
    });

    it('returns an empty list when nothing is due', async () => {
      const coordinator = makeCoordinator();
      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 30_000);

      expect(coordinator.claimElapsedDelayedRetries()).toEqual([]);
      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(true);
    });
  });

  describe('resumeExistingFromActivation (U2 G6)', () => {
    it('re-arms each crashed Run against its own queue', async () => {
      const coordinator = makeCoordinator();

      await coordinator.resumeExistingFromActivation('queue-a', {
        id: 'run-a',
        pendingRetryAt: clock.now + 30_000,
        pendingRetryCause: 'rate_limit'
      } as never);
      await coordinator.resumeExistingFromActivation('queue-b', {
        id: 'run-b',
        pendingRetryAt: clock.now + 600_000,
        pendingRetryCause: 'transient_error'
      } as never);

      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(true);
      expect(coordinator.hasPendingDelayedRetry('queue-b')).toBe(true);
      expect(wakeups).toEqual([]);
    });

    it('an elapsed persisted deadline becomes a backoff-elapsed wakeup, not a direct resume', async () => {
      const coordinator = makeCoordinator();

      await coordinator.resumeExistingFromActivation('queue-a', {
        id: 'run-a',
        pendingRetryAt: clock.now - 1,
        pendingRetryCause: 'rate_limit'
      } as never);

      expect(wakeups).toEqual([{ cause: 'backoff-elapsed', queueId: 'queue-a', deadline: clock.now - 1 }]);
      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(false);
    });

    it('ignores a Run with no delayed retry', async () => {
      const coordinator = makeCoordinator();

      await coordinator.resumeExistingFromActivation('queue-a', {
        id: 'run-a',
        pendingRetryAt: null,
        pendingRetryCause: null
      } as never);

      expect(wakeups).toEqual([]);
      expect(timer.armedIn()).toEqual([]);
    });
  });
});
