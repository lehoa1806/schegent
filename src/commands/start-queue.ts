// Feature 065 (T041 / refactor 2026-05-22) — `schegent.startQueue`
// command handler extracted from extension.ts to keep the host
// registration site below its LOC budget.
//
// Behaviour:
//   - When `arg.startIntent` is present (FR-015 operator-restart paths),
//     route through `GuardedRunService.applyStartQueueIntent()` so the
//     audit + coordinator wiring stays centralized. After a successful
//     `convert-to-now` (lifecycleAfter === 'running'), kick a drain
//     pass.
//   - When no `startIntent`, just kick a drain pass (legacy CMD_START_QUEUE).
//
// FR-R3-154 (T1645) — it is no longer fire-and-forget. It used to swallow
// every error and every intent rejection, returning `void`, so
// `cmd-start-queue.ts` ACKed `accepted` for a start that had been refused on
// the horizon bound, refused for an untrusted workspace, found nothing to
// change, or thrown. Errors are still logged here and only here; what changed
// is that the outcome comes back.
import type { GuardedRunService } from '../services/guarded-run-service';
import type { SchegentWorkflowController } from '../controller/workflow-controller';
import type { SanitizedLogger } from '../lib/logger';
import type { QueueStartFailureRegistry } from '../services/queue-start-failure-registry';
import { DEFAULT_QUEUE_ID } from '../contracts/queue-identity';
import {
  ACCEPTED,
  failed,
  noOp,
  refused,
  type CommandOutcome
} from '../contracts/command-outcome';

export interface StartQueueCommandDeps {
  readonly guardedRunService: Pick<GuardedRunService, 'applyStartQueueIntent'>;
  readonly controller: Pick<SchegentWorkflowController, 'drainQueuedWork'>;
  readonly logger: Pick<SanitizedLogger, 'warn'>;
  /**
   * Feature 195 (T018, FR-021) — the report the drain pass this command
   * triggers just wrote, read back rather than re-evaluated: the halt
   * predicate has exactly one call site (the drain's own step 2a), and this
   * command is a reader of its answer, never a second one (research D5).
   */
  readonly startFailures: Pick<QueueStartFailureRegistry, 'get'>;
}

export interface StartQueueIntent {
  readonly startMode: 'now' | 'scheduled' | 'cancel-schedule';
  readonly scheduledStartAt?: number;
  readonly source: 'operator-restart';
}

export interface StartQueueCommandArg {
  // Feature 092 (T061, FR-034) — which queue the start addresses. Absent
  // means the default queue, resolved by the two seams below rather than
  // here: `applyStartQueueIntent` and `drainQueuedWork` each already
  // default an omitted id, and duplicating that default in this file
  // would make three places that decide it.
  readonly queueId?: string;
  readonly startIntent?: StartQueueIntent;
}

/**
 * The report the drain pass just made, read back as this command's outcome.
 *
 * Feature 195 (T018, FR-021) established the read for `halted`; BUG-004 adds
 * `stranded-run` beside it and gives the pair one home, because the two drain
 * sites below both need the same answer. Before that, only the no-intent branch
 * asked — so the Start button on an `idle-pending` queue, which is the branch
 * that carries an intent, ACKed `accepted` for a queue that could not start and
 * never would.
 *
 * Both are reads of what the drain wrote, never a second evaluation: the halt
 * predicate lives at step 2a and the stranded-occupant predicate at step 3, one
 * call site each (research D5). An `admission` report is deliberately not here —
 * it belongs to a *previous* attempt that threw, and the queue's own surface
 * already carries it; turning it into this attempt's refusal would report a
 * stale failure as a fresh one.
 */
function outcomeAfterDrain(
  deps: StartQueueCommandDeps,
  queueId: string | undefined
): CommandOutcome {
  const report = deps.startFailures.get(queueId ?? DEFAULT_QUEUE_ID);
  if (report?.kind === 'halted') return refused('queue-halted-on-failed-task');
  if (report?.kind === 'stranded-run') return refused('queue-blocked-by-stranded-run');
  return ACCEPTED;
}

export async function runStartQueueCommand(
  arg: StartQueueCommandArg | undefined,
  deps: StartQueueCommandDeps
): Promise<CommandOutcome> {
  try {
    const queueId = arg?.queueId;
    const startIntent = arg?.startIntent;
    if (startIntent) {
      const result = await deps.guardedRunService.applyStartQueueIntent(startIntent, { queueId });
      if (result.outcome === 'applied') {
        if (result.lifecycleAfter === 'running') {
          await deps.controller.drainQueuedWork(queueId);
          // The intent applied — the lifecycle really did move — and the drain
          // it triggered still could not start anything, for one of the two
          // reasons that will not resolve themselves. The applied intent is not
          // what the operator asked for; a started queue is.
          return outcomeAfterDrain(deps, queueId);
        }
        return ACCEPTED;
      }
      // `applyStartQueueIntent`'s own vocabulary, reused rather than
      // translated — `rejected-horizon` and `rejected-untrusted` are already
      // the codes its audit records carry, and a second name for either would
      // be a second thing to keep in step. `noop` is the one that needs a name
      // of its own: the service says "nothing changed" and the ACK has to say
      // which of its four words that is.
      return result.outcome === 'noop'
        ? noOp('start-intent-no-change')
        : refused(result.outcome);
    }
    // No intent: the legacy `CMD_START_QUEUE`, which offers the queue to
    // `AutoDrainCoordinator.drainIfIdle` and returns. This stays a documented
    // asynchronous acceptance for every reason but one — `drainQueuedWork`
    // resolves when the queue has been offered work, not when a Run has
    // started, and `drainIfIdle` may legitimately decline (paused, at cap,
    // nothing pending) without reporting. FR-R3-152 owns making that answer
    // legible generally; until it does, `accepted` here means "the drain pass
    // was accepted", which is what the `StartQueueCommand` contract in
    // `src/contracts/sidebar-ipc.ts` says this branch promises.
    //
    // Feature 195 (T018, FR-021, SC-011, SC-012) — the exceptions, now two and
    // both in `outcomeAfterDrain`. The drain pass just above is the single site
    // that evaluates each of them; this command reads what it wrote rather than
    // asking either question again, and reports them as refusals rather than as
    // the asynchronous acceptance every other decline gets. Retrying or removing
    // the failed task remain the only two ways out of a halt — this branch adds
    // no third one.
    await deps.controller.drainQueuedWork(queueId);
    return outcomeAfterDrain(deps, queueId);
  } catch (err) {
    deps.logger.warn(`startQueue: ${(err as Error).message}`);
    // A code, not the caught error's message: this value crosses to the webview.
    return failed('start-queue-failed');
  }
}
