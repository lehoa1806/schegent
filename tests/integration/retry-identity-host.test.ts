// FR-R4-F05 (T15; contract I, I10; FR-023, SC-006; research R19) — a gated command held past
// the webview's 5 s wait is applied once, however many times its identity is sent.
//
// WHAT THIS PINS. The host side of retry identity already works: the executor joins a repeat of
// an in-flight identity to the running operation and replays a settled one from its cache. This
// test holds a REAL mutation (`CMD_MOVE_TASK` through the production router, `HANDLERS` and
// `MutationCommandExecutor`, over a real `QueueManager` whose store write is held by a
// controllable promise) and counts effects, so the claim "a retry past the timeout does not move
// the task twice" rests on a count and not on a reading of the executor. Delays use fake timers;
// the hold is a promise, never a sleep.
//
// PINS, NOT RED FIRST: this passes at the baseline, which is the point of recording it. The
// planted case fails the same assertion: a second send under a NEW identity moves the task
// twice, which is what the webview did before the intent ledger reused identities.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueManager } from '../../src/queue/queue-manager';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { MessageRouter } from '../../src/ui/sidebar/message-router';
import type { CommandAckMessage, SidebarCommand } from '../../src/ui/sidebar/messages';

/** A memento whose writes wait on a promise the test controls. */
class HoldableMemento implements Memento {
  private readonly map = new Map<string, unknown>();
  private release: (() => void) | null = null;
  private held: Promise<void> | null = null;

  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return this.held ?? Promise.resolve();
  }

  /** Writes from now on wait until `releaseWrites()`. */
  holdWrites(): void {
    this.held = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  releaseWrites(): void {
    this.release?.();
    this.held = null;
    this.release = null;
  }
}

interface Harness {
  readonly router: MessageRouter;
  readonly memento: HoldableMemento;
  readonly taskId: string;
  readonly moveCalls: () => number;
  readonly send: (correlationId: string) => Promise<readonly CommandAckMessage[]>;
}

async function build(): Promise<Harness> {
  const memento = new HoldableMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  const created = await queue.createQueue('Second queue');
  const targetQueueId = created.queueId ?? '';
  const task = await queue.enqueue('a pending task');
  let moves = 0;

  const router = new MessageRouter({
    executeCommand: async <T = unknown>() => undefined as T,
    isPrimary: () => true,
    isTrusted: () => true,
    queueOps: {
      moveTask: async (id: string, target: string, position?: number | null) => {
        moves += 1;
        return queue.moveTask(id, target, position);
      }
    } as never,
    audit: { append: async () => undefined } as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      sanitize: (value: string) => value
    }
  });

  return {
    router,
    memento,
    taskId: task.id,
    moveCalls: () => moves,
    send: async (correlationId) => {
      const acks: CommandAckMessage[] = [];
      const command = {
        type: 'CMD_MOVE_TASK',
        correlationId,
        payload: { taskId: task.id, targetQueueId }
      } as unknown as SidebarCommand;
      await router.dispatch(command, async (ack) => {
        acks.push(ack);
        return true;
      });
      return acks;
    }
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a held gated mutation is applied once per identity (T15)', () => {
  // The three holds of FR-027's record: just inside the webview's wait, just past it, and long.
  it.each([4_900, 5_100, 30_000])(
    'applies the move once and answers both sends alike when the write is held %i ms',
    async (heldMs) => {
      const h = await build();
      h.memento.holdWrites();

      const first = h.send('identity-x');
      await vi.advanceTimersByTimeAsync(heldMs);
      const repeat = h.send('identity-x');
      await vi.advanceTimersByTimeAsync(0);
      h.memento.releaseWrites();
      const [firstAcks, repeatAcks] = await Promise.all([first, repeat]);

      // Recorded per case for §3's delayed-ack record: effects and acks per send.
      expect({ heldMs, effects: h.moveCalls(), firstAcks: firstAcks.length, repeatAcks: repeatAcks.length })
        .toEqual({ heldMs, effects: 1, firstAcks: 1, repeatAcks: 1 });
      expect(repeatAcks[0]).toEqual(firstAcks[0]);
      expect(firstAcks[0]).toMatchObject({ status: 'accepted' });
    }
  );

  it('replays the settled outcome to a later send of the same identity, with no second effect', async () => {
    const h = await build();

    const original = await h.send('identity-y');
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    const replay = await h.send('identity-y');

    expect(h.moveCalls()).toBe(1);
    expect(replay[0]).toEqual(original[0]);
  });

  it('planted case: a second send under a NEW identity applies the move twice', async () => {
    const h = await build();
    h.memento.holdWrites();

    const first = h.send('identity-one');
    await vi.advanceTimersByTimeAsync(5_100);
    const retry = h.send('identity-two');
    await vi.advanceTimersByTimeAsync(0);
    h.memento.releaseWrites();
    await Promise.all([first, retry]);

    // The same assertion the cases above make, failing: the retry is a new action.
    expect(h.moveCalls()).toBe(2);
  });
});
