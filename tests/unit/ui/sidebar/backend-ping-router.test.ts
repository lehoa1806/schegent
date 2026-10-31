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
  // FR-R4-F05 (T7; FR-004, FR-006) — this case used to be "remains read-only and
  // available on a secondary host". Ping starts the backend CLI and appends an
  // audit row, so it is gated: a trusted secondary window and an untrusted
  // workspace are refused before the service is reached.
  interface GateCase {
    readonly label: string;
    readonly isPrimary: () => boolean;
    readonly isTrusted: () => boolean;
    readonly reason: string;
  }
  const gateCases: readonly GateCase[] = [
    {
      label: 'a trusted secondary window',
      isPrimary: () => false,
      isTrusted: () => true,
      reason: 'secondary-window-readonly'
    },
    {
      label: 'an untrusted workspace',
      isPrimary: () => true,
      isTrusted: () => false,
      reason: 'untrusted-workspace'
    }
  ];
  it.each(gateCases)('refuses Ping in $label and never calls the service', async (gate) => {
    const ping = vi.fn(async () => ({
      accepted: true,
      state: {
        status: 'success' as const, runner: 'codex' as const,
        startedAt: 1, completedAt: 2, latencyMs: 1, timeoutSeconds: 5
      }
    }));
    const router = new MessageRouter({
      executeCommand: async <T = unknown>() => undefined as T,
      isPrimary: gate.isPrimary,
      isTrusted: gate.isTrusted,
      logger: logger(),
      backendPingService: { ping }
    });
    const acks: CommandAckMessage[] = [];
    await router.dispatch({
      type: 'CMD_PING_BACKEND', correlationId: 'refused',
      payload: { runner: 'codex' }
    }, async (ack) => { acks.push(ack); return true; });

    expect(ping).not.toHaveBeenCalled();
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({ status: 'rejected', reason: gate.reason });
  });

  it('serves a trusted primary window', async () => {
    const ping = vi.fn(async () => ({
      accepted: true,
      state: {
        status: 'success' as const, runner: 'codex' as const,
        startedAt: 1, completedAt: 2, latencyMs: 1, timeoutSeconds: 5
      }
    }));
    const router = new MessageRouter({
      executeCommand: async <T = unknown>() => undefined as T,
      isPrimary: () => true,
      isTrusted: () => true,
      logger: logger(),
      backendPingService: { ping }
    });
    const acks: CommandAckMessage[] = [];
    await router.dispatch({
      type: 'CMD_PING_BACKEND', correlationId: 'primary',
      payload: { runner: 'codex' }
    }, async (ack) => { acks.push(ack); return true; });

    expect(ping).toHaveBeenCalledWith('codex', 'primary');
    expect(acks[0]).toMatchObject({ status: 'accepted' });
  });

  it('rejects without the workspace-bound service', async () => {
    // FR-R4-F05: Ping is gated, so a router with no `isPrimary` refuses it before the
    // handler can say `workspace-required`. The fixture wires a primary window
    // explicitly, as the router's docs require of every test that reaches a gated
    // handler.
    const router = new MessageRouter({
      executeCommand: async <T = unknown>() => undefined as T,
      isPrimary: () => true,
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
