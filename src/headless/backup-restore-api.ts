/**
 * FR-R7-03 (FR-001..FR-005, FR-008..FR-010) — Zero-`vscode` headless API for
 * SQLite store backup, listing, read-only verification, and guarded full-authority restore.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * Audit entries go exclusively through `AuditLogWriter` with metadata-only payloads
 * and zero raw filesystem paths (docs/hard-rules.md rules 21 & 22).
 */

import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import {
  MAX_BACKUP_EXTERNAL_DEPENDENCY_BYTES,
  type BackupDependencyManifest,
  type BackupExternalDependency,
  type BackupRestoreRejectionCode,
  type StoreBackupRestoreAuditPayload
} from '../contracts/sqlite-store/schema-types';
import {
  listBackupsInRoot,
  verifyBackupStandalone,
  type ExternalDependencyInspector,
  type ListedBackupEntry,
  type RestoreValidationOutcome,
  type SqliteApplicationStore,
  type VerifyBackupOutcome
} from '../services/sqlite-store';

export type StoreBackupGuardRefusalCode =
  | 'NOT_WORKSPACE_OWNER'
  | 'RUN_IN_FLIGHT'
  | 'STORE_UNAVAILABLE';

export type CreateStoreBackupResult =
  | {
      readonly status: 'created';
      readonly backupId: string;
      readonly backupDatabasePath: string;
      readonly manifestPath: string;
      readonly manifest: BackupDependencyManifest;
    }
  | {
      readonly status: 'refused';
      readonly reasonCode: StoreBackupGuardRefusalCode;
      readonly message: string;
    }
  | {
      readonly status: 'failed';
      readonly errorCode: string;
      readonly message: string;
    };

export type GuardedRestoreResult =
  | RestoreValidationOutcome
  | {
      readonly status: 'refused';
      readonly reasonCode: StoreBackupGuardRefusalCode;
      readonly message: string;
    }
  | {
      readonly status: 'failed';
      readonly errorCode: string;
      readonly message: string;
    };

export interface StoreBackupRestoreApi {
  createBackup(options?: { readonly backupId?: string | undefined }): Promise<CreateStoreBackupResult>;
  listBackups(): Promise<readonly ListedBackupEntry[]>;
  verifyBackup(
    backupId: string,
    options?: {
      readonly maxSupportedSchemaVersion?: number | undefined;
      readonly maxExternalDependencies?: number | undefined;
      readonly maxExternalDependencyBytes?: number | undefined;
      readonly simulateQuickCheckFailure?: boolean | undefined;
    }
  ): Promise<VerifyBackupOutcome>;
  restoreBackup(
    backupId: string,
    options?: {
      readonly maxSupportedSchemaVersion?: number | undefined;
      readonly maxExternalDependencies?: number | undefined;
      readonly maxExternalDependencyBytes?: number | undefined;
      readonly simulateQuickCheckFailure?: boolean | undefined;
    }
  ): Promise<GuardedRestoreResult>;
}

export interface StoreBackupRestoreApiDeps {
  readonly getSqliteStore: () => SqliteApplicationStore | null;
  readonly ensurePrimaryStore?: (() => Promise<SqliteApplicationStore | null>) | undefined;
  readonly trustedRootDir: string;
  readonly scopeId: string;
  readonly hasPrimacy: () => Promise<boolean>;
  readonly hasInFlightRun: () => boolean;
  readonly reloadAfterRestore: () => Promise<void> | void;
  readonly inspectExternalDependency?: ExternalDependencyInspector | undefined;
  readonly collectAuditLogDependencies?: (() => readonly BackupExternalDependency[]) | undefined;
  readonly auditWriter?: Pick<AuditLogWriter, 'append'> | undefined;
  readonly nowMs?: (() => number) | undefined;
}

const KNOWN_BACKUP_ERROR_PREFIXES = [
  'BACKUP_PATH_REFUSED',
  'INVALID_BACKUP_ID',
  'INVALID_BACKUP_FILENAME',
  'BACKUP_MODE_NARROWING_FAILED',
  'BACKUP_SCHEMA_VERSION_INVALID',
  'BACKUP_DIGEST_FAILED',
  'BACKUP_MANIFEST_WRITE_REFUSED'
] as const;

