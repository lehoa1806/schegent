// FR-R4-F16 (feature 244, contract P5.5, FR-001 to FR-003, SC-001) — end-to-end: removing a row writes
// `completionProvenance` into the `task-removed` audit line, in the payload and in the envelope's
// `newState`.
//
// The chain is the real one, built as `delete-task-cleanup.test.ts` builds it: a real `QueueManager`
// over a real `WorkspaceStateStore`, `SchegentWorkflowController.deleteTask` as the router's
// `PhaseOps.deleteTask`, the Remove handler through a real `MessageRouter`, and a real
// `AuditLogWriter` on a temporary root. Each written line is read back from disk and parsed. Only a
// row the operator attested reads `'operator-attested'`; every other row reads `null`; a stored value
// outside the vocabulary costs the field and nothing else.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import { SanitizedLogger } from '../../src/lib/logger';
import { QueueManager } from '../../src/queue/queue-manager';
import { KEYS, WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import type { PhaseRunner } from '../../src/controller/phase-runner';
import type { WorkspaceLockManager } from '../../src/state/lock';
import type { Notifier } from '../../src/ui/notifications';
import { CMD_REMOVE_QUEUE_ITEM } from '../../src/ui/sidebar/messages';
import { MessageRouter, type PhaseOps, type RouterDeps } from '../../src/ui/sidebar/message-router';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import { removeTempRoot } from '../temp-root-cleanup';

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

function makeLock(): WorkspaceLockManager {
  return {
    release: vi.fn(async () => {}),
    tryAcquire: vi.fn(async () => ({ acquired: false, owner: null })),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
}

interface WrittenRemoval {
  readonly payload: Record<string, unknown>;
  readonly newState: Record<string, unknown>;
  readonly actor: { kind?: unknown } | undefined;
}

const PAYLOAD_KEYS_WITH_FIELD = [
  'taskId',
  'queueId',
  'priorStatus',
  'runId',
  'cause',
  'sessionCleaned',
  'sessionCleanupRefusal',
  'completionProvenance',
  'stateTransition'
];

let tmpRoot: string;
let memento: FakeMemento;
let store: WorkspaceStateStore;
let queue: QueueManager;
let router: MessageRouter;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-removal-provenance-int-'));
  const logger = new SanitizedLogger();
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
  const controller = new SchegentWorkflowController(
    { run: vi.fn(), evictStagnationTracker: vi.fn() } as unknown as PhaseRunner,
    store,
    queue,
    { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier,
    logger,
    makeLock(),
    { cliPath: 'noop', cwd: tmpRoot, iterationCap: 5, timeoutMs: 1000 }
  );
  const phaseOps: PhaseOps = {
    skipPhase: vi.fn(async () => ({ ok: true })),
    disablePhase: vi.fn(async () => ({ ok: true })),
    enablePhase: vi.fn(async () => ({ ok: true })),
    deleteTask: (id) => controller.deleteTask(id)
  };
  const deps: RouterDeps = {
    executeCommand: vi.fn() as unknown as RouterDeps['executeCommand'],
    phaseOps,
    isPrimary: () => true,
    isTrusted: () => true,
    notifyWarning: () => undefined,
    logger,
    audit: new AuditLogWriter({ workspaceRoot: tmpRoot }, logger)
  };
  router = new MessageRouter(deps);
});

afterEach(async () => {
  await removeTempRoot(tmpRoot);
});

async function seedRow(
  description: string,
  runId: string | null,
  finish: 'completed' | 'failed' | 'canceled' | null
): Promise<string> {
  const row = await queue.enqueue(description);
  if (runId !== null) await queue.markInFlight(row.id, runId);
  if (finish !== null) await queue.finish(row.id, finish);
  return row.id;
}

/** Rewrites one stored row's provenance in the memento, as an older or newer build might have. */
async function seedProvenance(id: string, value: unknown): Promise<void> {
  const map = memento.get<Record<string, { requests: Array<Record<string, unknown>> } | undefined>>(KEYS.queue) ?? {};
  const queueState = map[DEFAULT_QUEUE_ID];
  if (queueState === undefined) throw new Error('the default queue must be persisted');
  const requests = queueState.requests.map((row) =>
    row.id === id ? { ...row, completionProvenance: value } : row
  );
  await memento.update(KEYS.queue, { ...map, [DEFAULT_QUEUE_ID]: { ...queueState, requests } });
}

/** Remove through the handler, then read back the one `task-removed` line it wrote for `taskId`. */
async function removeAndRead(taskId: string): Promise<WrittenRemoval> {
  const acks: string[] = [];
  await router.dispatch(
    { type: CMD_REMOVE_QUEUE_ITEM, correlationId: `rm-${taskId}`, payload: { id: taskId, confirmed: true } },
    async (msg) => {
      acks.push(msg.status);
      return true;
    }
  );
  expect(acks).toEqual(['accepted']);
  expect(queue.findById(taskId)).toBeNull();

  const body = await fs.readFile(path.join(tmpRoot, '.schegent', 'audit.log'), 'utf8');
  const lines = body
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { eventType: string; payload: Record<string, unknown> });
  const matching = lines.filter((line) => line.eventType === 'task-removed' && line.payload.taskId === taskId);
  expect(matching).toHaveLength(1);
  const payload = (matching[0] as { payload: Record<string, unknown> }).payload;
  const transition = payload.stateTransition as {
    newState: Record<string, unknown>;
    actor?: { kind?: unknown };
  };
  return { payload, newState: transition.newState, actor: transition.actor };
}

