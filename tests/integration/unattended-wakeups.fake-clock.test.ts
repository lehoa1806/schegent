// FR-R4-F02 (spec 240, US2; contract U2, U4, U5, W3 G10, G11; FR-007 to FR-011, FR-042; SC-003) — no
// wakeup is lost when several overlap.
//
// The real controller, retry coordinator, auto-drain coordinator, unattended admission service,
// credit watchdog, store and queue manager (`concurrent-run-harness.ts`), with the CLI invocation
// parked at a gate and the coordinator's deadlines on an injected `DeadlineTimer` over a faked
// `Date`. Time moves only when `advance()` moves it.
//
// At `5d700407` a delayed retry and a credit poll shared one timer handle. A second fire that
// arrived while the first resume was still awaiting its Run was dropped by the watchdog's `polling`
// guard, so queue B's wakeup was lost while queue A's Run ran; and a one-shot skip flag left by a
// backoff arm made a later CREDIT poll resume without running `/status`. Both measured on the
// unchanged watchdog class (measurements.md, US2, "Regression before the fix").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  QUEUE_A,
  QUEUE_B,
  QUEUE_C,
  drainUntil,
  fatalOutput,
  initGitRepo,
  makeHarness,
  removeWorkspace,
  type Harness
} from './concurrent-run-harness';
import {
  creditPausedRun,
  pausedRunWithoutSession,
  siblingInState
} from './unattended-harness';
import { CreditWatchdog } from '../../src/watchdog/credit-watchdog';
import { UnattendedAdmission } from '../../src/services/unattended-admission';
import type { DeadlineTimer } from '../../src/services/retry-coordinator';
import type { UnattendedWakeup } from '../../src/services/unattended-eligibility';
import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';

const T0 = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const POLL_INTERVAL_MS = 30 * 60 * 1000;

interface Handle {
  readonly at: number;
  readonly fn: () => void;
  cleared: boolean;
  fired: boolean;
}

/** The coordinator's timer on the faked `Date`: it fires only when the test advances time. */
class FakeDeadlineTimer implements DeadlineTimer {
  public readonly handles: Handle[] = [];

  set(fn: () => void, delayMs: number): { clear(): void } {
    const handle: Handle = { at: Date.now() + delayMs, fn, cleared: false, fired: false };
    this.handles.push(handle);
    return {
      clear: () => {
        handle.cleared = true;
      }
    };
  }

  armed(): Handle[] {
    return this.handles.filter((h) => !h.cleared && !h.fired).sort((a, b) => a.at - b.at);
  }

  /** The delays the armed handles will fire after, from the faked now. */
  armedIn(): number[] {
    return this.armed().map((h) => h.at - Date.now());
  }

  advance(ms: number): void {
    const target = Date.now() + ms;
    for (;;) {
      const due = this.armed().find((h) => h.at <= target);
      if (due === undefined) break;
      vi.setSystemTime(Math.max(Date.now(), due.at));
      due.fired = true;
      due.fn();
    }
    vi.setSystemTime(target);
  }
}

interface Fired {
  readonly queueId: string;
  readonly deadline: number;
  readonly at: number;
}

let tmpRoot: string;
let h: Harness;
let timer: FakeDeadlineTimer;
let admission: UnattendedAdmission;
let watchdog: CreditWatchdog;
let statusInvoke: ReturnType<typeof vi.fn>;
let fired: Fired[];
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

function statusOutput(text: string): unknown {
  const stdoutBuffer = new ZippedStreamBuffer();
  stdoutBuffer.append(text);
  stdoutBuffer.finalize();
  const stderrBuffer = new ZippedStreamBuffer();
  stderrBuffer.finalize();
  return { stdoutBuffer, stderrBuffer, exitCode: 0, killed: false, timedOut: false, durationMs: 1 };
}

async function open(cap: number, queues: readonly string[]): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  process.on('unhandledRejection', onUnhandled);
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-unattended-wakeups-'));
  await initGitRepo(tmpRoot);
  timer = new FakeDeadlineTimer();
  h = await makeHarness(tmpRoot, { concurrencyCap: cap, queues, deadlineTimer: timer });
  await h.lock.tryAcquire();
  fired = [];
  statusInvoke = vi.fn(async () => statusOutput('Credits: available'));
  watchdog = new CreditWatchdog(
    () => ({ invoke: statusInvoke, cancelActive: vi.fn(), hasActiveProcess: false }) as never,
    h.store,
    { update: vi.fn(), updateWindow: vi.fn(), showTransient: vi.fn(), dispose: vi.fn() } as never,
    h.logger,
    {
      pollIntervalMs: POLL_INTERVAL_MS,
      cliPath: 'claude',
      cwd: tmpRoot,
      timeoutMs: 1_000,
      environmentPolicy: { mode: 'inherit', inheritProcessEnv: true } as never
    },
    (evidenceAt) => void admission.creditsRestored(evidenceAt)
  );
  admission = new UnattendedAdmission({
    lock: h.lock,
    store: h.store,
    admit: (queueId, wakeup) => h.controller.admitUnattended(queueId, wakeup),
    clock: () => Date.now(),
    pollIntervalMs: () => POLL_INTERVAL_MS,
    pollNow: () => void watchdog.pollNow(),
    logger: h.logger
  });
  h.controller.setBackoffElapsedHandler((wakeup: UnattendedWakeup) => {
    if (wakeup.cause === 'backoff-elapsed') {
      fired.push({ queueId: wakeup.queueId, deadline: wakeup.deadline, at: Date.now() });
    }
    return admission.admit(wakeup);
  });
  h.controller.onDrainSweepEnd(() => admission.retryDue());
}

