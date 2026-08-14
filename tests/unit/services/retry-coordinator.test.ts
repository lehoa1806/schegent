import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RetryCoordinator, type RetryCoordinatorDeps } from '../../../src/services/retry-coordinator';
import type { DelayedRetryWatchdog } from '../../../src/controller/retry-handler';

/**
 * Feature 093 (T045) — per-queue delayed-retry deadlines.
 *
 * `CreditWatchdog` holds one `setTimeout`, because credits are an account-level
 * resource with one `/status` to poll. A delayed retry is one Run's backoff, and
 * before this feature the two were the same object because a window could only
 * run one Run. These tests pin the multiplexing that keeps N logical deadlines
 * from collapsing onto that one physical handle, and pin the addressing that
 * FR-024 requires: a lifecycle control affects only the queue it names.
 */

interface PauseCall {
  cause: string;
  durationOverrideMs?: number;
  skipStatusCheck?: boolean;
}

let now: number;
let pauseCalls: PauseCall[];
let cancelCalls: number;
let warnCalls: string[];

function makeWatchdog(): DelayedRetryWatchdog {
  return {
    pauseAndPoll: vi.fn(async (cause: string, options?: Record<string, unknown>) => {
      pauseCalls.push({ cause, ...options } as PauseCall);
    }),
    cancelPendingTimer: vi.fn(() => {
      cancelCalls += 1;
    })
  } as unknown as DelayedRetryWatchdog;
}

function makeCoordinator(
  opts: { watchdog?: DelayedRetryWatchdog | null } = {}
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
    clock: () => now,
    watchdog: opts.watchdog === undefined ? makeWatchdog() : opts.watchdog
  } as unknown as RetryCoordinatorDeps;
  return new RetryCoordinator(deps);
}

beforeEach(() => {
  now = 1_000_000;
  pauseCalls = [];
  cancelCalls = 0;
  warnCalls = [];
});

