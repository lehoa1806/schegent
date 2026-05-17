import * as vscode from 'vscode';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import type { GuardedRunService, GuardedScheduleResult, GuardedVia } from '../services/guarded-run-service';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { WorkspaceStateStore } from '../state/workspace-state';
import { DEFAULT_QUEUE_ID } from '../queue/queue-registry';

export interface EnqueueCommandArgs {
  description?: string;
  featureDir?: string;
  pipelineId?: string;
  /**
   * Feature 030: legacy field — accepted for backward compatibility with
   * the wake-up runner and programmatic callers that may still pass a
   * stale queueId. The single-queue migration routes every enqueue to
   * `DEFAULT_QUEUE_ID` regardless of this value.
   */
  queueId?: string;
  position?: number;
}

export interface RunEnqueueCtx {
  readonly guardedRunService: Pick<GuardedRunService, 'scheduleOrEnqueue'>;
  readonly store: Pick<WorkspaceStateStore, 'getQueue' | 'getQueueRegistry'>;
  readonly audit?: Pick<AuditLogWriter, 'append'> | null;
  readonly logger: SanitizedLogger;
  readonly notifier?: Notifier;
  readonly via: GuardedVia;
  readonly promptForInput?: boolean;
}

export interface RunEnqueueResult {
  readonly result: GuardedScheduleResult;
  readonly queueId: string | null;
  readonly queueName: string | null;
}

// Feature 017 — BUG-003. Pure-enqueue host command that the Dashboard
// (`CMD_START`) and Command Palette (`schegent.auto`) both delegate to.
// Replaces the legacy `runAuto()` → `GuardedRunService.startNow()` flow,
// which rejected operator submissions with the legacy already-in-flight
// reject reason while a controller was mid-pipeline (a contract violation
// of FR-010 / FR-013 / FR-029). The queue dispatcher promotes the new
// task to in-flight on the next dequeue tick when capacity allows.
export async function runEnqueue(
  args: EnqueueCommandArgs | undefined,
  ctx: RunEnqueueCtx
): Promise<RunEnqueueResult | undefined> {
  let description = args?.description?.trim();
  const featureDir = args?.featureDir;
  if (!description && !featureDir && ctx.promptForInput !== false) {
    const input = await vscode.window.showInputBox({
      prompt: 'Schegent: feature description',
      placeHolder: 'Describe the feature to enqueue',
      ignoreFocusOut: false
    });
    if (!input) return undefined;
    description = input.trim();
  }
  const finalDescription = description ?? `(reusing ${featureDir})`;

  // Feature 030: single-queue migration. The queue registry has exactly
  // one entry (id === DEFAULT_QUEUE_ID); any caller-supplied queueId
  // (legacy wake-up runner, programmatic, sidebar) is intentionally
  // ignored and the enqueue is hard-coded to the default queue.
  const result = await ctx.guardedRunService.scheduleOrEnqueue({
    description: finalDescription,
    scheduledAt: Date.now(),
    via: ctx.via,
    pipelineId: args?.pipelineId ?? null,
    queueId: DEFAULT_QUEUE_ID,
    position: args?.position ?? null
  });

  let queueId: string | null = null;
  let queueName: string | null = null;
  if (result.outcome === 'enqueued' && result.queueItemId) {
    const queue = ctx.store.getQueue();
    const inserted = queue.requests.find((r) => r.id === result.queueItemId);
    queueId = inserted?.queueId ?? null;
    if (queueId) {
      const registry = ctx.store.getQueueRegistry();
      const entry = registry.entries.find((q) => q.id === queueId);
      queueName = entry?.name ?? queueId;
    }
    if (ctx.audit) {
      try {
        await ctx.audit.append({
          runId: result.queueItemId,
          phase: 'speckit-specify',
          iteration: 0,
          eventType: 'task-enqueued',
          outcome: 'info',
          payload: {
            source: 'guarded-run-service',
            taskId: result.queueItemId,
            queueId,
            via: ctx.via
          }
        });
      } catch (err) {
        ctx.logger.warn(
          `enqueue: audit emit failed: ${ctx.logger.sanitize((err as Error).message ?? 'unknown')}`
        );
      }
    }
  }

  return { result, queueId, queueName };
}
