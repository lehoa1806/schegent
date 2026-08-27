// FR-R3-128 (T1484, FR-002) — the effects a Run's terminal outcome applies.
//
// WHY THIS FILE EXISTS, AND WHY IT IS NOT WHAT THE ITEM ASKED FOR. `FR-R3-128`'s
// T1484 asks for "the decision-pure units — phase-outcome classification, retry
// decision, terminal transition — as functions with no I/O". Those already exist:
// `src/controller/phase-sequencer.ts` returns a closed `PostPhaseDecision` union
// with no I/O, and `retryCoordinator` / `terminalTransitions` are injected
// collaborators. The task was redirected, on the record, to what actually makes
// `drive()` long: the EFFECT APPLICATION per decision arm.
//
// This is the first governed decrement of that, on this repository's own
// successive-decrement precedent (the composition-root series ran 1,010 -> 480 over
// nine commits, each lowering its gate in the same change).
//
// WHAT IT OWNS. The sequence two of the three terminal arms performed
// character-for-character:
//
//   1. the run-ended breakpoint audit
//   2. the status bar
//   3. the operator notification
//   4. `queue.finish`, whose failure is logged and swallowed
//   5. the history record, whose failure is logged and swallowed
//   6. `task-execution-ended`, via the ONE emitter FR-R3-107 consolidated
//
// STEPS 4 AND 5 SWALLOW. That is deliberate and predates this extraction: a Run
// that reached a terminal state has reached it, and failing to write the queue's
// copy or the history copy must not turn a completed Run into a thrown exception
// half-way through its terminal bookkeeping. Step 6 does NOT swallow, because the
// audit record is the one copy the project treats as required evidence.
//
// WHAT IT DOES NOT OWN, and this is the boundary that matters: it does not decide
// anything. It is handed a terminal status and applies it. The decision of WHICH
// terminal status belongs to `drive()`'s dispatch over `PostPhaseDecision`, and
// moving that here would relocate the branch density under a different name — the
// refactor that shows progress on a line count and none anywhere else.
//
// THE PROBE-FAILURE ARM IS DELIBERATELY NOT ROUTED THROUGH THIS. Its order differs:
// it emits `task-execution-ended` BEFORE the breakpoint audit and the history
// record, where these two emit it last. Unifying that order is a change to the
// sequence of audit emissions — observable, and outside a decrement whose premise is
// that nothing observable moves. Recorded here rather than quietly normalised.
import type { WorkflowRun } from '../state/workflow-run';
import type { QueueManager } from '../queue/queue-manager';
import type { FeatureRequestFailure } from '../queue/feature-request';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import type { StatusModel } from '../ui/status-bar';
import { errorMessage } from '../lib/errors';

/**
 * The status-bar and notification text a terminal status carries.
 *
 * `notify` is DATA, not a callback. A callback was the first shape and it was worse
 * twice over: each call site grew a three-line block body because
 * `Notifier.warn` returns a Thenable and a concise arrow would hand a promise to a
 * void slot, and the sequence's own module could no longer see what was said. A
 * level and a message is the whole content.
 */
export interface TerminalPresentation {
  readonly statusBar: StatusModel;
  readonly notify: { readonly level: 'info' | 'warn'; readonly message: string };
}

export interface TerminalSettleInputs {
  readonly run: WorkflowRun;
  readonly description: string;
  readonly terminalStatus: 'completed' | 'failed';
  readonly presentation: TerminalPresentation;
  /**
   * The structured error `queue.finish` records, when there is one.
   *
   * FR-R3-128 (T1487) — typed as `FeatureRequestFailure` rather than restated, which
   * is also what takes this module out of the `exactOptionalPropertyTypes` ratchet: a
   * hand-written shape whose `phase` was `string | undefined` was not assignable to
   * one whose `phase?` is `string`, and the fix is to stop having two shapes.
   */
  readonly queueError?: FeatureRequestFailure;
  /** Extra payload fields for the terminal audit record. */
  readonly auditExtra?: Readonly<Record<string, unknown>>;
}

