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
});
