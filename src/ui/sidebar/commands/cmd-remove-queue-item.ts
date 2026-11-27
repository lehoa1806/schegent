import type { RemoveQueueItemCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, appendQueueAudit, handleIllegalState } from './handler-helpers';
import { ILLEGAL_STATE_MESSAGES } from './constants';

// BUG-002 (T116) — use the audit-aware ops surface so we can
// (a) attribute the originating queue in the `task-removed` audit payload, and
// (b) differentiate `unknown-task-id` from `task-not-in-pending-state` in the
// rejection reason.
//
// FR-R3-161 (T046, FR-007a) — 2026-09-04. A third branch stood below, falling
// back to a boolean `queueRemover.remove(...)` when no typed surface was wired.
// It never ran: `activation/sidebar-router-wiring.ts` supplies `phaseOps` (the
// `WorkflowController`, which declares `deleteTask`) in every deployment, so the
// typed path always resolved (research F8, spec A4 — re-confirmed by T009
// immediately before this deletion). What it did do was keep a cleanup-free
// deletion route alive behind an unreachable branch: it removed the row without
// releasing the lease, without a session-cleanup decision, and without a
// refreshed lifecycle, and reported "not found or no longer pending" for both
// causes at once.
//
// An unwired host is now a structured refusal rather than a weaker deletion —
// the same `queue-ops-unavailable` the sibling task commands answer with. That
// is a rejection an operator sees, not a silent second protocol.
export const handler: CommandHandler<RemoveQueueItemCommand> = async (ctx, command) => {
  const ops = ctx.deps.queueOps;
  const taskDelete =
    ctx.deps.phaseOps?.deleteTask?.bind(ctx.deps.phaseOps) ?? ops?.removeTask?.bind(ops);
  if (!taskDelete) {
    await ack(ctx, 'rejected', 'queue-ops-unavailable');
    return;
  }
  const result = await taskDelete(command.payload.id);
  if (result.ok) {
    await ack(ctx, 'accepted');
    await appendQueueAudit(ctx, 'task-removed', {
      taskId: result.taskId ?? command.payload.id,
      queueId: result.queueId ?? null,
      priorStatus: result.priorStatus ?? null,
      // FR-R4-F16 (T022, FR-001) — `null` when the result carries none, so every `task-removed` written
      // after this feature has the key. The projection decides what reaches disk, in both copies.
      completionProvenance: result.completionProvenance ?? null,
      runId: result.runId ?? null,
      cause: 'operator',
      sessionCleaned: result.sessionCleaned ?? false,
      // Feature FR-R3-005 (T327) — `sessionCleaned: false` says the evidence
      // is still on disk; this says the host declined to reach for it, which
      // is the operator's cue to look at what `.schegent` points at. Bounded
      // code only: the payload stays paths-free, and the refused path
      // appears in the sanitized runtime log alone.
      sessionCleanupRefusal: result.sessionCleanupRefusal ?? null
    });
    return;
  }
  const reason = result.reason ?? 'not-found';
  const human = ILLEGAL_STATE_MESSAGES[reason] ?? `Cannot remove queue item: ${reason}`;
  await handleIllegalState(ctx, reason, human);
};
