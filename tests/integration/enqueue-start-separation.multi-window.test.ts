// Feature 065 (T049 / FR-019a) — multi-window contention.
//
// Two VS Code windows on the same workspace share the same persisted
// queue state (single source of truth: `WorkspaceStateStore` reads the
// VS Code Memento). When window A opens the start-mode chooser against
// `active-empty` and window B enqueues a task at the same moment, the
// queue lifecycle transitions to `idle-pending` from window B's side.
// Window A's snapshot tick (which mirrors the workspace state) MUST
// reflect that transition, and window A's chooser MUST close silently
// without dispatching IPC (no race-condition double-enqueue, no
// confirmation prompt). Window A's webview surface then renders a
// non-modal `queue state changed elsewhere — refresh to continue`
// notice (this surface is covered by the component test for the
// notice; here we exercise the underlying host-level state contract).
//
// We model two windows by:
//   - Sharing a single `FakeMemento` instance between two distinct
//     `WorkspaceStateStore` instances (window A and window B). The
//     stores must observe each other's writes when they reload.
//   - Wiring a per-window `GuardedRunService` so each window enqueues
//     independently. Both services target the same underlying queue.
//
// The test asserts:
//   (1) After window A initializes its store with `active-empty`,
//       window B's enqueue (no startIntent → host policy lands in
//       `idle-pending` because the queue was empty and no chooser
//       intent is present) flips the persisted lifecycle.
//   (2) Reloading window A's store reflects the new lifecycle (the
//       persistence boundary is the FakeMemento; the chooser-close
//       trigger lives in the webview's $effect on `snapshot.queue.lifecycle`).
//   (3) No IPC dispatch happened from window A during the lifecycle
//       transition — we never invoked `service.scheduleOrEnqueue` on
//       window A's side. (The webview's silent-close logic is
//       inherently a "no-IPC" path; the integration test asserts the
//       state contract that makes the webview detection possible.)

