import * as vscode from 'vscode';

import type { AuditLogWriter } from '../audit/audit-log-writer';
import { runAuto } from '../commands/auto';
import { runCancel } from '../commands/cancel';
import { runClearAll } from '../commands/clear-all';
import { runEnqueue } from '../commands/enqueue';
import { runExportAuditLog } from '../commands/export-audit';
import { runOpenDashboard } from '../commands/open-dashboard';
import {
  runClearCompleted,
  runClearFailed,
  runMoveQueuedItemDown,
  runMoveQueuedItemUp,
  runPauseQueue,
  runResumeQueue,
  runRetryQueuedItem
} from '../commands/queue-ops';
import { runRerunFromHistory } from '../commands/rerun-from-history';
import { runRestartCanceledTask } from '../commands/restart-canceled-task';
import { runResume } from '../commands/resume';
import { runRetryActiveRun } from '../commands/retry-active-run';
import { runRetryPhaseNow } from '../commands/retry-phase-now';
import { runSchedule } from '../commands/schedule';
import { runShowActiveRun } from '../commands/show-active-run';
import { runShowAuditLog } from '../commands/show-audit';
import {
  runStartQueueCommand,
  type StartQueueCommandArg
} from '../commands/start-queue';
import type { PipelineCatalog } from '../config/pipeline-config';
import type { SchegentWorkflowController } from '../controller/workflow-controller';
import type { SanitizedLogger } from '../lib/logger';
import type { QueueManager } from '../queue/queue-manager';
import type { GuardedRunService } from '../services/guarded-run-service';
import type { HistoryStore } from '../state/history-store';
import type { WorkspaceLockManager } from '../state/lock';
import type { WorkspaceStateStore } from '../state/workspace-state';
import { DashboardBridge } from '../ui/dashboard/dashboard-bridge';
import type { Notifier } from '../ui/notifications';
import type { StateProjector } from '../ui/sidebar/state-projector';

interface Stage2UiWiringDeps {
  readonly extensionRoot: string;
  readonly workspaceRoot: string;
  readonly projector: StateProjector;
  readonly dispatch: ConstructorParameters<typeof DashboardBridge>[0]['dispatch'];
  readonly guardedRunService: GuardedRunService;
  readonly store: WorkspaceStateStore;
  readonly auditWriter: AuditLogWriter;
  readonly notifier: Notifier;
  readonly logger: SanitizedLogger;
  readonly getCatalog: () => PipelineCatalog;
  readonly controller: SchegentWorkflowController;
  readonly queue: QueueManager;
  readonly lock: WorkspaceLockManager;
  readonly historyStore: HistoryStore;
  readonly getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] | undefined;
}

export interface Stage2UiWiring {
  readonly dashboardBridge: DashboardBridge;
  dispose(): void;
}

/**
 * Registers the operator command surface and owns its dashboard bridge.
 * Workflow/runtime composition stays in extension activation; this module is
 * the single lifecycle owner for VS Code UI command registrations.
 */
