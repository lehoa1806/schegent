import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import type { GuardedRunService } from '../services/guarded-run-service';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { WorkspaceStateStore } from '../state/workspace-state';
import { runEnqueue, type EnqueueCommandArgs, type RunEnqueueResult } from './enqueue';

export interface AutoCommandArgs extends EnqueueCommandArgs {}

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
    ctx.notifier.error(`Schegent: ${(err as Error).message}`);
    ctx.logger.error((err as Error).message);
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
  }
}
