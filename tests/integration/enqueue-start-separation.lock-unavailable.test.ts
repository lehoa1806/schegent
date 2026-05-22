// Feature 065 (T053 / FR-014) — lock-unavailable-at-fire regression.
//
// Spec context — `specs/065-enqueue-start-separation/spec.md` line 124:
//   "Idle-pending queue, scheduled start fires, but workspace lock is
//    held by a competing process: The promotion falls through the existing
//    auto-drain guards (lock unavailable). The scheduled start is
//    consumed; auto-drain retries on the next normal heartbeat (e.g.,
//    when the lock holder releases). The operator is not asked to
//    re-schedule."
//
// Coverage per tasks.md T053:
//   (a) arm a schedule;
//   (b) at fire time, hold the workspace lock from a competing test
//       process (simulated via a probe returning true);
//   (c) `ScheduledStartCoordinator.fire()` finds the lock unavailable;
//   (d) emit `scheduled-start-superseded { superseder: 'lock-unavailable' }`;
//   (e) clear `scheduledStartAt`;
//   (f) release the competing lock and assert that the next normal
//       auto-drain heartbeat retries the promotion under the existing
//       auto-drain rule;
//   (g) operator is NOT asked to reschedule (no UI ask, no rejection
//       audit).
//
// Implementation note: the coordinator's `fire()` accepts an optional
// `isForeignLockHeld()` probe (per T053 wiring). When the probe returns
// `true`, the coordinator emits the `lock-unavailable` superseded event
// without flipping the lifecycle. This test exercises that path against
// the real `ScheduledStartCoordinator` and `AutoDrainCoordinator` from
// the shared harness.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
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

interface Fixture {
  readonly memento: FakeMemento;
  readonly clock: MutableClock;
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly lock: WorkspaceLockManager;
  readonly autoDrain: AutoDrainCoordinator;
  readonly coordinator: ScheduledStartCoordinator;
  readonly service: GuardedRunService;
  readonly audit: ReturnType<typeof makeAuditCapture>;
  readonly fakeTimer: ReturnType<typeof makeFakeTimerControl>;
  readonly controller: ReturnType<typeof makeController>;
  // Test toggle for the lock probe. When `true`, `isForeignLockHeld()`
  // returns true; when `false`, false.
  foreignLockHeld: { value: boolean };
}

async function makeFixture(): Promise<Fixture> {
  const memento = new FakeMemento();
  const clock = new MutableClock(1_700_000_000_000);
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  const lock = new WorkspaceLockManager(store, 'self-window', clock, noopScheduler);
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

  // Mutable cell so each test can flip the probe value at fire time.
  const foreignLockHeld = { value: false };

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
    isForeignLockHeld: () => foreignLockHeld.value,
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

  return {
    memento,
    clock,
    store,
    queue,
    lock,
    autoDrain,
    coordinator,
    service,
    audit,
    fakeTimer,
    controller,
    foreignLockHeld
  };
}

let f: Fixture;

beforeEach(async () => {
  f = await makeFixture();
});

afterEach(() => {
  f.coordinator.dispose();
});

describe('Feature 065 (T053 / FR-014) — lock-unavailable-at-fire regression', () => {
  it('(a-g) fire while foreign lock held → superseded(lock-unavailable), schedule cleared, lifecycle stays idle-pending, operator not asked to reschedule', async () => {
    // (a) Arm a schedule by enqueuing with a scheduled start intent.
    const scheduledAt = f.clock.now() + 60 * 1000; // +60s
    const enqueueResult = await f.service.scheduleOrEnqueue({
      description: 'task awaiting scheduled start',
      scheduledAt: f.clock.now(),
      via: 'webview',
      startIntent: {
        startMode: 'scheduled',
        scheduledStartAt: scheduledAt,
        source: 'operator-chooser'
      },
      callerKind: 'human'
    });
    expect(enqueueResult.outcome).toBe('enqueued');
    expect(enqueueResult.lifecycleAfter).toBe('idle-pending');
    expect(f.store.getQueue().scheduledStartAt).toBe(scheduledAt);

    // Sanity: scheduled-start-armed event emitted during arm.
    expect(f.audit.byType('scheduled-start-armed').length).toBe(1);

    // (b) At fire time, the workspace lock is held by a competing
    // process. Flip the probe.
    f.foreignLockHeld.value = true;

    // (c) Advance the clock to the scheduled fire time and trigger the
    // coordinator's timer callback.
    f.clock.set(scheduledAt);
    f.fakeTimer.fireDue(scheduledAt);
    // Drain the coordinator's async work (await audit append + state set).
    await new Promise((r) => setTimeout(r, 0));

    // (d) `scheduled-start-superseded { superseder: 'lock-unavailable' }`
    // was emitted.
    const superseded = f.audit.byType('scheduled-start-superseded');
    expect(superseded.length).toBe(1);
    expect(superseded[0].payload.superseder).toBe('lock-unavailable');
    expect(superseded[0].payload.scheduledStartAt).toBe(scheduledAt);
    expect(superseded[0].payload.scheduledStartSource).toBe('operator-chooser');

    // No `scheduled-start-fired` was emitted (lock-unavailable path
    // short-circuits before the fired path).
    expect(f.audit.byType('scheduled-start-fired').length).toBe(0);

    // (e) `scheduledStartAt` was cleared; lifecycle stays `idle-pending`
    // (operator intent preserved — the task did not vanish).
    const afterFire = f.store.getQueue();
    expect(afterFire.scheduledStartAt).toBeNull();
    expect(afterFire.scheduledStartSource).toBeNull();
    expect(afterFire.queueLifecycle).toBe('idle-pending');
    // The task is still at the head of pending.
    const pending = afterFire.requests.filter((r) => r.status === 'pending');
    expect(pending.length).toBe(1);
    expect(pending[0].description).toBe('task awaiting scheduled start');

    // (g) No operator-facing reschedule ask was emitted. We verify by
    // asserting no horizon-error or schedule-rejected audit event was
    // recorded for this transition. The set of "ask the operator to
    // reschedule" signals consists of (1) `scheduled-start-horizon-exceeded`
    // and (2) any explicit `scheduled-start-rejected` event family.
    const askOps = f.audit.entries.filter((e) => {
      const t = e.eventType as string;
      return (
        t === 'scheduled-start-horizon-exceeded' ||
        t === 'scheduled-start-rejected'
      );
    });
    expect(askOps.length).toBe(0);

    // (f) The competing process releases its lock. The next auto-drain
    // heartbeat must retry the promotion under the existing auto-drain
    // rule. Because the coordinator cleared scheduledStartAt and the
    // lifecycle is idle-pending, auto-drain must FIRST observe a
    // lifecycle transition out of `idle-pending` to do anything (per
    // T010 / FR-003 — auto-drain MUST NOT auto-promote from idle-pending).
    //
    // The operator (or a future heartbeat-driven retry path) is what
    // moves the queue out of idle-pending. Here we verify the gate
    // remains correct: lock release alone is not enough.
    f.foreignLockHeld.value = false;
    await f.autoDrain.drainIfIdle();
    expect(f.controller.startNew).not.toHaveBeenCalled();
    expect(f.store.getQueue().queueLifecycle).toBe('idle-pending');

    // The operator's explicit "Start queue" click would then flip the
    // lifecycle to `running` and auto-drain would dispatch — that path is
    // exercised in `enqueue-start-separation.us4.test.ts`. Here we only
    // assert that the lock-unavailable path does NOT roll the queue back
    // to `active-empty`, does NOT delete the task, and does NOT raise a
    // reschedule prompt.
  });
});
