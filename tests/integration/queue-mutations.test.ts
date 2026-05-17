import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { MessageRouter } from '../../src/ui/sidebar/message-router';
import { SanitizedLogger } from '../../src/lib/logger';
import type { CommandAckMessage } from '../../src/ui/sidebar/messages';
import {
  CMD_RETRY_QUEUE_ITEM,
  CMD_MOVE_QUEUE_ITEM_UP,
  CMD_MOVE_QUEUE_ITEM_DOWN,
  CMD_PAUSE_QUEUE,
  CMD_RESUME_QUEUE,
  CMD_CLEAR_FAILED,
  CMD_CLEAR_COMPLETED
} from '../../src/ui/sidebar/messages';

class MockMemento implements Memento {
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

interface BuiltSystem {
  store: WorkspaceStateStore;
  queue: QueueManager;
  router: MessageRouter;
  acks: CommandAckMessage[];
  warnings: string[];
  postAck: (m: CommandAckMessage) => Promise<boolean>;
  isPrimary: { value: boolean };
}

async function build(): Promise<BuiltSystem> {
  const memento = new MockMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  const acks: CommandAckMessage[] = [];
  const warnings: string[] = [];
  const isPrimary = { value: true };
  const router = new MessageRouter({
    executeCommand: <T>(): Promise<T> => Promise.resolve(undefined as unknown as T),
    queueRemover: queue,
    queueOps: queue,
    isPrimary: () => isPrimary.value,
    isTrusted: () => true,
    notifyWarning: (m) => warnings.push(m),
    logger: new SanitizedLogger()
  });
  const postAck = async (m: CommandAckMessage): Promise<boolean> => {
    acks.push(m);
    return true;
  };
  return { store, queue, router, acks, warnings, postAck, isPrimary };
}

describe('Queue mutations integration (T044)', () => {
  let sys: BuiltSystem;

  beforeEach(async () => {
    sys = await build();
  });

  it('end-to-end: enqueue, fail, retry, reorder, pause, resume, clearFailed', async () => {
    const a = await sys.queue.enqueue('feature A — first');
    const b = await sys.queue.enqueue('feature B — second');
    const c = await sys.queue.enqueue('feature C — third');
    expect(sys.queue.list().map((r) => r.id)).toEqual([a.id, b.id, c.id]);

    // Mark A in-flight, fail it
    await sys.queue.markInFlight(a.id, 'run-A');
    await sys.queue.finish(a.id, 'failed', 'simulated stub failure');
    let aRow = sys.queue.findById(a.id);
    expect(aRow?.status).toBe('failed');
    expect(aRow?.lastError).toBe('simulated stub failure');

    // Retry A via router
    await sys.router.dispatch(
      { type: CMD_RETRY_QUEUE_ITEM, correlationId: 'r1', payload: { id: a.id } },
      sys.postAck
    );
    expect(sys.acks.at(-1)?.status).toBe('accepted');
    aRow = sys.queue.findById(a.id);
    expect(aRow?.status).toBe('pending');
    expect(aRow?.retryCount).toBe(1);
    expect(aRow?.lastError).toBeNull();
    // A must be at head of pending (no in-flight, so position 0)
    expect(sys.queue.list()[0].id).toBe(a.id);

    // Reorder: move B up (B is at position 1, A at 0). After Feature 030
    // (US2) the up/down handlers route through `reorderTaskInUnifiedQueue`,
    // which mutates the `position` field rather than the underlying array
    // order. Operators see the queue sorted by `position` everywhere, so
    // assertions compare the position-sorted view.
    await sys.router.dispatch(
      { type: CMD_MOVE_QUEUE_ITEM_UP, correlationId: 'mu1', payload: { id: b.id } },
      sys.postAck
    );
    expect(sys.acks.at(-1)?.status).toBe('accepted');
    const sortedAfterMoveUp = sys.queue
      .list()
      .slice()
      .sort((x, y) => x.position - y.position);
    expect(sortedAfterMoveUp.map((r) => r.id)).toEqual([b.id, a.id, c.id]);
    expect(sortedAfterMoveUp.map((r) => r.position)).toEqual([0, 1, 2]);

    // Move A down (A was at position 1 after the previous moveUp; moving
    // down swaps with C and produces [b, c, a] by position).
    await sys.router.dispatch(
      { type: CMD_MOVE_QUEUE_ITEM_DOWN, correlationId: 'md1', payload: { id: a.id } },
      sys.postAck
    );
    const sortedAfterMoveDown = sys.queue
      .list()
      .slice()
      .sort((x, y) => x.position - y.position);
    expect(sortedAfterMoveDown.map((r) => r.id)).toEqual([b.id, c.id, a.id]);

    // Pause queue via router
    await sys.router.dispatch(
      { type: CMD_PAUSE_QUEUE, correlationId: 'pq1' },
      sys.postAck
    );
    expect(sys.acks.at(-1)?.status).toBe('accepted');
    expect(sys.store.getQueue().paused).toBe(true);

    // Mark B in-flight then finish completed (in-flight isn't started by router; the controller
    // would orchestrate this; for the contract, we just verify pause does NOT mutate inFlightId)
    await sys.queue.markInFlight(b.id, 'run-B');
    await sys.queue.finish(b.id, 'completed');
    expect(sys.store.getQueue().paused).toBe(true); // still paused

    // Resume queue
    await sys.router.dispatch(
      { type: CMD_RESUME_QUEUE, correlationId: 'rq1' },
      sys.postAck
    );
    expect(sys.acks.at(-1)?.status).toBe('accepted');
    expect(sys.store.getQueue().paused).toBe(false);

    // Fail C, then clearFailed
    await sys.queue.markInFlight(c.id, 'run-C');
    await sys.queue.finish(c.id, 'failed', 'oops');
    await sys.router.dispatch({ type: CMD_CLEAR_FAILED, correlationId: 'cf1' }, sys.postAck);
    expect(sys.acks.at(-1)?.status).toBe('accepted');
    const remainingIds = sys.queue.list().map((r) => r.id);
    expect(remainingIds).not.toContain(c.id);

    // clearCompleted removes B
    await sys.router.dispatch({ type: CMD_CLEAR_COMPLETED, correlationId: 'cc1' }, sys.postAck);
    expect(sys.acks.at(-1)?.status).toBe('accepted');
    expect(sys.queue.list().map((r) => r.id)).toEqual([a.id]);
  });

  it('rejects mutations on secondary window with reason secondary-window-readonly', async () => {
    sys.isPrimary.value = false;
    const a = await sys.queue.enqueue('feature A');
    await sys.router.dispatch(
      { type: CMD_RETRY_QUEUE_ITEM, correlationId: 'sec1', payload: { id: a.id } },
      sys.postAck
    );
    expect(sys.acks.at(-1)?.status).toBe('rejected');
    expect(sys.acks.at(-1)?.reason).toBe('secondary-window-readonly');
    // queue state unchanged
    expect(sys.queue.findById(a.id)?.retryCount).toBe(0);
  });

  it('illegal-state retry of completed item: notifies + rejects, no exception', async () => {
    const a = await sys.queue.enqueue('feature A');
    await sys.queue.markInFlight(a.id, 'run-A');
    await sys.queue.finish(a.id, 'completed');
    await expect(
      sys.router.dispatch(
        { type: CMD_RETRY_QUEUE_ITEM, correlationId: 'illeg1', payload: { id: a.id } },
        sys.postAck
      )
    ).resolves.toBeUndefined();
    expect(sys.acks.at(-1)?.status).toBe('rejected');
    expect(sys.acks.at(-1)?.reason).toBe('illegal-state');
    expect(sys.warnings.length).toBe(1);
  });

  it('moveUp at the head of pending surfaces structured rejection', async () => {
    const a = await sys.queue.enqueue('feature A');
    const b = await sys.queue.enqueue('feature B');
    void b;
    // A is at index 0, can't move up further. Feature 030 (US2, T032)
    // unified the arrow + drag handlers; the canonical rejection cause
    // for an out-of-range new position is `invalid-position`, replacing
    // the legacy `at-edge` token.
    await sys.router.dispatch(
      { type: CMD_MOVE_QUEUE_ITEM_UP, correlationId: 'mu-edge', payload: { id: a.id } },
      sys.postAck
    );
    expect(sys.acks.at(-1)?.status).toBe('rejected');
    expect(sys.acks.at(-1)?.reason).toBe('invalid-position');
    expect(sys.warnings.length).toBe(1);
  });
});
