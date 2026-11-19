// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT. Registers
// commands through `registerGuardedCommand`; the registrations themselves
// perform nothing, and each handler re-checks trust and ownership at the point
// of effect, the same as every other registration in `ui-wiring.ts`.
//
// FR-R7-03 (FR-004, FR-006) — SQLite store backup, verify, and restore commands,
// extracted out of `registerStage2Ui()` to respect `ui-wiring.ts`'s composition-root
// LOC budget (`tests/lint/source-loc-budget.test.ts`).

import * as vscode from 'vscode';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import {
  runBackupStore,
  runRestoreStoreBackup,
  runVerifyStoreBackup,
  type BackupPickerItem,
  type BackupRestoreCommandUi
} from '../commands/sqlite-backup-restore';
import type { SchegentWorkflowController } from '../controller/workflow-controller';
import {
  createStoreBackupRestoreApi,
  createWorkspaceExternalDependencyInspector
} from '../headless/backup-restore-api';
import type { WorkspaceLockManager } from '../state/lock';
import { isTerminalRunStatus } from '../state/workflow-run';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { Notifier } from '../ui/notifications';
import type { StateProjector } from '../ui/sidebar/state-projector';
import { registerGuardedCommand, type GuardedCommandDeps } from './guarded-command-registration';
import {
  deriveWorkspaceScopeId,
  getSqliteCutoverCoordinator
} from './sqlite-cutover-wiring';

export interface SqliteBackupCommandsWiringDeps {
  readonly workspaceRoot: string;
  readonly globalStorageRoot: string;
  readonly store: WorkspaceStateStore;
  readonly controller: SchegentWorkflowController;
  readonly lock: Pick<WorkspaceLockManager, 'hasPrimacy'>;
  readonly auditWriter: AuditLogWriter;
  readonly notifier: Notifier;
  readonly projector: Pick<StateProjector, 'kick'>;
}

function createVscodeBackupRestoreUi(notifier: Notifier): BackupRestoreCommandUi {
  return {
    async pickBackup(items, title, placeHolder) {
      const picked = await vscode.window.showQuickPick<BackupPickerItem & vscode.QuickPickItem>(
        items as (BackupPickerItem & vscode.QuickPickItem)[],
        { title, placeHolder, matchOnDescription: true, matchOnDetail: true }
      );
      return picked;
    },
    async confirmModal(message, detail, approveLabel) {
      const chosen = await vscode.window.showWarningMessage(
        message,
        { modal: true, detail },
        approveLabel
      );
      return chosen === approveLabel;
    },
    info: (message) => notifier.info(message),
    warn: (message) => notifier.warn(message),
    error: (message) => notifier.error(message)
  };
}

function hasAnyInFlightRun(deps: SqliteBackupCommandsWiringDeps): boolean {
  if (deps.controller.liveRunCount > 0) {
    return true;
  }
  const runMap = deps.store.getRunMap();
  if (Object.values(runMap).some((run) => !isTerminalRunStatus(run.status))) {
    return true;
  }
  const queues = deps.store.getQueueStates();
  if (Object.values(queues).some((q) => q.inFlightId !== null)) {
    return true;
  }
  const connectedRuns = deps.store.getConnectedRuns();
  for (const connected of Object.values(connectedRuns)) {
    const status = (connected as { readonly status?: unknown } | undefined)?.status;
    if (status === 'in-flight' || status === 'waiting-for-handoff' || status === 'paused') {
      return true;
    }
  }
  const coordinator = getSqliteCutoverCoordinator(deps.store);
  if (coordinator?.hasInFlightSqliteRun()) {
    return true;
  }
  return false;
}

export function registerSqliteBackupCommands(
  guard: GuardedCommandDeps,
  deps: SqliteBackupCommandsWiringDeps
): readonly vscode.Disposable[] {
  const ui = createVscodeBackupRestoreUi(deps.notifier);
  const inspectExternalDependency = createWorkspaceExternalDependencyInspector(deps.workspaceRoot);

  const buildApi = () => {
    const coordinator = getSqliteCutoverCoordinator(deps.store);
    const trustedRootDir = coordinator?.storageRoot ?? deps.globalStorageRoot;
    const scopeId = coordinator?.scopeId ?? deriveWorkspaceScopeId(deps.workspaceRoot);

    return createStoreBackupRestoreApi({
      getSqliteStore: () => coordinator?.getSqliteStore() ?? null,
      ensurePrimaryStore: async () => {
        const services = await coordinator?.activatePrimary();
        return services?.sqliteStore ?? null;
      },
      trustedRootDir,
      scopeId,
      hasPrimacy: () => deps.lock.hasPrimacy(),
      hasInFlightRun: () => hasAnyInFlightRun(deps),
      reloadAfterRestore: async () => {
        await coordinator?.reloadAfterRestore();
        deps.projector.kick();
      },
      inspectExternalDependency,
      auditWriter: deps.auditWriter
    });
  };

  return [
    registerGuardedCommand(guard, 'schegent.backupStore', () =>
      runBackupStore({ api: buildApi(), ui })
    ),
    registerGuardedCommand(guard, 'schegent.verifyStoreBackup', (backupId?: unknown) =>
      runVerifyStoreBackup(
        { api: buildApi(), ui },
        typeof backupId === 'string' && backupId.length > 0 ? { backupId } : undefined
      )
    ),
    registerGuardedCommand(guard, 'schegent.restoreStoreBackup', (backupId?: unknown) =>
      runRestoreStoreBackup(
        { api: buildApi(), ui },
        typeof backupId === 'string' && backupId.length > 0 ? { backupId } : undefined
      )
    )
  ];
}