afterEach(async () => {
  watchdog.dispose();
  vi.useRealTimers();
  await h.quiesce();
  await h.controller.drainedRunsSettled();
  await removeWorkspace(tmpRoot);
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled, 'no unhandled rejection in any case').toEqual([]);
  unhandled.length = 0;
});

/** Put the Run on `queueId` on a backoff that elapses `afterMs` from now, and return its deadline. */
async function backoffAt(queueId: string, runId: string, afterMs: number): Promise<number> {
  const deadline = Date.now() + afterMs;
  await h.store.updateRun(
    queueId,
    {
      runId,
      allowedStatuses: ['paused'],
      label: 'resume',
      patch: () => ({ pendingRetryAt: deadline, pendingRetryCause: 'rate_limit', delayedRetryCount: 1 })
    },
    h.store.runCommitClaim(queueId)
  );
  return deadline;
}

describe('B\'s deadline elapses while A\'s unattended resume is still running (US2-1, SC-003)', () => {
  beforeEach(async () => open(2, [QUEUE_B]));

  it('admits B while A runs, at capacity two', async () => {
    const a = await creditPausedRun(h, QUEUE_A, 'A');
    const b = await siblingInState(h, QUEUE_B, 'future backoff');
    await h.controller.resumeExistingFromActivation();
    expect(timer.armedIn(), 'B\'s deadline is armed on the coordinator\'s own timer').toEqual([HOUR_MS]);

    await admission.creditsRestored(Date.now());
    expect(h.store.getRun(QUEUE_A)!.status).toBe('running');

    timer.advance(HOUR_MS);

    await drainUntil(
      () => h.store.getRun(QUEUE_B)?.status === 'running',
      () => `B to be admitted while A runs (B is ${h.store.getRun(QUEUE_B)?.status})`
    );
    expect(h.store.getRun(QUEUE_A)!.id).toBe(a.runId);
    expect(h.store.getRun(QUEUE_A)!.status, 'A is still running').toBe('running');
    expect(h.store.getRun(QUEUE_B)!.id).toBe(b.runId);
    expect(h.controller.liveRunCount).toBe(2);
  });
});

describe('every deadline fires once, at or after its time, never early (US2-2, SC-003)', () => {
  beforeEach(async () => open(3, [QUEUE_B, QUEUE_C]));

  for (const [label, firstIsB] of [
    ['B first, then C', true],
    ['C first, then B', false]
  ] as const) {
    it(`${label}`, async () => {
      const b = await siblingInState(h, QUEUE_B, 'future backoff');
      const c = await siblingInState(h, QUEUE_C, 'future backoff');
      const bAt = await backoffAt(QUEUE_B, b.runId, firstIsB ? HOUR_MS : 2 * HOUR_MS);
      const cAt = await backoffAt(QUEUE_C, c.runId, firstIsB ? 2 * HOUR_MS : HOUR_MS);
      await h.controller.resumeExistingFromActivation();
      const [first, second] = firstIsB ? [bAt, cAt] : [cAt, bAt];

      timer.advance(first - Date.now() - 1);
      expect(fired, 'nothing fires before its time').toEqual([]);
      timer.advance(1);
      expect(fired).toHaveLength(1);
      expect(fired[0]!.deadline).toBe(first);
      expect(fired[0]!.at).toBeGreaterThanOrEqual(first);

      timer.advance(second - Date.now() - 1);
      expect(fired).toHaveLength(1);
      timer.advance(1);
      expect(fired).toHaveLength(2);
      expect(fired[1]!.deadline).toBe(second);
      expect(fired[1]!.at).toBeGreaterThanOrEqual(second);

      timer.advance(10 * HOUR_MS);
      expect(fired, 'each deadline fired exactly once').toHaveLength(2);
    });
  }
});

