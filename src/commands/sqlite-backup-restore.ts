/**
 * FR-R7-03 (FR-003, FR-004, FR-005) — Operator command orchestration for
 * `schegent.backupStore`, `schegent.verifyStoreBackup`, and `schegent.restoreStoreBackup`.
 *
 * UI prompts (QuickPick, modal confirmation, notifications) are injected as ports so
 * every command flow, confirmation decline, precondition refusal, and validation rejection
 * code can be unit-tested deterministically without a live VS Code window.
 */

import type {
  CreateStoreBackupResult,
  GuardedRestoreResult,
  StoreBackupRestoreApi
} from '../headless/backup-restore-api';
import type {
  BackupBoundsOverrides,
  ListedBackupEntry,
  VerifyBackupOutcome
} from '../services/sqlite-store';

export interface BackupPickerItem {
  readonly label: string;
  readonly description: string;
  readonly detail: string;
  readonly backupId: string;
}

export interface BackupRestoreCommandUi {
  pickBackup(
    items: readonly BackupPickerItem[],
    title: string,
    placeHolder: string
  ): Promise<BackupPickerItem | undefined>;
  confirmModal(message: string, detail: string, approveLabel: string): Promise<boolean>;
  info(message: string): unknown;
  warn(message: string): unknown;
  error(message: string): unknown;
}

export interface BackupRestoreCommandDeps {
  readonly api: StoreBackupRestoreApi;
  readonly ui: BackupRestoreCommandUi;
}

export type BackupCommandOutcome =
  | { readonly status: 'canceled' }
  | CreateStoreBackupResult;

export type VerifyCommandOutcome =
  | { readonly status: 'canceled' }
  | { readonly status: 'empty' }
  | VerifyBackupOutcome;

export type RestoreCommandOutcome =
  | { readonly status: 'canceled' }
  | { readonly status: 'empty' }
  | GuardedRestoreResult;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function toPickerItems(entries: readonly ListedBackupEntry[]): BackupPickerItem[] {
  return entries.map((entry) => {
    const created =
      entry.createdAtMs !== null ? new Date(entry.createdAtMs).toISOString() : 'unknown timestamp';
    const schema = entry.schemaVersion !== null ? `schema v${entry.schemaVersion}` : 'schema unknown';
    const manifestBadge =
      entry.manifestStatus === 'valid' ? 'manifest valid' : `manifest ${entry.manifestStatus}`;
    return {
      label: entry.backupId,
      description: `${schema} · ${formatBytes(entry.databaseBytes)}`,
      detail: `Created ${created} · ${manifestBadge}`,
      backupId: entry.backupId
    };
  });
}

export async function runBackupStore(
  deps: BackupRestoreCommandDeps,
  options?: BackupBoundsOverrides & { readonly backupId?: string | undefined }
): Promise<BackupCommandOutcome> {
  const confirmed = await deps.ui.confirmModal(
    'Back up the Schegent SQLite store?',
    'Creates a consistent point-in-time snapshot of the workspace SQLite database and companion manifest with owner-only permissions (0600) inside extension storage. Backup files contain the same operational data as the live store.',
    'Create Backup'
  );
  if (!confirmed) {
    return { status: 'canceled' };
  }

  const result = await deps.api.createBackup(options);
  if (result.status === 'created') {
    deps.ui.info(
      `Schegent: backup '${result.backupId}' created (${formatBytes(result.manifest.databaseBytes)}, schema v${result.manifest.schemaVersion}) at ${result.backupDatabasePath}`
    );
  } else if (result.status === 'refused') {
    deps.ui.warn(`Schegent: backup refused (${result.reasonCode}) — ${result.message}`);
  } else {
    deps.ui.error(`Schegent: backup failed (${result.errorCode}) — ${result.message}`);
  }
  return result;
}

