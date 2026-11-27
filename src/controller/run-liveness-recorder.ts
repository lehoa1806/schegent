import type { SanitizedLogger } from '../lib/logger';
import type { RunActivityObservation } from '../monitor/activity-coalescer';
import { isRunRaceRefusal, type WorkspaceStateStore } from '../state/workspace-state';
import { isTerminalRunStatus, LIVE_RUN_STATUSES } from '../state/workflow-run';

export interface RunLivenessRecorderDeps {
  readonly store: Pick<WorkspaceStateStore, 'findRunById' | 'updateRun' | 'runCommitClaim'>;
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
 *   - **Never move the stamp backwards.** Two observations can interleave;
 *     the patch compares against the Run as it is inside the chain and keeps
 *     the later timestamp, so the outcome is independent of which lands last.
 *   - **`lastTransitionAt` is not touched.** The spread copies it verbatim and
 *     no branch below writes it. That is the point of the field split, and
 *     `liveness-does-not-touch-transition.test.ts` pins it.
 *
 * FR-R4-F01 (FR-008) — the write is `updateRun`, a PATCH of `liveness` applied to
 * the Run as it is inside the store's `KEYS.run` chain, not a whole Run built from
 * the read above. A pause, a cancel or a retry write that lands between the read
 * and the link therefore keeps its fields, and a Run that has gone terminal in the
 * meantime refuses the update (`run-status-precondition`) instead of being reopened.
 * Those two refusals are the expected outcome of a race and are not logged.
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
      .updateRun(
        queueId,
        {
          runId: run.id,
          allowedStatuses: LIVE_RUN_STATUSES,
          label: 'liveness',
          // FR-R3-077 — a liveness write is a Run commit like any other.
          patch: (current) =>
            current.liveness && current.liveness.lastActivityAt >= observation.at
              ? {}
              : {
                  liveness: {
                    lastActivityAt: observation.at,
                    stdoutLines: observation.stdoutLines,
                    stderrLines: observation.stderrLines
                  }
                }
        },
        store.runCommitClaim(queueId)
      )
      .catch((err: unknown) => {
        if (isRunRaceRefusal(err)) return;
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
