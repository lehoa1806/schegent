import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  wireScheduledWork,
  type ScheduledWorkWiring,
  type ScheduledWorkWiringDeps
} from '../../../src/activation/scheduled-work-wiring';
import type { ResumeAdmission } from '../../../src/controller/run-admission';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { RawInvocationOutput } from '../../../src/runner/invocation-result';
import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';

/**
 * FR-R3-192 (T1863, FR-003, FR-007) — paths 3 and 4: the credit watchdog's backoff-elapsed and
 * credits-restored arms, which both call the one `onResume` sweep, announce each Run the sweep
 * resumes.
 *
 * Driven through `wireScheduledWork(deps)` and the real `CreditWatchdog` it returns, under fake
 * timers. `setImmediate` is left real so the cases can let pending work settle. The fake controller
 * provides BOTH `resumeExisting` and `admitResume`, and `resumeExisting` is `admitResume` plus an
 * await of `completed`, as the real one is: at the base the sweep resumes by `resumeExisting` and
 * the positive cases fail on the warning count, not on a missing method.
 */

const TEST_ENV_POLICY = { mode: 'inherit', inheritProcessEnv: true } as const;
const POLL_INTERVAL_MINUTES = 30;
const TITLES = ['Schegent: Show Active Run', 'Schegent: Cancel In-Flight Workflow'] as const;

interface FakeRun {
  readonly id: string;
  readonly currentPhase: string;
}

interface Harness {
  readonly wiring: ScheduledWorkWiring;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly admitResume: ReturnType<typeof vi.fn>;
  readonly resumeExisting: ReturnType<typeof vi.fn>;
  readonly completions: Map<string, () => void>;
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
  pendingRetry?: ReadonlyArray<string>;
  primary?: boolean;
  resumed?: boolean;
}): Harness {
  const completions = new Map<string, () => void>();
  const resumed = options.resumed ?? true;
  const admitResume = vi.fn(async (queueId: string): Promise<ResumeAdmission> => {
    if (!resumed) return { resumed: false, completed: Promise.resolve() };
    const completed = new Promise<void>((done) => {
      completions.set(queueId, done);
    });
    return { resumed: true, completed };
  });
  const resumeExisting = vi.fn(async (queueId: string): Promise<boolean> => {
    const admission = await admitResume(queueId);
    await admission.completed;
    return admission.resumed;
  });
  const warn = vi.fn(async (_message: string) => undefined);

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
  const pending = new Set(options.pendingRetry ?? []);
  const controller = {
    claimElapsedDelayedRetries: vi.fn(),
    hasPendingDelayedRetry: (queueId: string) => pending.has(queueId),
    drainQueuedWork: vi.fn(async () => undefined),
    resumeExisting,
    admitResume,
    setWatchdog: vi.fn(),
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
    notifier: { info: vi.fn(), warn, error: vi.fn() },
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

  return { wiring: wireScheduledWork(deps), warn, admitResume, resumeExisting, completions };
}

describe('FR-R3-192 — paths 3 and 4, the watchdog resume sweep', () => {
  let active: Harness | null = null;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });

  afterEach(() => {
    active?.wiring.watchdog.dispose();
    active?.wiring.queueScheduleWatchdog.dispose();
    active = null;
    vi.useRealTimers();
  });

  const backoffElapsed = async (h: Harness): Promise<void> => {
    await h.wiring.watchdog.pauseAndPoll('transient_error', {
      durationOverrideMs: 1_000,
      skipStatusCheck: true
    });
    await vi.advanceTimersByTimeAsync(1_100);
  };

  const creditsRestored = async (h: Harness): Promise<void> => {
    await h.wiring.watchdog.pauseAndPoll('rate-limit');
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MINUTES * 60 * 1000 + 100);
  };

  it('announces the Run when a backoff elapses, while the Run is still going', async () => {
    const h = (active = harness({ runs: { default: { id: '1afda4d8-1111-4222-8333-444455556666', currentPhase: 'speckit-plan' } } }));
    await backoffElapsed(h);
    await vi.waitFor(() => expect(h.warn).toHaveBeenCalledTimes(1));

    const message = h.warn.mock.lastCall?.[0];
    expect(message).toContain('queue "default"');
    expect(message).toContain('run 1afda4d8 ');
    expect(message).toContain('phase "speckit-plan"');
    for (const title of TITLES) expect(message).toContain(title);
    expect(h.completions.has('default')).toBe(true);
    h.completions.get('default')?.();
  });

  it('announces the Run when the credit poll finds credits restored', async () => {
    const h = (active = harness({ runs: { default: { id: '2bfeb5e9-1111-4222-8333-444455556666', currentPhase: 'speckit-tasks' } } }));
    await creditsRestored(h);
    await vi.waitFor(() => expect(h.warn).toHaveBeenCalledTimes(1));

    const message = h.warn.mock.lastCall?.[0];
    expect(message).toContain('queue "default"');
    expect(message).toContain('run 2bfeb5e9 ');
    expect(message).toContain('phase "speckit-tasks"');
    expect(h.completions.has('default')).toBe(true);
    h.completions.get('default')?.();
  });

  it('announces nothing for a queue whose own delayed retry is still pending', async () => {
    const h = (active = harness({
      runs: { default: { id: '1afda4d8-1111-4222-8333-444455556666', currentPhase: 'speckit-plan' } },
      pendingRetry: ['default']
    }));
    await backoffElapsed(h);
    await settle();

    expect(h.admitResume).not.toHaveBeenCalled();
    expect(h.resumeExisting).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('announces nothing for a resume that admission refuses', async () => {
    const h = (active = harness({
      runs: { default: { id: '1afda4d8-1111-4222-8333-444455556666', currentPhase: 'speckit-plan' } },
      resumed: false
    }));
    await backoffElapsed(h);
    await vi.waitFor(() => expect(h.admitResume).toHaveBeenCalledTimes(1));
    await settle();

    expect(h.warn).not.toHaveBeenCalled();
  });

  it('resumes nothing and announces nothing when the window has lost primacy', async () => {
    const h = (active = harness({
      runs: { default: { id: '1afda4d8-1111-4222-8333-444455556666', currentPhase: 'speckit-plan' } },
      primary: false
    }));
    await backoffElapsed(h);
    await settle();

    expect(h.admitResume).not.toHaveBeenCalled();
    expect(h.resumeExisting).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });
});
