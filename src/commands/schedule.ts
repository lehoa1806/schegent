import * as vscode from 'vscode';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import { describeFailure } from '../lib/errors';
import type { GuardedRunService } from '../services/guarded-run-service';
import { ENQUEUE_STORAGE_FAULT_TOAST } from '../services/enqueue-failure';

/**
 * FR-R4-F05 (FR-014; contract F, F6; contract O, O5) — what the operator is told when
 * scheduling fails for a reason the command has no code for. Fixed text: an exception's
 * message can carry a path, so it goes to the log through `describeFailure` and never to
 * the toast. The outcomes the launch service returns as codes keep their own handling.
 */
export const SCHEDULE_FAILED_TOAST =
  'Schegent: the task could not be scheduled. See the Schegent log for details.';

/**
 * Feature 285 (OD-2, FR-009, D7) — what the command says when it is run with no `pipelineId`.
 * Queue work is composed from Workflows in the Queue's Add work composer, so the command points
 * there and reveals the Schegent view instead of opening a Pipeline picker. Fixed text.
 */
export const SCHEDULE_NEEDS_A_WORKFLOW_GUIDANCE =
  'Schegent: add work from a Queue in the Schegent view. Select Add work, then choose a Workflow.';

const SCHEGENT_VIEW_COMMAND = 'workbench.view.extension.schegent';

export interface ScheduleCommandArgs {
  description?: string;
  pipelineId?: string;
  queueId?: string;
  position?: number;
  /**
   * Feature 065 — wall-clock target for the scheduled start (Unix ms).
   * When omitted the host applies the safe default: `Date.now()` (i.e.
   * effectively "scheduled now" — the host coerces past timestamps and
   * the lifecycle lands in `running`).
   */
  scheduledStartAt?: number;
}

export interface RunScheduleCtx {
  readonly guardedRunService: GuardedRunService;
  readonly notifier: Notifier;
  readonly logger: SanitizedLogger;
}

/**
 * The no-`pipelineId` answer (FR-009): the guidance first, then the view. The guidance is the
 * answer and the reveal a convenience beside it, so a failed reveal is logged and leaves the
 * guidance standing rather than reaching the "could not be scheduled" toast.
 */
async function pointAtTheComposer(ctx: RunScheduleCtx): Promise<void> {
  ctx.notifier.info(SCHEDULE_NEEDS_A_WORKFLOW_GUIDANCE);
  try {
    await vscode.commands.executeCommand(SCHEGENT_VIEW_COMMAND);
  } catch (err) {
    ctx.logger.warn('schedule: the Schegent view could not be revealed', {
      error: describeFailure(err, (value) => ctx.logger.sanitize(value))
    });
  }
}

export async function runSchedule(
  args: ScheduleCommandArgs | undefined,
  ctx: RunScheduleCtx
): Promise<void> {
  try {
    const pipelineId = args?.pipelineId;
    if (!pipelineId) {
      await pointAtTheComposer(ctx);
      return;
    }

    let description = args.description?.trim();
    if (!description) {
      const input = await vscode.window.showInputBox({
        prompt: 'Schegent: enqueue feature',
        placeHolder: 'Describe the feature to enqueue',
        ignoreFocusOut: false
      });
      if (!input) return;
      description = input.trim();
    }
    // Feature 065 — schedule command is a programmatic scheduled enqueue.
    // Resolve the target instant from the caller arg; fall back to now
    // (the host coerces past timestamps to running, per FR-014a).
    const scheduledStartAt = args.scheduledStartAt ?? Date.now();
    const result = await ctx.guardedRunService.scheduleOrEnqueue({
      description,
      scheduledAt: Date.now(),
      via: 'command-palette',
      pipelineId,
      queueId: args.queueId ?? null,
      position: args.position ?? null,
      startIntent: {
        startMode: 'scheduled',
        scheduledStartAt,
        source: 'programmatic-scheduled'
      },
      callerKind: 'human'
    });
    switch (result.outcome) {
      case 'enqueued':
        ctx.notifier.info(`Schegent: enqueued ${(result.queueItemId ?? '').slice(0, 8)}`);
        return;
      case 'rejected-paused':
        ctx.notifier.warn('Schegent: queue is paused; cannot enqueue.');
        return;
      case 'rejected-foreign-lock':
        ctx.notifier.info('Schegent: another window holds the workspace lock.');
        return;
      case 'rejected-validation':
        if (result.reason?.startsWith('workflow-requires-graph-launch:')) {
          ctx.notifier.warn(
            `Schegent: rejected (${result.reason}). Launch composable Workflows from the Workflow Launch view.`
          );
          return;
        }
        ctx.notifier.warn(`Schegent: rejected (${result.reason ?? 'validation-failed'}).`);
        return;
      // FR-R4-F05 (F8) — one fixed sentence; `reason` is a code and is not echoed.
      case 'failed-storage':
        ctx.notifier.error(ENQUEUE_STORAGE_FAULT_TOAST);
        return;
    }
  } catch (err) {
    ctx.notifier.error(SCHEDULE_FAILED_TOAST);
    ctx.logger.error('schedule: unexpected failure', {
      error: describeFailure(err, (value) => ctx.logger.sanitize(value))
    });
  }
}
