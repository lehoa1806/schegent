import { describe, expect, it } from 'vitest';
import { FakeMemento } from '../enqueue-start-separation.helpers';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import { createConnectedRunService } from '../../../src/activation/ui-wiring';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import type { HistoryStore } from '../../../src/state/history-store';
import type { HistoryRecord } from '../../../src/state/history-entry';

// FR-R3-002 (T290) — a connected child on a non-Default queue reads `in-flight`.
//
// Seam 3 of FUNC-02: `readChildState` in `src/activation/ui-wiring.ts` asked
// `store.getQueue()` with no argument, which resolved the Default queue and
// searched only its `requests` array. A child running on any other queue was
// therefore absent from that array, fell through to the history fallback, found
// nothing there either, and resolved `null`.
//
// `null` is not a neutral answer at this seam. It means *no observation*, and
// the launcher's gate reads no observation as **settled** — so a live child was
// reported finished and the parent Workflow advanced past a node that was still
// executing. This is the worst-behaved of the four seams precisely because the
// wrong answer is the safe-looking one.
//
// The subject is `createConnectedRunService(...).readChildState`, composed over
// a real `WorkspaceStateStore` and a real `QueueManager` so the child is looked
// up exactly as the projector looks it up.

function makeHistory(entries: readonly HistoryRecord[] = []): Pick<HistoryStore, 'list'> {
  return { list: () => entries };
}

async function setup() {
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  const queue = new QueueManager(store);
  const created = await queue.createQueue('Release');
  const queueB = created.queueId!;
  return { store, queue, queueB };
}

describe('connected child on a non-Default queue (FR-R3-002)', () => {
  it('reads a pending child on a non-Default queue as in-flight, not settled', async () => {
    const { store, queue, queueB } = await setup();
    const child = await queue.enqueue('child pipeline', { queueId: queueB });
    const service = createConnectedRunService(store, makeHistory());

    // The premise of the regression: the child is genuinely not on Default, so
    // a Default-scoped read finds nothing and answers `null`.
    expect(store.getQueue(DEFAULT_QUEUE_ID).requests).toHaveLength(0);
    expect(store.getQueue(queueB).requests.map((r) => r.id)).toEqual([child.id]);
    expect(service.readChildState(child.id)).toBe('in-flight');
  });

  it('reads an executing child on a non-Default queue as in-flight', async () => {
    const { store, queue, queueB } = await setup();
    const child = await queue.enqueue('child pipeline', { queueId: queueB });
    await queue.markInFlight(child.id, 'run-1');
    const service = createConnectedRunService(store, makeHistory());

    expect(service.readChildState(child.id)).toBe('in-flight');
  });

  it('reads a completed child on a non-Default queue as completed, not null', async () => {
    const { store, queue, queueB } = await setup();
    const child = await queue.enqueue('child pipeline', { queueId: queueB });
    await queue.markInFlight(child.id, 'run-1');
    await queue.finish(child.id, 'completed');
    const service = createConnectedRunService(store, makeHistory());

    expect(service.readChildState(child.id)).toBe('completed');
  });

  it('reads a failed child on a non-Default queue as failed', async () => {
    const { store, queue, queueB } = await setup();
    const child = await queue.enqueue('child pipeline', { queueId: queueB });
    await queue.markInFlight(child.id, 'run-1');
    await queue.finish(child.id, 'failed', 'phase exited non-zero');
    const service = createConnectedRunService(store, makeHistory());

    expect(service.readChildState(child.id)).toBe('failed');
  });

  it('does not confuse two children with the same state on different queues', async () => {
    const { store, queue, queueB } = await setup();
    const onDefault = await queue.enqueue('default child', { queueId: DEFAULT_QUEUE_ID });
    const onB = await queue.enqueue('release child', { queueId: queueB });
    await queue.markInFlight(onDefault.id, 'run-a');
    await queue.finish(onDefault.id, 'completed');
    const service = createConnectedRunService(store, makeHistory());

    expect(service.readChildState(onDefault.id)).toBe('completed');
    expect(service.readChildState(onB.id)).toBe('in-flight');
  });

  it('still reads a Default-queue child correctly (behaviour unchanged)', async () => {
    const { store, queue } = await setup();
    const child = await queue.enqueue('child pipeline', { queueId: DEFAULT_QUEUE_ID });
    const service = createConnectedRunService(store, makeHistory());

    expect(service.readChildState(child.id)).toBe('in-flight');
  });

  it('still falls through to history for a child cleared from its queue', async () => {
    // The history fallback exists so that clearing completed items does not
    // turn every finished child reference into an unresolvable one. Scoping the
    // queue read must not disturb it.
    const { store, queue, queueB } = await setup();
    const child = await queue.enqueue('child pipeline', { queueId: queueB });
    await queue.markInFlight(child.id, 'run-1');
    await queue.finish(child.id, 'completed');
    await queue.clearCompleted(queueB);
    const service = createConnectedRunService(
      store,
      makeHistory([{ featureId: child.id, terminalStatus: 'completed' } as HistoryRecord])
    );

    expect(store.getRequest(child.id)).toBeNull();
    expect(service.readChildState(child.id)).toBe('completed');
  });

  it('still reads an unknown id as null, so a dead reference cannot wedge a run', async () => {
    const { store } = await setup();
    const service = createConnectedRunService(store, makeHistory());

    expect(service.readChildState('no-such-task')).toBeNull();
  });
});
