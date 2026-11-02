import * as vscode from 'vscode';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import { describeFailure } from '../lib/errors';
import type { GuardedRunService } from '../services/guarded-run-service';
import { ENQUEUE_STORAGE_FAULT_TOAST } from '../services/enqueue-failure';
import type { PipelineDef, PipelineCatalog } from '../config/pipeline-config';

/**
 * FR-R4-F05 (FR-014; contract F, F6; contract O, O5) — what the operator is told when
 * scheduling fails for a reason the command has no code for. Fixed text: an exception's
 * message can carry a path, so it goes to the log through `describeFailure` and never to
 * the toast. The outcomes the launch service returns as codes keep their own handling.
 */
export const SCHEDULE_FAILED_TOAST =
  'Schegent: the task could not be scheduled. See the Schegent log for details.';

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

async function pickPipelineId(
  pipelines: readonly PipelineDef[],
  defaultPipelineId: string
): Promise<string | undefined> {
  // Feature 098 (T049, FR-033a/FR-033b) — `defaultPipelineId` is the empty
  // string when no default is set, which is now what a fresh install ships.
  // With nothing to pick from, that empty id is still what travels onward: the
  // launch path answers it with the FR-023 refusal that names it, whereas
  // returning `undefined` here would abort the command silently.
  if (pipelines.length === 0) {
    return defaultPipelineId;
  }
  // One Pipeline and no default has exactly one thing the operator could have
  // meant. Answering the unset default instead would send an id nothing
  // resolves to the launch path while a resolvable one sat unused.
  if (pipelines.length === 1) {
    return defaultPipelineId === '' ? pipelines[0].id : defaultPipelineId;
  }
  // Feature 098 (T050, FR-035) — no row is badged. One id used to carry a
  // `$(zap)` label, a `[BuiltIn]` detail and a place ahead of the sort,
  // because one Pipeline came from the built-in layer. Every Pipeline is
  // imported now, so that marking would tell an operator their own definition
  // was "built in" on the strength of the id they chose.
  const items: PipelinePickItem[] = pipelines.map((p) => ({
    label: p.name,
    description: p.id,
    picked: p.id === defaultPipelineId,
    pipelineId: p.id
  }));
  items.sort((a, b) => {
    // The operator's default still sorts first: that is a choice they made.
    if (a.pipelineId === defaultPipelineId) return -1;
    if (b.pipelineId === defaultPipelineId) return 1;
    return a.label.localeCompare(b.label);
  });
  const choice = await vscode.window.showQuickPick(items, {
    title: 'Schegent: select pipeline',
    placeHolder: defaultPipelineId === '' ? 'Select a pipeline' : `Default: ${defaultPipelineId}`,
    ignoreFocusOut: false
  });
  return choice?.pipelineId;
}
