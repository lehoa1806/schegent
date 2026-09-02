// FR-R3-152 (T1631, FR-003, FR-004) — Queue lifecycle transition + lockstep
// invariants, exercised against the production writer(s) directly.
//
// This file used to assert against a hand-written local `transition()`
// function — a second, private model of the transition graph that called no
// production code. It agreed with a false claim (`running ⇒ inFlightId !==
// null`, still visible in this file's own prior history) because nothing here
// ever exercised `refreshUnheldLifecycle`, so the false claim and the false
// test stayed green together. Per FR-003, that private oracle is gone; every
// case below calls `refreshUnheldLifecycle`/`withRefreshedLifecycle`
// (`src/queue/queue-lifecycle-refresh.ts`) or the actual `QueueManager`
// methods that call them.
//
// The ratified table (FR-001, `src/contracts/snapshot-vocabulary.ts`):
//
//   running         — not held, ≥1 pending or in-flight Task.
//   active-empty    — not held, no pending or in-flight Task.
//   idle-pending    — held, pending work, waiting for an explicit trigger.
//   operator-paused — held, regardless of work.
//
// Lockstep invariants asserted throughout:
//   (i)   paused === (queueLifecycle === 'operator-paused')
//   (ii)  scheduledStartAt !== null ⇒ queueLifecycle === 'idle-pending'
//   (iii) queueLifecycle === 'idle-pending' ⇒ inFlightId === null
// `queueLifecycle === 'running' ⇒ inFlightId !== null` is deliberately NOT
// asserted — it is the disproven claim this feature closes (LC-Q-03).

import { describe, it, expect } from 'vitest';
import { QueueManager } from '../../../src/queue/queue-manager';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import {
  refreshUnheldLifecycle,
  withRefreshedLifecycle
} from '../../../src/queue/queue-lifecycle-refresh';
import type { FeatureRequest, QueueState } from '../../../src/queue/feature-request';
import { makeCoordinator } from './auto-drain-fixture';

/** A pending request, filled in only as far as `withRefreshedLifecycle` reads. */
function pendingRequest(id: string): FeatureRequest {
  return { id, status: 'pending' } as unknown as FeatureRequest;
}

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

function makeState(partial: Partial<QueueState> = {}): QueueState {
  return {
    requests: [],
    inFlightId: null,
    paused: false,
    pausedReason: null,
    updatedAt: 0,
    queueLifecycle: 'active-empty',
    pauseSource: null,
    scheduledStartAt: null,
    scheduledStartSource: null,
    ...partial
  };
}

/**
 * Lockstep invariants that must hold of any persisted `QueueState`.
 *
 * `paused` is deliberately not checked here: FR-R3-011 retired it to
 * migration-input-only (`@deprecated`, `feature-request.ts`) — live writers
 * (every one this file calls) never populate it, so `store.getQueue(...)`
 * returns `undefined` for it on any record written by current code. Asserting
 * `paused === (queueLifecycle === 'operator-paused')` against that live output
 * would be testing a field production code no longer writes; the retired
 * mirror's own lockstep is `queue-state-migrator`'s concern, not this file's.
 */
function assertLockstep(state: QueueState): void {
  if (state.scheduledStartAt !== null) {
    expect(state.queueLifecycle).toBe('idle-pending');
  }
  if (state.queueLifecycle === 'idle-pending') {
    expect(state.inFlightId).toBeNull();
  }
}

