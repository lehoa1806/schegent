import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import { describeFailure } from '../lib/errors';
import type { GuardedRunService } from '../services/guarded-run-service';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { WorkspaceStateStore } from '../state/workspace-state';
import { DEFAULT_QUEUE_ID } from '../contracts/queue-identity';
import { runEnqueue, type EnqueueCommandArgs, type RunEnqueueResult } from './enqueue';
import { ENQUEUE_STORAGE_FAULT_TOAST } from '../services/enqueue-failure';

/**
 * FR-R4-F05 (FR-014; contract F, F6; contract O, O5) — what the operator is told when
 * queueing fails for a reason the command has no code for. Fixed text: an exception's
 * message can carry a path, so it goes to the log through `describeFailure` and never to
 * the toast. The outcomes the launch service returns as codes keep their own handling.
 */
export const AUTO_FAILED_TOAST =
  'Schegent: the task could not be queued. See the Schegent log for details.';

/**
 * FR-R3-002 (T279) — `queueId` stays optional here even though `runEnqueue`
 * now requires one. `schegent.auto` is a Command Palette entry with no queue
 * selector, so its caller genuinely has no queue to name; `runAuto` resolves
 * the reserved default explicitly below rather than passing the absence on.
 */
export interface AutoCommandArgs extends Omit<EnqueueCommandArgs, 'queueId'> {
  queueId?: string;
}

export interface RunAutoCtx {
  readonly guardedRunService: Pick<GuardedRunService, 'scheduleOrEnqueue'>;
  readonly store: Pick<WorkspaceStateStore, 'getQueue' | 'getQueueRegistry'>;
  readonly audit?: Pick<AuditLogWriter, 'append'> | null;
  readonly notifier: Notifier;
  readonly logger: SanitizedLogger;
}

// Feature 017 — BUG-003. Command Palette entry now routes through the
// pure-enqueue `runEnqueue()` path. The legacy `startNow()` /
// `controller-already-running` reject is gone — operator submissions while
// a controller is mid-pipeline land as pending and the queue dispatcher
// promotes them when capacity allows.
export async function runAuto(
  args: AutoCommandArgs | undefined,
  ctx: RunAutoCtx
): Promise<void> {
  try {
    // Feature 065 — `schegent.auto` is a one-click "auto" command-palette
    // entry; preserve pre-feature behaviour by promoting to running
    // immediately (operator-chooser source for the audit trail).
    const argsWithIntent: EnqueueCommandArgs = {
      ...(args ?? {}),
      // FR-R3-002 (T279) — the Palette has no queue selector, so this surface
      // names the reserved default itself. Resolving it here keeps the choice
      // visible at the boundary that made it, instead of inside `runEnqueue`
      // where it would apply to every caller that merely forgot.
      queueId: args?.queueId ?? DEFAULT_QUEUE_ID,
      startIntent: args?.startIntent ?? {
        startMode: 'now',
        source: 'operator-chooser'
      },
      callerKind: args?.callerKind ?? 'human'
    };
    const outcome = await runEnqueue(argsWithIntent, {
      guardedRunService: ctx.guardedRunService,
      store: ctx.store,
      audit: ctx.audit ?? null,
      logger: ctx.logger,
      via: 'command-palette',
      promptForInput: true
    });
    if (!outcome) return;
    handleEnqueueResult(outcome, ctx.notifier);
  } catch (err) {
    ctx.notifier.error(AUTO_FAILED_TOAST);
    ctx.logger.error('auto: unexpected failure', {
      error: describeFailure(err, (value) => ctx.logger.sanitize(value))
    });
  }
}

function handleEnqueueResult(outcome: RunEnqueueResult, notifier: Notifier): void {
  switch (outcome.result.outcome) {
    case 'enqueued':
      notifier.info('Schegent: queued — will run when capacity allows');
      return;
    case 'rejected-foreign-lock':
      notifier.info('Schegent: another window holds the workspace lock.');
      return;
    case 'rejected-paused':
      notifier.warn('Schegent: queue is paused; cannot enqueue.');
      return;
    case 'rejected-validation':
      notifier.warn(`Schegent: rejected (${outcome.result.reason ?? 'validation-failed'}).`);
      return;
    // FR-R4-F05 (F8) — a queue that could not be read or saved. Shown as one fixed
    // sentence; `reason` is a code and is not echoed.
    case 'failed-storage':
      notifier.error(ENQUEUE_STORAGE_FAULT_TOAST);
      return;
  }
}
