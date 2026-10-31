import { describe, expect, it, vi } from 'vitest';
import { MutationCommandExecutor } from '../../../../src/ui/sidebar/mutation-command-executor';
import { CMD_ACK, type CommandAckMessage } from '../../../../src/ui/sidebar/messages';

function accepted(correlationId: string): CommandAckMessage {
  return { type: CMD_ACK, correlationId, status: 'accepted' };
}

describe('MutationCommandExecutor', () => {
  it('runs mutations one at a time', async () => {
    const executor = new MutationCommandExecutor();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const postAck = vi.fn(async () => true);

    const first = executor.execute('first', postAck, async (post) => {
      order.push('first-start');
      await gate;
      order.push('first-end');
      await post(accepted('first'));
    });
    const second = executor.execute('second', postAck, async (post) => {
      order.push('second-start');
      await post(accepted('second'));
    });

    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('replays the cached ack for a duplicate correlation id', async () => {
    const executor = new MutationCommandExecutor();
    const postAck = vi.fn(async () => true);
    const operation = vi.fn(async (
      post: (ack: CommandAckMessage) => Promise<boolean> | Thenable<boolean>
    ) => {
      await post(accepted('same'));
    });

    await executor.execute('same', postAck, operation);
    await executor.execute('same', postAck, operation);

    expect(operation).toHaveBeenCalledOnce();
    expect(postAck).toHaveBeenCalledTimes(2);
  });

  it('expires cached acks after one hour', async () => {
    let now = 0;
    const executor = new MutationCommandExecutor({ now: () => now });
    const postAck = vi.fn(async () => true);
    const operation = vi.fn(async (
      post: (ack: CommandAckMessage) => Promise<boolean> | Thenable<boolean>
    ) => {
      await post(accepted('expiring'));
    });

    await executor.execute('expiring', postAck, operation);
    now = 60 * 60 * 1000 + 1;
    await executor.execute('expiring', postAck, operation);

    expect(operation).toHaveBeenCalledTimes(2);
  });

  // FR-R4-F05 (T8; contract I, I10; FR-023) — an operation that posts two acks is
  // answered, on a repeat of its identity, with the FIRST. The executor used to keep
  // the last, so a retry could be told something the original run never first said.
  describe('the first ack is the one remembered', () => {
    const first = (id: string): CommandAckMessage => ({ type: CMD_ACK, correlationId: id, status: 'accepted' });
    const second = (id: string): CommandAckMessage => ({
      type: CMD_ACK,
      correlationId: id,
      status: 'rejected',
      reason: 'second-ack'
    });

    it('replays the first ack of an operation that posted two', async () => {
      const executor = new MutationCommandExecutor();
      const posted: CommandAckMessage[] = [];
      const postAck = vi.fn(async (ack: CommandAckMessage) => {
        posted.push(ack);
        return true;
      });
      const operation = vi.fn(async (
        post: (ack: CommandAckMessage) => Promise<boolean> | Thenable<boolean>
      ) => {
        await post(first('two'));
        await post(second('two'));
      });

      await executor.execute('two', postAck, operation);
      await executor.execute('two', postAck, operation);

      expect(operation).toHaveBeenCalledOnce();
      expect(posted).toHaveLength(3);
      expect(posted[2]).toMatchObject({ status: 'accepted' });
      expect(posted[2]?.reason).toBeUndefined();
    });

    it('gives a repeat that joins an in-flight operation the first ack too', async () => {
      const executor = new MutationCommandExecutor();
      const joined: CommandAckMessage[] = [];
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const operation = vi.fn(async (
        post: (ack: CommandAckMessage) => Promise<boolean> | Thenable<boolean>
      ) => {
        await post(first('join'));
        await hold;
        await post(second('join'));
      });

      const original = executor.execute('join', vi.fn(async () => true), operation);
      const repeat = executor.execute(
        'join',
        async (ack) => {
          joined.push(ack);
          return true;
        },
        operation
      );
      release();
      await Promise.all([original, repeat]);

      expect(operation).toHaveBeenCalledOnce();
      expect(joined).toHaveLength(1);
      expect(joined[0]).toMatchObject({ status: 'accepted' });
    });
  });

  // FR-R4-F05 (T8, C6) — a gated command that is not serialized (`serialize:
  // false`) runs beside a held serialized operation but keeps the identity
  // handling: a repeat joins it in flight, then replays its cached ack.
  describe('serialize: false', () => {
    it('runs beside a held serialized operation', async () => {
      const executor = new MutationCommandExecutor();
      const postAck = vi.fn(async () => true);
      let releaseHeld!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseHeld = resolve;
      });
      const order: string[] = [];

      const serialized = executor.execute('held', postAck, async (post) => {
        order.push('held-start');
        await held;
        order.push('held-end');
        await post(accepted('held'));
      });
      const concurrent = executor.execute(
        'concurrent',
        postAck,
        async (post) => {
          order.push('concurrent-start');
          await post(accepted('concurrent'));
          order.push('concurrent-end');
        },
        { serialize: false }
      );

      // The concurrent operation settles while the serialized one is still held.
      await concurrent;
      expect(order).toContain('concurrent-start');
      expect(order).toContain('concurrent-end');
      expect(order).not.toContain('held-end');
      releaseHeld();
      await serialized;
      expect(order.at(-1)).toBe('held-end');
    });

    it('joins a repeat of an in-flight identity and then replays it from the cache', async () => {
      const executor = new MutationCommandExecutor();
      const posted: CommandAckMessage[] = [];
      const postAck = vi.fn(async (ack: CommandAckMessage) => {
        posted.push(ack);
        return true;
      });
      let releaseOperation!: () => void;
      const hold = new Promise<void>((resolve) => {
        releaseOperation = resolve;
      });
      const operation = vi.fn(async (
        post: (ack: CommandAckMessage) => Promise<boolean> | Thenable<boolean>
      ) => {
        await hold;
        await post(accepted('same'));
      });

      const first = executor.execute('same', postAck, operation, { serialize: false });
      const second = executor.execute('same', postAck, operation, { serialize: false });
      await Promise.resolve();
      expect(operation).toHaveBeenCalledOnce();

      releaseOperation();
      await Promise.all([first, second]);
      expect(operation).toHaveBeenCalledOnce();
      expect(posted).toHaveLength(2);
      expect(posted[1]).toEqual(posted[0]);

      await executor.execute('same', postAck, operation, { serialize: false });
      expect(operation).toHaveBeenCalledOnce();
      expect(posted).toHaveLength(3);
      expect(posted[2]).toEqual(posted[0]);
    });
  });
});