export async function runVerifyStoreBackup(
  deps: BackupRestoreCommandDeps,
  options?: BackupBoundsOverrides & {
    readonly backupId?: string | undefined;
    readonly maxSupportedSchemaVersion?: number | undefined;
    readonly simulateQuickCheckFailure?: boolean | undefined;
  }
): Promise<VerifyCommandOutcome> {
  let targetBackupId = options?.backupId;
  if (!targetBackupId) {
    const entries = await deps.api.listBackups();
    if (entries.length === 0) {
      deps.ui.info('Schegent: no SQLite store backups were found for this workspace.');
      return { status: 'empty' };
    }
    const picked = await deps.ui.pickBackup(
      toPickerItems(entries),
      'Schegent: Verify Store Backup',
      'Select a backup to verify (read-only; does not modify the live store)'
    );
    if (!picked) {
      return { status: 'canceled' };
    }
    targetBackupId = picked.backupId;
  }

  const outcome = await deps.api.verifyBackup(targetBackupId, options);
  if (outcome.status === 'verified') {
    deps.ui.info(
      `Schegent: backup '${outcome.backupId}' verified (schema v${outcome.schemaVersion}, ${formatBytes(outcome.databaseBytes)}, ${outcome.authoritativeTableCount} authoritative tables, ${outcome.verifiedExternalDependencies} external dependencies).`
    );
  } else {
    deps.ui.warn(
      `Schegent: backup verification failed (${outcome.reasonCode}) — ${outcome.message}. Live store was not modified.`
    );
  }
  return outcome;
}

export async function runRestoreStoreBackup(
  deps: BackupRestoreCommandDeps,
  options?: BackupBoundsOverrides & {
    readonly backupId?: string | undefined;
    readonly maxSupportedSchemaVersion?: number | undefined;
    readonly simulateQuickCheckFailure?: boolean | undefined;
    readonly beforeCommitFence?: (() => boolean | Promise<boolean>) | undefined;
  }
): Promise<RestoreCommandOutcome> {
  const entries = await deps.api.listBackups();
  let targetBackupId = options?.backupId;

  if (!targetBackupId) {
    if (entries.length === 0) {
      deps.ui.info('Schegent: no SQLite store backups were found for this workspace.');
      return { status: 'empty' };
    }
    const picked = await deps.ui.pickBackup(
      toPickerItems(entries),
      'Schegent: Restore Store Backup',
      'Select a backup to restore (replaces all authoritative workspace store state)'
    );
    if (!picked) {
      return { status: 'canceled' };
    }
    targetBackupId = picked.backupId;
  }

  const selectedEntry = entries.find((e) => e.backupId === targetBackupId);
  const createdText =
    selectedEntry?.createdAtMs !== null && selectedEntry?.createdAtMs !== undefined
      ? new Date(selectedEntry.createdAtMs).toISOString()
      : 'unknown timestamp';
  const schemaText =
    selectedEntry?.schemaVersion !== null && selectedEntry?.schemaVersion !== undefined
      ? `schema v${selectedEntry.schemaVersion}`
      : 'schema unknown';
  const sizeText =
    selectedEntry !== undefined ? formatBytes(selectedEntry.databaseBytes) : 'unknown size';

  const confirmed = await deps.ui.confirmModal(
    `Restore Schegent SQLite store from backup '${targetBackupId}'?`,
    `This will replace all authoritative store state — Runs, Tasks, queues, history, usage records, and domain tables — with backup '${targetBackupId}' (${schemaText}, created ${createdText}, ${sizeText}). Any state recorded after this backup was created will be permanently lost. Restore is refused if any Run is currently in flight.`,
    'Restore Store'
  );
  if (!confirmed) {
    return { status: 'canceled' };
  }

  const outcome = await deps.api.restoreBackup(targetBackupId, options);
  if (outcome.status === 'restored') {
    deps.ui.info(
      `Schegent: store restored from '${targetBackupId}' (${outcome.restoredTableCount} tables, ${outcome.restoredRowCount} rows, ${outcome.restoredRunCount} Runs, schema v${outcome.schemaVersion}). Caches reloaded.`
    );
  } else if (outcome.status === 'committed_refresh_failed') {
    deps.ui.error(
      `Schegent: backup '${targetBackupId}' was committed on disk (${outcome.restoredTableCount} tables, schema v${outcome.schemaVersion}), but post-commit cache/catalog refresh failed (${outcome.errorCode}). Reload the window to synchronize in-memory state.`
    );
  } else if (outcome.status === 'refused') {
    deps.ui.warn(
      `Schegent: restore refused (${outcome.reasonCode}) — ${outcome.message} Live store was not modified.`
    );
  } else if (outcome.status === 'rejected') {
    deps.ui.warn(
      `Schegent: restore rejected (${outcome.reasonCode}) — ${outcome.message}. Live store was not modified.`
    );
  } else {
    deps.ui.error(
      `Schegent: restore failed (${outcome.errorCode}) — ${outcome.message}. Live store was not modified.`
    );
  }
  return outcome;
}
