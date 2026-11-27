import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  wireScheduledWork,
  type ScheduledWorkWiring,
  type ScheduledWorkWiringDeps
} from '../../../src/activation/scheduled-work-wiring';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { RawInvocationOutput } from '../../../src/runner/invocation-result';
import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';
import type { BackoffWakeup } from '../../../src/services/retry-coordinator';
import type { UnattendedAdmitOutcome } from '../../../src/services/unattended-admission';
import type { UnattendedWakeup } from '../../../src/services/unattended-eligibility';

/**
 * FR-R3-192 (T1863, FR-003, FR-007) and FR-R4-F02 (spec 240, US1; contract U2 G5) — paths 3 and 4:
 * the credit watchdog's backoff-elapsed and credits-restored arms, which both call the one
 * `onResume` sweep.
 *
 * REWRITTEN BY FEATURE 240. The sweep used to resume EVERY key of the Run map that had no pending
 * delayed retry, so these cases asserted that it resumed whatever it found. It now hands each wakeup
 * to the unattended admission service, which selects with the pure eligibility decision, so each
 * case below asserts WHICH queues are admitted and for what wakeup: a claimed elapsed deadline is
 * admitted for `backoff-elapsed` and nothing else is; a credits poll admits the queues whose Run is
 * eligible for a credits wakeup and leaves every other Run alone. The announcement the sweep used to
 * make moved with the admission to `SchegentWorkflowController.admitResume` (it speaks once an
 * unattended resume is admitted), and is asserted in
 * `tests/unit/controller/admit-resume-unattended-recheck.test.ts`.
 *
 * Driven through `wireScheduledWork(deps)` and the real `CreditWatchdog` it returns, under fake
 * timers. `setImmediate` is left real so the cases can let pending work settle. The controller is a
 * double that records the admissions the service makes through `admitUnattended`.
 */

const TEST_ENV_POLICY = { mode: 'inherit', inheritProcessEnv: true } as const;
const POLL_INTERVAL_MINUTES = 30;
const NOW = 1_700_000_000_000;

interface FakeRun {
  readonly id: string;
  readonly status: string;
  readonly manualPauseCause: string | null;
  readonly pendingRetryAt: number | null;
  readonly pendingRetryCause: string | null;
  readonly creditPause: { pausedAt: number; windowStartedAt: number | null; stoppedAt: number | null } | null;
}

const creditPaused = (): FakeRun => ({
  id: 'run-credit',
  status: 'paused',
  manualPauseCause: null,
  pendingRetryAt: null,
  pendingRetryCause: null,
  creditPause: { pausedAt: NOW - 5_000, windowStartedAt: NOW - 4_000, stoppedAt: null }
});

const backoffElapsedRun = (): FakeRun => ({
  ...creditPaused(),
  id: 'run-backoff',
  creditPause: null,
  pendingRetryAt: NOW - 1_000,
  pendingRetryCause: 'rate_limit'
});

interface Harness {
  readonly wiring: ScheduledWorkWiring;
  readonly admitUnattended: ReturnType<typeof vi.fn>;
  /** The retry coordinator's elapsed-deadline hand-off: what the wiring bound with `setBackoffElapsedHandler`. */
  readonly fireBackoffElapsed: () => Promise<void>;
}

const settle = (): Promise<void> => new Promise((done) => setImmediate(done));

function statusOk(): RawInvocationOutput {
  const stdoutBuffer = new ZippedStreamBuffer();
  stdoutBuffer.append('status: ok');
  stdoutBuffer.finalize();
  const stderrBuffer = new ZippedStreamBuffer();
  stderrBuffer.finalize();
  return { stdoutBuffer, stderrBuffer, exitCode: 0, killed: false, timedOut: false, durationMs: 1 };
}

