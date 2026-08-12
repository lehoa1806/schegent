// Feature 065 (T041 / refactor 2026-05-22) — `schegent.startQueue`
// command handler extracted from extension.ts to keep the host
// registration site below its LOC budget.
//
// Behaviour:
//   - When `arg.startIntent` is present (FR-015 operator-restart paths),
//     route through `GuardedRunService.applyStartQueueIntent()` so the
//     audit + coordinator wiring stays centralized. After a successful
//     `convert-to-now` (lifecycleAfter === 'running'), kick a drain
//     pass.
//   - When no `startIntent`, just kick a drain pass (legacy CMD_START_QUEUE).
//
// All errors are swallowed and logged — the command is fire-and-forget
// from the IPC side.
import type { GuardedRunService } from '../services/guarded-run-service';
import type { SchegentWorkflowController } from '../controller/workflow-controller';
import type { SanitizedLogger } from '../lib/logger';

export interface StartQueueCommandDeps {
  readonly guardedRunService: Pick<GuardedRunService, 'applyStartQueueIntent'>;
  readonly controller: Pick<SchegentWorkflowController, 'drainQueuedWork'>;
  readonly logger: Pick<SanitizedLogger, 'warn'>;
}

export interface StartQueueIntent {
  readonly startMode: 'now' | 'scheduled' | 'cancel-schedule';
  readonly scheduledStartAt?: number;
  readonly source: 'operator-restart';
}

export interface StartQueueCommandArg {
  // Feature 092 (T061, FR-034) — which queue the start addresses. Absent
  // means the default queue, resolved by the two seams below rather than
  // here: `applyStartQueueIntent` and `drainQueuedWork` each already
  // default an omitted id, and duplicating that default in this file
  // would make three places that decide it.
  readonly queueId?: string;
  readonly startIntent?: StartQueueIntent;
}

export async function runStartQueueCommand(
  arg: StartQueueCommandArg | undefined,
  deps: StartQueueCommandDeps
): Promise<void> {
  try {
    const queueId = arg?.queueId;
    const startIntent = arg?.startIntent;
    if (startIntent) {
      const result = await deps.guardedRunService.applyStartQueueIntent(startIntent, { queueId });
      if (result.outcome === 'applied' && result.lifecycleAfter === 'running') {
        await deps.controller.drainQueuedWork(queueId);
      }
      return;
    }
    await deps.controller.drainQueuedWork(queueId);
  } catch (err) {
    deps.logger.warn(`startQueue: ${(err as Error).message}`);
  }
}
