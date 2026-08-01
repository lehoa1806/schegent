import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ZippedStreamBuffer } from '../../../src/runner/zipped-stream-buffer';
import { CreditWatchdog } from '../../../src/watchdog/credit-watchdog';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { Memento } from '../../../src/state/workspace-state';
import type { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { RawInvocationOutput } from '../../../src/runner/invocation-result';

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
  return { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
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
  timeoutMs: 60_000
};

let memento: FakeMemento;
let store: WorkspaceStateStore;

beforeEach(async () => {
  vi.useFakeTimers();
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CreditWatchdog.pauseAndPoll', () => {
  it('persists paused state with cause and next poll time', async () => {
    const watchdog = new CreditWatchdog(
      makeRunner(async () => makeRawOutput({ stdout: 'status: ok' })),
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
      makeRunner(async () => makeRawOutput({})),
      store,
      statusBar,
      new SanitizedLogger(),
      watchdogOpts,
      async () => {}
    );
    await watchdog.pauseAndPoll('rate-limit');
    expect(statusBar.update).toHaveBeenCalledWith(expect.objectContaining({ kind: 'paused' }));
    watchdog.dispose();
  });
});

describe('CreditWatchdog poll behavior', () => {
  it('resumes when /status reports ok', async () => {
    const runner = makeRunner(async () => makeRawOutput({
      stdout: 'status: ok'
    }));
    const onResume = vi.fn(async () => {});
    const watchdog = new CreditWatchdog(runner, store, makeStatusBar(), new SanitizedLogger(), watchdogOpts, onResume);

    await watchdog.pauseAndPoll('rate-limit');
    await vi.advanceTimersByTimeAsync(watchdogOpts.pollIntervalMs + 100);
    await Promise.resolve();
    await Promise.resolve();

    expect(onResume).toHaveBeenCalled();
    expect(store.getWatchdog().paused).toBe(false);
    expect(store.getWatchdog().lastStatusOk).toBe(true);
    watchdog.dispose();
  });

  it('keeps polling when /status reports not ok', async () => {
    const runner = makeRunner(async () => makeRawOutput({
      stdout: 'still rate limited'
    }));
    const onResume = vi.fn(async () => {});
    const watchdog = new CreditWatchdog(runner, store, makeStatusBar(), new SanitizedLogger(), watchdogOpts, onResume);

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
      makeRunner(async () => makeRawOutput({})),
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
    const runner = makeRunner(async () => makeRawOutput({
      stdout: 'credits available'
    }));
    const watchdog = new CreditWatchdog(runner, store, makeStatusBar(), new SanitizedLogger(), watchdogOpts, onResume);

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
      makeRunner(async () => makeRawOutput({
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
      makeRunner(async () => makeRawOutput({
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
