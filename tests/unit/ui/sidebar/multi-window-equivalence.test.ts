import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unfencedCommit } from '../../../../src/state/ownership-claim';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StateProjector } from '../../../../src/ui/sidebar/state-projector';
import { MessageRouter, type QueueOps, type QueueRemover, type RouterDeps } from '../../../../src/ui/sidebar/message-router';
import {
  CMD_PAUSE_QUEUE,
  CMD_RESUME_QUEUE,
  CMD_RETRY_ACTIVE_RUN,
  CMD_RETRY_QUEUE_ITEM,
  CMD_REMOVE_QUEUE_ITEM,
  CMD_OPEN_AUDIT_LOG,
  CMD_OPEN_DASHBOARD,
  type CommandAckMessage
} from '../../../../src/ui/sidebar/messages';
import { WorkspaceStateStore, type Memento } from '../../../../src/state/workspace-state';
import { AuditLogWriter } from '../../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../../src/lib/logger';
import type { WorkflowRun } from '../../../../src/state/workflow-run';
import type { WorkflowSnapshot } from '../../../../src/ui/sidebar/snapshot';
import { DEFAULT_QUEUE_ID } from '../../../../src/queue/queue-registry';

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

let memento: FakeMemento;
let store: WorkspaceStateStore;
let audit: AuditLogWriter;
let tmpRoot: string;
let monoClock: { value: number };

function runningRun(): WorkflowRun {
  return {
    id: 'run-mw',
    featureId: 'feat-mw',
    featureDir: 'specs/099-mw',
    status: 'running',
    currentPhase: 'speckit-plan',
    currentIteration: 1,
    startedAt: 1_700_000_000_000,
    lastTransitionAt: 1_700_000_000_000,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null
  };
}

function frozenIso(): string {
  return new Date(1_700_000_000_000).toISOString();
}

function makeProjector(ownerId: string): StateProjector {
  return new StateProjector({
    store,
    audit,
    ownerId,
    debounceMs: 100,
    tickIntervalMs: 1_000,
    monotonicNow: () => monoClock.value,
    now: () => new Date(1_700_000_000_000)
  });
}

