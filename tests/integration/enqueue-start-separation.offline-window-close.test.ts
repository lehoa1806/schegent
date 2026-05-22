// Feature 065 (T050 / Q12 / Edge Cases / FR-018) — offline window-close.
//
// Scenario: operator enqueues a task on an empty queue, the chooser
// surfaces, then they close the window WITHOUT committing the chooser.
// On the next workspace open, the queue must still hold the pending task
// at the head of pending, the lifecycle must be `idle-pending` with
// `scheduledStartAt === null` (no schedule was committed), and the
// chooser MUST NOT auto-open. Instead, the "Start queue" affordance is
// exposed (FR-018).
//
// Coverage:
//   (a) enqueue + chooser opens (modeled: operator submits a task with
//       NO startIntent on an empty queue → host policy lands the task in
//       `idle-pending` because the human caller did not commit a chooser
//       choice).
//   (b) simulate window close: do NOT commit the chooser (we never
//       dispatch a follow-up `CMD_START_QUEUE`).
//   (c) reload the workspace state from the shared memento (modeling
//       VS Code re-activation against the persisted state).
//   (d) assert pending head-of-queue invariant, lifecycle is
//       `idle-pending`, `scheduledStartAt === null`.
//   (e) the webview re-renders; the chooser is NOT auto-opened — the
//       `QueueInputForm.svelte` only mounts the chooser when there is an
//       in-flight draft (`pendingDraft !== null`), and across reloads the
//       draft is not persisted. Instead the queue panel exposes the
//       `Start queue` affordance via `ScheduledStartIndicator` (when
//       `scheduledStartAt != null`) or a `Start queue` button (when
//       `scheduledStartAt === null`, per T051).

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

interface OpenWorkspace {
  readonly store: WorkspaceStateStore;
  readonly service: GuardedRunService;
}

async function openWorkspace(memento: FakeMemento, clock: MutableClock): Promise<OpenWorkspace> {
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  const lock = new WorkspaceLockManager(store, 'owner-1', clock, noopScheduler);
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

describe('Feature 065 (T050 / Q12 / FR-018) — offline window-close', () => {
  let memento: FakeMemento;
  let clock: MutableClock;

  beforeEach(() => {
    memento = new FakeMemento();
    clock = new MutableClock(1_700_000_000_000);
  });

  it('(a-e) enqueue without intent → close → reload preserves task, idle-pending, no auto-open chooser', async () => {
    // (a) Operator enqueues a task on the empty queue (no startIntent —
    // they would have committed the chooser, but instead closed the window).
    const win = await openWorkspace(memento, clock);
    const result = await win.service.scheduleOrEnqueue({
      description: 'task awaiting operator decision',
      scheduledAt: clock.now(),
      via: 'webview',
      callerKind: 'human'
    });
    expect(result.outcome).toBe('enqueued');
    expect(result.lifecycleAfter).toBe('idle-pending');

    // (b) Window close is modeled as "no further command dispatches".
    // We simply drop the in-process objects; the memento persists.

    // (c) Re-open the workspace state from the shared memento (modeling
    // VS Code activation).
    const reloaded = await openWorkspace(memento, clock);
    const queue = reloaded.store.getQueue();

    // (d) The task survived: lifecycle is idle-pending with no schedule.
    const pendingItems = queue.requests.filter((r) => r.status === 'pending');
    expect(pendingItems.length).toBe(1);
    expect(pendingItems[0].description).toBe('task awaiting operator decision');
    expect(pendingItems[0].position).toBe(0); // head-of-queue invariant
    expect(queue.queueLifecycle).toBe('idle-pending');
    expect(queue.scheduledStartAt).toBeNull();
    expect(queue.scheduledStartSource).toBeNull();

    // (e) No persisted "open chooser" / "pendingDraft" state — those
    // live only on the webview component. Across a workspace reload,
    // the queue's pending draft is gone (it was the textarea, not the
    // queue), and the queue's persisted state has no marker that would
    // cause the chooser to auto-mount. The webview only mounts the
    // chooser when `pendingDraft !== null && lifecycle === 'active-empty'`
    // (per QueueInputForm.svelte), and `idle-pending` fails that gate.
    // We assert the host-side contract: the persisted state has nothing
    // that would force the webview to surface the chooser.
    expect(queue.queueLifecycle).not.toBe('active-empty');
  });
});
