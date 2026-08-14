import type { QueueManager } from '../queue/queue-manager';
import type { SanitizedLogger } from '../lib/logger';
import { isTerminalRunStatus, type WorkflowRun } from '../state/workflow-run';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { HistoryRecorder } from './history-recorder';

/**
 * Durable, idempotent terminal transition journal. The intent is persisted
 * before the terminal run record. Activation replay completes queue/history
 * projection before clearing it, repairing crashes at any intermediate step.
 *
 * Feature 093 (T048) — one entry per in-flight transition, keyed by run id.
 * With one ambient intent, two Runs finishing at once meant the second `begin()`
 * overwrote the first's entry and the first `complete()` cleared the record for
 * both, so a crash before the second Run's queue/history projection had nothing
 * to replay.
 *
 * Keyed by **run id**, a deviation from the task's `queueId` wording recorded in
 * tasks.md: the key exists to keep two transitions from colliding, and every
 * call site holds the Run while none holds its queue. Resolving one would mean
 * falling back to the reserved queue when the Task row is gone — which is the
 * common case during replay, and would let a stranded entry collide with the
 * default queue's live one, reintroducing the very defect being removed. Run ids
 * are unique across queues, so an entry still names exactly one queue, and the
 * queue-addressed `setRun` below still resolves it from the Task row.
 */
export class TerminalTransitionCoordinator {
  constructor(
    private readonly store: WorkspaceStateStore,
    private readonly queue: Pick<QueueManager, 'finish'>,
    private readonly history: Pick<HistoryRecorder, 'record'>,
    private readonly logger: SanitizedLogger
  ) {}

  public async begin(run: WorkflowRun): Promise<void> {
    if (!isTerminalRunStatus(run.status)) return;
    const existing = this.store.getTerminalTransitionIntents()[run.id];
    if (existing && existing.run.status === run.status) return;
    await this.store.setTerminalTransitionIntent(run.id, {
      schemaVersion: 1,
      run,
      createdAt: Date.now()
    });
  }

  public async complete(run: WorkflowRun, description: string): Promise<void> {
    if (!isTerminalRunStatus(run.status)) return;
    await this.begin(run);
    // Feature 093 (T039) — pattern C-2, and deliberately `findRunByTask` rather
    // than `queueIdForTask`: the latter falls back to the reserved queue when
    // the Task row is gone, which is safe for a mutation that then finds
    // nothing but not for a write, where it would stamp this terminal Run over
    // whatever the default queue holds in flight. Both halves or neither.
    //
    // A replay whose Run record has already been cleared resolves to nothing
    // and writes nothing — the queue and history projection below is the
    // durable half and still runs, which is exactly what replay is for.
    const active = this.store.findRunByTask(run.featureId);
    if (active !== null && active.run.id === run.id) {
      await this.store.setRun(active.queueId, run);
    }
    try {
      await this.queue.finish(run.featureId, run.status as 'completed' | 'failed' | 'canceled');
      await this.history.record(
        run,
        description,
        run.status as 'completed' | 'failed' | 'canceled'
      );
      await this.store.setTerminalTransitionIntent(run.id, null);
    } catch (error) {
      this.logger.warn(`terminal-transition: replay remains pending: ${(error as Error).message}`);
    }
  }

  /**
   * Feature 093 (T048) — replay every pending transition, not just one.
   *
   * Sequential, and each entry is isolated by its own `try`: an entry whose
   * projection still cannot complete leaves itself journalled for the next
   * activation, and must not stop the entries behind it from replaying. A single
   * failure aborting the loop would strand transitions for reasons that have
   * nothing to do with them.
   */
  public async replay(): Promise<void> {
    for (const intent of Object.values(this.store.getTerminalTransitionIntents())) {
      try {
        await this.complete(intent.run, intent.run.featureId);
      } catch (error) {
        this.logger.warn(
          `terminal-transition: replay of run ${intent.run.id} failed: ${(error as Error).message}`
        );
      }
    }
  }
}
