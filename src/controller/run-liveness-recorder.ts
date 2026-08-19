import type { SanitizedLogger } from '../lib/logger';
import type { RunActivityObservation } from '../monitor/activity-coalescer';
import type { WorkspaceStateStore } from '../state/workspace-state';
import { isTerminalRunStatus } from '../state/workflow-run';

export interface RunLivenessRecorderDeps {
  readonly store: Pick<WorkspaceStateStore, 'findRunById' | 'setRun'>;
  readonly logger: SanitizedLogger;
}

/**
 * FR-R3-008 (T377) — persist a coalesced liveness observation.
 *
 * Fire-and-forget by design: the caller is the monitor's chunk path, which
 * cannot await and must not fail because a memento write did. Every failure is
 * absorbed and logged, and the next observation supersedes the one that was
 * lost — which is also why nothing retries here.
 *
 * Four guards, each closing a way this write could say something false:
 *
 *   - **No Run, no write.** The monitor knows a run id; the store is addressed
 *     by queue. `findRunById` returns both halves or neither, so a Run whose
 *     record has already been cleared is skipped rather than resurrected under a
 *     guessed queue id.
 *   - **Terminal Runs are left alone.** A late chunk arriving after the driver
 *     wrote `completed` must not reopen that record. `onExit` already stops the
 *     monitor from noting activity, so this is the defensive half.
 *   - **Never move the stamp backwards.** The read is outside the serialize
 *     chain, so two observations can interleave; taking the later timestamp
 *     makes the outcome independent of which one lands last.
 *   - **`lastTransitionAt` is not touched.** The spread copies it verbatim and
 *     no branch below writes it. That is the point of the field split, and
 *     `liveness-does-not-touch-transition.test.ts` pins it.
 *
 * The read and the `setRun` call are one synchronous block with no `await`
 * between them, so nothing can clear the record between resolving the queue and
 * appending to the chain. The write itself is `setRun`, so it is a whole-map
 * read-modify-write on the store's existing serialize chain — this path adds no
 * second way to reach a Run record.
 */
export function recordRunLiveness(
  deps: RunLivenessRecorderDeps,
  observation: RunActivityObservation
): void {
  const { store, logger } = deps;
  try {
    const found = store.findRunById(observation.runId);
    if (!found) return;
    const { queueId, run } = found;
    if (isTerminalRunStatus(run.status)) return;
    if (run.liveness && run.liveness.lastActivityAt >= observation.at) return;
    void store
      .setRun(queueId, {
        ...run,
        liveness: {
          lastActivityAt: observation.at,
          stdoutLines: observation.stdoutLines,
          stderrLines: observation.stderrLines
        }
      })
      .catch((err: unknown) => {
        logger.warn(
          `run-liveness write failed for run ${observation.runId}: ${(err as Error).message}`
        );
      });
  } catch (err: unknown) {
    logger.warn(
      `run-liveness record failed for run ${observation.runId}: ${(err as Error).message}`
    );
  }
}
