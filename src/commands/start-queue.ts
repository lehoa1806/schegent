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
    // Feature 195 (T018, FR-021, SC-011, SC-012) — the one exception. The
    // drain pass just above is the single site that evaluates the halt
    // (research D5); this command reads what it wrote rather than asking the
    // question again, and reports a halt as a refusal rather than as the
    // asynchronous acceptance every other decline gets. Retrying or removing
    // the failed task remain the only two ways out of a halt — this branch
    // adds no third one.
    await deps.controller.drainQueuedWork(queueId);
    const report = deps.startFailures.get(queueId ?? DEFAULT_QUEUE_ID);
    if (report?.kind === 'halted') {
      return refused('queue-halted-on-failed-task');
    }
    return ACCEPTED;
  } catch (err) {
    deps.logger.warn(`startQueue: ${(err as Error).message}`);
    // A code, not the caught error's message: this value crosses to the webview.
    return failed('start-queue-failed');
  }
}