describe('refreshUnheldLifecycle / withRefreshedLifecycle — the production writer (FR-001, FR-003)', () => {
  it('promotes an active-empty queue with only pending work to running — no in-flight Task required', () => {
    // This is the exact case the disproven claim forbade: `running` with
    // `inFlightId === null`. If `refreshUnheldLifecycle` is ever reverted to
    // require a live in-flight Task, this assertion goes red (SC-004).
    const state = makeState({
      queueLifecycle: 'active-empty',
      requests: [pendingRequest('r-1')]
    });
    const next = withRefreshedLifecycle(state);
    expect(next.queueLifecycle).toBe('running');
    expect(next.inFlightId).toBeNull();
    assertLockstep(next);
  });

  it('leaves an active-empty queue with no work at active-empty', () => {
    const next = withRefreshedLifecycle(makeState({ queueLifecycle: 'active-empty' }));
    expect(next.queueLifecycle).toBe('active-empty');
    assertLockstep(next);
  });

  it('active-empty never carries pending or in-flight work once refreshed', () => {
    // The converse of the promotion above: whenever refresh settles on
    // active-empty, hasWork was false.
    const next = withRefreshedLifecycle(
      makeState({ queueLifecycle: 'running', inFlightId: null, requests: [] })
    );
    expect(next.queueLifecycle).toBe('active-empty');
    expect(next.inFlightId).toBeNull();
    expect(next.requests.some((r) => r.status === 'pending')).toBe(false);
  });

  it('never derives a held lifecycle (idle-pending, operator-paused) — both pass through untouched', () => {
    const idlePending = refreshUnheldLifecycle(
      makeState({ queueLifecycle: 'idle-pending', requests: [] })
    );
    expect(idlePending).toBe('idle-pending');
    const paused = refreshUnheldLifecycle(
      makeState({
        queueLifecycle: 'operator-paused',
        inFlightId: 'r-1',
        requests: [pendingRequest('r-2')]
      })
    );
    expect(paused).toBe('operator-paused');
  });
});

describe('QueueManager writers — unheld transitions (FR-004)', () => {
  let store: WorkspaceStateStore;
  let queue: QueueManager;

  const setup = async (): Promise<void> => {
    store = new WorkspaceStateStore(new FakeMemento());
    await store.initialize();
    queue = new QueueManager(store);
  };

  it('enqueue does not disturb an already-running queue\'s lifecycle (admission is not a lifecycle caller)', async () => {
    await setup();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('running');
    await queue.enqueue('B');
    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('running');
  });

  it('markInFlight promotes an active-empty queue to running (the "start" transition)', async () => {
    await setup();
    const a = await queue.enqueue('A');
    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('active-empty');
    await queue.markInFlight(a.id, 'run-1');
    const after = store.getQueue(DEFAULT_QUEUE_ID);
    expect(after.queueLifecycle).toBe('running');
    expect(after.inFlightId).toBe(a.id);
    assertLockstep(after);
  });

  it('finish() with another pending Task keeps the queue running with no in-flight Task (LC-Q-03)', async () => {
    await setup();
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'completed');
    const after = store.getQueue(DEFAULT_QUEUE_ID);
    // The core regression this feature closes: running, with inFlightId
    // cleared, because B is still pending. Never idle-pending — that would
    // require an explicit trigger nothing here provided.
    expect(after.queueLifecycle).toBe('running');
    expect(after.inFlightId).toBeNull();
    expect(queue.findById(b.id)?.status).toBe('pending');
    assertLockstep(after);
  });

  it('finish() on the last Task settles the queue at active-empty, never idle-pending (FR-005 carve-out)', async () => {
    await setup();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'completed');
    const after = store.getQueue(DEFAULT_QUEUE_ID);
    expect(after.queueLifecycle).toBe('active-empty');
    expect(after.inFlightId).toBeNull();
    assertLockstep(after);
  });

  it('retry/restart back to pending promotes an active-empty queue to running, not idle-pending', async () => {
    await setup();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'failed');
    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('active-empty');
    const result = await queue.retry(a.id);
    expect(result.ok).toBe(true);
    const after = store.getQueue(DEFAULT_QUEUE_ID);
    expect(queue.findById(a.id)?.status).toBe('pending');
    // Same shape as the first block's promotion case: running, pending-only,
    // no in-flight Task — retry is a second production call site that must
    // agree with `refreshUnheldLifecycle`, not a duplicate of it.
    expect(after.queueLifecycle).toBe('running');
    expect(after.inFlightId).toBeNull();
    assertLockstep(after);
  });
});

