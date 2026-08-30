// Regression: a retried or restarted Task returns to `pending` and nothing ever
// starts it.
//
// `AutoDrainCoordinator` is edge-triggered — a drain happens only where a call
// site asks for one — and the retry/restart command paths asked for none. Three
// source comments claimed "the dequeue pump picks it up on the next tick"; no
// such pump exists, and the belief in one is why the omission survived three
// separate implementations. The operator saw the row go back to `pending` and
// sit there with no Run, no log, and no refusal.
//
// Two halves are asserted here, because the fix has two halves:
//
//   1. The trigger. `runRetryQueuedItem` and `runRestartCanceledTask` now report
//      the queue the row landed on, which is what lets their `ui-wiring`
//      registrations drain *that* queue (never a defaulted sweep of Default).
//   2. The lifecycle. `finish`/`markInFlight`/`retry` had no `queueLifecycle`
//      writer at all, so the badge lied about what was running. The refresh must
//      stay inside the two *unheld* lifecycles: deriving `idle-pending` here
//      would make `drainQueueOnce` step 1 refuse every queue's own continuation.

import { describe, it, expect, beforeEach } from 'vitest';
import { QueueManager } from '../../src/queue/queue-manager';
import { WorkspaceStateStore } from '../../src/state/workspace-state';
import { AutoDrainCoordinator } from '../../src/services/auto-drain-coordinator';
import { SanitizedLogger, type LogSink } from '../../src/lib/logger';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { runRetryQueuedItem } from '../../src/commands/queue-ops';
import { runRestartCanceledTask } from '../../src/commands/restart-canceled-task';
import { FakeMemento } from './enqueue-start-separation.helpers';

class CapturingSink implements LogSink {
  public readonly lines: string[] = [];
  appendLine(line: string): void {
    this.lines.push(line);
  }
}

describe('retry / restart-canceled supply a drain trigger (lifecycle round-check finding A)', () => {
  let store: WorkspaceStateStore;
  let queue: QueueManager;
  let logger: SanitizedLogger;
  let promoted: string[];
  let coordinator: AutoDrainCoordinator;
  let notices: string[];

  beforeEach(async () => {
    store = new WorkspaceStateStore(new FakeMemento());
    await store.initialize();
    logger = new SanitizedLogger([new CapturingSink()]);
    queue = new QueueManager(store, logger);
    promoted = [];
    notices = [];
    const controller = {
      admitNew: async (req: { id: string }) => {
        promoted.push(req.id);
        return { completed: Promise.resolve() };
      },
      admitResume: async () => ({ resumed: false, completed: Promise.resolve() }),
      get liveRunCount(): number {
        return promoted.length;
      }
    };
    const lease = {
      tryAcquire: async () => ({ acquired: true as const, ownerId: 'w-test' }),
      release: async () => undefined,
      claimFor: () => null
    };
    coordinator = new AutoDrainCoordinator({
      store,
      queue,
      executionLease: lease as never,
      controller: controller as never
    });
  });

  function opsCtx() {
    const notify = (m: string) => notices.push(m);
    return {
      queue,
      lock: { hasPrimacy: async () => true } as never,
      notifier: { info: notify, warn: notify, error: notify } as never,
      logger
    };
  }

  function restartCtx(taskId: string) {
    const notify = (m: string) => notices.push(m);
    return {
      store,
      queue,
      audit: { append: async () => undefined } as never,
      notifier: { info: notify, warn: notify, error: notify } as never,
      logger,
      taskId
    };
  }

  /** Enqueue, run, and fail a Task — the state the operator presses Retry on. */
  async function failedTask(queueId?: string) {
    const task = await queue.enqueue('do the thing', queueId ? { queueId } : {});
    await queue.markInFlight(task.id, 'run-1');
    await queue.finish(task.id, 'failed', 'boom');
    await coordinator.drainAll(); // the Run's own terminal drain: nothing pending
    expect(promoted).toEqual([]);
    return task;
  }

  it('retry reports the queue to drain, and draining it starts the Task', async () => {
    const task = await failedTask();

    const result = await runRetryQueuedItem({ id: task.id }, opsCtx());

    expect(result).toEqual({ ok: true, queueId: DEFAULT_QUEUE_ID });
    expect(queue.findById(task.id)?.status).toBe('pending');
    // The trigger the registration now fires with `result.queueId`.
    if (!result.ok) throw new Error('retry was refused');
    await coordinator.drainIfIdle(result.queueId);
    expect(promoted).toEqual([task.id]);
  });

  it('restart-canceled reports the queue to drain, and draining it starts the Task', async () => {
    const task = await queue.enqueue('do the other thing');
    expect(await queue.cancel(task.id)).toBe(true);

    const result = await runRestartCanceledTask(restartCtx(task.id));

    expect(result).toEqual({ ok: true, queueId: DEFAULT_QUEUE_ID });
    expect(queue.findById(task.id)?.status).toBe('pending');
    if (!result.ok) throw new Error('retry was refused');
    await coordinator.drainIfIdle(result.queueId);
    expect(promoted).toEqual([task.id]);
  });

  it('names the Task’s own queue, not Default', async () => {
    const created = await queue.createQueue('Release');
    const queueB = created.queueId!;
    const task = await failedTask(queueB);

    const retried = await runRetryQueuedItem({ id: task.id }, opsCtx());
    expect(retried).toEqual({ ok: true, queueId: queueB });
    expect(store.getQueue(DEFAULT_QUEUE_ID).requests).toHaveLength(0);

    const canceled = await queue.enqueue('another', { queueId: queueB });
    await queue.cancel(canceled.id);
    const restarted = await runRestartCanceledTask(restartCtx(canceled.id));
    expect(restarted).toEqual({ ok: true, queueId: queueB });
  });

  it('a refused retry reports no queue, so the caller fires no drain', async () => {
    const task = await queue.enqueue('still pending');

    // `pending` is not a retryable status.
    const result = await runRetryQueuedItem({ id: task.id }, opsCtx());

    expect(result).toEqual({ ok: false, reason: 'illegal-state' });
    expect(promoted).toEqual([]);
  });
});