import { describe, expect, it, beforeEach } from 'vitest';
import { WorkspaceStateStore } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { GuardedRunService } from '../../src/services/guarded-run-service';
import { WorkspaceLockManager } from '../../src/state/lock';
import { AutoDrainCoordinator } from '../../src/services/auto-drain-coordinator';
import { ScheduledStartCoordinator } from '../../src/services/scheduled-start-coordinator';
import {
  FakeMemento,
  MutableClock,
  makeFakeTimerControl,
  makeLogger,
  makeAuditCapture,
  makeCatalog,
  makeController,
  noopScheduler
} from './enqueue-start-separation.helpers';
import type { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import type { SanitizedLogger } from '../../src/lib/logger';
import type { AuditLogWriter } from '../../src/audit/audit-log-writer';

interface WindowFixture {
  readonly store: WorkspaceStateStore;
  readonly service: GuardedRunService;
}

async function makeWindow(
  ownerId: string,
  memento: FakeMemento,
  clock: MutableClock
): Promise<WindowFixture> {
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  const lock = new WorkspaceLockManager(store, ownerId, clock, noopScheduler);
  const logger = makeLogger();
  const audit = makeAuditCapture();
  const fakeTimer = makeFakeTimerControl(clock);
  const catalog = makeCatalog(['default']);
  const controller = makeController({ catalog });
  const autoDrain = new AutoDrainCoordinator({
    store,
    queue,
    lock,
    controller: controller as unknown as SchegentWorkflowController
  });
  const coordinator = new ScheduledStartCoordinator({
    store,
    auditWriter: audit as unknown as Pick<AuditLogWriter, 'append'>,
    logger: logger as unknown as Pick<SanitizedLogger, 'warn'>,
    onFire: async () => {
      const cur = store.getQueue();
      if (cur.queueLifecycle === 'idle-pending') {
        await store.setQueue({
          ...cur,
          queueLifecycle: 'running',
          scheduledStartAt: null,
          scheduledStartSource: null,
          updatedAt: clock.now()
        });
      }
      await autoDrain.drainIfIdle();
    },
    now: () => clock.now(),
    setTimer: fakeTimer.setTimer,
    clearTimer: fakeTimer.clearTimer
  });
  const service = new GuardedRunService({
    lock,
    queue,
    controller: controller as unknown as SchegentWorkflowController,
    logger: logger as unknown as SanitizedLogger,
    audit: audit as unknown as AuditLogWriter,
    store,
    cliPathProvider: () => process.execPath,
    workspaceRoot: '/tmp',
    clock: () => clock.now(),
    catalogProvider: () => catalog,
    scheduledStartCoordinator: coordinator
  });
  return { store, service };
}

describe('Feature 065 (T049 / FR-019a) — multi-window contention', () => {
  let memento: FakeMemento;
  let clock: MutableClock;

  beforeEach(async () => {
    memento = new FakeMemento();
    clock = new MutableClock(1_700_000_000_000);
  });

  it('window B enqueues without intent → window A reload sees lifecycle moved out of active-empty', async () => {
    // Window A initializes first; queue starts active-empty.
    const winA = await makeWindow('window-A', memento, clock);
    const lifecycleA0 = winA.store.getQueue().queueLifecycle;
    expect(lifecycleA0).toBe('active-empty');

    // Window B initializes against the SAME memento — it sees the same
    // lifecycle. (This mirrors a second VS Code window opening on the
    // same workspace.)
    const winB = await makeWindow('window-B', memento, clock);
    const lifecycleB0 = winB.store.getQueue().queueLifecycle;
    expect(lifecycleB0).toBe('active-empty');

    // Window B enqueues a task with NO startIntent (the standard
    // operator enqueue path). Per host policy table T012: empty queue +
    // human caller without intent → land in `idle-pending` with
    // `scheduledStartAt: null` (the chooser would normally surface on
    // window B's side, but the test simulates the operator submitting
    // WITHOUT committing the chooser — the host policy still drops the
    // task into pending and the lifecycle to `idle-pending`).
    const resultB = await winB.service.scheduleOrEnqueue({
      description: 'cross-window task',
      scheduledAt: clock.now(),
      via: 'webview',
      callerKind: 'human'
    });
    expect(resultB.outcome).toBe('enqueued');
    expect(resultB.lifecycleAfter).toBe('idle-pending');

    // Window A reloads its store (simulating a snapshot tick that
    // re-reads the underlying memento). The lifecycle MUST reflect
    // window B's write.
    const winA2 = await makeWindow('window-A-reload', memento, clock);
    const lifecycleA1 = winA2.store.getQueue().queueLifecycle;
    expect(lifecycleA1).toBe('idle-pending');
    expect(lifecycleA1).not.toBe(lifecycleA0);
  });

  it('window A never invokes its own service during the cross-window transition (no race-double-enqueue)', async () => {
    const winA = await makeWindow('window-A', memento, clock);
    const winB = await makeWindow('window-B', memento, clock);

    // Window B does an enqueue.
    await winB.service.scheduleOrEnqueue({
      description: 'cross-window task',
      scheduledAt: clock.now(),
      via: 'webview',
      callerKind: 'human'
    });

    // The integration-level surface for FR-019a is: window A's view of
    // the queue reflects window B's write WITHOUT window A having
    // invoked its own `scheduleOrEnqueue` (the webview's silent-close
    // is a UI-side $effect that triggers on snapshot.queue.lifecycle).
    // We assert window A's queue contents match window B's persisted
    // contents — proving the snapshot tick from window A is sufficient
    // to see the transition without dispatching its own enqueue.
    const winA2 = await makeWindow('window-A-reload', memento, clock);
    const requestsFromA = winA2.store.getQueue().requests.filter((r) => r.status === 'pending');
    const requestsFromB = winB.store.getQueue().requests.filter((r) => r.status === 'pending');
    expect(requestsFromA.length).toBe(1);
    expect(requestsFromA[0].description).toBe('cross-window task');
    expect(requestsFromA[0].id).toBe(requestsFromB[0].id);
    void winA; // window A is the "open chooser" side; never invoked here.
  });
});