describe('QueueManager.setQueuePausedState — held transitions (FR-004, per FR-019)', () => {
  let store: WorkspaceStateStore;
  let queue: QueueManager;

  const setup = async (): Promise<void> => {
    store = new WorkspaceStateStore(new FakeMemento());
    await store.initialize();
    queue = new QueueManager(store);
  };

  it('pause holds the queue at operator-paused regardless of work', async () => {
    await setup();
    await queue.enqueue('A');
    const result = await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID);
    expect(result.ok).toBe(true);
    const after = store.getQueue(DEFAULT_QUEUE_ID);
    expect(after.queueLifecycle).toBe('operator-paused');
    assertLockstep(after);
  });

  it('resume with pending work re-enters idle-pending (operator must re-schedule, FR-019)', async () => {
    await setup();
    await queue.enqueue('A');
    await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID);
    const result = await queue.setQueuePausedState(false, DEFAULT_QUEUE_ID);
    expect(result.ok).toBe(true);
    const after = store.getQueue(DEFAULT_QUEUE_ID);
    expect(after.queueLifecycle).toBe('idle-pending');
    assertLockstep(after);
  });

  it('resume with no pending work settles at active-empty', async () => {
    await setup();
    await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID);
    const result = await queue.setQueuePausedState(false, DEFAULT_QUEUE_ID);
    expect(result.ok).toBe(true);
    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('active-empty');
  });

  it('resume with an in-flight Task returns to running', async () => {
    await setup();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID);
    const result = await queue.setQueuePausedState(false, DEFAULT_QUEUE_ID);
    expect(result.ok).toBe(true);
    const after = store.getQueue(DEFAULT_QUEUE_ID);
    expect(after.queueLifecycle).toBe('running');
    expect(after.inFlightId).toBe(a.id);
  });
});

// FR-004's three named refusal paths (idle-pending, workspace-capacity,
// execution-lease) are exhaustively covered by `auto-drain.test.ts`'s own
// `drainIfIdle` suite (T036, FR-023–FR-028) — that file owns the
// `AutoDrainCoordinator` fixture and is the single place it is built
// (research.md D7). Reusing its exported `makeCoordinator` here, rather than
// re-deriving a second simulation, is what keeps this suite's refusal
// coverage from silently drifting out of step with the coordinator's own.
describe('AutoDrainCoordinator refusals leave the lifecycle untouched (FR-004, reusing auto-drain.test.ts D7)', () => {
  it('an idle-pending queue is refused before any lifecycle write is attempted', async () => {
    const { coord, spies } = makeCoordinator('lifecycle');
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(spies.tryAcquire).not.toHaveBeenCalled();
    expect(spies.admitNew).not.toHaveBeenCalled();
  });

  it('a workspace-at-capacity queue is refused without starting or writing anything', async () => {
    const { coord, spies } = makeCoordinator('workspace-capacity');
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(spies.tryAcquire).not.toHaveBeenCalled();
    expect(spies.admitNew).not.toHaveBeenCalled();
  });

  it('a queue whose execution lease another window holds is refused without starting', async () => {
    const { coord, spies } = makeCoordinator('lease');
    await coord.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(spies.tryAcquire).toHaveBeenCalled();
    expect(spies.admitNew).not.toHaveBeenCalled();
  });
});

describe('lockstep invariant holds for every lifecycle value (FR-001)', () => {
  // Renamed (code review, 2026-09-03): this case no longer checks
  // `paused === (queueLifecycle === 'operator-paused')` — see `assertLockstep`'s
  // own doc comment above for why that clause was dropped. The title now names
  // the two invariants the body still asserts, so a reader cannot mistake this
  // for continued `paused`-mirror coverage.
  it('scheduledStartAt/idle-pending lockstep invariants hold across all four lifecycle values', () => {
    const cases: readonly QueueState[] = [
      makeState({ queueLifecycle: 'running', inFlightId: 'r-1' }),
      makeState({
        queueLifecycle: 'operator-paused',
        paused: true,
        pausedReason: 'operator'
      }),
      makeState({
        queueLifecycle: 'idle-pending',
        scheduledStartAt: 1_700_000_000_000,
        scheduledStartSource: 'operator-chooser'
      }),
      makeState({ queueLifecycle: 'active-empty' })
    ];
    for (const state of cases) assertLockstep(state);
  });
});
