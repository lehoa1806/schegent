// Feature 195 (T064, FR-025) — cmd-attest-task-completed handler unit tests.
//
// Same one-line shape as `cmd-retry-queue-item` and `cmd-restart-canceled-task`:
// the sidebar route delegates to a registered VS Code command and ACKs exactly
// what that command answered. It is deliberately not the shape of
// `cmd-set-queue-failure-policy`, which re-checks its own payload — the inbound
// validator has already refused an unconfirmed or malformed attestation
// (`ipc-validator.test.ts`), and a second consent check here would be a second
// site deciding whether the operator asserted anything.
//
// Why it delegates rather than calling `QueueManager.attestCompleted` directly:
// returning a task to a non-blocking status is not the same thing as asking the
// queue to drain (`AutoDrainCoordinator` is edge-triggered), and the registered
// command is where the drain trigger lives — the lesson `cmd-retry-queue-item`'s
// own comment records after both retry affordances shipped without one.

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { handler as attestHandler } from '../../../../../src/ui/sidebar/commands/cmd-attest-task-completed';
import { CMD_ATTEST_TASK_COMPLETED } from '../../../../../src/contracts/sidebar-ipc';
import type {
  AttestTaskCompletedCommand,
  CommandAckMessage
} from '../../../../../src/contracts/sidebar-ipc';

function buildCtx(executeCommandImpl: (...args: unknown[]) => unknown): {
  ctx: Parameters<typeof attestHandler>[0];
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
    correlationId: 'test-attest-1'
  } as any;
  return { ctx, acks, executeCommandSpy };
}

function makeCmd(taskId: string): AttestTaskCompletedCommand {
  return {
    type: CMD_ATTEST_TASK_COMPLETED,
    correlationId: 'test-attest-1',
    payload: { taskId, confirmed: true }
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cmd-attest-task-completed handler (FR-025)', () => {
  it('calls executeCommand with "schegent.attestTaskCompleted" and the taskId', async () => {
    const { ctx, executeCommandSpy } = buildCtx(async () => ({ ok: true, queueId: 'q-beta' }));
    await attestHandler(ctx, makeCmd('task-7'));
    expect(executeCommandSpy).toHaveBeenCalledWith('schegent.attestTaskCompleted', {
      id: 'task-7'
    });
  });

  it('acks accepted on a committed attestation', async () => {
    const { ctx, acks } = buildCtx(async () => ({ ok: true, queueId: 'q-beta' }));
    await attestHandler(ctx, makeCmd('task-7'));
    expect(acks).toHaveLength(1);
    expect(acks[0]!.status).toBe('accepted');
  });

  // The table refuses the edge from every status but `failed` (192's invariant
  // 4, edge 4), and that refusal must reach the operator as a refusal rather
  // than as a silent accept — the row did not change.
  it('acks rejected with the reason the table gave', async () => {
    const { ctx, acks } = buildCtx(async () => ({ ok: false, reason: 'illegal-source-status' }));
    await attestHandler(ctx, makeCmd('task-7'));
    expect(acks[0]!.status).toBe('rejected');
    expect(acks[0]!.reason).toBe('illegal-source-status');
  });

  it('acks rather than throwing when the dispatch itself rejects, and leaks no message', async () => {
    const { ctx, acks } = buildCtx(() => Promise.reject(new Error('command not found')));
    await expect(attestHandler(ctx, makeCmd('task-7'))).resolves.toBeUndefined();
    expect(acks[0]!.status).toBe('rejected');
    expect(acks[0]!.outcome).toBe('failed');
    expect(acks[0]!.reason).toBe('command-dispatch-failed');
    expect(JSON.stringify(acks[0])).not.toContain('command not found');
  });
});
