// FR-R3-150 (T1618, code-review finding) — cmd-clear-queue handler unit
// tests. Fix: `exec()` discards the return value of `ctx.deps.executeCommand`,
// so a naive port of `cmd-clear-all.ts`'s shape (`exec` then unconditionally
// `ack(ctx, 'accepted')`) silently swallowed `runClearQueue`'s own `ok`/
// `reason` outcome — including the `unknown-queue-id` refusal `CMD_CLEAR_ALL`
// never had. The operator would see "accepted" for a Clean All that was
// actually refused. This file pins that the handler now reads
// `executeCommand`'s resolved value and relays it.
//
// Iteration 5 (second code-review finding) — the relay is `execAndAck`, and the
// last three cases below are what that changed. The hand-rolled
// `executeCommand` + `ackGenericResult` pair had no catch, so a dispatch
// rejection escaped the handler and NOTHING was ACKed; it read the trust gate's
// `undefined` as an unexplained `operation-rejected`; and it emitted no
// `outcome` field, alone among the transport's mutating routes.

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { handler as clearQueueHandler } from '../../../../../src/ui/sidebar/commands/cmd-clear-queue';
import { CMD_CLEAR_QUEUE } from '../../../../../src/contracts/sidebar-ipc';
import type { CommandAckMessage, ClearQueueCommand } from '../../../../../src/contracts/sidebar-ipc';

function buildCtx(executeCommandImpl: (...args: unknown[]) => unknown): {
  ctx: Parameters<typeof clearQueueHandler>[0];
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
    correlationId: 'test-clear-queue-1'
  } as any;
  return { ctx, acks, executeCommandSpy };
}

function makeCmd(queueId: string): ClearQueueCommand {
  return {
    type: CMD_CLEAR_QUEUE,
    correlationId: 'test-clear-queue-1',
    payload: { queueId }
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cmd-clear-queue handler (FR-R3-150)', () => {
  it('calls executeCommand with "schegent.clearQueue" and the addressed queueId', async () => {
    const { ctx, executeCommandSpy } = buildCtx(async () => ({ ok: true }));
    await clearQueueHandler(ctx, makeCmd('q-beta'));
    expect(executeCommandSpy).toHaveBeenCalledWith('schegent.clearQueue', 'q-beta');
  });

  it('acks accepted when the orchestrator reports ok:true', async () => {
    const { ctx, acks } = buildCtx(async () => ({ ok: true }));
    await clearQueueHandler(ctx, makeCmd('q-beta'));
    expect(acks).toHaveLength(1);
    expect(acks[0]!.status).toBe('accepted');
  });

  it('acks rejected with the reason when the orchestrator refuses an unknown queue id (FR-011)', async () => {
    const { ctx, acks } = buildCtx(async () => ({ ok: false, reason: 'unknown-queue-id' }));
    await clearQueueHandler(ctx, makeCmd('no-such-queue'));
    expect(acks).toHaveLength(1);
    expect(acks[0]!.status).toBe('rejected');
    expect(acks[0]!.reason).toBe('unknown-queue-id');
  });

  it('acks rejected with the reason on lock contention or a persistence failure', async () => {
    const { ctx, acks } = buildCtx(async () => ({ ok: false, reason: 'not-primary' }));
    await clearQueueHandler(ctx, makeCmd('q-beta'));
    expect(acks[0]!.status).toBe('rejected');
    expect(acks[0]!.reason).toBe('not-primary');
  });

  it('acks rejected, not accepted, when the guarded command refuses synchronously (untrusted workspace)', async () => {
    // `registerGuardedCommand` returns `undefined` (not a rejected promise)
    // when the workspace is untrusted — this is the shape this handler must
    // not read as a bare "accepted".
    const { ctx, acks } = buildCtx(() => undefined);
    await clearQueueHandler(ctx, makeCmd('q-beta'));
    expect(acks).toHaveLength(1);
    expect(acks[0]!.status).toBe('rejected');
    // Named, not collapsed to `operation-rejected`: the handler never ran, and
    // "The workspace is not trusted" is the only wording an operator can act on.
    expect(acks[0]!.reason).toBe('workspace-not-trusted');
  });

  it('acks rather than throwing when the dispatch itself rejects', async () => {
    const { ctx, acks } = buildCtx(() => Promise.reject(new Error('command not found')));
    await expect(clearQueueHandler(ctx, makeCmd('q-beta'))).resolves.toBeUndefined();
    expect(acks).toHaveLength(1);
    expect(acks[0]!.status).toBe('rejected');
    expect(acks[0]!.outcome).toBe('failed');
    expect(acks[0]!.reason).toBe('command-dispatch-failed');
    // The thrown message never reaches the ack — `reason` crosses to the
    // webview, and a message from this layer carries paths.
    expect(JSON.stringify(acks[0])).not.toContain('command not found');
  });

  it('refuses a payload-less message instead of throwing at the dereference', async () => {
    // `isCmdClearQueue` admits this by decision — see its own test. The layer
    // below cannot answer for it if this handler throws first, and a throw is
    // ACKed by the router as a raw sanitized message rather than a code.
    const { ctx, acks, executeCommandSpy } = buildCtx(async () => ({ ok: true }));
    await clearQueueHandler(ctx, { type: CMD_CLEAR_QUEUE, correlationId: 'test-clear-queue-1' } as any);
    expect(executeCommandSpy).not.toHaveBeenCalled();
    expect(acks).toHaveLength(1);
    expect(acks[0]!.status).toBe('rejected');
    expect(acks[0]!.reason).toBe('missing-payload');
  });

  it('carries the four-word outcome vocabulary alongside status', async () => {
    const accepted = buildCtx(async () => ({ ok: true }));
    await clearQueueHandler(accepted.ctx, makeCmd('q-beta'));
    expect(accepted.acks[0]!.outcome).toBe('accepted');

    const refused = buildCtx(async () => ({ ok: false, reason: 'unknown-queue-id' }));
    await clearQueueHandler(refused.ctx, makeCmd('no-such-queue'));
    expect(refused.acks[0]!.outcome).toBe('refused');
  });
});
