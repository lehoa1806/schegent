import type { QueueManager } from '../queue/queue-manager';
import type { HistoryStore } from '../state/history-store';
import type { WorkspaceLockManager } from '../state/lock';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { SchegentWorkflowController } from '../controller/workflow-controller';
import type { GuardedRunService } from '../services/guarded-run-service';

export interface RetryActiveRunCtx {
  // `store` and `controller` are optional so test fixtures that exercise
  // only the history-fallback path can omit them. In production the
  // extension always wires both.
  readonly store?: Pick<WorkspaceStateStore, 'getRun'>;
  readonly controller?: Pick<SchegentWorkflowController, 'resumeExisting'>;
  readonly queue: Pick<QueueManager, 'hasInFlight' | 'list' | 'retry'>;
  readonly history: Pick<HistoryStore, 'list'>;
  readonly lock: Pick<WorkspaceLockManager, 'isHeld'>;
  readonly guarded: Pick<GuardedRunService, 'scheduleOrEnqueue'>;
  readonly notifier: Notifier;
  readonly logger: SanitizedLogger;
}

export async function runRetryActiveRun(
  _arg: unknown,
  ctx: RetryActiveRunCtx
): Promise<void> {
  if (!ctx.lock.isHeld()) {
    ctx.notifier.warn('Schegent: another window holds the workspace lock; ignoring retry.');
    return;
  }

  // If there's an active run that is paused or failed, retry by resuming it.
  const currentRun = ctx.store?.getRun() ?? null;
  if (currentRun && (currentRun.status === 'paused' || currentRun.status === 'failed') && ctx.controller) {
    try {
      const resumed = await ctx.controller.resumeExisting();
      if (resumed) {
        ctx.notifier.info('Schegent: retrying active run.');
        return;
      }
    } catch (err) {
      ctx.logger.error(`retryActiveRun (resume) failed: ${(err as Error).message}`);
    }
  }

  if (ctx.queue.hasInFlight()) {
    ctx.notifier.warn('Schegent: a run is already in flight; cannot retry.');
    return;
  }
  try {
    const recentTerminal = pickMostRecentRetryable(ctx.queue.list());
    if (recentTerminal) {
      const result = await ctx.queue.retry(recentTerminal.id);
      if (!result.ok) {
        ctx.logger.warn(`retryActiveRun: queue.retry rejected: ${result.reason}`);
        ctx.notifier.warn(`Schegent: retry rejected (${result.reason}).`);
        return;
      }
      ctx.logger.info(`retryActiveRun: re-queued ${recentTerminal.id}`);
      ctx.notifier.info(`Schegent: re-queued '${truncate(recentTerminal.description)}'.`);
      return;
    }
    const lastHistory = pickMostRecentTerminalHistory(ctx.history.list());
    if (!lastHistory) {
      ctx.notifier.warn('Schegent: no recent run available to retry.');
      return;
    }
    // Feature 013 — Wave 6 (US6, FR-029..FR-031): use the full sanitized
    // `originalDescription` when present so the retry replays the original
    // input byte-identically. Legacy entries (pre-Wave-6 write) are refused
    // here — unlike `rerun-from-history`, retry-active-run has no `force`
    // affordance because it's a one-touch retry; the operator can fall back
    // to the explicit "Re-run" history action with `force: true` if they
    // want to replay the truncated preview.
    if (lastHistory.originalDescription === undefined) {
      ctx.notifier.warn(
        `Schegent: retry unavailable — original description for ${lastHistory.runId.slice(0, 8)} was not stored under this build.`
      );
      ctx.logger.warn(
        `retryActiveRun: rejected-legacy-entry runId=${lastHistory.runId} (originalDescription missing)`
      );
      return;
    }
    const result = await ctx.guarded.scheduleOrEnqueue({
      description: lastHistory.originalDescription,
      scheduledAt: Date.now(),
      via: 'retry-active',
      pipelineId: lastHistory.pipelineId ?? null,
      rerun: {
        originalRunId: lastHistory.runId,
        originalDescription: lastHistory.originalDescription,
        reason: 'manual'
      }
    });
    switch (result.outcome) {
      case 'enqueued':
        ctx.logger.info(
          `retryActiveRun: re-enqueued from history ${lastHistory.runId} as ${result.queueItemId ?? '?'}`
        );
        ctx.notifier.info(`Schegent: re-enqueued '${truncate(lastHistory.originalDescription)}'.`);
        return;
      case 'rejected-paused':
        ctx.notifier.warn('Schegent: queue is paused; cannot retry.');
        return;
      case 'rejected-foreign-lock':
        ctx.notifier.info('Schegent: another window holds the workspace lock.');
        return;
      case 'rejected-validation':
        ctx.notifier.warn(`Schegent: retry rejected (${result.reason ?? 'validation-failed'}).`);
        return;
    }
  } catch (err) {
    ctx.logger.error(`runRetryActiveRun failed: ${(err as Error).message}`);
    ctx.notifier.error('Schegent: retry failed.');
  }
}

interface RetryableItem {
  readonly id: string;
  readonly description: string;
  readonly updatedAt: number;
  readonly status: 'failed' | 'canceled' | 'paused';
}

function pickMostRecentRetryable(
  list: readonly { id: string; description: string; updatedAt: number; status: string }[]
): RetryableItem | null {
  let best: RetryableItem | null = null;
  for (const r of list) {
    if (r.status !== 'failed' && r.status !== 'canceled' && r.status !== 'paused') continue;
    if (!best || r.updatedAt > best.updatedAt) {
      best = {
        id: r.id,
        description: r.description,
        updatedAt: r.updatedAt,
        status: r.status as 'failed' | 'canceled' | 'paused'
      };
    }
  }
  return best;
}

interface RetryTargetHistory {
  readonly runId: string;
  readonly descriptionPreview: string;
  readonly originalDescription: string | undefined;
  readonly pipelineId: string | undefined;
}

function pickMostRecentTerminalHistory(
  history: readonly {
    runId: string;
    descriptionPreview: string;
    completedAt: string;
    terminalStatus: string;
    originalDescription?: string;
    pipelineId?: string;
  }[]
): RetryTargetHistory | null {
  let best: { entry: RetryTargetHistory; completedAt: number } | null = null;
  for (const h of history) {
    const t = Date.parse(h.completedAt);
    if (isNaN(t)) continue;
    if (!best || t > best.completedAt) {
      best = {
        entry: {
          runId: h.runId,
          descriptionPreview: h.descriptionPreview,
          originalDescription: h.originalDescription,
          pipelineId: h.pipelineId
        },
        completedAt: t
      };
    }
  }
  return best ? best.entry : null;
}

function truncate(s: string): string {
  return s.length > 60 ? `${s.slice(0, 60)}...` : s;
}
