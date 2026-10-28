import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';
import {
  CREDIT_POLL_PHASE_LABEL,
  CreditWatchdog,
  type WatchdogOptions
} from '../../../src/watchdog/credit-watchdog';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { Memento } from '../../../src/state/workspace-state';
import type { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { RawInvocationOutput } from '../../../src/runner/invocation-result';
import { seedCreditPausedRun } from './credit-paused-run';

/**
 * FR-R3-049 — the watchdog now requires an environment policy, so every
 * construction site supplies one. Added as a field only: no assertion in this
 * file changes, because the poll's cadence, pause/resume and status detection
 * are untouched by this feature.
 */
const TEST_ENV_POLICY = { mode: 'inherit', inheritProcessEnv: true } as const;

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

function makeStatusBar(): SchegentStatusBar {
  return { update: vi.fn(), updateWindow: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
}

function makeRunner(invokeImpl: () => Promise<RawInvocationOutput>): ClaudeCliRunner {
  return {
    invoke: vi.fn(invokeImpl),
    cancelActive: vi.fn(),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
}

type MockRawOutput = Omit<Partial<RawInvocationOutput>, 'stdoutBuffer' | 'stderrBuffer'> & { stdout?: string; stderr?: string };

function makeRawOutput(overrides: MockRawOutput = {}): RawInvocationOutput {
  const stdoutStr = overrides.stdout ?? '';
  const stderrStr = overrides.stderr ?? '';
  const stdoutBuffer = new ZippedStreamBuffer();
  stdoutBuffer.append(stdoutStr);
  stdoutBuffer.finalize();
  const stderrBuffer = new ZippedStreamBuffer();
  stderrBuffer.append(stderrStr);
  stderrBuffer.finalize();

  return {
    stdoutBuffer,
    stderrBuffer,
    exitCode: overrides.exitCode ?? 0,
    killed: overrides.killed ?? false,
    timedOut: overrides.timedOut ?? false,
    durationMs: overrides.durationMs ?? 1,
    ...overrides
  };
}

const watchdogOpts = {
  pollIntervalMs: 30 * 60 * 1000,
  cliPath: 'claude',
  cwd: '/repo',
  timeoutMs: 60_000,
  environmentPolicy: TEST_ENV_POLICY
};

let memento: FakeMemento;
let store: WorkspaceStateStore;

beforeEach(async () => {
  vi.useFakeTimers();
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  // FR-R4-F02 (US6) — the watchdog polls only for a Run with an open credit window, so every case
  // here, which is about the poll itself, starts with one. The window cases are in
  // `credit-watchdog-window.fake-clock.test.ts` and the reattach cases in `credit-watchdog-reattach.test.ts`.
  await seedCreditPausedRun(store);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CreditWatchdog.pauseAndPoll', () => {
  it('persists paused state with cause and next poll time', async () => {
    const watchdog = new CreditWatchdog(
      () => makeRunner(async () => makeRawOutput({ stdout: 'status: ok' })),
      store,
      makeStatusBar(),
      new SanitizedLogger(),
      watchdogOpts,
      async () => {}
    );
    await watchdog.pauseAndPoll('rate-limit');
    const state = store.getWatchdog();
    expect(state.paused).toBe(true);
    expect(state.cause).toBe('rate-limit');
    expect(state.nextPollAt).not.toBeNull();
    watchdog.dispose();
  });

  it('updates the status bar to paused with nextPollAt', async () => {
    const statusBar = makeStatusBar();
    const watchdog = new CreditWatchdog(
      () => makeRunner(async () => makeRawOutput({})),
      store,
      statusBar,
      new SanitizedLogger(),
      watchdogOpts,
      async () => {}
    );
    await watchdog.pauseAndPoll('rate-limit');
    expect(statusBar.updateWindow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'paused' })
    );
    watchdog.dispose();
  });
});

describe('CreditWatchdog poll behavior', () => {
  it('resumes when /status reports ok', async () => {
    const runner = makeRunner(async () => makeRawOutput({
      stdout: 'status: ok'
    }));
    const onResume = vi.fn(async () => {});
    const watchdog = new CreditWatchdog(() => runner, store, makeStatusBar(), new SanitizedLogger(), watchdogOpts, onResume);

    await watchdog.pauseAndPoll('rate-limit');
    await vi.advanceTimersByTimeAsync(watchdogOpts.pollIntervalMs + 100);
    await Promise.resolve();
    await Promise.resolve();

    expect(onResume).toHaveBeenCalled();
    expect(store.getWatchdog().paused).toBe(false);
    expect(store.getWatchdog().lastStatusOk).toBe(true);
    watchdog.dispose();
  });

  // Feature 098 (FR-008) — the poll invoked the CLI under `phase: 'finalize'`,
  // borrowing a built-in Phase id for something that is not a Phase at all. The
  // field reaches the runner's log lines (`phase=… iteration=…`) and nothing
  // else, so the cost was a log that named the wrong thing — and once the
  // catalog is runtime-only, `finalize` may be a Phase an operator imported,
  // which makes the line not merely vague but false.
  it('polls under a label that names the watchdog, not a Phase', async () => {
    const runner = makeRunner(async () => makeRawOutput({ stdout: 'status: ok' }));
    const watchdog = new CreditWatchdog(
      () => runner, store, makeStatusBar(), new SanitizedLogger(), watchdogOpts, async () => {}
    );

    await watchdog.pauseAndPoll('rate-limit');
    await vi.advanceTimersByTimeAsync(watchdogOpts.pollIntervalMs + 100);
    await Promise.resolve();
    await Promise.resolve();

    expect(runner.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ phase: CREDIT_POLL_PHASE_LABEL, prompt: '/status' })
    );
    expect(CREDIT_POLL_PHASE_LABEL).not.toBe('finalize');
    watchdog.dispose();
  });

  /**
   * FR-R3-049 — the poll's forwarded policy is OBSERVED here, not modelled.
   *
   * Neither of the feature's two new gates covers this. The parity test models
   * each call site's request by calling `policyRequestFields` itself, so it
   * passes whatever the watchdog does; the `tests/lint` guard reads the call's
   * argument text and only asks that the helper's *name* appear in it. Measured:
   * rewriting the poll as `...policyRequestFields({})` keeps `tsc --noEmit`, the
   * guard, the parity test and this file all green while the poll is back to
   * inheriting the complete ambient environment — the original defect, exactly.
   *
   * `tests/unit/controller/phase-runner.test.ts` already asserts the forwarded
   * allowlist on the real request for the two call sites that were correct. The
   * one site that was wrong was the one with no such assertion.
   */
  const RESTRICTIVE_POLICY = {
    mode: 'allowlist',
    inheritProcessEnv: false,
    // A synthetic name: this file asserts which names are forwarded, never a value.
    processEnvAllowlist: ['SCHEGENT_ALLOWED_FIXTURE_NAME']
  } as const;

  async function pollOnce(runner: ClaudeCliRunner, opts: WatchdogOptions): Promise<void> {
    const watchdog = new CreditWatchdog(
      () => runner, store, makeStatusBar(), new SanitizedLogger(), opts, async () => {}
    );
    await watchdog.pauseAndPoll('rate-limit');
    await vi.advanceTimersByTimeAsync(opts.pollIntervalMs + 100);
    await Promise.resolve();
    await Promise.resolve();
    watchdog.dispose();
  }

  it('forwards a configured environment policy on the poll (FR-001)', async () => {
    const runner = makeRunner(async () => makeRawOutput({ stdout: 'status: ok' }));
    await pollOnce(runner, { ...watchdogOpts, environmentPolicy: RESTRICTIVE_POLICY });

    expect(runner.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: '/status',
        inheritProcessEnv: false,
        processEnvAllowlist: ['SCHEGENT_ALLOWED_FIXTURE_NAME']
      })
    );
  });

  it('forwards an inherit policy as the absence of both fields (FR-005)', async () => {
    // The other direction: the default must not arrive as `inheritProcessEnv:
    // false`, or threading the policy would turn every unconfigured host's poll
    // into an overlay-only spawn that cannot resolve a bare `cli.path`.
    const runner = makeRunner(async () => makeRawOutput({ stdout: 'status: ok' }));
    await pollOnce(runner, watchdogOpts);

    const request = (runner.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect('inheritProcessEnv' in request).toBe(false);
    expect('processEnvAllowlist' in request).toBe(false);
  });

  it('clears the window-level pause before resuming (T050)', async () => {
    // Feature 093 (T050) — the window condition outranks the per-Run aggregate,
    // so a resume that does not give it back leaves the bar reading `paused`
    // while Runs execute. Before the channel split the next driver update
    // overwrote it, and nothing had to hand it back.
    const runner = makeRunner(async () => makeRawOutput({ stdout: 'status: ok' }));
    const statusBar = makeStatusBar();
    const watchdog = new CreditWatchdog(
      () => runner,
      store,
      statusBar,
      new SanitizedLogger(),
      watchdogOpts,
      async () => {}
    );

    await watchdog.pauseAndPoll('rate-limit');
    await vi.advanceTimersByTimeAsync(watchdogOpts.pollIntervalMs + 100);
    await Promise.resolve();
    await Promise.resolve();

    expect(statusBar.updateWindow).toHaveBeenCalledWith(null);
    watchdog.dispose();
  });

  it('keeps polling when /status reports not ok', async () => {
    const runner = makeRunner(async () => makeRawOutput({
      stdout: 'still rate limited'
    }));
    const onResume = vi.fn(async () => {});
    const watchdog = new CreditWatchdog(() => runner, store, makeStatusBar(), new SanitizedLogger(), watchdogOpts, onResume);

    await watchdog.pauseAndPoll('rate-limit');
    await vi.advanceTimersByTimeAsync(watchdogOpts.pollIntervalMs + 100);
    await Promise.resolve();
    await Promise.resolve();

    expect(onResume).not.toHaveBeenCalled();
    expect(store.getWatchdog().paused).toBe(true);
    expect(store.getWatchdog().lastStatusOk).toBe(false);
    watchdog.dispose();
  });
});

