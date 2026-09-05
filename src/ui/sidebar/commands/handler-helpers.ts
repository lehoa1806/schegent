import { createStateTransitionAuditEnvelope } from '../../../lib/audit-event-envelope';
import { errorMessage } from '../../../lib/errors';
import {
  ackFieldsFor,
  failed,
  fromMutationResult,
  normalizeCommandResult,
  UNRECOGNIZED_RESULT_REASON,
  type CommandOutcome
} from '../../../contracts/command-outcome';
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
  await postAck(ctx, msg);
}

/**
 * The one place an ACK reaches the transport. A post that throws is logged and
 * dropped: the webview's correlation times out, which is what it already does
 * for a host that has gone away, and re-throwing here would turn a delivery
 * failure into a handler failure the router would try to ACK in turn.
 */
async function postAck(ctx: HandlerContext, msg: CommandAckMessage): Promise<void> {
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

/**
 * FR-R3-154 (T1646) — `exec` for a command whose answer the route must report.
 *
 * `exec` above discards the resolved value, which was the mechanical reason
 * five routes could only ACK `accepted`: the value was gone by the time the
 * handler resumed. This one reads it, through the one function that decides
 * what each possible shape means (`normalizeCommandResult`), including the two
 * that carry no value — `undefined` from the Workspace Trust gate, and a throw.
 *
 * The catch is a SECOND conversion point, and deliberately distinct from the
 * one T1645 put inside each command. That one converts a failure of the
 * mutation; this one converts a failure of the dispatch — an id VS Code cannot
 * resolve, or a command whose own conversion did not hold. Both end as a code:
 * the sanitized message goes to the log, never into the ACK, because `reason`
 * crosses to the webview and a message from this layer carries paths.
 */
export async function execForOutcome(
  ctx: HandlerContext,
  commandId: string,
  ...args: unknown[]
): Promise<CommandOutcome> {
  try {
    const value = await Promise.resolve(
      ctx.deps.executeCommand<unknown>(commandId, ...args)
    );
    const outcome = normalizeCommandResult(value);
    if (outcome.outcome === 'failed' && outcome.reason === UNRECOGNIZED_RESULT_REASON) {
      ctx.deps.logger.warn(
        `sidebar router: ${commandId} returned an unrecognized result shape`
      );
    }
    return outcome;
  } catch (err) {
    const message = ctx.deps.logger.sanitize(errorMessage(err));
    ctx.deps.logger.warn(`sidebar router: ${commandId} dispatch failed: ${message}`);
    return failed(DISPATCH_FAILED_REASON);
  }
}

/** The ACK reason for a dispatch that threw rather than answering. */
export const DISPATCH_FAILED_REASON = 'command-dispatch-failed';

/**
 * FR-R3-154 (T1646) — post the ACK an outcome describes, correlation id
 * included (it comes from `ctx`, so a route cannot answer another route's
 * command). Notification is not this function's business: the registered
 * command owns the operator copy, and a toast here would be a second, unsourced
 * telling of the same refusal.
 */
export async function ackCommandOutcome(
  ctx: HandlerContext,
  outcome: CommandOutcome
): Promise<void> {
  const fields = ackFieldsFor(outcome);
  await postAck(ctx, {
    type: CMD_ACK,
    correlationId: ctx.correlationId,
    status: fields.status,
    outcome: fields.outcome,
    ...(fields.reason !== undefined ? { reason: fields.reason } : {})
  });
}

/**
 * FR-R3-154 (T1646) — execute a command and ACK exactly what it answered. The
 * five lifecycle routes are one line each because there is nothing else for
 * them to decide.
 */
export async function execAndAck(
  ctx: HandlerContext,
  commandId: string,
  ...args: unknown[]
): Promise<void> {
  await ackCommandOutcome(ctx, await execForOutcome(ctx, commandId, ...args));
}

/**
 * FR-R3-163 (feature 202) — ACK a result the caller already holds, through the
 * same converter every other route uses.
 *
 * The hand-written mapping this replaces produced the same `status` and the same
 * `reason` for all three inputs — `fromMutationResult` falls back to
 * `UNEXPLAINED_REJECTION_REASON`, which is the literal `'operation-rejected'`
 * that used to sit here (`command-outcome.ts:79`). So this deletes a duplicate
 * of a constant rather than changing a value, and no caller needs an edit. What
 * they gain is the `outcome` field, which this helper alone among the ack paths
 * did not set — additive and optional by the contract's own comment at
 * `host-messages.ts:12-19` (FR-011, FR-012, FR-013, F41).
 *
 * FOURTEEN callers, not seventeen. Seventeen routes called this helper at the
 * diff base and all seventeen gain the field; three of them — `cmd-cancel`,
 * `cmd-retry-queue-item`, `cmd-restart-canceled-task` — were moved onto
 * `execAndAck` by this same feature, so fourteen reach the field through here
 * and three reach it through the dispatching path. Both figures are correct for
 * different populations, and writing either one without its population is
 * finding F49 (`specs/202-cancel-ack-outcomes/research.md` Part 3b).
 *
 * Reachable outcomes are `accepted` and `refused` ONLY. `no-op` and `failed` are
 * unreachable through this path because of the argument's shape: every `!ok`
 * becomes `refused`, and a result in hand cannot have failed to dispatch
 * (FR-032).
 */
export async function ackGenericResult(
  ctx: HandlerContext,
  result: { ok: boolean; reason?: string }
): Promise<void> {
  await ackCommandOutcome(ctx, fromMutationResult(result));
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