describe('FR-R4-F16 — removal writes completionProvenance (contract P5.5, SC-001)', () => {
  it("reads 'operator-attested' for a failed row the operator attested, in both copies", async () => {
    const id = await seedRow('failed then attested', 'run-attested', 'failed');
    expect((await queue.attestCompleted(id)).ok).toBe(true);

    const written = await removeAndRead(id);

    expect(written.payload.priorStatus).toBe('completed');
    expect(written.payload.completionProvenance).toBe('operator-attested');
    expect(written.newState.completionProvenance).toBe('operator-attested');
    expect(Object.keys(written.payload).sort()).toEqual([...PAYLOAD_KEYS_WITH_FIELD].sort());
  });

  it.each([
    ['a host-completed row', 'run-host', 'completed', 'completed'],
    ['a failed row', 'run-failed', 'failed', 'failed'],
    ['a canceled row', 'run-canceled', 'canceled', 'canceled'],
    ['a pending row', null, null, 'pending']
  ] as const)('reads null in both copies for %s', async (_name, runId, finish, priorStatus) => {
    const id = await seedRow(`row ${priorStatus}`, runId, finish);

    const written = await removeAndRead(id);

    expect(written.payload.priorStatus).toBe(priorStatus);
    expect(written.payload).toHaveProperty('completionProvenance', null);
    expect(written.newState).toHaveProperty('completionProvenance', null);
    expect(Object.keys(written.payload).sort()).toEqual([...PAYLOAD_KEYS_WITH_FIELD].sort());
  });

  it('leaves the key out of both copies for a stored value outside the vocabulary, keeping every other key', async () => {
    const id = await seedRow('seeded', 'run-seeded', 'completed');
    await seedProvenance(id, 'host-verified');

    const written = await removeAndRead(id);

    expect('completionProvenance' in written.payload).toBe(false);
    expect('completionProvenance' in written.newState).toBe(false);
    expect(Object.keys(written.payload).sort()).toEqual(
      PAYLOAD_KEYS_WITH_FIELD.filter((key) => key !== 'completionProvenance').sort()
    );
    expect(written.payload.taskId).toBe(id);
    expect(written.payload.priorStatus).toBe('completed');
    expect(written.payload.runId).toBe('run-seeded');
  });

  it('still writes the line when the stored value is a path-like string', async () => {
    const id = await seedRow('hostile', 'run-hostile', 'completed');
    await seedProvenance(id, '/Users/someone/.ssh/id_rsa');

    const written = await removeAndRead(id);

    expect('completionProvenance' in written.payload).toBe(false);
    expect(JSON.stringify(written.payload)).not.toContain('/Users/someone');
  });

  it('keeps the envelope actor as the operator, as before', async () => {
    const id = await seedRow('actor', 'run-actor', 'completed');

    const written = await removeAndRead(id);

    expect(written.actor?.kind).toBe('operator');
  });
});
