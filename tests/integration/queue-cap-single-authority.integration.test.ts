// FR-R3-145 (T1572) — the queue configuration surface reads back its own write,
// out of the store the drain gates on.
//
// Covers:
//   SC-004 / FR-009 — set the cap through the path `CMD_SAVE_QUEUE_SETTINGS`
//                     takes, re-project, and read the value `QueueConfigModal`
//                     seeds its input from. It is the value that was set.
//   FR-010         — that value is the one `hasExecutionCapacity` gates on,
//                     asserted against `store.getGlobalConcurrencyCap()`.
//   FR-011         — every surface resolving a default queue resolves it from
//                     the same store, so the id the modal shows is the id an
//                     unrouted Task lands on.
//
// WHY BOTH ASSERTIONS, WHEN THE FIRST LOOKS SUFFICIENT
//
// Read-back alone is a weaker claim than it reads as. It says the surface is
// self-consistent — write a number, see that number — and it would pass just as
// happily if the modal and its save had *both* been pointed at a store nothing
// schedules against. That is not a contrived worry; it is one refactor away from
// the defect this feature exists to fix, which was the opposite arrangement:
// the modal seeded from `readGeneralSettings(...)` — the configuration
// projection by construction — while its save wrote `store.setGlobalConcurrencyCap`,
// and the ack (`handler-helpers.ts` calls `ack(ctx, 'accepted')` with no result
// argument) echoed nothing. The re-projection that did fire re-read
// configuration, which the save had never written, so the modal reopened showing
// the number the operator had just replaced and the save looked lost. Meanwhile
// the drain was gating on the memento the whole time, which is the half an
// operator could not see at all.
//
// So the second assertion names the reader instead of the writer. The displayed
// value is compared to `store.getGlobalConcurrencyCap()` — the exact expression
// in `QueueManager.hasExecutionCapacity`, not a number this test carried in from
// the save — and then to the predicate's own behaviour at the boundary. A test
// that only compared the surface to itself could not tell a single authority
// from two agreeing ones.
//
// The harness is the one `per-queue-snapshot-isolation.test.ts` established: a
// `FakeMemento` behind a real `WorkspaceStateStore`, a real `QueueManager` over
// it, and a real `StateProjector` composing the wire snapshot. Nothing here is a
// double for the thing under test — the point is that one store is reached by
// three different paths and answers all three the same way.

import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_GLOBAL_CONCURRENCY_CAP } from '../../src/contracts/queue-bounds';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { QueueManager } from '../../src/queue/queue-manager';
import { createQueue } from '../../src/queue/queue-registry';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import type { WorkflowSnapshot } from '../../src/ui/sidebar/snapshot';
import { StateProjector } from '../../src/ui/sidebar/state-projector';

/** A second queue, so the default-queue read-back is not the cold value by luck. */
const QUEUE_B = 'c7a1e9d4-3b52-4f68-9a0c-1d2e3f4a5b6c';

/**
 * A cap that is neither the cold default nor a bound. `1` would let a projection
 * that ignored the write entirely pass, and `MAX_GLOBAL_CONCURRENCY_CAP` would
 * let one that clamped everything to the ceiling pass.
 */
const CHOSEN_CAP = 7;

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
let queue: QueueManager;

beforeEach(async () => {
  store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  queue = new QueueManager(store);
  await store.setQueueRegistry(
    createQueue(store.getQueueRegistry(), {
      id: QUEUE_B,
      name: 'Queue B',
      now: 1_700_000_000_000
    })
  );
});

/**
 * The wire snapshot the webview receives. `queueSettings` is what
 * `QueueConfigModal` seeds `initialCap()` and `initialDefaultQueue()` from, so
 * reading it here is reading what the operator would see on reopening the modal.
 */
function project(): WorkflowSnapshot {
  const projector = new StateProjector({
    store,
    ownerId: 'cap-authority-window',
    sanitize: (value: string | null | undefined) => value ?? ''
  });
  projector.start();
  const snapshot = projector.getCurrentSnapshot();
  projector.dispose();
  return snapshot;
}

/**
 * The save the modal performs. `CMD_SAVE_QUEUE_SETTINGS` dispatches to
 * `cmd-save-queue-settings.ts`, which forwards to `ops.saveQueueSettings` —
 * this method. Called directly rather than through the router because the router
 * hop adds an ack envelope and nothing else: the validation, the range refusal
 * and both memento writes are all here.
 */
