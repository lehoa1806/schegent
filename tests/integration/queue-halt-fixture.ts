// Feature 195 — shared harness for the halt-on-failure integration suites
// (T009, T010, T017, T019, T021-T024, T059).
//
// Modeled on `concurrent-drain.test.ts`'s `makeWindow`: a real
// `WorkspaceStateStore`, a real `QueueManager`, and a real
// `AutoDrainCoordinator`, so a scenario exercises the same gate chain
// production code runs rather than a second, hand-rolled model of it.
//
// The one thing `concurrent-drain.test.ts`'s fixture does not need and this
// one does: a way to end an in-flight task as `failed` rather than always
// `completed` — `finish(taskId, status)` below is that.

import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { ExecutionLeaseManager } from '../../src/state/execution-lease';
import type { Clock, Scheduler } from '../../src/state/lock';
import { AutoDrainCoordinator } from '../../src/services/auto-drain-coordinator';
import { QueueStartFailureRegistry } from '../../src/services/queue-start-failure-registry';
import { createQueue } from '../../src/queue/queue-registry';
import type { FeatureRequest, FeatureRequestStatus, TerminalRequestStatus } from '../../src/queue/feature-request';
import type { QueueFailurePolicy } from '../../src/contracts/queue-failure-policy';
import type { SchegentWorkflowController } from '../../src/controller/workflow-controller';

export class FakeMemento implements Memento {
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

export class MutableClock implements Clock {
  private t: number;
  constructor(initial: number) {
    this.t = initial;
  }
  now(): number {
    return this.t;
  }
  advance(delta: number): void {
    this.t += delta;
  }
}

export const noopScheduler: Scheduler = {
  setInterval() {
    return { clear() {} };
  }
};

export interface HaltHarness {
  readonly memento: Memento;
  readonly store: WorkspaceStateStore;
  readonly queue: QueueManager;
  readonly autoDrain: AutoDrainCoordinator;
  readonly startFailures: QueueStartFailureRegistry;
  /** Every task id admitted, in the order `admitNew` was called. */
  readonly started: string[];
  /** Every queueId for which the execution lease was actually acquired. */
  readonly leaseAcquisitions: string[];
  /** Mutable: change mid-test to assert both policies against the same rows. */
  policy: QueueFailurePolicy;
  /** Ends the in-flight task on `queueId` with `status`, releasing the lease. */
  finish(queueId: string, status: TerminalRequestStatus): Promise<void>;
}

export async function makeHaltHarness(
  policy: QueueFailurePolicy = 'halt-on-failure',
  /**
   * Feature 195 (T023) — pass an existing `Memento` to model "the workspace
   * reopened": a fresh window's in-memory state (registry, `AutoDrainCoordinator`)
   * over the same persisted rows, with nothing about a prior halt carried
   * forward because nothing about it was ever written (FR-003).
   */
  sharedMemento?: Memento
): Promise<HaltHarness> {
  const memento = sharedMemento ?? new FakeMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  const clock = new MutableClock(1_700_000_000_000);
  const executionLease = new ExecutionLeaseManager(store, 'this-window', clock, noopScheduler);
  const startFailures = new QueueStartFailureRegistry(() => clock.now());

  const started: string[] = [];
  const leaseAcquisitions: string[] = [];
  let runSeq = 0;

  const controller = {
    admitNew: async (request: FeatureRequest) => {
      const runId = `run-${++runSeq}-${request.id}`;
      await queue.markInFlight(request.id, runId);
      started.push(request.id);
      return { completed: Promise.resolve() };
    },
    admitResume: async () => ({ resumed: false, completed: Promise.resolve() }),
    liveRunCount: 0
  };

  const state = { policy };
  const autoDrain = new AutoDrainCoordinator({
    store,
    queue,
    executionLease: {
      tryAcquire: async (queueId: string) => {
        const result = await executionLease.tryAcquire(queueId);
        if (result.acquired) leaseAcquisitions.push(queueId);
        return result;
      },
      release: (queueId: string) => executionLease.release(queueId),
      claimFor: (queueId: string) => executionLease.claimFor(queueId)
    },
    controller: controller as unknown as SchegentWorkflowController,
    startFailures,
    failurePolicyDefault: { resolve: () => state.policy }
  });

  return {
    memento,
    store,
    queue,
    autoDrain,
    startFailures,
    started,
    leaseAcquisitions,
    get policy(): QueueFailurePolicy {
      return state.policy;
    },
    set policy(value: QueueFailurePolicy) {
      state.policy = value;
    },
    async finish(queueId: string, status: TerminalRequestStatus): Promise<void> {
      const inFlight = store.getQueue(queueId).requests.find((r) => r.status === 'in-flight');
      if (inFlight) await queue.finish(inFlight.id, status);
      await executionLease.release(queueId);
    }
  };
}

/** Registers `ids` as additional queues, so a scenario can address more than one. */
export async function withQueues(
  harness: Pick<HaltHarness, 'store'>,
  ids: readonly { id: string; name: string }[]
): Promise<void> {
  let registry = harness.store.getQueueRegistry();
  for (const entry of ids) {
    registry = createQueue(registry, { id: entry.id, name: entry.name, now: 1_700_000_000_000 });
  }
  await harness.store.setQueueRegistry(registry);
}

/** A row already ended `failed`, for scenarios that seed one directly. */
export function isFailedRow(request: FeatureRequest): boolean {
  return (request.status as FeatureRequestStatus) === 'failed';
}