const SAFE_OPAQUE_BACKUP_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function sanitizeAuditBackupId(backupId: string): string {
  if (SAFE_OPAQUE_BACKUP_ID_RE.test(backupId) && !backupId.includes('..')) {
    return backupId;
  }
  return 'invalid-id';
}

function extractClosedErrorCode(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    for (const prefix of KNOWN_BACKUP_ERROR_PREFIXES) {
      if (err.message.startsWith(prefix)) {
        return prefix;
      }
    }
  }
  return fallback;
}

function generateBackupId(nowMs: number): string {
  const iso = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  const suffix = randomBytes(4).toString('hex');
  return `bkp-${iso}-${suffix}`;
}

/**
 * Safe read-only external dependency inspector confined strictly within `workspaceRoot`.
 * Refuses path traversal, symlinks, non-regular files, and files exceeding the byte ceiling.
 */
export function createWorkspaceExternalDependencyInspector(
  workspaceRoot: string
): ExternalDependencyInspector {
  const resolvedRoot = path.resolve(workspaceRoot);
  return (relativePath: string) => {
    if (
      relativePath.length === 0 ||
      relativePath.includes('\0') ||
      path.isAbsolute(relativePath)
    ) {
      return { exists: false, byteLength: 0, sha256Digest: '' };
    }
    const rawSegments = relativePath.split(/[\\/]/);
    if (rawSegments.some((seg) => seg.length === 0 || seg === '.' || seg === '..')) {
      return { exists: false, byteLength: 0, sha256Digest: '' };
    }
    const target = path.resolve(resolvedRoot, relativePath);
    const rel = path.relative(resolvedRoot, target);
    if (rel.length === 0 || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return { exists: false, byteLength: 0, sha256Digest: '' };
    }

    const parts = rel.split(path.sep);
    let current = resolvedRoot;
    for (let i = 0; i < parts.length - 1; i += 1) {
      current = path.join(current, parts[i]!);
      try {
        const st = lstatSync(current);
        if (st.isSymbolicLink() || !st.isDirectory()) {
          return { exists: false, byteLength: 0, sha256Digest: '' };
        }
      } catch {
        return { exists: false, byteLength: 0, sha256Digest: '' };
      }
    }

    try {
      const st = lstatSync(target);
      if (st.isSymbolicLink() || !st.isFile()) {
        return { exists: false, byteLength: 0, sha256Digest: '' };
      }
      if (st.size > MAX_BACKUP_EXTERNAL_DEPENDENCY_BYTES) {
        return { exists: true, byteLength: st.size, sha256Digest: '' };
      }
      const bytes = readFileSync(target);
      const sha256Digest = createHash('sha256').update(bytes).digest('hex');
      return { exists: true, byteLength: bytes.byteLength, sha256Digest };
    } catch {
      return { exists: false, byteLength: 0, sha256Digest: '' };
    }
  };
}