describe('CreditWatchdog.reattachOnActivation', () => {
  it('does nothing when watchdog state is not paused', async () => {
    const watchdog = new CreditWatchdog(
      () => makeRunner(async () => makeRawOutput({})),
      store,
      makeStatusBar(),
      new SanitizedLogger(),
      watchdogOpts,
      async () => {}
    );
    await watchdog.reattachOnActivation();
    expect(store.getWatchdog().paused).toBe(false);
    watchdog.dispose();
  });

  it('schedules a poll when paused state is persisted', async () => {
    await store.setWatchdog({
      paused: true,
      pausedSince: Date.now(),
      nextPollAt: Date.now() + 1_000,
      pollIntervalMs: watchdogOpts.pollIntervalMs,
      lastStatusOk: null,
      cause: 'rate-limit'
    });

    const onResume = vi.fn(async () => {});
    // The positive form of the bounded grammar (contract W2); the earlier free-text 'credits
    // available' is not evidence under it, which is the point of the grammar.
    const runner = makeRunner(async () => makeRawOutput({
      stdout: 'Credits: available'
    }));
    const watchdog = new CreditWatchdog(() => runner, store, makeStatusBar(), new SanitizedLogger(), watchdogOpts, onResume);

    await watchdog.reattachOnActivation();
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(onResume).toHaveBeenCalled();
    watchdog.dispose();
  });
});