function harness(options: {
  runs: Record<string, FakeRun>;
  /** The queues whose delayed-retry deadline elapses when the retry coordinator's timer fires. */
  claimed?: readonly string[];
  primary?: boolean;
  outcome?: UnattendedAdmitOutcome;
}): Harness {
  const outcome = options.outcome ?? 'admitted';
  const admitUnattended = vi.fn(
    async (_queueId: string, _wakeup: UnattendedWakeup): Promise<UnattendedAdmitOutcome> => outcome
  );
  let backoffHandler: ((wakeup: BackoffWakeup) => unknown) | null = null;

  let watchdogState = {
    paused: false,
    pausedSince: null,
    nextPollAt: null,
    pollIntervalMs: POLL_INTERVAL_MINUTES * 60 * 1000,
    lastStatusOk: null,
    cause: null
  } as Record<string, unknown>;
  const store = {
    getRunMap: () => options.runs,
    getRun: (queueId: string) => options.runs[queueId] ?? null,
    getWatchdog: () => watchdogState,
    setWatchdog: async (next: Record<string, unknown>) => {
      watchdogState = next;
    },
    getQueueStates: () => []
  };
  const controller = {
    drainQueuedWork: vi.fn(async () => undefined),
    admitUnattended,
    onDrainSweepEnd: vi.fn(),
    setBackoffElapsedHandler: vi.fn((handler: (wakeup: BackoffWakeup) => unknown) => {
      backoffHandler = handler;
    }),
    setGuardedRunService: vi.fn(),
    setRateLimitHandler: vi.fn()
  };
  const runner = { invoke: vi.fn(async () => statusOk()) };

  const deps = {
    workspaceRoot: '/workspace',
    cliPath: 'claude',
    logger: new SanitizedLogger(),
    store,
    queue: { setScheduledStartCancelHook: vi.fn(), setLifecycleAuditHook: vi.fn() },
    controller,
    auditWriter: { append: vi.fn(async () => undefined) },
    notifier: { info: vi.fn(), warn: vi.fn(async () => undefined), error: vi.fn() },
    statusBar: { update: vi.fn(), updateWindow: vi.fn(), showTransient: vi.fn(), dispose: vi.fn() },
    lock: {
      hasPrimacy: vi.fn(async () => options.primary ?? true),
      isForeignLockHeld: vi.fn(async () => false)
    },
    guardedRunService: {},
    runnerRegistry: { getOrCreate: () => runner },
    catalogSession: { catalog: { pipelinesById: new Map([['pipeline', {}]]) } },
    backendKind: 'claude',
    pollIntervalMinutes: POLL_INTERVAL_MINUTES,
    processEnvironmentPolicy: TEST_ENV_POLICY
  } as unknown as ScheduledWorkWiringDeps;

  const wiring = wireScheduledWork(deps);
  const fireBackoffElapsed = async (): Promise<void> => {
    for (const queueId of options.claimed ?? []) {
      await backoffHandler?.({ cause: 'backoff-elapsed', queueId, deadline: NOW - 1_000 });
    }
  };
  return { wiring, admitUnattended, fireBackoffElapsed };
}

describe('FR-R3-192 / FR-R4-F02 — paths 3 and 4, the watchdog resume sweep', () => {
  let active: Harness | null = null;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    active?.wiring.watchdog.dispose();
    active?.wiring.queueScheduleWatchdog.dispose();
    active = null;
    vi.useRealTimers();
  });

  const backoffElapsed = (h: Harness): Promise<void> => h.fireBackoffElapsed();

  const creditsRestored = async (h: Harness): Promise<void> => {
    await h.wiring.watchdog.pauseAndPoll('rate-limit');
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MINUTES * 60 * 1000 + 100);
  };

  it('admits the claimed queue for a backoff-elapsed wakeup when a backoff elapses, and no other queue', async () => {
    const h = (active = harness({
      runs: { 'backoff-queue': backoffElapsedRun(), 'credit-queue': creditPaused() },
      claimed: ['backoff-queue']
    }));
    await backoffElapsed(h);
    await vi.waitFor(() => expect(h.admitUnattended).toHaveBeenCalledTimes(1));

    expect(h.admitUnattended).toHaveBeenCalledWith(
      'backoff-queue',
      expect.objectContaining({ cause: 'backoff-elapsed', queueId: 'backoff-queue' })
    );
  });

  it('admits each queue eligible for credits, and leaves every other Run alone, when the credit poll finds credits restored', async () => {
    const h = (active = harness({
      runs: {
        'credit-queue': creditPaused(),
        'failed-queue': { ...creditPaused(), id: 'run-failed', status: 'failed', creditPause: null },
        'operator-queue': { ...creditPaused(), id: 'run-op', creditPause: null, manualPauseCause: 'operator-paused' },
        'cap-queue': { ...creditPaused(), id: 'run-cap', creditPause: null }
      }
    }));
    await creditsRestored(h);
    await vi.waitFor(() => expect(h.admitUnattended).toHaveBeenCalledTimes(1));
    await settle();

    expect(h.admitUnattended).toHaveBeenCalledTimes(1);
    expect(h.admitUnattended).toHaveBeenCalledWith(
      'credit-queue',
      expect.objectContaining({ cause: 'credits-restored', queueId: 'credit-queue' })
    );
  });

  it('admits nothing for a queue whose own delayed retry is still pending, on a credits poll', async () => {
    const h = (active = harness({
      runs: {
        'waiting-queue': { ...backoffElapsedRun(), pendingRetryAt: NOW + 3_600_000 }
      }
    }));
    await creditsRestored(h);
    await settle();

    expect(h.admitUnattended).not.toHaveBeenCalled();
  });

  it('asks for the claimed queue once and does nothing further when admission refuses it', async () => {
    const h = (active = harness({
      runs: { 'backoff-queue': backoffElapsedRun() },
      claimed: ['backoff-queue'],
      outcome: 'capacity-refused'
    }));
    await backoffElapsed(h);
    await vi.waitFor(() => expect(h.admitUnattended).toHaveBeenCalledTimes(1));
    await settle();

    expect(h.admitUnattended).toHaveBeenCalledTimes(1);
  });

  it('admits nothing when the window has lost primacy', async () => {
    const h = (active = harness({
      runs: { 'credit-queue': creditPaused() },
      primary: false
    }));
    await creditsRestored(h);
    await settle();

    expect(h.admitUnattended).not.toHaveBeenCalled();
  });
});
