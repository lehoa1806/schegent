import * as vscode from 'vscode';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import type { GuardedRunService, GuardedScheduleResult, GuardedVia } from '../services/guarded-run-service';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { EnqueueStartIntent } from '../contracts/sidebar-ipc';

/**
 * FR-R3-002 (T278) — typed refusal for an enqueue that names no queue.
 *
 * The alternative this replaces was routing to `DEFAULT_QUEUE_ID`, which is
 * indistinguishable, at every layer downstream, from a caller that meant
 * Default. A control that cannot name its queue refuses; it does not choose —
 * the same discipline `resolveSoleRun` follows when it returns
 * `ambiguous-run-target` rather than picking a Run.
 *
 * Callers that legitimately have no queue selector (the Command Palette, the
 * webview's unscoped submit) name `DEFAULT_QUEUE_ID` **explicitly** at their
 * own boundary, where "unscoped means Default" is that surface's documented
 * contract, rather than letting the absence travel this far.
 */
export class UnnamedQueueError extends Error {
  public readonly via: GuardedVia;
  constructor(via: GuardedVia) {
    super('enqueue-requires-queue-id');
    this.name = 'UnnamedQueueError';
    this.via = via;
  }
}

export interface EnqueueCommandArgs {
  description?: string;
  featureDir?: string;
  pipelineId?: string;
  /**
   * FR-R3-002 (T276) — required. The queue the task is enqueued to. This was
   * optional and ignored under the feature-030 single-queue migration; features
   * 092/093 made the state multi-queue and this seam was the last one still
   * discarding what Dashboard Start forwarded. An absent or blank id is
   * refused with `UnnamedQueueError`, never substituted.
   */
  queueId: string;
  position?: number;
  /**
   * Feature 065 — optional explicit start-intent. The host policy table
   * in `GuardedRunService.resolveStartIntentPolicy()` decides whether to
   * promote immediately, arm a scheduled start, or land the task in
   * idle-pending with no schedule. Omission is the legacy/safe default
   * (idle-pending with `automation-enqueue-no-start-mode` for
   * automation callers).
   */
  startIntent?: EnqueueStartIntent;
  /**
   * Feature 065 — whether the enqueue originated from a human-facing UI
   * (`'human'`) or from automation (programmatic IPC, hooks —
   * `'automation'`). Required for the host's safe-default audit
   * trail when `startIntent` is absent.
   */
  callerKind?: 'human' | 'automation';
  /**
   * Feature 065 — caller identifier for the
   * `automation-enqueue-no-start-mode` audit event. Recorded only when
   * `callerKind === 'automation'` and `startIntent` is absent.
   */
  callerId?: string;
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
  // FR-R3-002 (T278) — refuse before prompting. An operator asked for a
  // description that the refusal is about to discard has been asked for
  // nothing, so the queue check precedes the input box.
  const targetQueueId = args?.queueId?.trim();
  if (targetQueueId === undefined || targetQueueId.length === 0) {
    throw new UnnamedQueueError(ctx.via);
  }

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

  // FR-R3-002 (T277) — the caller's queue is written through. The
  // feature-030 override that hard-coded `DEFAULT_QUEUE_ID` here is deleted:
  // the registry has had more than one entry since feature 092's v9 → v10
  // migration, so "there is only one queue" stopped being true and the
  // override became a silent misroute of the queue Dashboard Start forwarded.
  const result = await ctx.guardedRunService.scheduleOrEnqueue({
    description: finalDescription,
    scheduledAt: Date.now(),
    via: ctx.via,
    pipelineId: args?.pipelineId ?? null,
    queueId: targetQueueId,
    position: args?.position ?? null,
    ...(args?.startIntent ? { startIntent: args.startIntent } : {}),
    ...(args?.callerKind ? { callerKind: args.callerKind } : {}),
    ...(args?.callerId ? { callerId: args.callerId } : {})
  });

  let queueId: string | null = null;
  let queueName: string | null = null;
  if (result.outcome === 'enqueued' && result.queueItemId) {
    const queue = ctx.store.getQueue(targetQueueId);
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
