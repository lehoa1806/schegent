import { createStateTransitionAuditEnvelope } from '../../../lib/audit-event-envelope';
import { CMD_ACK } from '../messages';
import type {
  CommandAckMessage,
  ReadPhaseLogRequest,
  ReadPhaseLogResponse
} from '../messages';
import type { HandlerContext } from './handler-contract';
import type { QueueOps } from './router-types';
import { ILLEGAL_STATE_MESSAGES } from './constants';

export async function ack(
  ctx: HandlerContext,
  status: 'accepted' | 'rejected',
  reason?: string,
  result?: unknown
): Promise<void> {
  const base: CommandAckMessage = {
    type: CMD_ACK,
    correlationId: ctx.correlationId,
    status
  };
  const msg: CommandAckMessage =
    reason !== undefined && result !== undefined
      ? { ...base, reason, result }
      : reason !== undefined
        ? { ...base, reason }
        : result !== undefined
          ? { ...base, result }
          : base;
  try {
    await ctx.postAck(msg);
  } catch (err) {
    ctx.deps.logger.warn(
      `sidebar router: failed to post ack: ${(err as Error).message}`
    );
  }
}

export async function exec(
  ctx: HandlerContext,
  commandId: string,
  ...args: unknown[]
): Promise<void> {
  await Promise.resolve(ctx.deps.executeCommand(commandId, ...args));
}

export async function ackGenericResult(
  ctx: HandlerContext,
  result: { ok: boolean; reason?: string }
): Promise<void> {
  await ack(
    ctx,
    result.ok ? 'accepted' : 'rejected',
    result.ok ? undefined : result.reason ?? 'operation-rejected'
  );
}

export async function ackMutationResult(
  ctx: HandlerContext,
  result: { ok: boolean; reason?: string },
  actionLabel: 'retry' | 'reorder'
): Promise<void> {
  if (result.ok) {
    await ack(ctx, 'accepted');
    return;
  }
  const reason = result.reason ?? 'illegal-state';
  const human = ILLEGAL_STATE_MESSAGES[reason] ?? `${actionLabel} failed`;
  await handleIllegalState(ctx, reason, human);
}

export async function handleIllegalState(
  ctx: HandlerContext,
  reason: string,
  humanMessage: string
): Promise<void> {
  if (ctx.deps.notifyWarning) {
    try {
      ctx.deps.notifyWarning(humanMessage);
    } catch (err) {
      ctx.deps.logger.warn(
        `sidebar router: notifyWarning failed: ${ctx.deps.logger.sanitize((err as Error).message ?? 'unknown')}`
      );
    }
  }
  await ack(ctx, 'rejected', reason);
}

export function requireOps(ctx: HandlerContext): QueueOps | null {
  if (ctx.deps.queueOps) return ctx.deps.queueOps;
  void ack(ctx, 'rejected', 'queue-ops-unavailable');
  return null;
}

// FR-R3-024 (FR-008) — `checkPrimary` is gone. It returned a verdict a caller
// could await and drop, and `cmd-read-metrics` did exactly that. Its one
// replacement is `withPrimary` in `./primacy-gate`, which takes the gated work
// as an argument so there is no verdict to drop; the predicate underneath it is
// `isWindowPrimary`. Re-adding a verdict-returning primacy helper here would
// leave the original mistake available under a new name.

export async function appendQueueAudit(
  ctx: HandlerContext,
  eventType:
    | 'queue-created'
    | 'queue-renamed'
    | 'queue-deleted'
    | 'queue-paused'
    | 'queue-resumed'
    | 'queue-settings-saved'
    | 'task-modified'
    | 'task-removed'
    | 'task-reordered'
    | 'task-moved'
    | 'schedule-set'
    | 'schedule-cleared'
    | 'schedule-fired',
  payload: Record<string, unknown>
): Promise<void> {
  if (!ctx.deps.audit) return;
  try {
    await ctx.deps.audit.append({
      runId: `queue:${String(payload.queueId ?? 'settings')}`,
      phase: 'queue',
      iteration: 0,
      eventType,
      payload: {
        ...payload,
        stateTransition: createStateTransitionAuditEnvelope({
          correlationId: ctx.correlationId,
          reasonCode: eventType,
          newState: payload
        })
      },
      outcome: 'info',
      correlationId: ctx.correlationId
    });
  } catch (err) {
    ctx.deps.logger.warn(
      `sidebar router: queue audit append failed: ${(err as Error).message}`
    );
  }
}

export async function appendPhaseAudit(
  ctx: HandlerContext,
  eventType: 'phase-removed',
  payload: Record<string, unknown>
): Promise<void> {
  if (!ctx.deps.audit) return;
  try {
    await ctx.deps.audit.append({
      runId: String(payload.runId ?? `task:${String(payload.taskId ?? 'unknown')}`),
      phase: String(payload.phaseId ?? 'phase'),
      iteration: 0,
      eventType,
      payload: {
        ...payload,
        stateTransition: createStateTransitionAuditEnvelope({
          correlationId: ctx.correlationId,
          reasonCode: eventType,
          newState: payload
        })
      },
      outcome: 'info',
      correlationId: ctx.correlationId
    });
  } catch (err) {
    ctx.deps.logger.warn(
      `sidebar router: phase audit append failed: ${(err as Error).message}`
    );
  }
}