describe('CreditWatchdog.setPollInterval (US7 / T101 / T104)', () => {
  it('updates the active interval and logs the change', () => {
    const logger = new SanitizedLogger();
    const infoSpy = vi.spyOn(logger, 'info');
    const watchdog = new CreditWatchdog(
      () => makeRunner(async () => makeRawOutput({
      })),
      store,
      makeStatusBar(),
      logger,
      watchdogOpts,
      vi.fn()
    );

    expect(watchdog.getPollIntervalMs()).toBe(watchdogOpts.pollIntervalMs);
    watchdog.setPollInterval(5 * 60 * 1000, 'config-change');
    expect(watchdog.getPollIntervalMs()).toBe(5 * 60 * 1000);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringMatching(/watchdog: pollIntervalMs .* → 300000.*config-change/)
    );
    watchdog.dispose();
  });

  it('rejects non-positive intervals and warns', () => {
    const logger = new SanitizedLogger();
    const warnSpy = vi.spyOn(logger, 'warn');
    const watchdog = new CreditWatchdog(
      () => makeRunner(async () => makeRawOutput({
      })),
      store,
      makeStatusBar(),
      logger,
      watchdogOpts,
      vi.fn()
    );
    watchdog.setPollInterval(0);
    watchdog.setPollInterval(-1);
    watchdog.setPollInterval(Number.NaN);
    expect(watchdog.getPollIntervalMs()).toBe(watchdogOpts.pollIntervalMs);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    watchdog.dispose();
  });
});

