// Feature FR-R3-006 (T350) — what a reset does when something goes wrong.
//
// The success path is the easy half and the KEYS-completeness test already
// covers the clear itself. This file covers the three ways the transaction can
// be interrupted, because each one has a *different* correct answer and getting
// them confused is how the pre-feature implementation behaved:
//
//   1. **Cancellation fails.** A phase is still running when the quiesce window
//      elapses. The reset must refuse and clear nothing — clearing alongside a
//      live subprocess is the exact state the feature exists to make impossible,
//      and it is worse than not resetting because the subprocess then writes into
//      a state that no longer describes it.
//
//   2. **The clear is interrupted part-way.** The host dies between the mark and
//      the commit. The marker must be left reading `in-progress`, and the next
//      activation must finish it — a partially cleared state is indistinguishable
//      from a whole one by inspection, so "notice and report" is not enough.
//
//   3. **A write lands after the operator confirmed.** A `setRun` or
//      `updateQueue` racing the clear must complete wholly before it or queue
//      behind it. Landing *inside* the clear is what put a recreated key into a
//      freshly reset workspace, and it is what the serialize chain now prevents.
//
// The store is exercised directly against a `Memento` double, and the command
// against a `ResetHost` double, so the failures can be injected at the exact
// instruction they occur at rather than approximated with timing.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unfencedCommit } from '../../../src/state/ownership-claim';

// `vi.hoisted` rather than bare module-level consts: `vi.mock` is hoisted above
// the imports, and the imports below pull in `vscode` while the consts are still
// in their temporal dead zone. This is the same shape `multi-root.test.ts` uses.
const mocks = vi.hoisted(() => ({
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn()
}));

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: mocks.showInformationMessage,
    showWarningMessage: mocks.showWarningMessage,
    showErrorMessage: mocks.showErrorMessage
  }
}));

// Imports after the vscode mock registration — `reset.ts` reaches the window API
// through it.
import {
  runReset,
  RESET_CONFIRM_LABEL,
  RESET_CANCEL_LABEL,
  type ResetHost,
  type ResetStageSupport
} from '../../../src/commands/reset';
import type { WorkspaceStateResetPayload } from '../../../src/contracts/audit-events';
import {
  KEYS,
  RESET_CLEARED_KEYS,
  WorkspaceStateStore,
  type Memento
} from '../../../src/state/workspace-state';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';

const { showInformationMessage, showWarningMessage, showErrorMessage } = mocks;

class RecordingMemento implements Memento {
  public readonly writes: Array<{ key: string; value: unknown }> = [];
  /** Throw from `update` once the predicate matches, simulating a dead host. */
  public failOn: ((key: string, writeIndex: number) => boolean) | null = null;
  private readonly map = new Map<string, unknown>();