export async function appendPhaseLogAudit(
  ctx: HandlerContext,
  eventType: 'phase-log-read' | 'phase-log-tail-started' | 'phase-log-tail-stopped',
  args: {
    readonly selection: ReadPhaseLogRequest['selection'];
    readonly response: ReadPhaseLogResponse;
  }
): Promise<void> {
  if (!ctx.deps.audit) return;
  const { selection, response } = args;
  const entryCount =
    response.outcome === 'success' ? response.manifest.entries.length : 0;
  const skippedLines =
    response.outcome === 'success' ? response.manifest.skippedLines : 0;
  const truncatedCount =
    response.outcome === 'success' ? response.manifest.truncatedCount : 0;
  const iterationResolved =
    response.outcome === 'success'
      ? response.manifest.selectedIteration
      : selection.iterationN;
  const payload: Record<string, unknown> = {
    queueId: selection.queueId,
    taskId: selection.taskId,
    pipelineId: selection.pipelineId,
    phaseId: selection.phaseId,
    iterationN: iterationResolved,
    entryCount,
    skippedLines,
    truncatedCount,
    outcome: response.outcome
  };
  if (response.outcome === 'failure') {
    payload.reason = response.reason;
  }
  try {
    await ctx.deps.audit.append({
      // The `task:` marker `appendPhaseAudit` uses sixty lines above, for the same reason.
      // This wrote the bare task id, and an unmarked task id in the `runId` field is
      // indistinguishable from a run id — so every phase-log event appeared to be filed
      // against a run that had never existed. The read itself was always correct:
      // `phase-log-service.ts` resolves taskId -> runId before loading the manifest. Only
      // the record was wrong, and it is the record an operator reads when reconstructing
      // what the UI was looking at.
      //
      // The marker rather than the resolved run id, because the response carries no run id
      // and threading one through the IPC contract is a larger change than a wrong label
      // warrants. `taskId` is in the payload either way.
      runId: `task:${selection.taskId}`,
      phase: selection.phaseId,
      iteration: typeof iterationResolved === 'number' ? iterationResolved : 0,
      eventType,
      payload,
      outcome: response.outcome === 'success' ? 'success' : 'failure',
      correlationId: ctx.correlationId
    });
  } catch (err) {
    ctx.deps.logger.warn(
      `sidebar router: phase-log audit append failed: ${(err as Error).message}`
    );
  }
}

/**
 * Feature 030 (US2, T032) — single audit emission point for
 * `task-reordered`. The payload conforms to `TaskReorderedPayload`;
 * `cause` is omitted from the payload on the success branch.
 */
export async function emitReorderAudit(
  ctx: HandlerContext,
  taskId: string,
  source: 'drag' | 'arrow',
  decision: {
    outcome: 'success' | 'rejected';
    cause?: 'task-not-pending' | 'invalid-position' | 'no-op';
    fromPosition: number;
    toPosition: number;
  }
): Promise<void> {
  const payload: Record<string, unknown> = {
    queueId: 'default',
    taskId,
    fromPosition: decision.fromPosition,
    toPosition: decision.toPosition,
    source,
    outcome: decision.outcome,
    newPosition: decision.toPosition
  };
  if (decision.outcome === 'rejected' && decision.cause) {
    payload.cause = decision.cause;
  }
  await appendQueueAudit(ctx, 'task-reordered', payload);
}

/**
 * Feature 030 (US2, T032) — resolve target arrow's pending-row position and
 * route through `reorderTaskInUnifiedQueue` so success AND every rejection
 * emit the canonical `task-reordered` audit event with `source: 'arrow'`.
 *
 * Feature 065 BUG-009 T078 (FR-030) — delta math uses the source row's
 * GLOBAL `orderedItems` index (`probe.fromGlobalPosition`), since the
 * incoming `newPosition` is interpreted in the global index space.
 */
export async function dispatchArrowMove(
  ctx: HandlerContext,
  ops: QueueOps,
  taskId: string,
  delta: -1 | 1
): Promise<void> {
  if (!ops.reorderTaskInUnifiedQueue) {
    await ack(ctx, 'rejected', 'queue-ops-unavailable');
    return;
  }
  const probe = await ops.reorderTaskInUnifiedQueue(taskId, -1);
  if (probe.fromGlobalPosition < 0) {
    await emitReorderAudit(ctx, taskId, 'arrow', probe);
    const cause = probe.cause ?? 'reorder-rejected';
    const human = ILLEGAL_STATE_MESSAGES[cause] ?? 'Reorder rejected';
    await handleIllegalState(ctx, cause, human);
    return;
  }
  const newPos = probe.fromGlobalPosition + delta;
  const decision = await ops.reorderTaskInUnifiedQueue(taskId, newPos);
  await emitReorderAudit(ctx, taskId, 'arrow', decision);
  if (decision.outcome === 'success') {
    await ack(ctx, 'accepted');
  } else {
    const cause = decision.cause ?? 'reorder-rejected';
    const human = ILLEGAL_STATE_MESSAGES[cause] ?? 'Reorder rejected';
    await handleIllegalState(ctx, cause, human);
  }
}