export function registerStage2Ui(deps: Stage2UiWiringDeps): Stage2UiWiring {
  const dashboardBridge = new DashboardBridge({
    extensionRoot: deps.extensionRoot,
    projector: deps.projector,
    dispatch: deps.dispatch,
    logger: deps.logger
  });
  const queueOpsCtx = {
    queue: deps.queue,
    lock: deps.lock,
    notifier: deps.notifier,
    logger: deps.logger
  };
  const commands: vscode.Disposable[] = [
    vscode.commands.registerCommand('schegent.auto', (args) =>
      runAuto(args, {
        guardedRunService: deps.guardedRunService,
        store: deps.store,
        audit: deps.auditWriter,
        notifier: deps.notifier,
        logger: deps.logger
      })
    ),
    vscode.commands.registerCommand('schegent.enqueue', async (args) => {
      const result = await runEnqueue(args, {
        guardedRunService: deps.guardedRunService,
        store: deps.store,
        audit: deps.auditWriter,
        logger: deps.logger,
        via: 'dashboard-submit',
        promptForInput: false
      });
      if (result?.result.outcome === 'enqueued') {
        void deps.controller.drainQueuedWork().catch((err) =>
          deps.logger.warn(`enqueue: auto-drain failed: ${(err as Error).message}`)
        );
      }
      return result;
    }),
    vscode.commands.registerCommand('schegent.schedule', (args) =>
      runSchedule(args, {
        guardedRunService: deps.guardedRunService,
        getCatalog: deps.getCatalog,
        notifier: deps.notifier,
        logger: deps.logger
      })
    ),
    vscode.commands.registerCommand('schegent.resume', (prompt?: string) =>
      runResume({
        store: deps.store,
        controller: deps.controller,
        lock: deps.lock,
        notifier: deps.notifier,
        logger: deps.logger,
        prompt
      })
    ),
    vscode.commands.registerCommand(
      'schegent.startQueue',
      (arg?: StartQueueCommandArg) =>
        runStartQueueCommand(arg, {
          guardedRunService: deps.guardedRunService,
          controller: deps.controller,
          logger: deps.logger
        })
    ),
    vscode.commands.registerCommand('schegent.cancel', (arg?: { taskId?: string }) =>
      runCancel({
        controller: deps.controller,
        store: deps.store,
        queue: deps.queue,
        audit: deps.auditWriter,
        lock: deps.lock,
        notifier: deps.notifier,
        logger: deps.logger,
        taskId: typeof arg?.taskId === 'string' ? arg.taskId : undefined
      })
    ),
    vscode.commands.registerCommand(
      'schegent.restartCanceledTask',
      (arg?: { taskId?: string }) =>
        runRestartCanceledTask({
          store: deps.store,
          queue: deps.queue,
          audit: deps.auditWriter,
          notifier: deps.notifier,
          logger: deps.logger,
          taskId: typeof arg?.taskId === 'string' ? arg.taskId : ''
        })
    ),
    vscode.commands.registerCommand('schegent.showAuditLog', () =>
      runShowAuditLog({ workspaceRoot: deps.workspaceRoot, notifier: deps.notifier })
    ),
    vscode.commands.registerCommand('schegent.exportAuditLog', () =>
      runExportAuditLog({ workspaceRoot: deps.workspaceRoot, notifier: deps.notifier })
    ),
    vscode.commands.registerCommand('schegent.retryQueuedItem', (arg) =>
      runRetryQueuedItem(arg, queueOpsCtx)
    ),
    vscode.commands.registerCommand('schegent.moveQueuedItemUp', (arg) =>
      runMoveQueuedItemUp(arg, queueOpsCtx)
    ),
    vscode.commands.registerCommand('schegent.moveQueuedItemDown', (arg) =>
      runMoveQueuedItemDown(arg, queueOpsCtx)
    ),
    vscode.commands.registerCommand('schegent.clearAll', () =>
      runClearAll({
        controller: deps.controller,
        store: deps.store,
        queue: deps.queue,
        audit: deps.auditWriter,
        lock: deps.lock,
        notifier: deps.notifier,
        logger: deps.logger
      })
    ),
    vscode.commands.registerCommand('schegent.clearCompleted', () =>
      runClearCompleted(queueOpsCtx)
    ),
    vscode.commands.registerCommand('schegent.clearFailed', () =>
      runClearFailed(queueOpsCtx)
    ),
    vscode.commands.registerCommand('schegent.pauseQueue', (arg) =>
      runPauseQueue(arg, queueOpsCtx)
    ),
    vscode.commands.registerCommand('schegent.resumeQueue', () =>
      runResumeQueue(queueOpsCtx)
    ),
    vscode.commands.registerCommand('schegent.rerunFromHistory', (arg) =>
      runRerunFromHistory(arg, {
        guarded: deps.guardedRunService,
        history: deps.historyStore,
        lock: deps.lock,
        notifier: deps.notifier,
        logger: deps.logger
      })
    ),
    vscode.commands.registerCommand('schegent.showActiveRun', (arg) =>
      runShowActiveRun(arg, { notifier: deps.notifier, logger: deps.logger })
    ),
    vscode.commands.registerCommand('schegent.openDashboard', (arg) =>
      runOpenDashboard(arg, {
        bridge: dashboardBridge,
        notifier: deps.notifier,
        logger: deps.logger,
        getWorkspaceFolders: deps.getWorkspaceFolders
      })
    ),
    vscode.commands.registerCommand('schegent.retryActiveRun', (arg) =>
      runRetryActiveRun(arg, {
        store: deps.store,
        controller: deps.controller,
        queue: deps.queue,
        history: deps.historyStore,
        lock: deps.lock,
        guarded: deps.guardedRunService,
        notifier: deps.notifier,
        logger: deps.logger
      })
    ),
    vscode.commands.registerCommand('schegent.retryPhaseNow', (arg) =>
      runRetryPhaseNow(arg, {
        controller: deps.controller,
        lock: deps.lock,
        notifier: deps.notifier,
        logger: deps.logger
      })
    ),
    vscode.commands.registerCommand('schegent.pausePhase', async () => {
      const result = await deps.controller.pauseActivePhase();
      if (!result.ok) {
        deps.notifier.warn(`Schegent: pause phase rejected (${result.reason}).`);
      }
    }),
    vscode.commands.registerCommand('schegent.resumePhase', async (prompt?: string) => {
      const result = await deps.controller.resumeActivePhase(prompt);
      if (!result.ok) {
        deps.notifier.warn(`Schegent: resume phase rejected (${result.reason}).`);
      }
    }),
    vscode.commands.registerCommand('schegent.restartPhase', async () => {
      const result = await deps.controller.restartActivePhase();
      if (!result.ok) {
        deps.notifier.warn(`Schegent: restart phase rejected (${result.reason}).`);
      }
    }),
    vscode.commands.registerCommand('schegent.redetectClaudeTransport', () => {
      deps.notifier.info(
        'Schegent: Claude CLI now natively streams prompts over stdin. No transport redetection is necessary.'
      );
    })
  ];

  return {
    dashboardBridge,
    dispose(): void {
      dashboardBridge.dispose();
      for (const command of commands) command.dispose();
    }
  };
}