describe('RetryCoordinator — per-queue delayed-retry deadlines (Feature 093 T045)', () => {
  describe('armDelayedRetry', () => {
    it('arms the watchdog for a single queue exactly as the pre-feature path did', async () => {
      const coordinator = makeCoordinator();

      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 60_000);

      expect(pauseCalls).toHaveLength(1);
      expect(pauseCalls[0]).toMatchObject({
        cause: 'rate_limit',
        durationOverrideMs: 60_000,
        skipStatusCheck: true
      });
      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(true);
    });

    it('keeps the earlier deadline armed when a later one is added', async () => {
      const coordinator = makeCoordinator();

      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 60_000);
      await coordinator.armDelayedRetry('queue-b', 'transient_error', 600_000);

      // B is later, so the physical timer stays pointed at A — one extra
      // pauseAndPoll here would have re-armed the shared handle for B and
      // silently discarded A's deadline.
      expect(pauseCalls).toHaveLength(1);
      expect(pauseCalls[0].durationOverrideMs).toBe(60_000);
      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(true);
      expect(coordinator.hasPendingDelayedRetry('queue-b')).toBe(true);
    });

    it('re-points the timer when a shorter deadline arrives', async () => {
      const coordinator = makeCoordinator();

      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 600_000);
      await coordinator.armDelayedRetry('queue-b', 'transient_error', 30_000);

      expect(pauseCalls).toHaveLength(2);
      expect(pauseCalls[1]).toMatchObject({
        cause: 'transient_error',
        durationOverrideMs: 30_000
      });
      // A is still owed its retry; it is simply not the one armed right now.
      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(true);
    });

    it('warns and records nothing when the watchdog is not yet wired', async () => {
      const coordinator = makeCoordinator({ watchdog: null });

      await coordinator.armDelayedRetry('queue-a', 'transient_error', 60_000);

      expect(pauseCalls).toHaveLength(0);
      expect(warnCalls.some((m) => m.includes('watchdog not wired'))).toBe(true);
      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(false);
    });
  });

  describe('cancelPendingTimer', () => {
    it('drops only the named queue and re-arms the next-earliest (FR-024)', async () => {
      const coordinator = makeCoordinator();
      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 30_000);
      await coordinator.armDelayedRetry('queue-b', 'transient_error', 600_000);
      pauseCalls.length = 0;

      coordinator.cancelPendingTimer('queue-a');
      await Promise.resolve();
      await Promise.resolve();

      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(false);
      // B still has a retry coming, and it is now the armed one — before the
      // split, cancelling A cleared the window's only timer and B's retry was
      // never going to fire.
      expect(coordinator.hasPendingDelayedRetry('queue-b')).toBe(true);
      expect(pauseCalls).toHaveLength(1);
      expect(pauseCalls[0].durationOverrideMs).toBe(600_000);
    });

    it('leaves the armed deadline alone when a queue with no deadline cancels', async () => {
      const coordinator = makeCoordinator();
      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 30_000);
      pauseCalls.length = 0;

      coordinator.cancelPendingTimer('queue-c');
      await Promise.resolve();

      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(true);
      expect(cancelCalls).toBe(0);
      expect(pauseCalls).toHaveLength(0);
    });

    it('clears every deadline in the window-wide form', async () => {
      const coordinator = makeCoordinator();
      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 30_000);
      await coordinator.armDelayedRetry('queue-b', 'transient_error', 600_000);

      coordinator.cancelPendingTimer();

      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(false);
      expect(coordinator.hasPendingDelayedRetry('queue-b')).toBe(false);
      expect(cancelCalls).toBe(1);
    });
  });

  describe('claimElapsedDelayedRetries', () => {
    it('returns only the queues whose deadline has passed and re-arms the rest', async () => {
      const coordinator = makeCoordinator();
      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 30_000);
      await coordinator.armDelayedRetry('queue-b', 'transient_error', 600_000);
      pauseCalls.length = 0;

      now += 30_000;
      const due = coordinator.claimElapsedDelayedRetries();
      await Promise.resolve();
      await Promise.resolve();

      expect(due).toEqual(['queue-a']);
      // B is mid-backoff. The watchdog's resume callback is window-level, so
      // without this filter B would be resumed by A's fire.
      expect(coordinator.hasPendingDelayedRetry('queue-b')).toBe(true);
      expect(pauseCalls).toHaveLength(1);
      expect(pauseCalls[0].durationOverrideMs).toBe(570_000);
    });

    it('returns an empty list when nothing is due', async () => {
      const coordinator = makeCoordinator();
      await coordinator.armDelayedRetry('queue-a', 'rate_limit', 30_000);

      expect(coordinator.claimElapsedDelayedRetries()).toEqual([]);
      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(true);
    });
  });

  describe('resumeExistingFromActivation', () => {
    it('re-arms each crashed Run against its own queue', async () => {
      const coordinator = makeCoordinator();
      const resume = vi.fn(async () => {});

      await coordinator.resumeExistingFromActivation(
        'queue-a',
        { id: 'run-a', pendingRetryAt: now + 30_000, pendingRetryCause: 'rate_limit' } as never,
        resume
      );
      await coordinator.resumeExistingFromActivation(
        'queue-b',
        { id: 'run-b', pendingRetryAt: now + 600_000, pendingRetryCause: 'transient_error' } as never,
        resume
      );

      // Both deadlines survive the sweep. Keyed by nothing, the second read
      // would have been the only one left.
      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(true);
      expect(coordinator.hasPendingDelayedRetry('queue-b')).toBe(true);
      expect(resume).not.toHaveBeenCalled();
    });

    it('resumes immediately when the persisted deadline has already passed', async () => {
      const coordinator = makeCoordinator();
      const resume = vi.fn(async () => {});

      await coordinator.resumeExistingFromActivation(
        'queue-a',
        { id: 'run-a', pendingRetryAt: now - 1, pendingRetryCause: 'rate_limit' } as never,
        resume
      );
      await new Promise((r) => setImmediate(r));

      expect(resume).toHaveBeenCalledTimes(1);
      expect(coordinator.hasPendingDelayedRetry('queue-a')).toBe(false);
    });
  });
});