describe('an outcome never loses the earliest remaining deadline (US2-3, G18)', () => {
  it('a refused admission leaves the next deadline armed', async () => {
    await open(1, [QUEUE_B, QUEUE_C]);
    await creditPausedRun(h, QUEUE_A, 'A holds the only slot');
    const template = h.store.getRun(QUEUE_A)!;
    const bRun = await pausedRunWithoutSession(h, QUEUE_B, 'B', template, {
      pendingRetryAt: Date.now() + HOUR_MS,
      pendingRetryCause: 'rate_limit',
      delayedRetryCount: 1,
      creditPause: null
    });
    await pausedRunWithoutSession(h, QUEUE_C, 'C', template, {
      pendingRetryAt: Date.now() + 2 * HOUR_MS,
      pendingRetryCause: 'rate_limit',
      delayedRetryCount: 1,
      creditPause: null
    });
    await h.controller.resumeExistingFromActivation();

    timer.advance(HOUR_MS);
    await drainUntil(() => fired.length === 1, 'B\'s deadline to fire');

    expect(h.store.getRun(QUEUE_B)!.id).toBe(bRun.runId);
    expect(h.store.getRun(QUEUE_B)!.status, 'B was refused for capacity').toBe('paused');
    expect(timer.armedIn(), 'C\'s deadline is still armed').toEqual([HOUR_MS]);
  });

  it('a resumed Run that fails leaves the next deadline armed', async () => {
    await open(3, [QUEUE_B, QUEUE_C]);
    const b = await siblingInState(h, QUEUE_B, 'future backoff');
    const c = await siblingInState(h, QUEUE_C, 'future backoff');
    await backoffAt(QUEUE_B, b.runId, HOUR_MS);
    await backoffAt(QUEUE_C, c.runId, 2 * HOUR_MS);
    await h.controller.resumeExistingFromActivation();

    timer.advance(HOUR_MS);
    await drainUntil(() => h.store.getRun(QUEUE_B)?.status === 'running', 'B to be admitted');
    h.script(() => fatalOutput());
    await h.atGate(b.runId);
    h.step(b.runId);
    await drainUntil(() => h.store.getRun(QUEUE_B)?.status === 'failed', 'B to fail');

    expect(timer.armedIn(), 'C is still armed after B failed').toEqual([HOUR_MS]);
  });

  it('a canceled queue never fires and the sibling still does', async () => {
    await open(3, [QUEUE_B, QUEUE_C]);
    const b = await siblingInState(h, QUEUE_B, 'future backoff');
    const c = await siblingInState(h, QUEUE_C, 'future backoff');
    await backoffAt(QUEUE_B, b.runId, HOUR_MS);
    await backoffAt(QUEUE_C, c.runId, 2 * HOUR_MS);
    await h.controller.resumeExistingFromActivation();

    const paused = await h.controller.pauseActivePhase(QUEUE_B);
    expect(paused.ok).toBe(true);
    expect(timer.armedIn()).toEqual([2 * HOUR_MS]);

    timer.advance(3 * HOUR_MS);
    await drainUntil(() => fired.length === 1, 'C\'s deadline to fire');
    expect(fired.map((f) => f.queueId)).toEqual([QUEUE_C]);
  });

  it('a poll error leaves the deadline armed, and the next poll still runs', async () => {
    await open(2, [QUEUE_B]);
    await creditPausedRun(h, QUEUE_A, 'A');
    const b = await siblingInState(h, QUEUE_B, 'future backoff');
    await backoffAt(QUEUE_B, b.runId, HOUR_MS);
    await h.controller.resumeExistingFromActivation();
    statusInvoke.mockRejectedValueOnce(new Error('the CLI could not be spawned'));

    await expect(watchdog.pollNow()).resolves.toBeUndefined();

    expect(timer.armedIn(), 'the retry deadline does not live on the watchdog').toEqual([HOUR_MS]);
    statusInvoke.mockResolvedValue(statusOutput('Credits: available'));
    await watchdog.pollNow();
    expect(statusInvoke).toHaveBeenCalledTimes(2);
  });
});

describe('a swallowed backoff fire is followed by a credit poll that runs /status (US2-4, FR-021)', () => {
  beforeEach(async () => open(2, [QUEUE_B]));

  it('runs /status', async () => {
    await creditPausedRun(h, QUEUE_A, 'A');
    const b = await siblingInState(h, QUEUE_B, 'future backoff');
    await backoffAt(QUEUE_B, b.runId, HOUR_MS);
    // The fire is swallowed: the handler takes the wakeup and does nothing with it.
    h.controller.setBackoffElapsedHandler(() => undefined);
    await h.controller.resumeExistingFromActivation();
    timer.advance(HOUR_MS);

    await watchdog.pollNow();

    expect(statusInvoke).toHaveBeenCalledTimes(1);
    expect(statusInvoke).toHaveBeenCalledWith(expect.objectContaining({ prompt: '/status' }));
  });
});
