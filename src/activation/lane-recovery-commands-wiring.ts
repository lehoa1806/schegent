// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: GATED HERE.
// `schegent.inspectExecutionLanes` is read-only and registered unwrapped, so this module checks
// `guard.isWorkspaceTrusted()` at invocation time to ensure Restricted Mode never spawns Git
// subprocesses and reads SQLite solely via `withZeroMutationReadOnlySqliteConnection`.
// `schegent.recoverExecutionLane` is mutating and owner-only, guarded by `registerGuardedCommand`.
//
// FR-R8-01 (01-07) — Guarded installed-editor execution-lane inspection & recovery commands,
// extracted out of `registerStage2Ui()` to respect `ui-wiring.ts`'s composition-root LOC budget.

import * as vscode from 'vscode';
import {
  readLaneSnapshotFromService,
  readLaneSnapshotFromSqlitePort,
  runInspectExecutionLanes,
  runRecoverExecutionLane,
  type LaneRecoveryCommandUi,
  type LaneRecoveryPickerItem,
  type ReadOnlyLaneSnapshot
} from '../commands/execution-lane-recovery';
import type { SanitizedLogger } from '../lib/logger';
import { withZeroMutationReadOnlySqliteConnection } from '../state/sqlite-operational-port';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { Notifier } from '../ui/notifications';
import { registerGuardedCommand, type GuardedCommandDeps } from './guarded-command-registration';
import {
  deriveWorkspaceScopeId,
  getSqliteCutoverCoordinator
} from './sqlite-cutover-wiring';

export interface LaneRecoveryCommandsWiringDeps {
  readonly workspaceRoot: string;
  readonly globalStorageRoot: string;
  readonly store: WorkspaceStateStore;
  readonly notifier: Notifier;
  readonly logger: Pick<SanitizedLogger, 'info' | 'warn'>;
  /** Optional UI port override for extension-host tests; defaults to native VS Code dialogs/editor. */
  readonly ui?: LaneRecoveryCommandUi | undefined;
}

function createVscodeLaneRecoveryUi(notifier: Notifier): LaneRecoveryCommandUi {
  return {
    async pickItem(items, title, placeHolder) {
      const picked = await vscode.window.showQuickPick<LaneRecoveryPickerItem & vscode.QuickPickItem>(
        items as (LaneRecoveryPickerItem & vscode.QuickPickItem)[],
        { title, placeHolder, matchOnDescription: true, matchOnDetail: true }
      );
      return picked;
    },
    async confirmModal(summary, detail, confirmLabel) {
      const chosen = await vscode.window.showWarningMessage(
        summary,
        { modal: true, detail },
        confirmLabel
      );
      return chosen === confirmLabel;
    },
    async openMarkdownReport(markdown) {
      const document = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: markdown
      });
      await vscode.window.showTextDocument(document, { preview: false });
    },
    info: (message) => notifier.info(message),
    warn: (message) => notifier.warn(message),
    error: (message) => notifier.error(message)
  };
}

function emptySnapshot(modeNote: string): ReadOnlyLaneSnapshot {
  return {
    lanes: [],
    requests: [],
    journalsByRequestId: {},
    gitByLaneId: {},
    targetTips: {},
    gitProbed: false,
    modeNote
  };
}

function stripUnsafeRecoverArgs(rawArgs: unknown): unknown {
  if (rawArgs === undefined || rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return rawArgs;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawArgs as Record<string, unknown>)) {
    if (key !== 'confirm') out[key] = value;
  }
  return out;
}

export function registerLaneRecoveryCommands(
  guard: GuardedCommandDeps,
  deps: LaneRecoveryCommandsWiringDeps
): readonly vscode.Disposable[] {
  const ui = deps.ui ?? createVscodeLaneRecoveryUi(deps.notifier);
  const getCoordinator = () => getSqliteCutoverCoordinator(deps.store);

  const verifyPrimaryAndTrusted = async (): Promise<boolean> => {
    if (!guard.isWorkspaceTrusted()) return false;
    if (guard.isOwner === undefined) return false;
    try {
      return await guard.isOwner();
    } catch {
      return false;
    }
  };

  const readInspectionSnapshot = async (options: {
    readonly allowLiveGit: boolean;
  }): Promise<ReadOnlyLaneSnapshot> => {
    const trusted = guard.isWorkspaceTrusted();
    const allowLiveGit = trusted && options.allowLiveGit;
    const coordinator = getCoordinator();
    const scopeId = coordinator?.scopeId ?? deriveWorkspaceScopeId(deps.workspaceRoot);
    const storageRoot = coordinator?.storageRoot ?? deps.globalStorageRoot;

    // When trusted and the primary LaneService is active, read through it (skipping Git if disabled).
    const liveService = trusted ? (coordinator?.getLaneService() ?? null) : null;
    if (liveService !== null) {
      return await readLaneSnapshotFromService(liveService, { allowLiveGit });
    }

    // Restricted Mode (untrusted) or secondary window without an active primary LaneService:
    // read persisted SQLite rows strictly via zero-mutation read-only connection and spawn zero Git.
    const modeNote = trusted
      ? 'Read-only SQLite snapshot (primary lane service is inactive in this window); live Git probe skipped.'
      : 'Live Git inspection skipped in Restricted Mode (untrusted workspace).';
    const inspected = await withZeroMutationReadOnlySqliteConnection(
      storageRoot,
      ['sqlite', scopeId],
      'schegent-state.db',
      (conn) => readLaneSnapshotFromSqlitePort(conn, scopeId, modeNote)
    );
    if (inspected.outcome === 'ok') {
      return inspected.value;
    }
    if (inspected.outcome === 'absent') {
      return emptySnapshot(modeNote);
    }
    throw Object.assign(new Error('Execution lane inspection failed'), { code: inspected.outcome });
  };

  const resolvePrimaryLaneService = async () => {
    if (!(await verifyPrimaryAndTrusted())) return null;
    const coordinator = getCoordinator();
    const active = coordinator?.getLaneService() ?? null;
    if (active !== null) return active;
    const services = await coordinator?.activatePrimary();
    return services?.laneService ?? null;
  };

  return [
    registerGuardedCommand(guard, 'schegent.inspectExecutionLanes', () =>
      runInspectExecutionLanes({
        isWorkspaceTrusted: () => guard.isWorkspaceTrusted(),
        readSnapshot: readInspectionSnapshot,
        ui,
        logger: deps.logger
      })
    ),
    registerGuardedCommand(guard, 'schegent.recoverExecutionLane', (rawArgs?: unknown) =>
      runRecoverExecutionLane(
        {
          getLaneService: resolvePrimaryLaneService,
          verifyPrimaryAndTrusted,
          ui,
          logger: deps.logger
        },
        stripUnsafeRecoverArgs(rawArgs)
      )
    )
  ];
}
