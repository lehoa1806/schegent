// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT. Registers
// commands through `registerGuardedCommand`; the registrations themselves
// perform nothing, and each handler re-checks trust at the point of effect, the
// same as every other registration in `ui-wiring.ts`.
//
// Feature 195 (T064, FR-025) — the two queue-item commands that end with a
// drain, extracted out of `registerStage2Ui()` together.
//
// WHY THESE TWO AND NOT ONE. `AutoDrainCoordinator` is edge-triggered: nothing
// polls, so a command that frees a halted queue has to ask for the drain
// itself. Retry and attested completion are the two operator actions that do
// that — one returns the row to `pending`, the other records it `completed` —
// and both then have to name the queue the row is actually on. Keeping them in
// one module puts that obligation in one place instead of two inline copies
// twenty lines apart; `tests/lint/pending-transition-drain-trigger.test.ts` is
// the gate that holds the retry half of it, and it resolves a registration by
// searching the activation wiring modules rather than assuming `ui-wiring.ts`.
//
// WHY EXTRACTED AT ALL. `registerStage2Ui()` was one line under the 400-line
// composition-root bound (`tests/lint/source-loc-budget.test.ts`), so T064's
// registration could not be added inline — the same forcing function that
// produced `queue-failure-policy-wiring.ts` under T037, and the response that
// gate's own message asks for.
//
// Removal is deliberately NOT here. It is the third exit from a halt and it
// ends no drain: the row leaves the queue, so there is nothing to start.

import * as vscode from 'vscode';
import { registerGuardedCommand, type GuardedCommandDeps } from './guarded-command-registration';
import {
  runAttestTaskCompleted,
  runRetryQueuedItem,
  type QueueOpsCtx
} from '../commands/queue-ops';
import type { SchegentWorkflowController } from '../controller/workflow-controller';
import { errorMessage } from '../lib/errors';
import type { SanitizedLogger } from '../lib/logger';

export interface QueueItemExitWiringDeps {
  readonly queueOps: QueueOpsCtx;
  readonly controller: Pick<SchegentWorkflowController, 'drainQueuedWork'>;
  readonly logger: Pick<SanitizedLogger, 'warn'>;
}

// The drain is spelled out at both registrations rather than routed through a
// local helper, and that is deliberate: `pending-transition-drain-trigger.test.ts`
// proves the trigger by finding `drainQueuedWork(<queueId>)` inside the
// registration itself, and reports a bare `drainQueuedWork()` — which sweeps the
// default queue and silently skips a row on any other one — as a trigger that
// reads as present and does nothing. A helper would hide both facts from the one
// gate that checks them. Two lines of duplication is the cheaper half of that
// trade.
export function registerQueueItemExitCommands(
  guard: GuardedCommandDeps,
  deps: QueueItemExitWiringDeps
): readonly vscode.Disposable[] {
  return [
    registerGuardedCommand(guard, 'schegent.retryQueuedItem', async (arg) => {
      const result = await runRetryQueuedItem(arg, deps.queueOps);
      if (result.ok) {
        // Same omission, same fix as `schegent.restartCanceledTask`. This is
        // also the sidebar's Retry (↻): `cmd-retry-queue-item` delegates here
        // rather than calling `queueOps.retry()` itself, so the two retry
        // affordances share this one trigger instead of forking around it.
        void deps.controller
          .drainQueuedWork(result.queueId)
          .catch((err) => deps.logger.warn(`retryQueuedItem: auto-drain failed: ${errorMessage(err)}`));
      }
      return result;
    }),
    // Feature 195 (T064, FR-025) — attested completion. Registered-only (no
    // palette entry): the assertion is about one named task the operator is
    // looking at, and a palette command would offer it with no row in front of
    // it. Carries the drain trigger for the same reason retry does — the halt
    // ends when the queue is next offered a drain, not when the status is
    // written.
    registerGuardedCommand(guard, 'schegent.attestTaskCompleted', async (arg) => {
      const result = await runAttestTaskCompleted(arg, deps.queueOps);
      if (result.ok) {
        void deps.controller
          .drainQueuedWork(result.queueId)
          .catch((err) =>
            deps.logger.warn(`attestTaskCompleted: auto-drain failed: ${errorMessage(err)}`)
          );
      }
      return result;
    })
  ];
}
