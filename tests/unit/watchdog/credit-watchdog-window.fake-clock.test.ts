// FR-R4-F02 (spec 240, US6; contract W3 G5 to G8, W6 G20; US6-4, US6-5; SC-008) — the 24-hour
// polling window of a credit-paused Run.
//
// Driven through the real `CreditWatchdog` over a real `WorkspaceStateStore` (its invariants and
// its `updateRun` chain are the ones that run in production) under a faked clock. The runner is a
// double, so each case also counts the `/status` invocations: the property is not only that a
// window is stamped, but that polling stops and costs nothing once no window is open.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CREDIT_POLL_WINDOW_MS } from '../../../src/contracts/retry-bounds';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { SanitizedLogger } from '../../../src/lib/logger';
import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';
import { QueueMutationRejected, WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { CREDIT_WINDOW_STOPPED_NOTICE } from '../../../src/watchdog/credit-window';
import { CreditWatchdog } from '../../../src/watchdog/credit-watchdog';
import type { RawInvocationOutput } from '../../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import { registerQueue, seedCreditPausedRun } from './credit-paused-run';

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

const INTERVAL_MS = 30 * 60 * 1000;
const QUEUE_B = '22222222-3333-4444-8555-666666666666';
const OPTIONS = {
  pollIntervalMs: INTERVAL_MS,
  cliPath: 'claude',
  cwd: '/repo',
  timeoutMs: 60_000,
  environmentPolicy: { mode: 'inherit', inheritProcessEnv: true } as const
};

const output = (stdout: string): RawInvocationOutput => {
  const stdoutBuffer = new ZippedStreamBuffer();
  stdoutBuffer.append(stdout);
  stdoutBuffer.finalize();
  const stderrBuffer = new ZippedStreamBuffer();
  stderrBuffer.finalize();
  return { stdoutBuffer, stderrBuffer, exitCode: 0, killed: false, timedOut: false, durationMs: 1 };
};

let store: WorkspaceStateStore;
let invoke: ReturnType<typeof vi.fn>;
let onCreditsRestored: ReturnType<typeof vi.fn>;
let notice: ReturnType<typeof vi.fn>;
let logger: SanitizedLogger;
let warn: ReturnType<typeof vi.spyOn>;
let watchdogs: CreditWatchdog[];

function makeWatchdog(): CreditWatchdog {
  const watchdog = new CreditWatchdog(
    () => ({ invoke, cancelActive: vi.fn(), hasActiveProcess: false }) as never,
    store,
    { update: vi.fn(), updateWindow: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar,
    logger,
    OPTIONS,
    onCreditsRestored,
    { warn: notice }
  );
  watchdogs.push(watchdog);
  return watchdog;
}

const creditPauseOf = (queueId: string = DEFAULT_QUEUE_ID) => store.getRun(queueId)?.creditPause ?? null;

beforeEach(async () => {
  vi.useFakeTimers();
  store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  invoke = vi.fn(async () => output('Credits not available'));
  onCreditsRestored = vi.fn();
  notice = vi.fn(async () => undefined);
  logger = new SanitizedLogger();
  warn = vi.spyOn(logger, 'warn');
  watchdogs = [];
});

afterEach(() => {
  for (const watchdog of watchdogs) watchdog.dispose();
  vi.useRealTimers();
});

describe('the window starts at the first poll (G5)', () => {
  it('stamps windowStartedAt when the first poll fires, and polls', async () => {
    await seedCreditPausedRun(store, { pausedAt: Date.now(), windowStartedAt: null, stoppedAt: null });
    await makeWatchdog().pauseAndPoll('rate-limit');
    expect(creditPauseOf()?.windowStartedAt).toBeNull();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(creditPauseOf()?.windowStartedAt).toBe(Date.now());
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('does not restamp a window that has started: it is the first poll that counts', async () => {
    const started = Date.now();
    await seedCreditPausedRun(store, { pausedAt: started, windowStartedAt: null, stoppedAt: null });
    await makeWatchdog().pauseAndPoll('rate-limit');
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(creditPauseOf()?.windowStartedAt).toBe(started + INTERVAL_MS);
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});

describe('the window ends at 24 hours and polling stops (G5, G8; SC-008)', () => {
  it('stamps stoppedAt, leaves the Run paused, runs no /status, and arms nothing', async () => {
    const windowStartedAt = Date.now() - CREDIT_POLL_WINDOW_MS + INTERVAL_MS / 2;
    await seedCreditPausedRun(store, { pausedAt: windowStartedAt - 1, windowStartedAt, stoppedAt: null });
    await makeWatchdog().pauseAndPoll('rate-limit');

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.status).toBe('paused');
    expect(run.creditPause?.stoppedAt).toBe(Date.now());
    expect(run.creditPause?.windowStartedAt).toBe(windowStartedAt);
    expect(invoke).not.toHaveBeenCalled();
    expect(store.getWatchdog().paused).toBe(false);
    expect(store.getWatchdog().nextPollAt).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('polls on the interval until the window is over, then never again (at most one interval late)', async () => {
    await seedCreditPausedRun(store, { pausedAt: Date.now(), windowStartedAt: Date.now(), stoppedAt: null });
    await makeWatchdog().pauseAndPoll('rate-limit');

    await vi.advanceTimersByTimeAsync(CREDIT_POLL_WINDOW_MS + 2 * INTERVAL_MS);
    const polls = invoke.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * INTERVAL_MS);

    // The window opened `INTERVAL_MS` after the pause started: 24 hours of it is 48 intervals.
    expect(polls).toBeGreaterThanOrEqual(CREDIT_POLL_WINDOW_MS / INTERVAL_MS - 1);
    expect(polls).toBeLessThanOrEqual(CREDIT_POLL_WINDOW_MS / INTERVAL_MS);
    expect(invoke).toHaveBeenCalledTimes(polls);
    expect(creditPauseOf()?.stoppedAt).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('control: a Run inside its window is polled again at the next interval', async () => {
    await seedCreditPausedRun(store, { pausedAt: Date.now(), windowStartedAt: Date.now(), stoppedAt: null });
    await makeWatchdog().pauseAndPoll('rate-limit');
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(creditPauseOf()?.stoppedAt).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('one Run\'s window does not end another\'s (G5, FR-024 of feature 093)', () => {
  it('keeps polling for the sibling whose window is open, and stops only the expired one', async () => {
    await registerQueue(store, QUEUE_B);
    const expired = Date.now() - CREDIT_POLL_WINDOW_MS + INTERVAL_MS / 2;
    await seedCreditPausedRun(store, { pausedAt: expired - 1, windowStartedAt: expired, stoppedAt: null }, DEFAULT_QUEUE_ID);
    await seedCreditPausedRun(
      store,
      { pausedAt: Date.now(), windowStartedAt: Date.now(), stoppedAt: null },
      QUEUE_B,
      { id: 'run-credit-b', featureId: 'feature-credit-b' }
    );
    await makeWatchdog().pauseAndPoll('rate-limit');

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(creditPauseOf(DEFAULT_QUEUE_ID)?.stoppedAt).not.toBeNull();
    expect(creditPauseOf(QUEUE_B)?.stoppedAt).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(notice).toHaveBeenCalledTimes(1);
  });
});

describe('a poll in flight when a window ends is honored once (G7)', () => {
  it('delivers its recovered answer once, and the stamp waits for the next poll', async () => {
    const windowStartedAt = Date.now() - CREDIT_POLL_WINDOW_MS + INTERVAL_MS / 2;
    await seedCreditPausedRun(store, { pausedAt: windowStartedAt - 1, windowStartedAt, stoppedAt: null });
    let release: (value: RawInvocationOutput) => void = () => undefined;
    invoke.mockImplementationOnce(() => new Promise<RawInvocationOutput>((resolve) => { release = resolve; }));
    const watchdog = makeWatchdog();

    const polling = watchdog.pollNow();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(invoke).toHaveBeenCalledTimes(1);
    release(output('Credits: available'));
    await polling;

    expect(onCreditsRestored).toHaveBeenCalledTimes(1);
    // The window ended while the poll was in flight, but windows are stamped at a poll's start.
    expect(creditPauseOf()?.stoppedAt).toBeNull();
  });
});

describe('a reload never starts the window over (G9, US6-5)', () => {
  it('keeps windowStartedAt across a fresh watchdog over the same store', async () => {
    const windowStartedAt = Date.now() - 2 * INTERVAL_MS;
    await seedCreditPausedRun(store, { pausedAt: windowStartedAt - 1, windowStartedAt, stoppedAt: null });
    await store.setWatchdog({
      paused: true,
      pausedSince: windowStartedAt,
      nextPollAt: Date.now() + 1_000,
      pollIntervalMs: INTERVAL_MS,
      lastStatusOk: false,
      lastPollOutcome: 'not-recovered',
      cause: 'rate-limit'
    });

    const reloaded = makeWatchdog();
    await reloaded.reattachOnActivation();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(creditPauseOf()?.windowStartedAt).toBe(windowStartedAt);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('a refused stamp leaves only that Run out of the poll (G6)', () => {
  it('logs one metadata-only line and runs no /status when that was the only open window', async () => {
    await seedCreditPausedRun(store, { pausedAt: Date.now(), windowStartedAt: null, stoppedAt: null });
    vi.spyOn(store, 'updateRun').mockRejectedValueOnce(new QueueMutationRejected('stale-run-id', 'the Run was replaced'));
    await makeWatchdog().pauseAndPoll('rate-limit');

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    const refused = warn.mock.calls.filter(([message]) => String(message).includes('stamp was refused'));
    expect(refused).toHaveLength(1);
    expect(refused[0]?.[1]).toEqual({ reasonCode: 'stale-run-id' });
    expect(JSON.stringify(refused[0])).not.toContain('run-credit-1');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('one notice per stopped Run (W6 G20)', () => {
  it('raises the fixed notice once when a window stops, and not again at later polls', async () => {
    const expired = Date.now() - CREDIT_POLL_WINDOW_MS + INTERVAL_MS / 2;
    await seedCreditPausedRun(store, { pausedAt: expired - 1, windowStartedAt: expired, stoppedAt: null });
    const watchdog = makeWatchdog();
    await watchdog.pauseAndPoll('rate-limit');

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await watchdog.pollNow();
    await watchdog.pollNow();

    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith(CREDIT_WINDOW_STOPPED_NOTICE);
  });

  it('carries no account text, amount, Run id or queue name', () => {
    expect(CREDIT_WINDOW_STOPPED_NOTICE).toBe(
      'Schegent stopped checking credits for a paused run after 24 hours. Resume it when your account has credits.'
    );
    expect(CREDIT_WINDOW_STOPPED_NOTICE).not.toMatch(/\$|\d{2,}\s*(usd|credits)|run-|queue/i);
  });
});
