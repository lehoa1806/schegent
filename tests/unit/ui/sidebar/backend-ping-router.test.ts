import { describe, expect, it, vi } from 'vitest';
import { MessageRouter } from '../../../../src/ui/sidebar/message-router';
import type { CommandAckMessage } from '../../../../src/ui/sidebar/messages';

function logger() {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    sanitize: (value: string) => value
  };
}

describe('CMD_PING_BACKEND router', () => {
  it('remains read-only and available on a secondary host', async () => {
    const ping = vi.fn(async () => ({
      accepted: true,
      state: {
        status: 'success' as const, runner: 'codex' as const,
        startedAt: 1, completedAt: 2, latencyMs: 1, timeoutSeconds: 5
      }
    }));
    const router = new MessageRouter({
      executeCommand: async <T = unknown>() => undefined as T,
      queueRemover: { remove: async () => false },
      isPrimary: () => false,
      isTrusted: () => true,
      logger: logger(),
      backendPingService: { ping }
    });
    const acks: CommandAckMessage[] = [];
    await router.dispatch({
      type: 'CMD_PING_BACKEND', correlationId: 'secondary',
      payload: { runner: 'codex' }
    }, async (ack) => { acks.push(ack); return true; });

    expect(ping).toHaveBeenCalledWith('codex', 'secondary');
    expect(acks[0]).toMatchObject({ status: 'accepted' });
  });

  it('rejects without the workspace-bound service', async () => {
    const router = new MessageRouter({
      executeCommand: async <T = unknown>() => undefined as T,
      queueRemover: { remove: async () => false },
      isTrusted: () => true,
      logger: logger()
    });
    const acks: CommandAckMessage[] = [];
    await router.dispatch({
      type: 'CMD_PING_BACKEND', correlationId: 'no-workspace',
      payload: { runner: 'claude' }
    }, async (ack) => { acks.push(ack); return true; });
    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'workspace-required' });
  });
});
