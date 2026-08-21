import type { HistoryStore } from '../state/history-store';
import type { WorkspaceLockManager } from '../state/lock';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import type { GuardedRunService } from '../services/guarded-run-service';

export interface RerunCtx {
  guarded: Pick<GuardedRunService, 'scheduleOrEnqueue'>;
  history: Pick<HistoryStore, 'list'>;
  lock: Pick<WorkspaceLockManager, 'hasPrimacy'>;
  notifier: Notifier;
  logger: SanitizedLogger;
}

interface RerunArgs {
  readonly runId: string;
  readonly force: boolean;
}

function parseArgs(arg: unknown): RerunArgs | null {
  if (!arg || typeof arg !== 'object') return null;
  const obj = arg as { runId?: unknown; force?: unknown };
  if (typeof obj.runId !== 'string' || obj.runId.length === 0) return null;
  return { runId: obj.runId, force: obj.force === true };
}

export async function runRerunFromHistory(arg: unknown, ctx: RerunCtx): Promise<void> {
  if (!(await ctx.lock.hasPrimacy())) {
    ctx.notifier.warn('Schegent: another window holds the workspace lock; ignoring rerun.');
    return;
  }
  const args = parseArgs(arg);
  if (!args) {
    ctx.notifier.warn('Schegent: rerun requires a runId.');
    return;
  }
  const { runId, force } = args;
  try {
    const entry = ctx.history.list().find((h) => h.runId === runId);
    if (!entry) {
      ctx.notifier.warn(`Schegent: history entry ${runId} not found.`);
      return;
    }

    // Feature 013 — Wave 6 (US6, FR-029..FR-031): dual rerun path.
    //
    // - If the entry carries `originalDescription` (post-Wave-6 write),
    //   replay it byte-for-byte (the field is the FULL sanitized
    //   description, no length cap).
    // - If the entry is legacy (pre-Wave-6 write, `originalDescription`
    //   absent) AND `force !== true`, refuse with an operator-visible
    //   warning. The preview is intentionally NOT used as a silent
    //   fallback (FR-031).
    // - If legacy AND `force === true`, the operator has opted in to
    //   replaying the truncated preview; we proceed with `descriptionPreview`
    //   and log the divergence at warn level for the audit-tail surface.
    const originalDescription = entry.originalDescription ?? null;
    let descriptionToRun: string;
    let rerunDescriptionField: string;
    if (originalDescription !== null) {
      descriptionToRun = originalDescription;
      rerunDescriptionField = originalDescription;
    } else if (!force) {
      ctx.notifier.warn(
        `Schegent: rerun unavailable for ${runId.slice(0, 8)} — original description was not stored under this build. Re-run with force=true to replay the truncated preview.`
      );
      ctx.logger.warn(
        `rerun: rejected-legacy-entry runId=${runId} (originalDescription missing; force=false)`
      );
      return;
    } else {
      descriptionToRun = entry.descriptionPreview;
      rerunDescriptionField = entry.descriptionPreview;
      ctx.logger.warn(
        `rerun: forced-legacy-preview runId=${runId} (original description missing; replaying preview only)`
      );
    }

    // Feature 065 — Rerun is operator-initiated (already confirmed by
    // selecting the entry in the history pane). Promote immediately.
    const result = await ctx.guarded.scheduleOrEnqueue({
      description: descriptionToRun,
      scheduledAt: Date.now(),
      via: 'rerun-from-history',
      pipelineId: entry.pipelineId ?? null,
      rerun: {
        originalRunId: runId,
        originalDescription: rerunDescriptionField,
        reason: 'manual'
      },
      startIntent: {
        startMode: 'now',
        source: 'operator-chooser'
      },
      callerKind: 'human'
    });
    switch (result.outcome) {
      case 'enqueued':
        ctx.logger.info(`rerun: re-enqueued ${runId} as ${result.queueItemId ?? '?'}`);
        ctx.notifier.info(`Schegent: re-enqueued rerun of ${runId.slice(0, 8)}.`);
        return;
      case 'rejected-paused':
        ctx.notifier.warn('Schegent: queue is paused; cannot rerun.');
        return;
      case 'rejected-foreign-lock':
        ctx.notifier.info('Schegent: another window holds the workspace lock.');
        return;
      case 'rejected-validation':
        ctx.notifier.warn(`Schegent: rerun rejected (${result.reason ?? 'validation-failed'}).`);
        return;
    }
  } catch (err) {
    ctx.logger.error(`runRerunFromHistory failed: ${(err as Error).message}`);
    ctx.notifier.error(`Schegent: rerun failed.`);
  }
}
