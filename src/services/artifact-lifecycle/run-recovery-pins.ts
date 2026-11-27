/**
 * FR-R6-F05 (FR-005, T019) — which runs pin their recovery checkpoints.
 *
 * A non-terminal run (active or paused) still needs its checkpoints to resume,
 * so the checkpoint sweeper must not age them out. Terminality is the one rule
 * in `state/workflow-run.ts`; this module only projects it onto run ids.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { isTerminalRunStatus, type WorkflowRunStatus } from '../../state/workflow-run';
import { safeRunSegment } from '../run-checkpoint-paths';

export interface RecoveryPinRun {
  readonly id: string;
  readonly status: WorkflowRunStatus;
}

/** Ids of every run that is not terminal. */
export function recoveryPinnedRunIds(runs: Iterable<RecoveryPinRun | undefined>): ReadonlySet<string> {
  const pinned = new Set<string>();
  for (const run of runs) {
    if (run !== undefined && !isTerminalRunStatus(run.status)) pinned.add(run.id);
  }
  return pinned;
}

/**
 * The `isPinnedRun` hook of `RunCheckpointRetentionService`. It reads the run
 * map on every call, so a run that pauses after the service is built is still
 * protected when the sweep runs. Matches both raw run ids and `safeRunSegment`
 * normalized directory names under `checkpoints/`.
 */
export function recoveryPinnedRunPredicate(
  getRunMap: () => Readonly<Record<string, RecoveryPinRun | undefined>>
): (runSegment: string) => boolean {
  return (runSegment) => {
    for (const run of Object.values(getRunMap())) {
      if (run !== undefined && !isTerminalRunStatus(run.status)) {
        if (run.id === runSegment || safeRunSegment(run.id) === runSegment) return true;
      }
    }
    return false;
  };
}