function stripVolatile(snap: WorkflowSnapshot): Omit<WorkflowSnapshot, 'isPrimary' | 'producedAt'> {
  // producedAt and isPrimary differ legitimately between windows; strip them
  // so we can byte-compare the deterministic core. With a frozen `now()`
  // producedAt is identical here, but in real usage it carries clock skew.
  const { isPrimary: _ip, producedAt: _pa, ...rest } = snap;
  return rest;
}

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-mw-'));
  audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
  monoClock = { value: 0 };
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('Multi-window equivalence (T068 / SC-014)', () => {
  it('two projectors with the same store inputs produce byte-equal deterministic cores', async () => {
    await store.setRun(DEFAULT_QUEUE_ID, runningRun(), unfencedCommit('test-fixture'));
    await store.setQueue({
      paused: false,
      pausedReason: null,
      inFlightId: null,
      updatedAt: 1_700_000_000_000,
      queueLifecycle: 'active-empty',
      pauseSource: null,
      scheduledStartAt: null,
      scheduledStartSource: null,
      requests: [
        {
          id: 'q-1',
          description: 'first',
          enqueuedAt: 1_700_000_000_000,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
          startedAt: null,
          completedAt: null,
          status: 'pending',
          position: 0,
          runId: null,
          retryCount: 0,
          lastError: null,
          pausedReason: null
        },
        {
          id: 'q-2',
          description: 'second',
          enqueuedAt: 1_700_000_000_500,
          createdAt: 1_700_000_000_500,
          updatedAt: 1_700_000_000_500,
          startedAt: null,
          completedAt: null,
          status: 'pending',
          position: 1,
          runId: null,
          retryCount: 0,
          lastError: null,
          pausedReason: null
        }
      ]
    });
    await store.setLock({
      ownerId: 'window-A',
      acquiredAt: 1_700_000_000_000,
      heartbeatAt: 1_700_000_000_000
    });

    const projA = makeProjector('window-A');
    const projB = makeProjector('window-B');
    projA.start();
    projB.start();

    const snapA = projA.getCurrentSnapshot();
    const snapB = projB.getCurrentSnapshot();

    expect(snapA.isPrimary).toBe(true);
    expect(snapB.isPrimary).toBe(false);

    const coreA = JSON.stringify(stripVolatile(snapA));
    const coreB = JSON.stringify(stripVolatile(snapB));
    expect(coreB).toBe(coreA);

    projA.dispose();
    projB.dispose();
  });

  it('rejects mutating commands when isPrimary returns false on the secondary router', async () => {
    const acks: CommandAckMessage[] = [];
    const queueRemover: QueueRemover = { remove: async () => true };
    const queueOps: QueueOps = {
      retry: async () => ({ ok: true }),
      moveUp: async () => ({ ok: true }),
      moveDown: async () => ({ ok: true }),
      clearCompleted: async () => ({ removed: 0 }),
      clearFailed: async () => ({ removed: 0 }),
      setQueuePausedState: async () => ({ ok: true, queueId: 'default' })
    };
    const router = new MessageRouter({
      executeCommand: (async () => undefined) as RouterDeps['executeCommand'],
      queueRemover,
      queueOps,
      isPrimary: () => false,
      isTrusted: () => true,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        sanitize: (s: string) => s
      }
    });

    const post = async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    };

    const mutating = [
      { type: CMD_PAUSE_QUEUE, payload: { reason: null }, correlationId: 'c1' },
      { type: CMD_RESUME_QUEUE, payload: undefined, correlationId: 'c2' },
      { type: CMD_RETRY_ACTIVE_RUN, payload: undefined, correlationId: 'c3' },
      { type: CMD_RETRY_QUEUE_ITEM, payload: { id: 'q-x' }, correlationId: 'c4' },
      { type: CMD_REMOVE_QUEUE_ITEM, payload: { id: 'q-y' }, correlationId: 'c5' }
    ] as const;
    for (const cmd of mutating) {
      await router.dispatch(cmd as never, post);
    }

    expect(acks).toHaveLength(mutating.length);
    for (const ack of acks) {
      expect(ack.status).toBe('rejected');
      expect(ack.reason).toBe('secondary-window-readonly');
    }
  });

  it('allows non-mutating commands on the secondary router', async () => {
    const acks: CommandAckMessage[] = [];
    const router = new MessageRouter({
      executeCommand: (async () => undefined) as RouterDeps['executeCommand'],
      queueRemover: { remove: async () => true },
      isPrimary: () => false,
      isTrusted: () => true,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        sanitize: (s: string) => s
      }
    });
    const post = async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    };
    await router.dispatch(
      { type: CMD_OPEN_AUDIT_LOG, payload: undefined, correlationId: 'r1' } as never,
      post
    );
    await router.dispatch(
      { type: CMD_OPEN_DASHBOARD, payload: undefined, correlationId: 'r2' } as never,
      post
    );
    expect(acks.map((a) => a.status)).toEqual(['accepted', 'accepted']);
    void frozenIso;
  });

  it('lock heartbeat staleness flips secondary back to primary readonly behavior', async () => {
    await store.setRun(DEFAULT_QUEUE_ID, runningRun(), unfencedCommit('test-fixture'));
    await store.setLock({
      ownerId: 'window-A',
      acquiredAt: 1_700_000_000_000,
      heartbeatAt: 1_000_000_000_000 // very old heartbeat
    });
    const projB = new StateProjector({
      store,
      audit,
      ownerId: 'window-B',
      debounceMs: 100,
      tickIntervalMs: 1_000,
      monotonicNow: () => monoClock.value,
      now: () => new Date(1_700_000_000_000)
    });
    projB.start();
    expect(projB.getCurrentSnapshot().isPrimary).toBe(true);
    projB.dispose();
  });
});
