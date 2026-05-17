import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageRouter, type RouterDeps } from '../../../../src/ui/sidebar/message-router';
import { SanitizedLogger } from '../../../../src/lib/logger';
import type { CommandAckMessage, SidebarCommand } from '../../../../src/ui/sidebar/messages';
import {
  CMD_CANCEL,
  CMD_OPEN_AUDIT_LOG,
  CMD_REMOVE_QUEUE_ITEM,
  CMD_RESET,
  CMD_RESUME,
  CMD_START,
  CMD_RETRY_QUEUE_ITEM,
  CMD_MOVE_QUEUE_ITEM_UP,
  CMD_MOVE_QUEUE_ITEM_DOWN,
  CMD_CLEAR_COMPLETED,
  CMD_CLEAR_FAILED,
  CMD_PAUSE_QUEUE,
  CMD_RESUME_QUEUE,
  CMD_PAUSE_PHASE,
  CMD_RESUME_PHASE,
  CMD_RESTART_PHASE,
  CMD_SKIP_PHASE,
  CMD_DISABLE_PHASE,
  CMD_ENABLE_PHASE,
  CMD_WAKE_UP_NOW
} from '../../../../src/ui/sidebar/messages';

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

class FakeQueueOps {
  removed: string[] = [];
  removeResult: boolean = true;
  removeTaskCalls: string[] = [];
  removeTaskResult: { ok: boolean; reason?: string; queueId?: string } | null = {
    ok: true,
    queueId: 'default'
  };
  retryCalls: string[] = [];
  retryResult: { ok: boolean; reason?: string } = { ok: true };
  moveUpCalls: string[] = [];
  moveUpResult: { ok: boolean; reason?: string } = { ok: true };
  moveDownCalls: string[] = [];
  moveDownResult: { ok: boolean; reason?: string } = { ok: true };
  clearCompletedCalls: number = 0;
  clearCompletedResult: { removed: number } = { removed: 0 };
  clearFailedCalls: number = 0;
  clearFailedResult: { removed: number } = { removed: 0 };
  setPausedCalls: Array<{ paused: boolean; reason: string | null }> = [];
  setPausedThrows: Error | null = null;

  async remove(id: string): Promise<boolean> {
    this.removed.push(id);
    return this.removeResult;
  }
  async removeTask(
    id: string
  ): Promise<{ ok: boolean; reason?: string; queueId?: string }> {
    this.removeTaskCalls.push(id);
    if (this.removeTaskResult === null) {
      // Pass-through to legacy `remove(...)` so router fallback can be exercised.
      const ok = await this.remove(id);
      return ok ? { ok: true } : { ok: false, reason: 'unknown-task-id' };
    }
    return this.removeTaskResult;
  }
  async retry(id: string): Promise<{ ok: boolean; reason?: string }> {
    this.retryCalls.push(id);
    return this.retryResult;
  }
  async moveUp(id: string): Promise<{ ok: boolean; reason?: string }> {
    this.moveUpCalls.push(id);
    return this.moveUpResult;
  }
  async moveDown(id: string): Promise<{ ok: boolean; reason?: string }> {
    this.moveDownCalls.push(id);
    return this.moveDownResult;
  }
  async clearCompleted(): Promise<{ removed: number }> {
    this.clearCompletedCalls++;
    return this.clearCompletedResult;
  }
  async clearFailed(): Promise<{ removed: number }> {
    this.clearFailedCalls++;
    return this.clearFailedResult;
  }
  async setPaused(paused: boolean, reason: string | null = null): Promise<void> {
    this.setPausedCalls.push({ paused, reason });
    if (this.setPausedThrows) throw this.setPausedThrows;
  }
}