  public get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }

  public update(key: string, value: unknown): Thenable<void> {
    if (this.failOn?.(key, this.writes.length)) {
      return Promise.reject(new Error('memento write failed'));
    }
    this.writes.push({ key, value });
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

function stubLogger(): {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface HostDouble {
  readonly host: ResetHost;
  readonly stopProducers: ReturnType<typeof vi.fn>;
  readonly reload: ReturnType<typeof vi.fn>;
  readonly recorded: WorkspaceStateResetPayload[];
}

function hostDouble(quiesce: ResetStageSupport['quiesce']): HostDouble {
  const recorded: WorkspaceStateResetPayload[] = [];
  const stopProducers = vi.fn(async () => undefined);
  const reload = vi.fn(async () => undefined);
  const support: ResetStageSupport = {
    quiesce,
    recordReset: async (payload) => {
      recorded.push(payload);
    }
  };
  return {
    host: { support: () => support, stopProducers, reload },
    stopProducers,
    reload,
    recorded
  };
}

function seed(memento: RecordingMemento): void {
  for (const key of Object.values(KEYS)) void memento.update(key, { seeded: true });
}

beforeEach(() => {
  showInformationMessage.mockReset();
  showWarningMessage.mockReset();
  showErrorMessage.mockReset();
  showInformationMessage.mockResolvedValue(RESET_CONFIRM_LABEL);
});

describe('FR-R3-006 — cancellation failure refuses the reset', () => {
  it('clears nothing when the quiesce window elapses with work still running', async () => {
    const memento = new RecordingMemento();
    seed(memento);
    const store = new WorkspaceStateStore(memento);
    const double = hostDouble(async () => ({ ok: false, reason: 'runner-still-active' }));
    memento.writes.length = 0;

    const outcome = await runReset({ store, logger: stubLogger() as never, host: double.host });

    expect(outcome).toEqual({
      status: 'refused',
      reason: 'runner-still-active',
      phase: 'quiesce'
    });
    // The load-bearing assertion: not one key was touched.
    expect(memento.writes).toEqual([]);
    expect(memento.get(KEYS.queue)).toEqual({ seeded: true });
    // Including the marker — a refusal is not a reset, so nothing claims a
    // generation and nothing later looks like an interrupted one to finish.
    expect(store.getResetMarker()).toBeNull();
  });

  it('leaves the window intact — no teardown, no reload', async () => {
    const store = new WorkspaceStateStore(new RecordingMemento());
    const double = hostDouble(async () => ({ ok: false, reason: 'runner-still-active' }));

    await runReset({ store, logger: stubLogger() as never, host: double.host });

    // An operator told "no" gets a working window back. Tearing down and
    // reloading around a refusal would drop and re-acquire primacy for an
    // operation that did nothing.
    expect(double.stopProducers).not.toHaveBeenCalled();
    expect(double.reload).not.toHaveBeenCalled();
  });

  it('records the refusal with its reason and no generation', async () => {
    const store = new WorkspaceStateStore(new RecordingMemento());
    const double = hostDouble(async () => ({ ok: false, reason: 'runner-still-active' }));

    await runReset({ store, logger: stubLogger() as never, host: double.host });

    expect(double.recorded).toEqual([
      {
        outcome: 'refused',
        phaseReached: 'quiesce',
        generation: null,
        refusalReason: 'runner-still-active',
        canceledRunCount: 0
      }
    ]);
  });

  it('treats a quiesce that throws as a refusal, not as a reason to clear', async () => {
    const memento = new RecordingMemento();
    seed(memento);
    const store = new WorkspaceStateStore(memento);
    const double = hostDouble(async () => {
      throw new Error('controller exploded');
    });
    memento.writes.length = 0;

    const outcome = await runReset({ store, logger: stubLogger() as never, host: double.host });

    expect(outcome).toEqual({
      status: 'refused',
      reason: 'quiesce-failed',
      phase: 'quiesce'
    });
    expect(memento.writes).toEqual([]);
  });

  it('does not confirm-and-clear when the operator declines', async () => {
    showInformationMessage.mockResolvedValue(RESET_CANCEL_LABEL);
    const memento = new RecordingMemento();
    seed(memento);
    const store = new WorkspaceStateStore(memento);
    const double = hostDouble(async () => ({ ok: true, canceledRunCount: 0 }));
    memento.writes.length = 0;

    const outcome = await runReset({ store, logger: stubLogger() as never, host: double.host });

    expect(outcome).toEqual({ status: 'declined' });
    expect(memento.writes).toEqual([]);
    expect(double.stopProducers).not.toHaveBeenCalled();
  });
});

describe('FR-R3-006 — a partially-applied clear is detectable and completable', () => {
  it('leaves the marker in-progress when the clear dies part-way', async () => {
    const memento = new RecordingMemento();
    seed(memento);
    const store = new WorkspaceStateStore(memento);
    // Die on the third cleared key, well after the mark and well before the
    // commit — the shape of a host that was killed mid-clear.
    const victim = RESET_CLEARED_KEYS[2]!;
    memento.failOn = (key) => key === victim;

    await expect(store.reset()).rejects.toThrow('memento write failed');

    expect(store.getResetMarker()).toEqual({ generation: 1, status: 'in-progress' });
    // And the state really is half-cleared: keys before the victim are gone,
    // keys after it are not. This is the state that used to be invisible.
    expect(memento.get(RESET_CLEARED_KEYS[0]!)).toBeUndefined();
    expect(memento.get(RESET_CLEARED_KEYS[3]!)).toEqual({ seeded: true });
  });

  it('finishes the interrupted clear on the next activation, at the same generation', async () => {
    const memento = new RecordingMemento();
    seed(memento);
    const store = new WorkspaceStateStore(memento);
    memento.failOn = (key) => key === RESET_CLEARED_KEYS[2];
    await expect(store.reset()).rejects.toThrow();
    memento.failOn = null;

    // A fresh store over the same memento is the next activation.
    const next = new WorkspaceStateStore(memento);
    const completed = await next.completeInterruptedReset();

    expect(completed, 'the completion reports the generation it finished').toBe(1);
    expect(next.getResetMarker()).toEqual({ generation: 1, status: 'complete' });
    for (const key of RESET_CLEARED_KEYS) {
      expect(memento.get(key), `${key} must be cleared by the completion`).toBeUndefined();
    }
  });

  it('is a no-op when the last reset committed', async () => {
    const memento = new RecordingMemento();
    const store = new WorkspaceStateStore(memento);
    await store.reset();
    memento.writes.length = 0;

    expect(await store.completeInterruptedReset()).toBeNull();
    expect(memento.writes, 'a completed reset must not be re-run').toEqual([]);
  });

  it('is a no-op on a workspace that has never been reset', async () => {
    const memento = new RecordingMemento();
    seed(memento);
    const store = new WorkspaceStateStore(memento);
    memento.writes.length = 0;

    expect(await store.completeInterruptedReset()).toBeNull();
    expect(memento.writes).toEqual([]);
    expect(memento.get(KEYS.queue)).toEqual({ seeded: true });
  });

  it('ignores an unreadable marker rather than refusing to reset', async () => {
    const memento = new RecordingMemento();
    await memento.update(KEYS.resetMarker, { generation: 'not-a-number' });
    const store = new WorkspaceStateStore(memento);

    expect(store.getResetMarker()).toBeNull();
    expect(await store.completeInterruptedReset()).toBeNull();
    // A corrupt marker must not be able to block the one command an operator
    // reaches for when the state is already wrong.
    expect(await store.reset()).toBe(1);
  });

  it('reports the failed clear without pretending it succeeded', async () => {
    const memento = new RecordingMemento();
    seed(memento);
    const store = new WorkspaceStateStore(memento);
    memento.failOn = (key) => key === RESET_CLEARED_KEYS[2];
    const double = hostDouble(async () => ({ ok: true, canceledRunCount: 2 }));

    const outcome = await runReset({ store, logger: stubLogger() as never, host: double.host });

    expect(outcome).toEqual({ status: 'failed', reason: 'clear-failed', phase: 'clear' });
    // The window still comes back — a failed clear must not also cost the
    // operator their primacy for the rest of the session.
    expect(double.reload).toHaveBeenCalledTimes(1);
    expect(double.recorded).toEqual([
      {
        outcome: 'failed',
        phaseReached: 'clear',
        generation: null,
        refusalReason: 'clear-failed',
        canceledRunCount: 2
      }
    ]);
  });
});

describe('FR-R3-006 — a write racing the clear cannot land inside it', () => {
  it('completes a concurrent queue write wholly before the clear', async () => {
    const memento = new RecordingMemento();
    const store = new WorkspaceStateStore(memento);

    // Start a queue write, then a reset, without awaiting between them: the
    // ordering has to come from the serialize chain, not from the test.
    const write = store.updateQueue(
      (queue) => ({ queue: { ...queue, paused: true }, result: undefined }),
      DEFAULT_QUEUE_ID,
      unfencedCommit('test-fixture')
    );
    const reset = store.reset();
    await Promise.all([write, reset]);

    const queueWrites = memento.writes.filter((w) => w.key === KEYS.queue);
    const clearIndex = memento.writes.findIndex(
      (w) => w.key === KEYS.queue && w.value === undefined
    );
    expect(queueWrites.length).toBeGreaterThanOrEqual(2);
    // The clear is the LAST thing written to that key. If the concurrent write
    // had interleaved, a defined value would follow the undefined one and the
    // key would be back in a workspace the operator was told was cleared.
    expect(
      memento.writes.slice(clearIndex + 1).some((w) => w.key === KEYS.queue),
      'no write to the queue key may follow the clear'
    ).toBe(false);
    expect(memento.get(KEYS.queue)).toBeUndefined();
  });

  it('queues a write issued after the reset behind the whole clear', async () => {
    const memento = new RecordingMemento();
    const store = new WorkspaceStateStore(memento);

    const reset = store.reset();
    const write = store.updateQueue(
      (queue) => ({ queue: { ...queue, paused: true }, result: undefined }),
      DEFAULT_QUEUE_ID,
      unfencedCommit('test-fixture')
    );
    await Promise.all([reset, write]);

    // This one legitimately lands after the clear — it was issued after it —
    // and the point is that it lands wholly after rather than in the middle.
    const clearIndex = memento.writes.findIndex(
      (w) => w.key === KEYS.queue && w.value === undefined
    );
    // Hand-rolled reverse scan: this package targets ES2022 and `findLastIndex`
    // is ES2023.
    let markerCommitIndex = -1;
    for (let index = memento.writes.length - 1; index >= 0; index -= 1) {
      if (memento.writes[index]!.key === KEYS.resetMarker) {
        markerCommitIndex = index;
        break;
      }
    }
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(
      markerCommitIndex,
      'the commit marker must be written before the queued write resumes'
    ).toBeGreaterThan(clearIndex);
    const laterQueueWrite = memento.writes.findIndex(
      (w, index) => index > clearIndex && w.key === KEYS.queue
    );
    expect(laterQueueWrite).toBeGreaterThan(markerCommitIndex);
  });

  it('does not wedge subsequent writes when a reset fails', async () => {
    const memento = new RecordingMemento();
    const store = new WorkspaceStateStore(memento);
    memento.failOn = (key) => key === RESET_CLEARED_KEYS[2];
    await expect(store.reset()).rejects.toThrow();
    memento.failOn = null;

    // The chain stores the swallowed promise, so the next write proceeds rather
    // than inheriting a rejection forever.
    await expect(
      store.updateQueue(
        (queue) => ({ queue: { ...queue, paused: true }, result: undefined }),
        DEFAULT_QUEUE_ID,
        unfencedCommit('test-fixture')
      )
    ).resolves.toBeUndefined();
    expect(memento.get(KEYS.queue)).not.toBeUndefined();
  });
});
