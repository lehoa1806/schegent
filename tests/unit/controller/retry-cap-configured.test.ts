// Feature 056 Track 4 (FR-023..FR-026, T036) — Regression tests pinning
// the configured retry-cap window.
//
// The `schegent.retry.maxAttempts` setting is now bounded by
// [1, DELAYED_RETRY_CAP] = [1, 5] across:
//   - package.json contribution metadata.
//   - Host validator (`KEY_SPECS['retry.maxAttempts'].max`).
//   - `extension.ts` `getRetryCap` accessor (the runtime sieve).
//
// `RetryHandler.handleDelayedRetry` reads the dynamic cap via
// `deps.getRetryCap`; the FR-006 invariant — the cap-th failure trips
// queue pause — is honored for every cap in [1, 5].

import { describe, it, expect, vi } from 'vitest';
import { RetryHandler } from '../../../src/controller/retry-handler';
import type { WorkflowRun, PhaseResult } from '../../../src/state/workflow-run';
import { SanitizedLogger } from '../../../src/lib/logger';

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  const base: WorkflowRun = {
    id: 'run-1',
    featureId: 'feat-1',
    featureDir: '/tmp/feat-1',
    status: 'running',
    pipeline: {
      id: 'speckit-new-feature',
      name: 'speckit-new-feature',
      phases: []
    },
    phaseOverrides: [],
    currentPhase: 'specify',
    currentIteration: 1,
    startedAt: Date.now(),
    lastTransitionAt: Date.now(),
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null
  };
  return { ...base, ...overrides };
}

function failedPhase(): PhaseResult {
  return {
    phase: 'specify',
    iteration: 1,
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    result: 'failed',
    terminationReason: 'rate_limit',
    exitCode: 1,
    stdoutSummary: '',
    stderrSummary: '',
    auditEntryId: null
  };
}

interface FakeStore {
  setRun: ReturnType<typeof vi.fn>;
  applyDelayedRetryPause?: ReturnType<typeof vi.fn>;
}

interface CallSpy {
  queuePauseCalled: boolean;
  scheduledCount: number;
}

function makeDeps(retryCap: number, spy: CallSpy) {
  const persistTransition = vi.fn(async (_p: WorkflowRun, n: WorkflowRun) => n);
  const setQueuePausedState = vi.fn(async () => {
    spy.queuePauseCalled = true;
  });
  const pause = vi.fn(async () => {});
  return {
    store: {
      setRun: vi.fn(async () => {})
    } as unknown as FakeStore,
    queue: {
      setQueuePausedState,
      pause
    } as unknown as never,
    statusBar: { update: vi.fn() } as unknown as never,
    notifier: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as unknown as never,
    logger: new SanitizedLogger(),
    getWatchdog: () => ({
      pauseAndPoll: vi.fn(async () => {
        spy.scheduledCount++;
      }),
      cancelPendingTimer: vi.fn()
    }),
    auditWriter: { append: vi.fn() },
    getRetryCap: () => retryCap,
    persistTransition
  };
}

describe('Feature 056 Track 4 — configured retry cap honored across the [1, 5] window', () => {
  for (const cap of [1, 2, 3, 4, 5]) {
    it(`cap=${cap}: the ${cap}th failure trips queue-pause-and-fail (FR-024)`, async () => {
      const spy: CallSpy = { queuePauseCalled: false, scheduledCount: 0 };
      // `delayedRetryCount` starts at `cap - 1` so the next failure is
      // the cap-th attempt: handleDelayedRetry must take the
      // scheduleQueuePauseAndFail branch and never schedule a retry.
      const run = makeRun({ delayedRetryCount: cap - 1 });
      const deps = makeDeps(cap, spy);
      const handler = new RetryHandler(deps as never);
      await handler.handleDelayedRetry(run, 1, failedPhase(), 'rate_limit', null, null);
      expect(spy.queuePauseCalled).toBe(true);
      expect(spy.scheduledCount).toBe(0);
    });

    it(`cap=${cap}: the (${cap}-1)th failure schedules a delayed retry (FR-024)`, async () => {
      if (cap === 1) return; // No "below cap" failure exists for cap=1.
      const spy: CallSpy = { queuePauseCalled: false, scheduledCount: 0 };
      const run = makeRun({ delayedRetryCount: cap - 2 });
      const deps = makeDeps(cap, spy);
      const handler = new RetryHandler(deps as never);
      await handler.handleDelayedRetry(run, 1, failedPhase(), 'rate_limit', null, null);
      expect(spy.queuePauseCalled).toBe(false);
      expect(spy.scheduledCount).toBe(1);
    });
  }
});