describe('queueLifecycle tracks the work on the queue (lifecycle round-check finding B)', () => {
  let store: WorkspaceStateStore;
  let queue: QueueManager;

  beforeEach(async () => {
    store = new WorkspaceStateStore(new FakeMemento());
    await store.initialize();
    queue = new QueueManager(store, new SanitizedLogger([new CapturingSink()]));
  });

  const lifecycle = () => store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle;

  it('a queue that finished its last Task no longer badges Running', async () => {
    const task = await queue.enqueue('only task');
    await queue.markInFlight(task.id, 'run-1');
    expect(lifecycle()).toBe('running');

    await queue.finish(task.id, 'completed');

    // Before the fix, `finish` had no `queueLifecycle` writer, so this stayed
    // `'running'` with `inFlightId === null` — and survived reloads, because the
    // v6 to v7 migration is idempotent.
    expect(store.getQueue(DEFAULT_QUEUE_ID).inFlightId).toBeNull();
    expect(lifecycle()).toBe('active-empty');
  });

  it('stays running while pending work remains, so the queue drains its own continuation', async () => {
    const first = await queue.enqueue('first');
    await queue.enqueue('second');
    await queue.markInFlight(first.id, 'run-1');
    await queue.finish(first.id, 'completed');

    // The load-bearing assertion. `run-driver` calls `scheduleAutoDrain()` after
    // this `finish`, and `drainQueueOnce` step 1 refuses an `idle-pending`
    // queue — deriving that here would stop every queue after its first Task.
    expect(lifecycle()).toBe('running');
  });

  it('pausing the in-flight Task refreshes it too', async () => {
    const task = await queue.enqueue('a task');
    const next = await queue.enqueue('another');
    await queue.markInFlight(task.id, 'run-1');
    expect(lifecycle()).toBe('running');

    // Pausing clears `inFlightId`, but `next` is still pending, so the queue is
    // still one the drain should visit.
    await queue.pause(task.id);
    expect(lifecycle()).toBe('running');

    await queue.cancel(next.id);
    expect(lifecycle()).toBe('active-empty');
  });

  it('leaves enqueue alone — admission owns the lifecycle of new work', async () => {
    // `QueueManager.enqueue` writes no lifecycle by design:
    // `GuardedRunService.applyStartIntentPolicy` decides whether newly admitted
    // work lands `running` or is held `idle-pending` behind the FR-018 chooser,
    // and its `append-tail-no-chooser` branch preserves the lifecycle on
    // purpose. Refreshing here would overrule that policy from underneath.
    const task = await queue.enqueue('first');
    await queue.markInFlight(task.id, 'run-1');
    await queue.finish(task.id, 'completed');
    expect(lifecycle()).toBe('active-empty');

    await queue.enqueue('admitted by the manager alone');
    expect(lifecycle()).toBe('active-empty');
  });

  it('leaves the held lifecycles alone, so no retry releases a hold', async () => {
    // operator-paused: the queue is held by the operator. Retry requeues the
    // row; it must not hand the queue back to the drain.
    const task = await queue.enqueue('held task');
    await queue.markInFlight(task.id, 'run-1');
    await queue.finish(task.id, 'failed', 'boom');
    await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID, 'operator asked');
    expect(lifecycle()).toBe('operator-paused');

    expect((await queue.retry(task.id)).ok).toBe(true);
    expect(queue.findById(task.id)?.status).toBe('pending');
    expect(lifecycle()).toBe('operator-paused');
  });

  it('leaves idle-pending alone, so the idle-pending gate stays the single site', async () => {
    const task = await queue.enqueue('held task');
    await queue.markInFlight(task.id, 'run-1');
    await queue.finish(task.id, 'failed', 'boom');

    const held = store.getQueue(DEFAULT_QUEUE_ID);
    await store.setQueue({ ...held, queueLifecycle: 'idle-pending' });

    expect((await queue.retry(task.id)).ok).toBe(true);
    expect(lifecycle()).toBe('idle-pending');
  });
});