async function saveThroughTheCommandPath(cap: number, defaultQueueId: string): Promise<void> {
  const result = await queue.saveQueueSettings({
    globalConcurrencyCap: cap,
    defaultQueueId
  });
  // Asserted rather than assumed: a refusal would leave the store untouched and
  // every assertion below would then be checking that two unchanged values
  // agree, which they trivially would.
  expect(result, 'the save must be accepted, or the read-back proves nothing').toEqual({
    ok: true,
    queueId: defaultQueueId
  });
}

describe('queue settings read back out of the store that decides (SC-004, FR-009)', () => {
  it('shows the cold value before any save, so the assertions below measure a change', () => {
    // The control on the read-back: without it, a projection hard-wired to
    // `CHOSEN_CAP` would satisfy every other test in this file.
    const cold = project().queueSettings;
    expect(cold.globalConcurrencyCap).toBe(DEFAULT_GLOBAL_CONCURRENCY_CAP);
    expect(cold.defaultQueueId).toBe(DEFAULT_QUEUE_ID);
    expect(CHOSEN_CAP).not.toBe(DEFAULT_GLOBAL_CONCURRENCY_CAP);
    expect(QUEUE_B).not.toBe(DEFAULT_QUEUE_ID);
  });

  it('seeds the reopened modal with the cap that was saved', async () => {
    await saveThroughTheCommandPath(CHOSEN_CAP, QUEUE_B);
    expect(project().queueSettings.globalConcurrencyCap).toBe(CHOSEN_CAP);
  });

  it('seeds the reopened modal with the default queue that was saved', async () => {
    await saveThroughTheCommandPath(CHOSEN_CAP, QUEUE_B);
    expect(project().queueSettings.defaultQueueId).toBe(QUEUE_B);
  });
});

describe('the displayed cap is the cap the drain gates on (FR-010)', () => {
  it('equals the value hasExecutionCapacity reads, not the value the surface wrote', async () => {
    await saveThroughTheCommandPath(CHOSEN_CAP, QUEUE_B);
    const displayed = project().queueSettings.globalConcurrencyCap;

    // This is the assertion read-back cannot make. The right-hand side is the
    // expression at the enforcement site — `liveRunCount < this.store.getGlobalConcurrencyCap()`
    // — evaluated against the same store the scheduler holds, and NOT the number
    // this test handed to the save. If the projection were re-pointed at a second
    // store tomorrow, the read-back tests above would still pass while this one
    // would not, which is exactly the both-sides-wrong case it exists to rule out.
    expect(displayed).toBe(store.getGlobalConcurrencyCap());
  });

  it('is the value the capacity predicate actually flips at', async () => {
    await saveThroughTheCommandPath(CHOSEN_CAP, QUEUE_B);
    const displayed = project().queueSettings.globalConcurrencyCap;

    // The same claim stated as behaviour rather than as an accessor comparison.
    // A getter can agree with the surface and still not be the thing consulted;
    // the boundary cannot. One live Run below the displayed number admits
    // another, and the displayed number itself refuses.
    expect(queue.hasExecutionCapacity(displayed - 1)).toBe(true);
    expect(queue.hasExecutionCapacity(displayed)).toBe(false);
  });
});

describe('the displayed default queue is the queue tasks are routed to (FR-011)', () => {
  it('equals the id the store answers with', async () => {
    await saveThroughTheCommandPath(CHOSEN_CAP, QUEUE_B);
    expect(project().queueSettings.defaultQueueId).toBe(store.getDefaultQueueId());
  });

  it('is where an unrouted Task lands', async () => {
    await saveThroughTheCommandPath(CHOSEN_CAP, QUEUE_B);
    const displayed = project().queueSettings.defaultQueueId;

    // The behavioural half, for the same reason as the cap's. Routing is the
    // question `defaultQueueId` answers, and before this feature the host
    // answered it from the memento while the webview answered it from the
    // configuration projection — two surfaces, two stores, one question.
    const task = await queue.enqueue('a task with no queue named');
    expect(task.queueId).toBe(displayed);
    expect(task.queueId).not.toBe(DEFAULT_QUEUE_ID);
  });
});
