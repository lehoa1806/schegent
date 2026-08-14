import type { QueueManager } from '../queue/queue-manager';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkflowRun } from '../state/workflow-run';
import type { ExecutionLeasePort } from './auto-drain-coordinator';

export interface ExecutionLeaseReleaseDeps {
  readonly queue: Pick<QueueManager, 'findById' | 'queueIdForTask'>;
  readonly executionLease: ExecutionLeasePort;
  readonly logger: SanitizedLogger;
}

/** The statuses that end a Run's execution-lease tenure (FR-033a). */
const TERMINAL_STATUSES = ['completed', 'failed', 'canceled'] as const;

/**
 * Feature 092 (T132, T133, BUG-001, FR-033a) — end a queue execution lease's
 * tenure at its Run's terminal transition.
 *
 * `AutoDrainCoordinator` claims the lease at drain step 6 and returns as soon as
 * the Run has started, so the tenure outlives the drain call by the whole length
 * of the Run. Nothing used to close it: the queue stayed claimed until the 15 s
 * staleness threshold reclaimed it — invisible while drain step 4b refused to
 * start a second Run anyway, and a stuck queue the moment that gate is deleted.
 *
 * Three properties this deliberately holds:
 *
 * - Terminal is `completed | failed | canceled`, enumerated rather than derived
 *   by negating the active status — that negation also admits `paused`, and a
 *   paused Run still owns its queue; a later resume continues on the same lease.
 * - The queue is resolved from the Task row and never guessed. `queueIdForTask`
 *   falls back to the reserved queue for a row that is gone, which is right for
 *   a mutation that then finds nothing and wrong here: every Run in one window
 *   shares an owner id, so `release()`'s ownership guard cannot tell a wrong
 *   queue from a right one, and releasing the fallback would clear a sibling
 *   Run's live lease. No row, no release.
 * - Failures are swallowed and logged. This runs on the terminal path, where a
 *   throw would take the Run's completion down with it, and the staleness
 *   threshold is still behind us as the backstop.
 *
 * A separate module rather than a controller method because the tenure is a
 * property of the lease, not of the facade: the drain owns one end of it
 * (step 7, for a start that never reached the controller) and this owns the
 * other, and the two are disjoint by construction.
 */
export async function releaseExecutionLeaseForTerminalRun(
  deps: ExecutionLeaseReleaseDeps,
  run: WorkflowRun
): Promise<void> {
  if (!(TERMINAL_STATUSES as readonly string[]).includes(run.status)) return;
  try {
    if (!deps.queue.findById(run.featureId)) {
      deps.logger.warn(
        'execution lease not released: no queue row for the terminated run task'
      );
      return;
    }
    await deps.executionLease.release(deps.queue.queueIdForTask(run.featureId));
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    deps.logger.warn(
      `failed to release execution lease after terminal transition: ${deps.logger.sanitize(raw)}`
    );
  }
}
