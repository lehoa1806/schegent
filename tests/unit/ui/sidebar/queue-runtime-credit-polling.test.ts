// FR-R4-F02 (spec 240, US6; contract W6 G17; data-model §10) — the `creditPolling` projection of a
// credit-paused Run, read through the real composition path (`StateProjector` ->
// `snapshot-composer.ts` -> `composeQueueRuntimes`), not a hand-built composer context.
//
// The projection is what lets the surface say "Credit polling stopped" and offer Resume, so each
// state is pinned from the persisted facts that decide it: the Run's `creditPause`, and the
// watchdog record's last poll outcome (window-wide).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AuditLogWriter } from '../../../../src/audit/audit-log-writer';
import { CREDIT_POLL_WINDOW_MS } from '../../../../src/contracts/retry-bounds';
import { DEFAULT_QUEUE_ID } from '../../../../src/contracts/queue-identity';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { WorkspaceStateStore, type Memento } from '../../../../src/state/workspace-state';
import { StateProjector } from '../../../../src/ui/sidebar/state-projector';
import { seedCreditPausedRun } from '../../watchdog/credit-paused-run';
import { runOf } from './queue-runtime-read.helpers';

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

let store: WorkspaceStateStore;
let audit: AuditLogWriter;
let tmpRoot: string;

beforeEach(async () => {
  store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-credit-polling-'));
  audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function projectNow() {
  const projector = new StateProjector({ store, audit, ownerId: 'this-window', debounceMs: 100 });
  projector.start();
  const snapshot = projector.getCurrentSnapshot();
  projector.dispose();
  return snapshot;
}

const WINDOW_STARTED = 1_700_000_000_000;

describe('creditPolling on the in-flight Run (W6 G17)', () => {
  it('is null for a Run that is not paused for credits', async () => {
    await seedCreditPausedRun(store, { pausedAt: 1, windowStartedAt: 2, stoppedAt: null }, DEFAULT_QUEUE_ID, {
      creditPause: null
    });

    expect(runOf(projectNow())?.creditPolling).toBeNull();
  });

  it('is null on a queue that holds no Run at all', () => {
    expect(runOf(projectNow())).toBeNull();
  });

  it('is `polling` with an open window and no poll outcome yet, ending 24 hours after it started', async () => {
    await seedCreditPausedRun(store, { pausedAt: 1, windowStartedAt: WINDOW_STARTED, stoppedAt: null });

    expect(runOf(projectNow())?.creditPolling).toEqual({
      state: 'polling',
      windowEndsAt: WINDOW_STARTED + CREDIT_POLL_WINDOW_MS
    });
  });

  it('is `polling` with an open window and a not-recovered last outcome', async () => {
    await seedCreditPausedRun(store, { pausedAt: 1, windowStartedAt: WINDOW_STARTED, stoppedAt: null });
    await store.setWatchdog({ ...store.getWatchdog(), lastPollOutcome: 'not-recovered' });

    expect(runOf(projectNow())?.creditPolling?.state).toBe('polling');
  });

  it('is `unreachable` with an open window when the last poll could not reach /status', async () => {
    await seedCreditPausedRun(store, { pausedAt: 1, windowStartedAt: WINDOW_STARTED, stoppedAt: null });
    await store.setWatchdog({ ...store.getWatchdog(), lastPollOutcome: 'unreachable' });

    expect(runOf(projectNow())?.creditPolling).toEqual({
      state: 'unreachable',
      windowEndsAt: WINDOW_STARTED + CREDIT_POLL_WINDOW_MS
    });
  });

  it('is `stopped` once the window has stopped, whatever the last outcome was', async () => {
    await seedCreditPausedRun(store, { pausedAt: 1, windowStartedAt: WINDOW_STARTED, stoppedAt: WINDOW_STARTED + 5 });
    await store.setWatchdog({ ...store.getWatchdog(), lastPollOutcome: 'unreachable' });

    expect(runOf(projectNow())?.creditPolling).toEqual({
      state: 'stopped',
      windowEndsAt: WINDOW_STARTED + CREDIT_POLL_WINDOW_MS
    });
  });

  it('has a null windowEndsAt before the first poll has started the window', async () => {
    await seedCreditPausedRun(store, { pausedAt: 1, windowStartedAt: null, stoppedAt: null });

    expect(runOf(projectNow())?.creditPolling).toEqual({ state: 'polling', windowEndsAt: null });
  });

  it('carries only the state and the end time: no status text, no Run id, nothing else', async () => {
    await seedCreditPausedRun(store, { pausedAt: 1, windowStartedAt: WINDOW_STARTED, stoppedAt: null });

    expect(Object.keys(runOf(projectNow())?.creditPolling ?? {}).sort()).toEqual(['state', 'windowEndsAt']);
  });
});