export interface TerminalSettleDeps {
  readonly queue: Pick<QueueManager, 'finish'>;
  readonly notifier: Notifier;
  readonly statusBar: { update(runId: string, model: StatusModel): void };
  readonly logger: SanitizedLogger;
  readonly historyRecorder: {
    /**
     * The real recorder returns a `HistoryRecordResult`; this narrows to `unknown`
     * because the terminal sequence does not read it. Narrowing rather than
     * importing the result type keeps this module's dependency surface to the four
     * collaborators it actually calls.
     */
    record(run: WorkflowRun, description: string, outcome: string): Promise<unknown>;
  };
  readonly emitRunEndedBreakpointAudit: (run: WorkflowRun) => Promise<void>;
  /**
   * The ONE `task-execution-ended` emitter (`FR-R3-107`). Injected rather than
   * reimplemented: a second emitter is exactly the defect that item removed, and a
   * copy here would be a third.
   */
  readonly emitTerminalOutcome: (
    run: WorkflowRun,
    terminalStatus: 'completed' | 'failed',
    extra?: Readonly<Record<string, unknown>>
  ) => Promise<void>;
}

/**
 * The collaborators `settleTerminalRun` needs, as they appear on `RunDriverDeps`.
 *
 * Declared structurally rather than importing `RunDriverDeps`: this module is the
 * destination of an extraction, and importing the type of the thing it was extracted
 * FROM would put the edge back.
 */
export interface TerminalSettleSource {
  readonly queue: TerminalSettleDeps['queue'];
  readonly notifier: Notifier;
  readonly statusBar: TerminalSettleDeps['statusBar'];
  readonly logger: SanitizedLogger;
  readonly historyRecorder: TerminalSettleDeps['historyRecorder'];
  readonly emitRunEndedBreakpointAudit: (run: WorkflowRun) => Promise<void>;
}

/**
 * Bind a driver's dependencies to the sequence.
 *
 * Here rather than in the driver so the driver's own body stays a loop and a
 * dispatch: a thirty-line deps literal inside `run-driver.ts` would have moved the
 * sequence out and left its wiring behind, which is most of the length back.
 */
export function terminalSettler(
  source: TerminalSettleSource,
  emitTerminalOutcome: TerminalSettleDeps['emitTerminalOutcome']
): (inputs: TerminalSettleInputs) => Promise<void> {
  return (inputs) => settleTerminalRun({ ...source, emitTerminalOutcome }, inputs);
}

/**
 * Apply a Run's terminal outcome.
 *
 * Order is load-bearing and is the order the arms had: the breakpoint audit first
 * (it describes the Run that just ended), the operator surfaces next, then the two
 * best-effort records, then the required audit record last.
 */
export async function settleTerminalRun(
  deps: TerminalSettleDeps,
  inputs: TerminalSettleInputs
): Promise<void> {
  const { run, description, terminalStatus, presentation } = inputs;

  await deps.emitRunEndedBreakpointAudit(run);
  deps.statusBar.update(run.id, presentation.statusBar);
  // `void` on the warn path: `Notifier.warn` returns a Thenable this sequence does
  // not await — the operator's dismissal is not a step in a Run's termination.
  if (presentation.notify.level === 'warn') void deps.notifier.warn(presentation.notify.message);
  else deps.notifier.info(presentation.notify.message);

  try {
    if (inputs.queueError === undefined) {
      await deps.queue.finish(run.featureId, terminalStatus);
    } else {
      await deps.queue.finish(run.featureId, terminalStatus, inputs.queueError);
    }
  } catch (queueError) {
    // Swallowed by design: see the module docblock. A Run that ended has ended.
    deps.logger.warn(
      `run-driver: queue.finish (${terminalStatus}) failed: ${errorMessage(queueError)}`
    );
  }

  try {
    await deps.historyRecorder.record(run, description, terminalStatus);
  } catch (historyError) {
    deps.logger.warn(
      `run-driver: history record (${terminalStatus}) failed: ${errorMessage(historyError)}`
    );
  }

  // Last, and NOT swallowed: the audit record is required evidence.
  await deps.emitTerminalOutcome(run, terminalStatus, inputs.auditExtra);
}