// FR-R4-F02 (spec 240, US2; contract W3 G10, G11; FR-008, FR-010, FR-021) — the watchdog polls credits
// only, and a poll in flight is joined, never dropped.
//
// At `5d700407` the watchdog also carried delayed retries: `pauseAndPoll` took a duration override and
// a one-shot `skipStatusCheck`, the second of which stayed set when another arm replaced the timer, so
// a later CREDIT poll resumed without ever running `/status`. And a fire that arrived while a poll was
// still awaiting its resume was dropped by `if (this.polling) return`, which is how a second queue's
// wakeup was lost while the first queue's Run was running. Both are gone: the retry coordinator keeps
// delayed retries on its own timer, `pollNow()` joins the poll in flight, and the callback is
// notified, not awaited, so no Run holds the poll.
describe('FR-R4-F02 — a poll in flight is joined, and the resume is not awaited (G10, G11)', () => {
  function deferredOutput(): { runner: ClaudeCliRunner; release: () => void; invoke: ReturnType<typeof vi.fn> } {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invoke = vi.fn(async () => {
      await gate;
      return makeRawOutput({ stdout: 'status: ok' });
    });
    return { runner: { invoke, cancelActive: vi.fn(), hasActiveProcess: false } as unknown as ClaudeCliRunner, release, invoke };
  }

  it('a pollNow() during a poll joins it: one /status, and the second caller waits for the first', async () => {
    const { runner, release, invoke } = deferredOutput();
    const onCreditsRestored = vi.fn(async () => {});
    const watchdog = new CreditWatchdog(() => runner, store, makeStatusBar(), new SanitizedLogger(), watchdogOpts, onCreditsRestored);

    let firstDone = false;
    let secondDone = false;
    const first = watchdog.pollNow().then(() => {
      firstDone = true;
    });
    await Promise.resolve();
    const second = watchdog.pollNow().then(() => {
      secondDone = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(secondDone, 'the second call is not dropped: it is waiting on the poll in flight').toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([first, second]);
    expect([firstDone, secondDone]).toEqual([true, true]);
    expect(invoke, 'still one /status').toHaveBeenCalledTimes(1);
    expect(onCreditsRestored, 'one notification, not two').toHaveBeenCalledTimes(1);
    watchdog.dispose();
  });

  it('a timer fire during a poll joins it as well', async () => {
    const { runner, release, invoke } = deferredOutput();
    const watchdog = new CreditWatchdog(() => runner, store, makeStatusBar(), new SanitizedLogger(), watchdogOpts, async () => {});
    await watchdog.pauseAndPoll('rate-limit');

    await vi.advanceTimersByTimeAsync(watchdogOpts.pollIntervalMs + 100);
    expect(invoke).toHaveBeenCalledTimes(1);
    const joined = watchdog.pollNow();
    release();
    await joined;

    expect(invoke).toHaveBeenCalledTimes(1);
    watchdog.dispose();
  });

  it('calls onCreditsRestored with the time of the positive poll, and does not await it', async () => {
    const runner = makeRunner(async () => makeRawOutput({ stdout: 'status: ok' }));
    const stuck = new Promise<void>(() => undefined);
    const onCreditsRestored = vi.fn((_evidenceAt: number) => stuck);
    const watchdog = new CreditWatchdog(() => runner, store, makeStatusBar(), new SanitizedLogger(), watchdogOpts, onCreditsRestored);

    const before = Date.now();
    await watchdog.pollNow();
    const after = Date.now();

    expect(onCreditsRestored).toHaveBeenCalledTimes(1);
    const evidenceAt = onCreditsRestored.mock.calls[0]![0];
    expect(evidenceAt).toBeGreaterThanOrEqual(before);
    expect(evidenceAt).toBeLessThanOrEqual(after);
    watchdog.dispose();
  });

  it('a notification that rejects is observed: no unhandled rejection and the poll still completes', async () => {
    // Real timers: the case waits one real macrotask for an `unhandledRejection`, and a successful
    // poll arms no timer, so nothing here needs the fake clock (it would also fake `setImmediate`).
    vi.useRealTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const runner = makeRunner(async () => makeRawOutput({ stdout: 'status: ok' }));
      const watchdog = new CreditWatchdog(
        () => runner, store, makeStatusBar(), new SanitizedLogger(), watchdogOpts,
        () => Promise.reject(new Error('the admission failed'))
      );

      await expect(watchdog.pollNow()).resolves.toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
      watchdog.dispose();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('has no skip flag and no delayed-retry options: a credit poll always runs /status', async () => {
    const runner = makeRunner(async () => makeRawOutput({ stdout: 'status: ok' }));
    const watchdog = new CreditWatchdog(() => runner, store, makeStatusBar(), new SanitizedLogger(), watchdogOpts, async () => {});

    expect('skipNextStatusCheck' in (watchdog as unknown as Record<string, unknown>)).toBe(false);
    // The options a delayed retry used to pass are not read: they cannot shorten the wait or skip the check.
    const withOptions = watchdog.pauseAndPoll as unknown as (cause: string, options: unknown) => Promise<void>;
    await withOptions.call(watchdog, 'transient_error', { durationOverrideMs: 5, skipStatusCheck: true });
    expect(store.getWatchdog().nextPollAt).toBe(Date.now() + watchdogOpts.pollIntervalMs);
    await vi.advanceTimersByTimeAsync(watchdogOpts.pollIntervalMs + 100);

    expect(runner.invoke).toHaveBeenCalledTimes(1);
    watchdog.dispose();
  });
});
