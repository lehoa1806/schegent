// Feature 195 (T038, FR-018, FR-019) — cmd-set-queue-failure-policy handler
// unit tests. Same shape as `cmd-clear-queue.test.ts`: this handler delegates
// to the `schegent.setQueueFailurePolicy` VS Code command and relays its own
// `CommandOutcome` back over the IPC ack, never an unconditional `accepted`.

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { handler as setQueueFailurePolicyHandler } from '../../../../../src/ui/sidebar/commands/cmd-set-queue-failure-policy';
import { CMD_SET_QUEUE_FAILURE_POLICY } from '../../../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  SetQueueFailurePolicyCommand
} from '../../../../../src/contracts/sidebar-ipc';

function buildCtx(executeCommandImpl: (...args: unknown[]) => unknown): {
  ctx: Parameters<typeof setQueueFailurePolicyHandler>[0];
  acks: CommandAckMessage[];
  executeCommandSpy: ReturnType<typeof vi.fn>;
} {
  const acks: CommandAckMessage[] = [];
  const executeCommandSpy = vi.fn(executeCommandImpl);
  const ctx = {
    deps: {
      executeCommand: executeCommandSpy,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), sanitize: (s: string) => s }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'test-set-queue-failure-policy-1'
  } as any;
  return { ctx, acks, executeCommandSpy };
}

function makeCmd(
  queueId: string,
  policy: 'halt-on-failure' | 'continue' | null
): SetQueueFailurePolicyCommand {
  return {
    type: CMD_SET_QUEUE_FAILURE_POLICY,
    correlationId: 'test-set-queue-failure-policy-1',
    payload: { queueId, policy }
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cmd-set-queue-failure-policy handler (FR-018, FR-019)', () => {
  it('calls executeCommand with "schegent.setQueueFailurePolicy", the queueId and the policy', async () => {
    const { ctx, executeCommandSpy } = buildCtx(async () => ({ outcome: 'accepted' }));
    await setQueueFailurePolicyHandler(ctx, makeCmd('q-beta', 'halt-on-failure'));
    expect(executeCommandSpy).toHaveBeenCalledWith(
      'schegent.setQueueFailurePolicy',
      'q-beta',
      'halt-on-failure'
    );
  });

  it('forwards policy: null to follow the workspace default', async () => {
    const { ctx, executeCommandSpy } = buildCtx(async () => ({ outcome: 'accepted' }));
    await setQueueFailurePolicyHandler(ctx, makeCmd('q-beta', null));
    expect(executeCommandSpy).toHaveBeenCalledWith('schegent.setQueueFailurePolicy', 'q-beta', null);
  });

  it('acks accepted only on a committed write', async () => {
    const { ctx, acks } = buildCtx(async () => ({ outcome: 'accepted' }));
    await setQueueFailurePolicyHandler(ctx, makeCmd('q-beta', 'continue'));
    expect(acks).toHaveLength(1);
    expect(acks[0]!.status).toBe('accepted');
    expect(acks[0]!.outcome).toBe('accepted');
  });

  it('acks a no-op as rejected/no-op, never accepted (FR-019)', async () => {
    const { ctx, acks } = buildCtx(async () => ({
      outcome: 'no-op',
      reason: 'failure-policy-unchanged'
    }));
    await setQueueFailurePolicyHandler(ctx, makeCmd('q-beta', 'halt-on-failure'));
    expect(acks[0]!.status).toBe('rejected');
    expect(acks[0]!.outcome).toBe('no-op');
    expect(acks[0]!.reason).toBe('failure-policy-unchanged');
  });

  it('acks rejected with the reason when the host refuses an unknown queue id', async () => {
    const { ctx, acks } = buildCtx(async () => ({ outcome: 'refused', reason: 'unknown-queue-id' }));
    await setQueueFailurePolicyHandler(ctx, makeCmd('no-such-queue', 'continue'));
    expect(acks[0]!.status).toBe('rejected');
    expect(acks[0]!.outcome).toBe('refused');
    expect(acks[0]!.reason).toBe('unknown-queue-id');
  });

  it('refuses a payload-less message instead of throwing at the dereference', async () => {
    const { ctx, acks, executeCommandSpy } = buildCtx(async () => ({ outcome: 'accepted' }));
    await setQueueFailurePolicyHandler(
      ctx,
      { type: CMD_SET_QUEUE_FAILURE_POLICY, correlationId: 'test-set-queue-failure-policy-1' } as any
    );
    expect(executeCommandSpy).not.toHaveBeenCalled();
    expect(acks).toHaveLength(1);
    expect(acks[0]!.status).toBe('rejected');
    expect(acks[0]!.reason).toBe('missing-payload');
  });

  it('refuses a policy outside the closed vocabulary rather than forwarding it', async () => {
    const { ctx, acks, executeCommandSpy } = buildCtx(async () => ({ outcome: 'accepted' }));
    await setQueueFailurePolicyHandler(ctx, makeCmd('q-beta', 'pause-forever' as never));
    expect(executeCommandSpy).not.toHaveBeenCalled();
    expect(acks[0]!.status).toBe('rejected');
    expect(acks[0]!.reason).toBe('missing-payload');
  });

  it('acks rather than throwing when the dispatch itself rejects', async () => {
    const { ctx, acks } = buildCtx(() => Promise.reject(new Error('command not found')));
    await expect(
      setQueueFailurePolicyHandler(ctx, makeCmd('q-beta', 'continue'))
    ).resolves.toBeUndefined();
    expect(acks[0]!.status).toBe('rejected');
    expect(acks[0]!.outcome).toBe('failed');
    expect(acks[0]!.reason).toBe('command-dispatch-failed');
    expect(JSON.stringify(acks[0])).not.toContain('command not found');
  });
});
