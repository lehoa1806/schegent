// Feature 063 — T021 unit test pinning FR-006: `QueueManager.clearAll()`
// MUST NOT touch any memento namespace other than the five canonical
// surfaces it owns (queue items, in-flight, pause via registry, active
// run, watchdog backoff). The spec calls this out as a non-negotiable
// invariant — operators relying on suppression preferences, history,
// pipelines, models, and settings must NOT see those wiped by Clean All.
//
// We assert this with a write spy on the Memento. The set of keys
// touched by clearAll() must be a strict subset of:
//   - schegent.queue                  (queue items + paused mirror)
//   - schegent.queues.registry         (pause source authoritative)
//   - schegent.run                     (active run)
//   - schegent.watchdog                (backoff)
//
// Any write outside this allow-list is treated as a contract violation
// and fails the test.

import { describe, it, expect } from 'vitest';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import type { WorkflowRun } from '../../../src/state/workflow-run';

class SpyMemento implements Memento {
  public touched: string[] = [];
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.touched.push(key);
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

const ALLOWED_KEYS = new Set([
  'schegent.queue',
  'schegent.queues.registry',
  'schegent.run',
  'schegent.watchdog'
]);

const FORBIDDEN_KEYS = [
  'schegent.ui.confirmSuppression', // FR-006: suppression preferences preserved
  'schegent.history', // audit history & rerun history must survive
  'schegent.state.quarantine.v2', // multi-queue migration quarantine
  'schegent.queue.defaultQueueId', // single-queue default config
  'schegent.queue.globalConcurrencyCap', // user concurrency setting
  'schegent.lock', // lock namespace is not a queue surface
  'schegent.schemaVersion', // schema version pin
  'schegent.schemaVersionNumeric'
];

function makeRun(featureId: string): WorkflowRun {
  return {
    id: 'run-1',
    featureId,
    featureDir: 'specs/001-x',
    status: 'running',
    currentPhase: 'speckit-plan',
    currentIteration: 0,
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

async function populateAllSurfaces(): Promise<{
  store: WorkspaceStateStore;
  queue: QueueManager;
  memento: SpyMemento;
}> {
  const memento = new SpyMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);

  // Populate every surface clearAll touches.
  const a = await queue.enqueue('task A');
  await queue.enqueue('task B');
  await queue.markInFlight(a.id, 'run-A');
  await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID, 'maintenance', 'operator');
  await store.setRun(DEFAULT_QUEUE_ID, makeRun(a.id), unfencedCommit('test-fixture'));
  await store.setWatchdog({
    paused: true,
    pausedSince: 1_700_000_000_000,
    nextPollAt: 1_700_000_030_000,
    pollIntervalMs: 60_000,
    lastStatusOk: false,
    cause: 'cli-down'
  });

  // Populate surfaces we expect to be UNTOUCHED.
  await store.setConfirmSuppression('queue.clean-all', true);
  await store.setConfirmSuppression('queue.remove-item', true);

  memento.touched = [];
  return { store, queue, memento };
}

describe('QueueManager.clearAll() — no cross-contamination (T021)', () => {
  it('only writes to the four canonical queue/run/watchdog keys', async () => {
    const { queue, memento } = await populateAllSurfaces();
    await queue.clearAll();

    const unique = new Set(memento.touched);
    for (const key of unique) {
      expect(
        ALLOWED_KEYS.has(key),
        `clearAll() wrote to unexpected key: ${key}`
      ).toBe(true);
    }
  });

  it('does not touch the forbidden memento namespaces', async () => {
    const { queue, memento } = await populateAllSurfaces();
    await queue.clearAll();

    for (const key of FORBIDDEN_KEYS) {
      expect(memento.touched).not.toContain(key);
    }
  });

  it('preserves the confirm-suppression set verbatim', async () => {
    const { store, queue } = await populateAllSurfaces();
    await queue.clearAll();

    const after = store.getConfirmSuppression();
    expect(after.version).toBe(1);
    expect(after.suppressedActionKeys).toEqual(
      expect.arrayContaining(['queue.clean-all', 'queue.remove-item'])
    );
  });

  it('preserves the watchdog config scalars (pollIntervalMs, lastStatusOk)', async () => {
    const { store, queue } = await populateAllSurfaces();
    await queue.clearAll();

    const after = store.getWatchdog();
    // Active-pause fields cleared:
    expect(after.paused).toBe(false);
    expect(after.pausedSince).toBeNull();
    expect(after.nextPollAt).toBeNull();
    expect(after.cause).toBeNull();
    // Config / observability scalars preserved:
    expect(after.pollIntervalMs).toBe(60_000);
    expect(after.lastStatusOk).toBe(false);
  });

  it('preserves the queue.defaultQueueId / queue.globalConcurrencyCap when set', async () => {
    const memento = new SpyMemento();
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    const queue = new QueueManager(store);

    // Seed an explicit default-id / concurrency cap so we can assert they
    // are not stomped by clearAll.
    await memento.update('schegent.queue.defaultQueueId', 'custom-default');
    await memento.update('schegent.queue.globalConcurrencyCap', 3);

    await queue.enqueue('a task');
    await queue.setQueuePausedState(true, DEFAULT_QUEUE_ID, null, 'operator');

    memento.touched = [];
    await queue.clearAll();

    expect(memento.touched).not.toContain('schegent.queue.defaultQueueId');
    expect(memento.touched).not.toContain('schegent.queue.globalConcurrencyCap');
    expect(memento.get('schegent.queue.defaultQueueId')).toBe('custom-default');
    expect(memento.get('schegent.queue.globalConcurrencyCap')).toBe(3);
  });

  it('no-op clearAll() writes nothing at all', async () => {
    const memento = new SpyMemento();
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    const queue = new QueueManager(store);
    memento.touched = [];

    const result = await queue.clearAll();

    expect(result.wasNoop).toBe(true);
    expect(memento.touched).toEqual([]);
  });
});
