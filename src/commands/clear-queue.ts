// FR-R3-150 (T1620) — `runClearQueue` orchestrator for the queue-scoped
// Clean All. Mirrors `clear-all.ts`'s `runClearAll` shape, addressed
// throughout (research.md D2, D5):
//
//   1. Workspace-lock primacy check (`lock.hasPrimacy()`) — the same
//      precondition-only rule as every existing mutation path; never
//      released here (AGENTS.md hard rule, D5).
//   2. A bounded runner-ack probe scoped to the addressed queue, built on
//      `waitForQueueRunnerStop` (`queue-runner-ack.ts`), which races
//      `controller.isDriving(queueId)` — never the workspace-wide
//      `controller.running` getter, so cleaning one queue never waits on,
//      or reports on, a sibling's still-executing Run.
//   3. `QueueManager.clearQueue(queueId, probe)`, which performs the
//      one-write reset (tasks, run, pause, schedule, lifecycle) for
//      exactly this queue. On a runner-ack timeout the reset still
//      completes in full (FR-015) — this orchestrator never rolls it back.
//   4. Direct execution-lease release by the already-known `queueId`
//      (`ctx.executionLease.release(queueId)`) — never through the
//      task-derived `releaseExecutionLeaseForTerminalRun` lookup, whose
//      task rows this reset has already removed (D5).
//   5. A single `queue-cleared` audit event, emitted ONLY when
//      `result.wasNoop === false`.
//   6. Operator-visible toast translation for lock contention, persistence
//      error, and runner non-ack — all three name the addressed queue (a
//      code-review finding: the first two used to be `clear-all.ts`'s
//      unaddressed workspace-wide wording verbatim, even though `queueId`
//      is known for the whole lifetime of this function, unlike a toast
//      that fires before any queue is even named).

import type { SchegentWorkflowController } from '../controller/workflow-controller';
import { waitForQueueRunnerStop } from '../controller/queue-runner-ack';
import { deriveRunnerState } from '../controller/runner-ack-shared';
import type { QueueManager } from '../queue/queue-manager';
import type { ExecutionLeasePort } from '../services/auto-drain-coordinator';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { WorkspaceLockManager } from '../state/lock';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import { errorMessage } from '../lib/errors';
import {
  cleanAllLockContentionToast,
  cleanAllPersistenceErrorToast,
  cleanAllRunnerStillPendingToast
} from './clear-all';

// Code-review finding (iteration 4) — built on `clear-all.ts`'s shared
// toast functions, addressed by passing `queueId`, rather than a second
// hand-maintained copy of the wording. The host must not import the
// webview `action-copy.ts` bundle (see that file's own header comment), so
// the base wording still lives in `clear-all.ts`, not there.

export type ClearQueueOrchestrationResult = { ok: true } | { ok: false; reason: string };

export interface ClearQueueCtx {
  controller: SchegentWorkflowController;
  queue: QueueManager;
  executionLease: ExecutionLeasePort;
  audit: AuditLogWriter;
  lock: WorkspaceLockManager;
  notifier: Notifier;
  logger: SanitizedLogger;
}

export async function runClearQueue(
  ctx: ClearQueueCtx,
  queueId: string
): Promise<ClearQueueOrchestrationResult> {
  if (!(await ctx.lock.hasPrimacy())) {
    ctx.notifier.warn(cleanAllLockContentionToast(queueId));
    return { ok: false, reason: 'not-primary' };
  }

  const probe = async (): Promise<boolean> => {
    try {
      ctx.controller.cancelActive(queueId);
    } catch (err) {
      ctx.logger.warn(
        `runClearQueue: controller.cancelActive(${queueId}) threw: ${errorMessage(err)}`
      );
    }
    return await waitForQueueRunnerStop(ctx.controller, queueId);
  };

  let result;
  try {
    result = await ctx.queue.clearQueue(queueId, probe);
  } catch (err) {
    ctx.logger.error(`runClearQueue: clearQueue failed: ${errorMessage(err)}`);
    ctx.notifier.error(cleanAllPersistenceErrorToast(queueId));
    return { ok: false, reason: 'persistence-error' };
  }

  if (result.outcome === 'refused') {
    // Unknown/missing queueId — refused before any write. No toast here: the
    // sidebar IPC boundary is where this reaches the operator (FR-011).
    return { ok: false, reason: result.reason };
  }

  // D5 — direct release by the already-known queueId, never through
  // `releaseExecutionLeaseForTerminalRun`'s task-derived lookup, whose task
  // rows this reset has already removed. Idempotent and safe on a queue that
  // held no lease.
  const releaseLease = async (): Promise<void> => {
    try {
      await ctx.executionLease.release(queueId);
    } catch (err) {
      ctx.logger.warn(`runClearQueue: execution lease release failed: ${errorMessage(err)}`);
    }
  };

  if (result.wasNoop) {
    await releaseLease();
    return { ok: true };
  }

  // Code-review finding (efficiency) — the lease release and the audit
  // append touch unrelated stores (execution-lease vs. audit log) and
  // neither depends on the other's outcome; each was already independently
  // try/caught, so running them concurrently loses nothing but the second
  // write's latency.
  await Promise.all([
    releaseLease(),
    (async (): Promise<void> => {
      try {
        await ctx.audit.append({
          runId: `queue:${queueId}`,
          phase: 'queue',
          iteration: 0,
          eventType: 'queue-cleared',
          payload: {
            queueId,
            removedPending: result.removed.pending,
            removedCompleted: result.removed.completed,
            removedFailed: result.removed.failed,
            removedCanceled: result.removed.canceled,
            removedInFlight: result.inflightAborted ? 1 : 0,
            pauseCleared: result.pauseCleared,
            scheduleCleared: result.scheduleCleared,
            runnerState: deriveRunnerState(result)
          },
          outcome: 'info'
        });
      } catch (err) {
        ctx.logger.warn(`runClearQueue: audit append failed: ${errorMessage(err)}`);
      }
    })()
  ]);

  // FR-015 — bounded warning naming the queue, not a rollback: the reset
  // above already completed in full regardless of runner-ack outcome.
  if (result.inflightAborted && !result.runnerAcked) {
    ctx.notifier.warn(cleanAllRunnerStillPendingToast(queueId));
  }

  return { ok: true };
}