export function createStoreBackupRestoreApi(deps: StoreBackupRestoreApiDeps): StoreBackupRestoreApi {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const relativeBackupDirSegments = Object.freeze(['sqlite', deps.scopeId, 'backups'] as const);

  const appendAudit = async (
    eventType: 'store-backup' | 'store-restore',
    payload: StoreBackupRestoreAuditPayload
  ): Promise<void> => {
    if (!deps.auditWriter) return;
    const cleanPayload: Record<string, unknown> = {
      operation: payload.operation,
      outcome: payload.outcome,
      backupId: sanitizeAuditBackupId(payload.backupId)
    };
    if (payload.errorCode !== undefined) cleanPayload.errorCode = payload.errorCode;
    if (payload.schemaVersion !== undefined) cleanPayload.schemaVersion = payload.schemaVersion;
    if (payload.databaseBytes !== undefined) cleanPayload.databaseBytes = payload.databaseBytes;
    if (payload.restoredTableCount !== undefined) {
      cleanPayload.restoredTableCount = payload.restoredTableCount;
    }
    if (payload.restoredRowCount !== undefined) {
      cleanPayload.restoredRowCount = payload.restoredRowCount;
    }
    if (payload.verifiedExternalDependencies !== undefined) {
      cleanPayload.verifiedExternalDependencies = payload.verifiedExternalDependencies;
    }
    try {
      await deps.auditWriter.append({
        runId: '',
        phase: 'operator',
        iteration: 0,
        eventType,
        payload: cleanPayload,
        outcome: payload.outcome === 'succeeded' ? 'success' : 'failure'
      });
    } catch {
      // Never fail a completed store operation because of a secondary audit sink error,
      // and never leak raw paths or raw errors.
    }
  };

  const resolvePrimaryStore = async (): Promise<SqliteApplicationStore | null> => {
    const existing = deps.getSqliteStore();
    if (existing !== null) return existing;
    if (deps.ensurePrimaryStore) {
      return await deps.ensurePrimaryStore();
    }
    return null;
  };

  const listBackups = async (): Promise<readonly ListedBackupEntry[]> =>
    listBackupsInRoot(deps.trustedRootDir, relativeBackupDirSegments);

  return {
    async createBackup(options): Promise<CreateStoreBackupResult> {
      let isOwner = false;
      try {
        isOwner = await deps.hasPrimacy();
      } catch {
        isOwner = false;
      }
      if (!isOwner) {
        return {
          status: 'refused',
          reasonCode: 'NOT_WORKSPACE_OWNER',
          message: 'Another window holds the workspace ownership fence; backup refused.'
        };
      }

      const backupId = options?.backupId ?? generateBackupId(nowMs());
      const store = await resolvePrimaryStore();
      if (store === null) {
        await appendAudit('store-backup', {
          operation: 'backup',
          outcome: 'refused',
          backupId,
          errorCode: 'STORE_UNAVAILABLE'
        });
        return {
          status: 'refused',
          reasonCode: 'STORE_UNAVAILABLE',
          message: 'SQLite application store is not open for this workspace.'
        };
      }

      try {
        const auditLogDependencies = deps.collectAuditLogDependencies?.() ?? [];
        const created = await store.backupRestore.createOnlineBackup({
          backupId,
          scopeId: deps.scopeId,
          trustedRootDir: deps.trustedRootDir,
          relativeBackupDirSegments,
          auditLogDependencies,
          writeManifestFile: true
        });
        await appendAudit('store-backup', {
          operation: 'backup',
          outcome: 'succeeded',
          backupId: created.manifest.backupId,
          schemaVersion: created.manifest.schemaVersion,
          databaseBytes: created.manifest.databaseBytes,
          verifiedExternalDependencies: created.manifest.externalDependencies.length
        });
        return {
          status: 'created',
          backupId: created.manifest.backupId,
          backupDatabasePath: created.backupDatabasePath,
          manifestPath: created.manifestPath,
          manifest: created.manifest
        };
      } catch (err) {
        const errorCode = extractClosedErrorCode(err, 'BACKUP_FAILED');
        await appendAudit('store-backup', {
          operation: 'backup',
          outcome: 'failed',
          backupId,
          errorCode
        });
        return {
          status: 'failed',
          errorCode,
          message: `Store backup failed (${errorCode}).`
        };
      }
    },

    listBackups,

    async verifyBackup(backupId, options): Promise<VerifyBackupOutcome> {
      const entries = await listBackups();
      const entry = entries.find((e) => e.backupId === backupId);
      if (!entry) {
        return {
          status: 'rejected',
          reasonCode: 'BACKUP_OPEN_FAILED',
          message: `Backup '${sanitizeAuditBackupId(backupId)}' was not found in the workspace backup directory.`
        };
      }
      if (entry.manifestStatus !== 'valid' || !entry.manifest) {
        return {
          status: 'rejected',
          reasonCode: 'BACKUP_OPEN_FAILED',
          message: `Backup '${entry.backupId}' has a ${entry.manifestStatus} companion manifest.`
        };
      }
      return verifyBackupStandalone({
        backupDatabasePath: entry.backupDatabasePath,
        manifest: entry.manifest,
        trustedRootDir: deps.trustedRootDir,
        maxSupportedSchemaVersion: options?.maxSupportedSchemaVersion,
        maxExternalDependencies: options?.maxExternalDependencies,
        maxExternalDependencyBytes: options?.maxExternalDependencyBytes,
        inspectExternalDependency: deps.inspectExternalDependency,
        simulateQuickCheckFailure: options?.simulateQuickCheckFailure
      });
    },

    async restoreBackup(backupId, options): Promise<GuardedRestoreResult> {
      let isOwner = false;
      try {
        isOwner = await deps.hasPrimacy();
      } catch {
        isOwner = false;
      }
      if (!isOwner) {
        return {
          status: 'refused',
          reasonCode: 'NOT_WORKSPACE_OWNER',
          message: 'Another window holds the workspace ownership fence; restore refused.'
        };
      }

      if (deps.hasInFlightRun()) {
        await appendAudit('store-restore', {
          operation: 'restore',
          outcome: 'refused',
          backupId,
          errorCode: 'RUN_IN_FLIGHT'
        });
        return {
          status: 'refused',
          reasonCode: 'RUN_IN_FLIGHT',
          message:
            'Cannot restore store while a Run is in flight. Wait for or cancel active Runs before restoring.'
        };
      }

      const store = await resolvePrimaryStore();
      if (store === null) {
        await appendAudit('store-restore', {
          operation: 'restore',
          outcome: 'refused',
          backupId,
          errorCode: 'STORE_UNAVAILABLE'
        });
        return {
          status: 'refused',
          reasonCode: 'STORE_UNAVAILABLE',
          message: 'SQLite application store is not open for this workspace.'
        };
      }

      const entries = await listBackups();
      const entry = entries.find((e) => e.backupId === backupId);
      if (!entry || entry.manifestStatus !== 'valid' || !entry.manifest) {
        const reasonCode: BackupRestoreRejectionCode = 'BACKUP_OPEN_FAILED';
        await appendAudit('store-restore', {
          operation: 'restore',
          outcome: 'rejected',
          backupId,
          errorCode: reasonCode
        });
        return {
          status: 'rejected',
          reasonCode,
          message: !entry
            ? `Backup '${sanitizeAuditBackupId(backupId)}' was not found in the workspace backup directory.`
            : `Backup '${entry.backupId}' has a ${entry.manifestStatus} companion manifest.`
        };
      }

      // Re-check ownership fence and in-flight Runs immediately before opening the write transaction.
      let stillOwner = false;
      try {
        stillOwner = await deps.hasPrimacy();
      } catch {
        stillOwner = false;
      }
      if (!stillOwner) {
        return {
          status: 'refused',
          reasonCode: 'NOT_WORKSPACE_OWNER',
          message: 'Workspace ownership fence was lost before restore; restore refused.'
        };
      }
      if (deps.hasInFlightRun()) {
        await appendAudit('store-restore', {
          operation: 'restore',
          outcome: 'refused',
          backupId: entry.backupId,
          errorCode: 'RUN_IN_FLIGHT'
        });
        return {
          status: 'refused',
          reasonCode: 'RUN_IN_FLIGHT',
          message:
            'Cannot restore store while a Run is in flight. Wait for or cancel active Runs before restoring.'
        };
      }

      try {
        const outcome = store.backupRestore.validateAndRestoreBackup({
          backupDatabasePath: entry.backupDatabasePath,
          manifest: entry.manifest,
          trustedRootDir: deps.trustedRootDir,
          maxSupportedSchemaVersion: options?.maxSupportedSchemaVersion,
          maxExternalDependencies: options?.maxExternalDependencies,
          maxExternalDependencyBytes: options?.maxExternalDependencyBytes,
          inspectExternalDependency: deps.inspectExternalDependency,
          simulateQuickCheckFailure: options?.simulateQuickCheckFailure
        });

        if (outcome.status === 'rejected') {
          await appendAudit('store-restore', {
            operation: 'restore',
            outcome: 'rejected',
            backupId: entry.backupId,
            errorCode: outcome.reasonCode
          });
          return outcome;
        }

        await deps.reloadAfterRestore();

        await appendAudit('store-restore', {
          operation: 'restore',
          outcome: 'succeeded',
          backupId: entry.backupId,
          schemaVersion: outcome.schemaVersion,
          databaseBytes: entry.databaseBytes,
          restoredTableCount: outcome.restoredTableCount,
          restoredRowCount: outcome.restoredRowCount,
          verifiedExternalDependencies: outcome.verifiedExternalDependencies
        });
        return outcome;
      } catch (err) {
        const errorCode = extractClosedErrorCode(err, 'RESTORE_FAILED');
        await appendAudit('store-restore', {
          operation: 'restore',
          outcome: 'failed',
          backupId: entry.backupId,
          errorCode
        });
        return {
          status: 'failed',
          errorCode,
          message: `Store restore failed (${errorCode}).`
        };
      }
    }
  };
}
