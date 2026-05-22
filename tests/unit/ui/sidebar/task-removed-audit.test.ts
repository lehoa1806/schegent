// Feature 034 T010 — task-removed audit payload includes sessionCleaned.
// See specs/034-task-deletion-cleanup/contracts/task-removed-audit.md.
//
// Asserts: the existing `task-removed` audit event payload carries the
// additive `sessionCleaned: boolean` field on every emission. Both the
// typed-ops path (PhaseOps.deleteTask) and the legacy fallback path
// (queueRemover.remove) MUST emit the field. The legacy fallback path
// has no cleanup invocation and always emits `sessionCleaned: false`.

import { describe, it, expect, vi } from 'vitest';
import { MessageRouter, type RouterDeps, type PhaseOps, type QueueOps } from '../../../../src/ui/sidebar/message-router';
import { SanitizedLogger } from '../../../../src/lib/logger';
import type { CommandAckMessage, SidebarCommand } from '../../../../src/ui/sidebar/messages';
import { CMD_REMOVE_QUEUE_ITEM } from '../../../../src/ui/sidebar/messages';

interface CapturedAck {
  msg: CommandAckMessage;
}

interface CapturedAuditEntry {
  runId: string;
  phase: string;
  iteration: number;
  eventType: string;
  payload: Record<string, unknown>;
  outcome: 'info' | 'success' | 'failure';
  correlationId?: string;
}

type DeleteTaskResult = NonNullable<PhaseOps['deleteTask']> extends (id: string) => Promise<infer R>
  ? R
  : never;

class FakeQueueOpsMinimal implements QueueOps {
  removeCalls: string[] = [];
  removeResult = true;
  // Stub for QueueOps fields the router doesn't touch in this path.
  retry = vi.fn(async () => ({ ok: true }));
  moveUp = vi.fn(async () => ({ ok: true }));
  moveDown = vi.fn(async () => ({ ok: true }));
  clearCompleted = vi.fn(async () => ({ removed: 0 }));
  clearFailed = vi.fn(async () => ({ removed: 0 }));
  setQueuePausedState = vi.fn(async () => ({ ok: true, queueId: 'default' }));

  async remove(id: string): Promise<boolean> {
    this.removeCalls.push(id);
    return this.removeResult;
  }
}

function makeRouter(opts: {
  phaseOpsDeleteTask?: (id: string) => Promise<DeleteTaskResult>;
  fakeQueueOps?: FakeQueueOpsMinimal;
} = {}): {
  router: MessageRouter;
  acks: CapturedAck[];
  auditEntries: CapturedAuditEntry[];
  fakeQueueOps: FakeQueueOpsMinimal;
} {
  const acks: CapturedAck[] = [];
  const auditEntries: CapturedAuditEntry[] = [];
  const fakeQueueOps = opts.fakeQueueOps ?? new FakeQueueOpsMinimal();
  // When phaseOpsDeleteTask is provided, the router prefers the typed-ops path.
  const phaseOps: PhaseOps | undefined = opts.phaseOpsDeleteTask
    ? {
        skipPhase: vi.fn(async () => ({ ok: true })),
        disablePhase: vi.fn(async () => ({ ok: true })),
        enablePhase: vi.fn(async () => ({ ok: true })),
        deleteTask: opts.phaseOpsDeleteTask
      }
    : undefined;
  const deps: RouterDeps = {
    executeCommand: vi.fn() as unknown as RouterDeps['executeCommand'],
    queueRemover: fakeQueueOps,
    queueOps: phaseOps ? undefined : (fakeQueueOps as unknown as QueueOps),
    phaseOps,
    isPrimary: () => true,
    isTrusted: () => true,
    notifyWarning: () => undefined,
    logger: new SanitizedLogger(),
    audit: {
      append: async (entry) => {
        auditEntries.push(entry as CapturedAuditEntry);
        return undefined;
      }
    }
  };
  const router = new MessageRouter(deps);
  return { router, acks, auditEntries, fakeQueueOps };
}

async function dispatch(
  router: MessageRouter,
  command: SidebarCommand,
  acks: CapturedAck[]
): Promise<void> {
  await router.dispatch(command, async (msg) => {
    acks.push({ msg });
    return true;
  });
}

const PATH_KEYS = ['path', 'filePath', 'workspaceRoot', 'sessionLogPath', 'sessionRoot', 'sessionPath'];

function assertPayloadIsPathsFree(payload: Record<string, unknown>): void {
  for (const k of PATH_KEYS) {
    expect(payload).not.toHaveProperty(k);
  }
}

