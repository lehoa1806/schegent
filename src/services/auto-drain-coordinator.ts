// Feature 013 — Wave 7 (US7 / T099): auto-drain orchestration extracted
// from `WorkflowController`. Called from the `finally` block of
// `driveRun()`. Decides whether the next queued feature should be
// promoted to in-flight when a run terminates.
//
// Encapsulates the chain: queue.paused-guard → capacity-guard →
// peekNextPending → lock.tryAcquire → controller.startNew.

import type { QueueManager } from '../queue/queue-manager';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { WorkspaceLockManager } from '../state/lock';
import type { SchegentWorkflowController } from '../controller/workflow-controller';

export interface AutoDrainCoordinatorDeps {
  readonly store: Pick<WorkspaceStateStore, 'getQueue'>;
  readonly queue: Pick<QueueManager, 'peekNextPending' | 'hasCapacity'>;
  readonly lock: Pick<WorkspaceLockManager, 'tryAcquire'>;
  readonly controller: Pick<SchegentWorkflowController, 'startNew'>;
}

export class AutoDrainCoordinator {
  private readonly store: AutoDrainCoordinatorDeps['store'];
  private readonly queue: AutoDrainCoordinatorDeps['queue'];
  private readonly lock: AutoDrainCoordinatorDeps['lock'];
  private readonly controller: AutoDrainCoordinatorDeps['controller'];

  constructor(deps: AutoDrainCoordinatorDeps) {
    this.store = deps.store;
    this.queue = deps.queue;
    this.lock = deps.lock;
    this.controller = deps.controller;
  }

  public async drainIfIdle(): Promise<void> {
    const queueState = this.store.getQueue();
    // Feature 065 (T010 / FR-003): an `idle-pending` queue MUST NOT
    // auto-promote. The scheduler (or an explicit operator restart via
    // `CMD_START_QUEUE`) owns the transition out of `idle-pending`.
    if (queueState.queueLifecycle === 'idle-pending') return;
    if (queueState.paused) return;
    if (!this.queue.hasCapacity()) return;
    const next = this.queue.peekNextPending();
    if (!next) return;
    const acquired = await this.lock.tryAcquire();
    if (!acquired.acquired) return;
    await this.controller.startNew(next, null);
  }
}
