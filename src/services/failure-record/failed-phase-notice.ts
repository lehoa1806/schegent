// ---------------------------------------------------------------------------
// FR-R4-F15 (feature 243, contracts C6.1 and C6.4) — the driver's failed-phase effect: keep the record,
// then say what happened.
//
// The two steps are one decision. The notice names "Show last error" only when the record was
// written, so it cannot be built until the write has answered. Held together here they are a single
// call in `RunDriver.drive()`, which is the size its method and file budgets can carry.
//
// THE ORDER IS THE CONTRACT. The Run is persisted as failed before this runs (the caller's last write).
// The record is read from the phase result already in hand, the notice follows, and the terminal effect
// sequence of `run-terminal-effects.ts` (FR-R3-128) is untouched after it. `record()` never throws, so
// a record that could not be written is `false` here and the notice makes no promise about one.
//
// The recorder is optional on the same terms as the driver's `checkpoints`: a driver built without
// one fails every Run exactly as before, and its notice makes no promise about a record either.
// ---------------------------------------------------------------------------

import type { SequencerFailureCause } from '../../controller/fail-decision-cause';
import type { InvocationResult } from '../../parser/stdout-parser';
import type { WorkflowRun } from '../../state/workflow-run';
import { failureNotice, type FailureNotice } from '../failure-notice';
import type { FailureRecorder } from './failure-record-service';

export type { FailureRecorder } from './failure-record-service';

/** What the driver holds when the sequencer's decision after a phase is `fail`. */
export interface FailedPhase {
  readonly run: Pick<WorkflowRun, 'id' | 'featureId' | 'currentPhase'>;
  readonly decision: {
    readonly failureCause: SequencerFailureCause;
    readonly stalledCount?: number | undefined;
  };
  readonly result: InvocationResult;
  /** The Task's description; the notice cuts its row-button label from it. */
  readonly taskTitle: string;
  readonly iteration: number;
}

export async function failedPhaseNotice(
  recorder: FailureRecorder | undefined,
  options: { readonly iterationCap: number },
  failed: FailedPhase
): Promise<FailureNotice> {
  const { run, decision, result, taskTitle, iteration } = failed;
  const { failureCause: cause, stalledCount } = decision;
  const { iterationCap } = options;
  const recordWritten = (await recorder?.record({ run, cause, result, iteration, iterationCap, stalledCount })) === true;
  return failureNotice({ cause, phase: run.currentPhase, taskTitle, iteration, iterationCap, stalledCount, recordWritten });
}
