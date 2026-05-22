import * as vscode from 'vscode';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import type { GuardedRunService } from '../services/guarded-run-service';
import { BUILT_IN_PIPELINE_ID, type PipelineDef, type PipelineCatalog } from '../config/pipeline-config';

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

interface PipelinePickItem extends vscode.QuickPickItem {
  readonly pipelineId: string;
}

export interface RunScheduleCtx {
  readonly guardedRunService: GuardedRunService;
  readonly getCatalog: () => PipelineCatalog;
  readonly notifier: Notifier;
  readonly logger: SanitizedLogger;
}

export async function runSchedule(
  args: ScheduleCommandArgs | undefined,
  ctx: RunScheduleCtx
): Promise<void> {
  try {
    const catalog = ctx.getCatalog();
    let pipelineId: string | undefined = args?.pipelineId;
    if (!pipelineId) {
      pipelineId = await pickPipelineId(catalog.pipelines, catalog.defaultPipelineId);
      if (pipelineId === undefined) return;
    }

    let description = args?.description?.trim();
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
    const scheduledStartAt = args?.scheduledStartAt ?? Date.now();
    const result = await ctx.guardedRunService.scheduleOrEnqueue({
      description,
      scheduledAt: Date.now(),
      via: 'command-palette',
      pipelineId: pipelineId ?? null,
      queueId: args?.queueId ?? null,
      position: args?.position ?? null,
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
        ctx.notifier.warn(`Schegent: rejected (${result.reason ?? 'validation-failed'}).`);
        return;
    }
  } catch (err) {
    ctx.notifier.error(`Schegent: ${(err as Error).message}`);
    ctx.logger.error((err as Error).message);
  }
}

async function pickPipelineId(
  pipelines: readonly PipelineDef[],
  defaultPipelineId: string
): Promise<string | undefined> {
  if (pipelines.length <= 1) {
    return defaultPipelineId;
  }
  const items: PipelinePickItem[] = pipelines.map((p) => ({
    label: p.id === BUILT_IN_PIPELINE_ID ? `$(zap) ${p.name}` : p.name,
    description: p.id,
    detail: p.id === BUILT_IN_PIPELINE_ID ? '[BuiltIn]' : undefined,
    picked: p.id === defaultPipelineId,
    pipelineId: p.id
  }));
  items.sort((a, b) => {
    if (a.pipelineId === defaultPipelineId) return -1;
    if (b.pipelineId === defaultPipelineId) return 1;
    if (a.pipelineId === BUILT_IN_PIPELINE_ID) return -1;
    if (b.pipelineId === BUILT_IN_PIPELINE_ID) return 1;
    return a.label.localeCompare(b.label);
  });
  const choice = await vscode.window.showQuickPick(items, {
    title: 'Schegent: select pipeline',
    placeHolder: `Default: ${defaultPipelineId}`,
    ignoreFocusOut: false
  });
  return choice?.pipelineId;
}
