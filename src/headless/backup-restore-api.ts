/**
 * FR-R7-03 (FR-001..FR-005, FR-008..FR-010) & FR-R7-11 — Zero-`vscode` headless API for
 * SQLite store backup, listing, read-only verification, and guarded full-authority restore.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * Audit entries go exclusively through `AuditLogWriter` with metadata-only payloads
 * and zero raw filesystem paths (docs/hard-rules.md rules 21 & 22).
 */

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, readSync } from 'node:fs';
import * as path from 'node:path';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { SanitizedLogger } from '../lib/logger';
import { openReadOnlyNoFollowSync } from '../lib/safe-open';
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
      readonly status: 'committed_refresh_failed';
      readonly errorCode: 'POST_COMMIT_REFRESH_FAILED';
      readonly restoredTableCount: number;
      readonly restoredRunCount: number;
      readonly schemaVersion: number;
      readonly message: string;
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
  readonly trustedRootDir: string | (() => string);
  readonly scopeId: string;
  readonly hasPrimacy: () => Promise<boolean>;
  readonly hasInFlightRun: () => boolean;
  readonly reloadAfterRestore: () => Promise<void> | void;
  readonly inspectExternalDependency?: ExternalDependencyInspector | undefined;
  readonly collectAuditLogDependencies?: (() => readonly BackupExternalDependency[]) | undefined;
  readonly auditWriter?: Pick<AuditLogWriter, 'append'> | undefined;
  readonly logger?: Pick<SanitizedLogger, 'warn'> | undefined;
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
const EXTERNAL_DEP_READ_CHUNK_BYTES = 64 * 1024;

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
 * Refuses path traversal, symlinks, non-regular files, and files exceeding the remaining byte budget
 * before reading past the budget ceiling.
 */
export function createWorkspaceExternalDependencyInspector(
  workspaceRoot: string
): ExternalDependencyInspector {
  const resolvedRoot = path.resolve(workspaceRoot);
  return (relativePath: string, options?: { readonly remainingBudgetBytes?: number | undefined }) => {
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

    const rawBudget = options?.remainingBudgetBytes;
    const boundedBudget =
      rawBudget !== undefined && Number.isFinite(rawBudget)
        ? Math.max(0, Math.floor(rawBudget))
        : MAX_BACKUP_EXTERNAL_DEPENDENCY_BYTES;
    const effectiveLimit = Math.min(boundedBudget, MAX_BACKUP_EXTERNAL_DEPENDENCY_BYTES);

    try {
      const st = lstatSync(target);
      if (st.isSymbolicLink() || !st.isFile()) {
        return { exists: false, byteLength: 0, sha256Digest: '' };
      }
      if (st.size > effectiveLimit) {
        return { exists: true, byteLength: st.size, sha256Digest: '', exceededByteBudget: true };
      }

      let fd: number | null = null;
      try {
        fd = openReadOnlyNoFollowSync(target);
        const preStat = fstatSync(fd);
        if (!preStat.isFile()) {
          return { exists: false, byteLength: 0, sha256Digest: '' };
        }
        if (preStat.size > effectiveLimit) {
          return {
            exists: true,
            byteLength: preStat.size,
            sha256Digest: '',
            exceededByteBudget: true
          };
        }
        const hash = createHash('sha256');
        let totalRead = 0;
        if (effectiveLimit > 0) {
          const chunk = Buffer.allocUnsafe(Math.min(EXTERNAL_DEP_READ_CHUNK_BYTES, effectiveLimit));
          while (totalRead < effectiveLimit) {
            const toRead = Math.min(chunk.byteLength, effectiveLimit - totalRead);
            const bytesRead = readSync(fd, chunk, 0, toRead, null);
            if (bytesRead === 0) break;
            hash.update(chunk.subarray(0, bytesRead));
            totalRead += bytesRead;
          }
        }
        const postStat = fstatSync(fd);
        if (!postStat.isFile()) {
          return { exists: false, byteLength: 0, sha256Digest: '' };
        }
        if (postStat.size > effectiveLimit) {
          return {
            exists: true,
            byteLength: postStat.size,
            sha256Digest: '',
            exceededByteBudget: true
          };
        }
        if (totalRead !== postStat.size) {
          return { exists: false, byteLength: 0, sha256Digest: '' };
        }
        return { exists: true, byteLength: totalRead, sha256Digest: hash.digest('hex') };
      } finally {
        if (fd !== null) {
          try {
            closeSync(fd);
          } catch {
            // Ignore close failure.
          }
        }
      }
    } catch {
      return { exists: false, byteLength: 0, sha256Digest: '' };
    }
  };
}

