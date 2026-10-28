// FR-R4-F02 (spec 240, US6; contract W3 G9; research R3 finding 4; US6-5) — what a reload does with
// the persisted watchdog record.
//
// Before this feature a delayed retry was armed through the watchdog, so a `paused: true` record
// could mean "a retry is counting down" with no credit pause behind it, and a reload re-armed it
// as a credit poll. Delayed retries now run on the retry coordinator's own timer, so that record
// can only be a leftover. At `5d700407` (recorded in measurements.md, US6) such a record was
// re-armed and polled `/status`, and a recovered answer swept every Run; now it is cleared, with one
// metadata-only line, and nothing is polled.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { SanitizedLogger } from '../../../src/lib/logger';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { CreditWatchdog } from '../../../src/watchdog/credit-watchdog';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import { seedCreditPausedRun } from './credit-paused-run';

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
const STALE_RECORD = {
  paused: true,
  pausedSince: 1_000,
  nextPollAt: 2_000,
  pollIntervalMs: INTERVAL_MS,
  lastStatusOk: false,
  lastPollOutcome: 'not-recovered' as const,
  cause: 'transient_error'
};

let store: WorkspaceStateStore;
let invoke: ReturnType<typeof vi.fn>;
let onCreditsRestored: ReturnType<typeof vi.fn>;
let info: ReturnType<typeof vi.spyOn>;
let updateWindow: ReturnType<typeof vi.fn>;
let watchdog: CreditWatchdog;

beforeEach(async () => {
  vi.useFakeTimers();
  store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  invoke = vi.fn();
  onCreditsRestored = vi.fn();
  updateWindow = vi.fn();
  const logger = new SanitizedLogger();
  info = vi.spyOn(logger, 'info');
  watchdog = new CreditWatchdog(
    () => ({ invoke, cancelActive: vi.fn(), hasActiveProcess: false }) as never,
    store,
    { update: vi.fn(), updateWindow, dispose: vi.fn() } as unknown as SchegentStatusBar,
    logger,
    {
      pollIntervalMs: INTERVAL_MS,
      cliPath: 'claude',
      cwd: '/repo',
      timeoutMs: 60_000,
      environmentPolicy: { mode: 'inherit', inheritProcessEnv: true }
    },
    onCreditsRestored
  );
});

afterEach(() => {
  watchdog.dispose();
  vi.useRealTimers();
});

describe('a record with no open credit window', () => {
  it('is cleared at reattach, with one metadata-only line, and nothing is polled or swept', async () => {
    await store.setWatchdog(STALE_RECORD);

    await watchdog.reattachOnActivation();
    await vi.advanceTimersByTimeAsync(10 * INTERVAL_MS);

    expect(store.getWatchdog()).toMatchObject({ paused: false, nextPollAt: null, pausedSince: null, cause: null });
    expect(store.getWatchdog().lastPollOutcome).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(onCreditsRestored).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(updateWindow).toHaveBeenLastCalledWith(null);
    const cleared = info.mock.calls.filter(([, context]) => (context as { reasonCode?: string } | undefined)?.reasonCode === 'watchdog-stale-record-cleared');
    expect(cleared).toHaveLength(1);
    expect(JSON.stringify(cleared[0])).not.toMatch(/run-|queue|transient/);
  });

  it('is also cleared when the only credit-paused Run has had its window stopped', async () => {
    await seedCreditPausedRun(store, { pausedAt: 1, windowStartedAt: 2, stoppedAt: 3 });
    await store.setWatchdog(STALE_RECORD);

    await watchdog.reattachOnActivation();

    expect(store.getWatchdog().paused).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves an already-clear record alone: no write, no line', async () => {
    const before = store.getWatchdog();
    const write = vi.spyOn(store, 'setWatchdog');

    await watchdog.reattachOnActivation();

    expect(write).not.toHaveBeenCalled();
    expect(store.getWatchdog()).toEqual(before);
    expect(info).not.toHaveBeenCalled();
  });
});

describe('a record with an open credit window', () => {
  it('is re-armed for the time that was left, and the window is not touched', async () => {
    const windowStartedAt = Date.now() - INTERVAL_MS;
    await seedCreditPausedRun(store, { pausedAt: windowStartedAt - 1, windowStartedAt, stoppedAt: null });
    await store.setWatchdog({ ...STALE_RECORD, nextPollAt: Date.now() + 5_000, cause: 'rate-limit' });
    invoke.mockResolvedValue(undefined);

    await watchdog.reattachOnActivation();

    expect(vi.getTimerCount()).toBe(1);
    expect(store.getRun(DEFAULT_QUEUE_ID)?.creditPause).toMatchObject({ windowStartedAt, stoppedAt: null });
    expect(invoke).not.toHaveBeenCalled();
  });
});
