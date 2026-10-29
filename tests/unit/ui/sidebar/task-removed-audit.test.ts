// Feature 034 T010 — task-removed audit payload includes sessionCleaned.
// See specs/034-task-deletion-cleanup/contracts/task-removed-audit.md.
//
// Asserts: the existing `task-removed` audit event payload carries the
// additive `sessionCleaned: boolean` field on every emission.
//
// FR-R3-161 (T047/T049a) — 2026-09-04. This header used to say "both the
// typed-ops path (PhaseOps.deleteTask) and the legacy fallback path
// (queueRemover.remove) MUST emit the field". There is one path now: the router
// declares no boolean remover, and `cmd-remove-queue-item.ts` refuses with
// `queue-ops-unavailable` rather than deleting a row a weaker way when no typed
// surface is wired. The fixture below models only what the router consumes.

import { describe, it, expect, vi } from 'vitest';
import { MessageRouter, type RouterDeps, type PhaseOps } from '../../../../src/ui/sidebar/message-router';
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

// FR-R3-161 (T047/T049a) — `class FakeQueueOpsMinimal implements QueueOps` stood
// here, existing only so the deleted legacy case could reach a boolean
// `remove(...)` through an unwired `queueOps`. Every remaining case supplies
// `phaseOpsDeleteTask`, which is the route an operator's removal actually takes,
// so the router never read that stand-in and nothing here observes it any more.
function makeRouter(opts: {
  phaseOpsDeleteTask?: (id: string) => Promise<DeleteTaskResult>;
} = {}): {
  router: MessageRouter;
  acks: CapturedAck[];
  auditEntries: CapturedAuditEntry[];
} {
  const acks: CapturedAck[] = [];
  const auditEntries: CapturedAuditEntry[] = [];
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
  return { router, acks, auditEntries };
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

  // FR-R3-161 (T049a, FR-016) — 2026-09-04. **Deliberate removal 4 of 4.**
  // `it('legacy fallback path → sessionCleaned: false', …)` stood here. Its
  // entire subject was the router's boolean-remover fallback branch, which
  // T046 deletes; once `queueRemover` is gone the case has no subject to
  // exercise. It needs no replacement pin, and that is not an assertion of
  // convenience: the branch was unreachable in production, because the wiring
  // always supplies `phaseOps` (T009 re-confirmed it against
  // `activation/sidebar-router-wiring.ts` immediately before the deletion), so
  // no operator could reach the behaviour it pinned while the branch existed.
  // The three typed-ops cases above are what an operator's removal actually
  // runs, and they are untouched.
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

// FR-R4-F16 (spec 244, contract P5.4, FR-001, FR-003) — the same event carries `completionProvenance`,
// copied from the removal's result. A result with none (an older or injected `deleteTask`) still
// writes the key, as `null`, so every `task-removed` written after this feature carries it. The key
// sits after `priorStatus`, and the payload stays paths-free.
describe('FR-R4-F16 — task-removed payload carries completionProvenance', () => {
  async function removeWith(result: Partial<DeleteTaskResult>): Promise<CapturedAuditEntry> {
    const { router, acks, auditEntries } = makeRouter({
      phaseOpsDeleteTask: async (id) => ({
        ok: true,
        taskId: id,
        queueId: 'default',
        priorStatus: 'completed',
        runId: 'R1',
        sessionCleaned: true,
        ...result
      })
    });
    await dispatch(
      router,
      { type: CMD_REMOVE_QUEUE_ITEM, correlationId: 'rm-P', payload: { id: 'task-p', confirmed: true } },
      acks
    );
    expect((acks[0] as CapturedAck).msg.status).toBe('accepted');
    const removed = auditEntries.filter((e) => e.eventType === 'task-removed');
    expect(removed).toHaveLength(1);
    return removed[0] as CapturedAuditEntry;
  }

  it("copies 'operator-attested' from the result, after priorStatus", async () => {
    const entry = await removeWith({ completionProvenance: 'operator-attested' });
    expect(entry.payload.completionProvenance).toBe('operator-attested');
    const keys = Object.keys(entry.payload);
    expect(keys.indexOf('completionProvenance')).toBe(keys.indexOf('priorStatus') + 1);
    assertPayloadIsPathsFree(entry.payload);
  });

  it('copies null from the result', async () => {
    const entry = await removeWith({ completionProvenance: null });
    expect(entry.payload).toHaveProperty('completionProvenance', null);
  });

  it('writes null when the result carries no field at all', async () => {
    const entry = await removeWith({});
    expect(entry.payload).toHaveProperty('completionProvenance', null);
    assertPayloadIsPathsFree(entry.payload);
  });

  it('writes the same value into the envelope copy as into the payload', async () => {
    const entry = await removeWith({ completionProvenance: 'operator-attested' });
    const newState = (entry.payload.stateTransition as { newState: Record<string, unknown> }).newState;
    expect(newState.completionProvenance).toBe('operator-attested');
  });

  it('adds no identity field beside it', async () => {
    const entry = await removeWith({ completionProvenance: 'operator-attested' });
    expect(Object.keys(entry.payload).sort()).toEqual(
      [
        'taskId',
        'queueId',
        'priorStatus',
        'runId',
        'cause',
        'sessionCleaned',
        'sessionCleanupRefusal',
        'completionProvenance',
        'stateTransition'
      ].sort()
    );
  });
});