export function createStoreBackupRestoreApi(deps: StoreBackupRestoreApiDeps): StoreBackupRestoreApi {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const relativeBackupDirSegments = Object.freeze(['sqlite', deps.scopeId, 'backups'] as const);

  const resolveTrustedRootDir = (): string =>
    typeof deps.trustedRootDir === 'function' ? deps.trustedRootDir() : deps.trustedRootDir;

  const logNotWorkspaceOwner = (operation: 'backup' | 'restore', backupId: string): void => {
    deps.logger?.warn('store operation refused: not workspace owner', {
      operation,
      outcome: 'refused',
      backupId: sanitizeAuditBackupId(backupId),
      errorCode: 'NOT_WORKSPACE_OWNER'
    });
  };

  const hasWorkspaceOwnership = async (): Promise<boolean> => {
    try {
      return await deps.hasPrimacy();
    } catch {
      return false;
    }
  };

  const appendAudit = async (
    eventType: 'store-backup' | 'store-restore',
    payload: StoreBackupRestoreAuditPayload
  ): Promise<void> => {
    if (!deps.auditWriter) return;
    const cleanBackupId = sanitizeAuditBackupId(payload.backupId);
    const cleanPayload: Record<string, unknown> = {
      operation: payload.operation,
      outcome: payload.outcome,
      backupId: cleanBackupId
    };
    if (payload.errorCode !== undefined) cleanPayload.errorCode = payload.errorCode;
    if (payload.schemaVersion !== undefined) cleanPayload.schemaVersion = payload.schemaVersion;
    if (payload.databaseBytes !== undefined) cleanPayload.databaseBytes = payload.databaseBytes;
    if (payload.restoredTableCount !== undefined) {
      cleanPayload.restoredTableCount = payload.restoredTableCount;
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
    } catch (err) {
      // Never fail a completed store operation because of a secondary audit sink error,
      // and never leak raw paths or raw errors.
      const reasonCode =
        err instanceof Error && 'reasonCode' in err && typeof err.reasonCode === 'string'
          ? err.reasonCode
          : err instanceof Error
            ? err.name
            : 'audit-append-failed';
      deps.logger?.warn('store operation audit append failed', {
        operation: payload.operation,
        outcome: payload.outcome,
        backupId: cleanBackupId,
        reasonCode
      });
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
    listBackupsInRoot(resolveTrustedRootDir(), relativeBackupDirSegments);

  return {
    async createBackup(options): Promise<CreateStoreBackupResult> {
      const backupId = options?.backupId ?? generateBackupId(nowMs());
      if (!(await hasWorkspaceOwnership())) {
        logNotWorkspaceOwner('backup', backupId);
        return {
          status: 'refused',
          reasonCode: 'NOT_WORKSPACE_OWNER',
          message: 'Another window holds the workspace ownership fence; backup refused.'
        };
      }

      let failureFallback: 'STORE_OPEN_FAILED' | 'BACKUP_FAILED' = 'STORE_OPEN_FAILED';
      try {
        const store = await resolvePrimaryStore();
        if (!(await hasWorkspaceOwnership())) {
          logNotWorkspaceOwner('backup', backupId);
          return {
            status: 'refused',
            reasonCode: 'NOT_WORKSPACE_OWNER',
            message: 'Workspace ownership fence was lost before backup; backup refused.'
          };
        }
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

        failureFallback = 'BACKUP_FAILED';
        const trustedRootDir = resolveTrustedRootDir();
        const auditLogDependencies = deps.collectAuditLogDependencies?.() ?? [];
        const created = await store.backupRestore.createOnlineBackup({
          backupId,
          scopeId: deps.scopeId,
          trustedRootDir,
          relativeBackupDirSegments,
          auditLogDependencies,
          writeManifestFile: true
        });
        await appendAudit('store-backup', {
          operation: 'backup',
          outcome: 'succeeded',
          backupId: created.manifest.backupId,
          schemaVersion: created.manifest.schemaVersion,
          databaseBytes: created.manifest.databaseBytes
        });
        return {
          status: 'created',
          backupId: created.manifest.backupId,
          backupDatabasePath: created.backupDatabasePath,
          manifestPath: created.manifestPath,
          manifest: created.manifest
        };
      } catch (err) {
        const errorCode = extractClosedErrorCode(err, failureFallback);
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
      const trustedRootDir = resolveTrustedRootDir();
      const entries = await listBackupsInRoot(trustedRootDir, relativeBackupDirSegments);
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
        trustedRootDir,
        maxSupportedSchemaVersion: options?.maxSupportedSchemaVersion,
        maxExternalDependencies: options?.maxExternalDependencies,
        maxExternalDependencyBytes: options?.maxExternalDependencyBytes,
        inspectExternalDependency: deps.inspectExternalDependency,
        simulateQuickCheckFailure: options?.simulateQuickCheckFailure
      });
    },

    async restoreBackup(backupId, options): Promise<GuardedRestoreResult> {
      if (!(await hasWorkspaceOwnership())) {
        logNotWorkspaceOwner('restore', backupId);
        return {
          status: 'refused',
          reasonCode: 'NOT_WORKSPACE_OWNER',
          message: 'Another window holds the workspace ownership fence; restore refused.'
        };
      }

      let auditBackupId = backupId;
      let failureFallback: 'STORE_OPEN_FAILED' | 'RESTORE_FAILED' = 'RESTORE_FAILED';
      let committedOutcome: Extract<RestoreValidationOutcome, { readonly status: 'restored' }>;
      let committedDatabaseBytes: number;

      try {
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

        failureFallback = 'STORE_OPEN_FAILED';
        const store = await resolvePrimaryStore();
        failureFallback = 'RESTORE_FAILED';
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

        const trustedRootDir = resolveTrustedRootDir();
        const entries = await listBackupsInRoot(trustedRootDir, relativeBackupDirSegments);
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
        auditBackupId = entry.backupId;

        // Re-check ownership fence and in-flight Runs immediately before opening the write transaction.
        if (!(await hasWorkspaceOwnership())) {
          logNotWorkspaceOwner('restore', entry.backupId);
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

        const outcome = store.backupRestore.validateAndRestoreBackup({
          backupDatabasePath: entry.backupDatabasePath,
          manifest: entry.manifest,
          trustedRootDir,
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

        committedOutcome = outcome;
        committedDatabaseBytes = entry.databaseBytes;
      } catch (err) {
        const errorCode = extractClosedErrorCode(err, failureFallback);
        await appendAudit('store-restore', {
          operation: 'restore',
          outcome: 'failed',
          backupId: auditBackupId,
          errorCode
        });
        return {
          status: 'failed',
          errorCode,
          message: `Store restore failed (${errorCode}).`
        };
      }

      // Post-commit cache/catalog refresh: SQLite restore is already committed on disk.
      try {
        await deps.reloadAfterRestore();
      } catch {
        const errorCode = 'POST_COMMIT_REFRESH_FAILED' as const;
        await appendAudit('store-restore', {
          operation: 'restore',
          outcome: 'failed',
          backupId: auditBackupId,
          errorCode,
          schemaVersion: committedOutcome.schemaVersion,
          databaseBytes: committedDatabaseBytes,
          restoredTableCount: committedOutcome.restoredTableCount
        });
        return {
          status: 'committed_refresh_failed',
          errorCode,
          restoredTableCount: committedOutcome.restoredTableCount,
          restoredRunCount: committedOutcome.restoredRunCount,
          schemaVersion: committedOutcome.schemaVersion,
          message:
            'Restore committed on disk, but post-commit cache/catalog refresh failed (POST_COMMIT_REFRESH_FAILED). Reload the window to synchronize in-memory state.'
        };
      }

      await appendAudit('store-restore', {
        operation: 'restore',
        outcome: 'succeeded',
        backupId: auditBackupId,
        schemaVersion: committedOutcome.schemaVersion,
        databaseBytes: committedDatabaseBytes,
        restoredTableCount: committedOutcome.restoredTableCount
      });
      return committedOutcome;
    }
  };
}