describe('Feature 034 T010 — task-removed payload carries sessionCleaned', () => {
  it('typed-ops path, runId present, cleanup succeeded → sessionCleaned: true', async () => {
    const { router, acks, auditEntries } = makeRouter({
      phaseOpsDeleteTask: async (id) => ({
        ok: true,
        taskId: id,
        queueId: 'default',
        priorStatus: 'completed',
        runId: 'R1',
        sessionCleaned: true
      })
    });
    await dispatch(
      router,
      { type: CMD_REMOVE_QUEUE_ITEM, correlationId: 'rm-A', payload: { id: 'task-1', confirmed: true } },
      acks
    );
    expect(acks[0].msg.status).toBe('accepted');
    const removed = auditEntries.filter((e) => e.eventType === 'task-removed');
    expect(removed).toHaveLength(1);
    expect(removed[0].payload).toMatchObject({
      taskId: 'task-1',
      queueId: 'default',
      priorStatus: 'completed',
      runId: 'R1',
      cause: 'operator',
      sessionCleaned: true
    });
    assertPayloadIsPathsFree(removed[0].payload);
  });

  it('typed-ops path, runId null → sessionCleaned: false', async () => {
    const { router, acks, auditEntries } = makeRouter({
      phaseOpsDeleteTask: async (id) => ({
        ok: true,
        taskId: id,
        queueId: 'default',
        priorStatus: 'pending',
        runId: null,
        sessionCleaned: false
      })
    });
    await dispatch(
      router,
      { type: CMD_REMOVE_QUEUE_ITEM, correlationId: 'rm-B', payload: { id: 'task-2', confirmed: true } },
      acks
    );
    const removed = auditEntries.filter((e) => e.eventType === 'task-removed');
    expect(removed).toHaveLength(1);
    expect(removed[0].payload).toMatchObject({
      sessionCleaned: false,
      runId: null
    });
    assertPayloadIsPathsFree(removed[0].payload);
  });

  it('typed-ops path, cleanup failed → sessionCleaned: false', async () => {
    const { router, acks, auditEntries } = makeRouter({
      phaseOpsDeleteTask: async (id) => ({
        ok: true,
        taskId: id,
        queueId: 'default',
        priorStatus: 'completed',
        runId: 'R-failed',
        sessionCleaned: false
      })
    });
    await dispatch(
      router,
      { type: CMD_REMOVE_QUEUE_ITEM, correlationId: 'rm-C', payload: { id: 'task-3', confirmed: true } },
      acks
    );
    const removed = auditEntries.filter((e) => e.eventType === 'task-removed');
    expect(removed).toHaveLength(1);
    expect(removed[0].payload).toMatchObject({
      sessionCleaned: false,
      runId: 'R-failed'
    });
    assertPayloadIsPathsFree(removed[0].payload);
  });

  it('legacy fallback path → sessionCleaned: false', async () => {
    // No phaseOps.deleteTask AND no queueOps.removeTask wired —
    // the router falls back to queueRemover.remove(...).
    const { router, acks, auditEntries, fakeQueueOps } = makeRouter();
    fakeQueueOps.removeResult = true;
    await dispatch(
      router,
      { type: CMD_REMOVE_QUEUE_ITEM, correlationId: 'rm-L', payload: { id: 'task-legacy', confirmed: true } },
      acks
    );
    expect(acks[0].msg.status).toBe('accepted');
    expect(fakeQueueOps.removeCalls).toEqual(['task-legacy']);
    const removed = auditEntries.filter((e) => e.eventType === 'task-removed');
    expect(removed).toHaveLength(1);
    expect(removed[0].payload).toMatchObject({
      taskId: 'task-legacy',
      cause: 'operator',
      sessionCleaned: false
    });
    assertPayloadIsPathsFree(removed[0].payload);
  });

  it('rejection branch (unknown-task-id) → NO task-removed event emitted', async () => {
    const { router, acks, auditEntries } = makeRouter({
      phaseOpsDeleteTask: async () => ({ ok: false, reason: 'unknown-task-id' })
    });
    await dispatch(
      router,
      { type: CMD_REMOVE_QUEUE_ITEM, correlationId: 'rm-R', payload: { id: 'gone', confirmed: true } },
      acks
    );
    expect(acks[0].msg.status).toBe('rejected');
    expect(auditEntries.filter((e) => e.eventType === 'task-removed')).toHaveLength(0);
  });
});