function makeRouter(opts: {
  queueOps?: FakeQueueOps;
  isPrimary?: () => boolean;
  notifyWarning?: (m: string) => void;
  wakeUpNow?: RouterDeps['wakeUpNow'];
  onWakeUpNowComplete?: RouterDeps['onWakeUpNowComplete'];
} = {}): {
  router: MessageRouter;
  executeCommand: ReturnType<typeof vi.fn>;
  queueOps: FakeQueueOps;
  acks: CapturedAck[];
  warnings: string[];
  auditEntries: CapturedAuditEntry[];
} {
  const queueOps = opts.queueOps ?? new FakeQueueOps();
  const executeCommand = vi.fn();
  executeCommand.mockResolvedValue(undefined);
  const acks: CapturedAck[] = [];
  const warnings: string[] = [];
  const auditEntries: CapturedAuditEntry[] = [];
  const deps: RouterDeps = {
    executeCommand: executeCommand as unknown as RouterDeps['executeCommand'],
    queueRemover: queueOps,
    queueOps,
    phaseOps: {
      skipPhase: vi.fn(async () => ({ ok: true })),
      disablePhase: vi.fn(async () => ({ ok: true })),
      enablePhase: vi.fn(async () => ({ ok: true }))
    },
    isPrimary: opts.isPrimary ?? (() => true),
    isTrusted: () => true,
    notifyWarning: opts.notifyWarning ?? ((m) => warnings.push(m)),
    wakeUpNow: opts.wakeUpNow,
    onWakeUpNowComplete: opts.onWakeUpNowComplete,
    logger: new SanitizedLogger(),
    audit: {
      append: async (entry) => {
        auditEntries.push(entry as CapturedAuditEntry);
        return undefined;
      }
    }
  };
  const router = new MessageRouter(deps);
  return { router, executeCommand, queueOps, acks, warnings, auditEntries };
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

describe('MessageRouter.dispatch', () => {
  let acks: CapturedAck[];
  let router: MessageRouter;
  let executeCommand: ReturnType<typeof vi.fn>;
  let queueOps: FakeQueueOps;

  beforeEach(() => {
    const built = makeRouter();
    router = built.router;
    executeCommand = built.executeCommand;
    queueOps = built.queueOps;
    acks = [];
  });

  it('routes CMD_START to schegent.enqueue with queue targeting payload (BUG-003)', async () => {
    executeCommand.mockResolvedValueOnce({
      result: { outcome: 'enqueued', queueItemId: 'task-1' },
      queueId: 'default',
      queueName: 'Default queue'
    });
    await dispatch(
      router,
      {
        type: CMD_START,
        correlationId: 'c1',
        payload: { description: 'add login', queueId: 'default', position: 2 }
      },
      acks
    );
    expect(executeCommand).toHaveBeenCalledWith('schegent.enqueue', {
      description: 'add login',
      pipelineId: undefined,
      queueId: 'default',
      position: 2
    });
    expect(acks).toHaveLength(1);
    expect(acks[0].msg.status).toBe('accepted');
    expect(acks[0].msg.correlationId).toBe('c1');
    expect(acks[0].msg.result).toEqual({
      outcome: 'enqueued',
      queueItemId: 'task-1',
      queueId: 'default',
      queueName: 'Default queue'
    });
  });

  // T021b (US2, FR-014 routing) — CMD_START.pipelineId forwarding contract.
  it('CMD_START forwards pipelineId: "speckit-bugfix" byte-for-byte to schegent.enqueue (T021b, US2)', async () => {
    executeCommand.mockResolvedValueOnce({
      result: { outcome: 'enqueued', queueItemId: 'task-2' },
      queueId: 'default',
      queueName: 'Default queue'
    });
    await dispatch(
      router,
      {
        type: CMD_START,
        correlationId: 'bf1',
        payload: {
          description: 'fix login bug',
          pipelineId: 'speckit-bugfix',
          queueId: 'default',
          position: 1
        }
      },
      acks
    );
    expect(executeCommand).toHaveBeenCalledWith('schegent.enqueue', {
      description: 'fix login bug',
      pipelineId: 'speckit-bugfix',
      queueId: 'default',
      position: 1
    });
    expect(acks[0].msg.status).toBe('accepted');
  });

  it('CMD_START without pipelineId forwards undefined so the controller applies default-fallback (T021b, US2)', async () => {
    executeCommand.mockResolvedValueOnce({
      result: { outcome: 'enqueued', queueItemId: 'task-3' },
      queueId: 'default',
      queueName: 'Default queue'
    });
    await dispatch(
      router,
      {
        type: CMD_START,
        correlationId: 'bf2',
        payload: { description: 'new feature', queueId: 'default', position: 0 }
      },
      acks
    );
    expect(executeCommand).toHaveBeenCalledWith('schegent.enqueue', {
      description: 'new feature',
      pipelineId: undefined,
      queueId: 'default',
      position: 0
    });
    expect(acks[0].msg.status).toBe('accepted');
  });

  // Feature 017 — BUG-003. CMD_START must NOT produce `rejected-already-running`
  // on a `controller.running` basis. The `schegent.enqueue` host command
  // routes through `GuardedRunService.scheduleOrEnqueue()` which has no
  // `controller.running` reject path — the queue dispatcher promotes the
  // pending task when capacity allows. The router surfaces the host result
  // verbatim in the ACK so the webview can render an "Enqueued to <queue>"
  // confirmation (SC-011).
  it('CMD_START surfaces an accepted ACK with the queue name even when a controller is already running (BUG-003 / SC-011)', async () => {
    executeCommand.mockResolvedValueOnce({
      result: { outcome: 'enqueued', queueItemId: 'task-while-running' },
      queueId: 'queue-A',
      queueName: 'Queue A'
    });
    await dispatch(
      router,
      {
        type: CMD_START,
        correlationId: 'while-running',
        payload: { description: 'second task', queueId: 'queue-A', position: 0 }
      },
      acks
    );
    expect(executeCommand).toHaveBeenCalledWith('schegent.enqueue', {
      description: 'second task',
      pipelineId: undefined,
      queueId: 'queue-A',
      position: 0
    });
    expect(acks[0].msg.status).toBe('accepted');
    expect(acks[0].msg.reason).toBeUndefined();
    expect(acks[0].msg.result).toMatchObject({
      outcome: 'enqueued',
      queueItemId: 'task-while-running',
      queueId: 'queue-A',
      queueName: 'Queue A'
    });
    // The router MUST NOT emit a `start rejected-already-running` audit
    // event on the controller-running basis (a `task-enqueued` audit is
    // emitted from `runEnqueue()` — that path is exercised in the
    // GuardedRunService unit tests).
  });

  it('CMD_START surfaces a rejected ACK with the host reason when scheduleOrEnqueue rejects (BUG-003)', async () => {
    executeCommand.mockResolvedValueOnce({
      result: { outcome: 'rejected-paused', reason: 'queue-paused' },
      queueId: null,
      queueName: null
    });
    await dispatch(
      router,
      {
        type: CMD_START,
        correlationId: 'paused',
        payload: { description: 'queued task', queueId: 'default', position: 0 }
      },
      acks
    );
    expect(acks[0].msg.status).toBe('rejected');
    expect(acks[0].msg.reason).toBe('queue-paused');
  });

  it('CMD_START primary-host gate is unchanged: secondary host rejects with secondary-window-readonly (T021b, US2)', async () => {
    const built = makeRouter({ isPrimary: () => false });
    const localAcks: CapturedAck[] = [];
    await dispatch(
      built.router,
      {
        type: CMD_START,
        correlationId: 'bf3',
        payload: {
          description: 'fix login bug',
          pipelineId: 'speckit-bugfix',
          queueId: 'default',
          position: 1
        }
      },
      localAcks
    );
    expect(localAcks[0].msg.status).toBe('rejected');
    expect(localAcks[0].msg.reason).toBe('secondary-window-readonly');
    expect(built.executeCommand).not.toHaveBeenCalled();
  });

  it('routes CMD_CANCEL to schegent.cancel with the taskId payload (BUG-001)', async () => {
    await dispatch(
      router,
      { type: CMD_CANCEL, correlationId: 'c2', payload: { taskId: 'task-1' } },
      acks
    );
    expect(executeCommand).toHaveBeenCalledWith('schegent.cancel', { taskId: 'task-1' });
    expect(acks[0].msg.status).toBe('accepted');
  });

  it('routes CMD_RESUME to schegent.resume', async () => {
    await dispatch(router, { type: CMD_RESUME, correlationId: 'c3' }, acks);
    expect(executeCommand).toHaveBeenCalledWith('schegent.resume');
    expect(acks[0].msg.status).toBe('accepted');
  });

  it('routes CMD_RESET to schegent.reset', async () => {
    await dispatch(router, { type: CMD_RESET, correlationId: 'c4', payload: { confirmed: true } }, acks);
    expect(executeCommand).toHaveBeenCalledWith('schegent.reset');
    expect(acks[0].msg.status).toBe('accepted');
  });

  it('routes CMD_OPEN_AUDIT_LOG to schegent.showAuditLog', async () => {
    await dispatch(router, { type: CMD_OPEN_AUDIT_LOG, correlationId: 'c5' }, acks);
    expect(executeCommand).toHaveBeenCalledWith('schegent.showAuditLog');
    expect(acks[0].msg.status).toBe('accepted');
  });

  it('routes CMD_REMOVE_QUEUE_ITEM to queueOps.removeTask and acks accepted', async () => {
    const built = makeRouter();
    built.queueOps.removeTaskResult = { ok: true, queueId: 'default' };
    const localAcks: CapturedAck[] = [];
    await dispatch(
      built.router,
      { type: CMD_REMOVE_QUEUE_ITEM, correlationId: 'c6', payload: { id: 'q-99', confirmed: true } },
      localAcks
    );
    expect(built.queueOps.removeTaskCalls).toEqual(['q-99']);
    expect(built.executeCommand).not.toHaveBeenCalled();
    expect(localAcks[0].msg.status).toBe('accepted');
  });

  it('emits task-removed audit with queueId and cause on accepted CMD_REMOVE_QUEUE_ITEM (BUG-002)', async () => {
    const built = makeRouter();
    built.queueOps.removeTaskResult = { ok: true, queueId: 'queue-secondary' };
    const localAcks: CapturedAck[] = [];
    await dispatch(
      built.router,
      { type: CMD_REMOVE_QUEUE_ITEM, correlationId: 'rm-1', payload: { id: 'task-42', confirmed: true } },
      localAcks
    );
    expect(localAcks[0].msg.status).toBe('accepted');
    const removedEvents = built.auditEntries.filter((entry) => entry.eventType === 'task-removed');
    expect(removedEvents).toHaveLength(1);
    expect(removedEvents[0].payload).toMatchObject({
      taskId: 'task-42',
      queueId: 'queue-secondary',
      cause: 'operator'
    });
    expect(removedEvents[0].correlationId).toBe('rm-1');
  });

  it('rejects CMD_REMOVE_QUEUE_ITEM with task-not-in-pending-state for non-pending rows (BUG-002)', async () => {
    const built = makeRouter();
    built.queueOps.removeTaskResult = { ok: false, reason: 'task-not-in-pending-state' };
    const localAcks: CapturedAck[] = [];
    await dispatch(
      built.router,
      { type: CMD_REMOVE_QUEUE_ITEM, correlationId: 'rm-2', payload: { id: 'in-flight-task', confirmed: true } },
      localAcks
    );
    expect(localAcks[0].msg.status).toBe('rejected');
    expect(localAcks[0].msg.reason).toBe('task-not-in-pending-state');
    expect(built.warnings.some((w) => /pending/i.test(w))).toBe(true);
    // The reject path must NOT emit a task-removed audit event.
    expect(built.auditEntries.filter((e) => e.eventType === 'task-removed')).toHaveLength(0);
  });

  it('rejects CMD_REMOVE_QUEUE_ITEM with unknown-task-id when the task is missing (BUG-002)', async () => {
    const built = makeRouter();
    built.queueOps.removeTaskResult = { ok: false, reason: 'unknown-task-id' };
    const localAcks: CapturedAck[] = [];
    await dispatch(
      built.router,
      { type: CMD_REMOVE_QUEUE_ITEM, correlationId: 'rm-3', payload: { id: 'never-existed', confirmed: true } },
      localAcks
    );
    expect(localAcks[0].msg.status).toBe('rejected');
    expect(localAcks[0].msg.reason).toBe('unknown-task-id');
    expect(built.auditEntries.filter((e) => e.eventType === 'task-removed')).toHaveLength(0);
  });

  it('sends rejected ack with sanitized reason on dispatch error', async () => {
    executeCommand.mockRejectedValueOnce(new Error('boom: Bearer abcdefghijklmnopqrst'));
    await dispatch(
      router,
      { type: CMD_CANCEL, correlationId: 'c8', payload: { taskId: 'task-error' } },
      acks
    );
    expect(acks[0].msg.status).toBe('rejected');
    expect(acks[0].msg.reason).toBeDefined();
    expect(acks[0].msg.reason).not.toContain('abcdefghijklmnopqrst');
    expect(acks[0].msg.reason).toContain('[REDACTED]');
  });

  describe('Queue mutating commands (T042)', () => {
    it('CMD_RETRY_QUEUE_ITEM calls queueOps.retry and acks accepted on ok', async () => {
      queueOps.retryResult = { ok: true };
      await dispatch(
        router,
        { type: CMD_RETRY_QUEUE_ITEM, correlationId: 'r1', payload: { id: 'q-1' } },
        acks
      );
      expect(queueOps.retryCalls).toEqual(['q-1']);
      expect(acks[0].msg.status).toBe('accepted');
    });

    it('CMD_RETRY_QUEUE_ITEM rejects with reason and notifies on illegal-state', async () => {
      const built = makeRouter();
      built.queueOps.retryResult = { ok: false, reason: 'illegal-state' };
      const localAcks: CapturedAck[] = [];
      await dispatch(
        built.router,
        { type: CMD_RETRY_QUEUE_ITEM, correlationId: 'r2', payload: { id: 'q-1' } },
        localAcks
      );
      expect(localAcks[0].msg.status).toBe('rejected');
      expect(localAcks[0].msg.reason).toBe('illegal-state');
      expect(built.warnings.length).toBeGreaterThan(0);
    });

    it('CMD_MOVE_QUEUE_ITEM_UP calls queueOps.moveUp', async () => {
      await dispatch(
        router,
        { type: CMD_MOVE_QUEUE_ITEM_UP, correlationId: 'mu1', payload: { id: 'q-2' } },
        acks
      );
      expect(queueOps.moveUpCalls).toEqual(['q-2']);
      expect(acks[0].msg.status).toBe('accepted');
    });

    it('CMD_MOVE_QUEUE_ITEM_UP rejects on at-edge with notification', async () => {
      const built = makeRouter();
      built.queueOps.moveUpResult = { ok: false, reason: 'at-edge' };
      const localAcks: CapturedAck[] = [];
      await dispatch(
        built.router,
        { type: CMD_MOVE_QUEUE_ITEM_UP, correlationId: 'mu2', payload: { id: 'q-2' } },
        localAcks
      );
      expect(localAcks[0].msg.status).toBe('rejected');
      expect(localAcks[0].msg.reason).toBe('at-edge');
      expect(built.warnings.length).toBeGreaterThan(0);
    });

    it('CMD_MOVE_QUEUE_ITEM_DOWN calls queueOps.moveDown', async () => {
      await dispatch(
        router,
        { type: CMD_MOVE_QUEUE_ITEM_DOWN, correlationId: 'md1', payload: { id: 'q-3' } },
        acks
      );
      expect(queueOps.moveDownCalls).toEqual(['q-3']);
      expect(acks[0].msg.status).toBe('accepted');
    });

    it('CMD_CLEAR_COMPLETED calls queueOps.clearCompleted', async () => {
      queueOps.clearCompletedResult = { removed: 4 };
      await dispatch(router, { type: CMD_CLEAR_COMPLETED, correlationId: 'cc1' }, acks);
      expect(queueOps.clearCompletedCalls).toBe(1);
      expect(acks[0].msg.status).toBe('accepted');
    });

    it('CMD_CLEAR_FAILED calls queueOps.clearFailed', async () => {
      queueOps.clearFailedResult = { removed: 2 };
      await dispatch(router, { type: CMD_CLEAR_FAILED, correlationId: 'cf1' }, acks);
      expect(queueOps.clearFailedCalls).toBe(1);
      expect(acks[0].msg.status).toBe('accepted');
    });

    it('CMD_PAUSE_QUEUE calls queueOps.setPaused(true)', async () => {
      await dispatch(router, { type: CMD_PAUSE_QUEUE, correlationId: 'pq1' }, acks);
      expect(queueOps.setPausedCalls).toEqual([{ paused: true, reason: null }]);
      expect(acks[0].msg.status).toBe('accepted');
    });

    it('CMD_PAUSE_QUEUE forwards optional reason', async () => {
      await dispatch(
        router,
        { type: CMD_PAUSE_QUEUE, correlationId: 'pq2', payload: { reason: 'rate-limited' } },
        acks
      );
      expect(queueOps.setPausedCalls).toEqual([{ paused: true, reason: 'rate-limited' }]);
      expect(acks[0].msg.status).toBe('accepted');
    });

    it('CMD_RESUME_QUEUE calls queueOps.setPaused(false)', async () => {
      await dispatch(router, { type: CMD_RESUME_QUEUE, correlationId: 'rq1' }, acks);
      expect(queueOps.setPausedCalls).toEqual([{ paused: false, reason: null }]);
      expect(acks[0].msg.status).toBe('accepted');
    });

    it('routes phase control commands through the command registry', async () => {
      await dispatch(router, { type: CMD_PAUSE_PHASE, correlationId: 'pp1' }, acks);
      await dispatch(router, { type: CMD_RESUME_PHASE, correlationId: 'rp1' }, acks);
      await dispatch(
        router,
        { type: CMD_RESTART_PHASE, correlationId: 'xp1', payload: { phaseId: 'speckit-plan' } },
        acks
      );

      expect(executeCommand).toHaveBeenNthCalledWith(1, 'schegent.pausePhase');
      expect(executeCommand).toHaveBeenNthCalledWith(2, 'schegent.resumePhase');
      expect(executeCommand).toHaveBeenNthCalledWith(3, 'schegent.restartPhase');
      expect(acks.map((ack) => ack.msg.status)).toEqual(['accepted', 'accepted', 'accepted']);
    });

    it('routes skip, disable, and enable through phaseOps', async () => {
      await dispatch(
        router,
        { type: CMD_SKIP_PHASE, correlationId: 'sk1', payload: { phaseId: 'speckit-plan' } },
        acks
      );
      await dispatch(
        router,
        { type: CMD_DISABLE_PHASE, correlationId: 'ds1', payload: { phaseId: 'speckit-plan' } },
        acks
      );
      await dispatch(
        router,
        { type: CMD_ENABLE_PHASE, correlationId: 'en1', payload: { phaseId: 'speckit-plan' } },
        acks
      );

      expect(acks.map((ack) => ack.msg.status)).toEqual(['accepted', 'accepted', 'accepted']);
    });
  });

  describe('Primary-window write gate (T042)', () => {
    it('rejects CMD_RETRY_QUEUE_ITEM when not primary, with reason secondary-window-readonly', async () => {
      const built = makeRouter({ isPrimary: () => false });
      const localAcks: CapturedAck[] = [];
      await dispatch(
        built.router,
        { type: CMD_RETRY_QUEUE_ITEM, correlationId: 'sec1', payload: { id: 'q-1' } },
        localAcks
      );
      expect(localAcks[0].msg.status).toBe('rejected');
      expect(localAcks[0].msg.reason).toBe('secondary-window-readonly');
      expect(built.queueOps.retryCalls).toEqual([]);
    });

    it('rejects CMD_PAUSE_QUEUE when not primary', async () => {
      const built = makeRouter({ isPrimary: () => false });
      const localAcks: CapturedAck[] = [];
      await dispatch(built.router, { type: CMD_PAUSE_QUEUE, correlationId: 'sec2' }, localAcks);
      expect(localAcks[0].msg.status).toBe('rejected');
      expect(localAcks[0].msg.reason).toBe('secondary-window-readonly');
      expect(built.queueOps.setPausedCalls).toEqual([]);
    });

    it('rejects CMD_REMOVE_QUEUE_ITEM when not primary (gated mutating cmd)', async () => {
      const built = makeRouter({ isPrimary: () => false });
      const localAcks: CapturedAck[] = [];
      await dispatch(
        built.router,
        { type: CMD_REMOVE_QUEUE_ITEM, correlationId: 'sec3', payload: { id: 'q-1', confirmed: true } },
        localAcks
      );
      expect(localAcks[0].msg.status).toBe('rejected');
      expect(localAcks[0].msg.reason).toBe('secondary-window-readonly');
    });

    it('still allows CMD_OPEN_AUDIT_LOG when not primary (read-only)', async () => {
      const built = makeRouter({ isPrimary: () => false });
      const localAcks: CapturedAck[] = [];
      await dispatch(built.router, { type: CMD_OPEN_AUDIT_LOG, correlationId: 'ro1' }, localAcks);
      expect(localAcks[0].msg.status).toBe('accepted');
    });
  });

  describe('No thrown exceptions on illegal state (T042 / FR-032)', () => {
    it('CMD_RETRY_QUEUE_ITEM never throws on not-found, returns rejected ack', async () => {
      const built = makeRouter();
      built.queueOps.retryResult = { ok: false, reason: 'not-found' };
      const localAcks: CapturedAck[] = [];
      await expect(
        dispatch(
          built.router,
          { type: CMD_RETRY_QUEUE_ITEM, correlationId: 'nf1', payload: { id: 'absent' } },
          localAcks
        )
      ).resolves.toBeUndefined();
      expect(localAcks[0].msg.status).toBe('rejected');
      expect(localAcks[0].msg.reason).toBe('not-found');
    });
  });

  describe('Wake up now', () => {
    it('acks accepted and kicks projection after manual completion', async () => {
      const wakeUpNow = vi.fn(async () => ({
        outcome: 'succeeded' as const,
        message: 'Wake up completed.',
        attempt: {
          id: 'attempt-1',
          timestamp: '2026-05-14T00:00:00.000Z',
          triggerSource: 'manual' as const,
          status: 'succeeded' as const,
          durationMs: 12,
          rawResponse: 'ok',
          message: 'Completed',
          truncated: false
        }
      }));
      const onWakeUpNowComplete = vi.fn();
      const built = makeRouter({ wakeUpNow, onWakeUpNowComplete });
      const localAcks: CapturedAck[] = [];

      await dispatch(
        built.router,
        { type: CMD_WAKE_UP_NOW, correlationId: 'wake-1' },
        localAcks
      );

      expect(wakeUpNow).toHaveBeenCalledTimes(1);
      expect(localAcks[0].msg.status).toBe('accepted');
      expect(localAcks[0].msg.result).toMatchObject({
        outcome: 'succeeded',
        attempt: { id: 'attempt-1', triggerSource: 'manual', status: 'succeeded' }
      });
      expect(onWakeUpNowComplete).toHaveBeenCalledTimes(1);
    });
  });
});
