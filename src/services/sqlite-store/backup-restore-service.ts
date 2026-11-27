/**
 * FR-R6-F04 (F04-A, FR-009, SC-009), FR-R7-03 (FR-001, FR-002, FR-005, FR-009, FR-010) &
 * FR-R7-14 (14-01, 14-02, 14-03) —
 * Consistent online backup in `WAL` mode, lifecycle-aware external dependency collection,
 * symmetric creation/verification bounds with full rollback cleanup, async chunked SHA-256
 * verification, and SQLite-native `ATTACH` + `INSERT INTO ... SELECT` atomic restore with
 * pre-commit ownership fencing.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * File creation through safe-open (docs/hard-rules.md rule 69).
 */

import { randomUUID } from 'node:crypto';
import { link, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import {
  MAX_BACKUP_EXTERNAL_DEPENDENCIES,
  SQLITE_SCHEMA_CURRENT_VERSION,
  type BackupDependencyManifest,
  type BackupExternalDependency,
  type BackupRestoreRejectionCode,
  type StorageAuthority
} from '../../contracts/sqlite-store/schema-types';
import { narrowMode } from '../../lib/narrow-mode';
import {
  ensureAnchorWithinRoot,
  judgeLeafRedirect,
  openWithinRoot,
  platformLacksNoFollow
} from '../../lib/safe-open';
import {
  AUTHORITATIVE_RESTORE_TABLES,
  SCHEMA_CONTROL_TABLES,
  type AuthoritativeRestoreTableName
} from './authoritative-restore-tables';
import {
  boundedVerificationLimit,
  collectExternalDependenciesFromConn,
  externalDependencyKey,
  hasTableInConn,
  resolveBackupBounds,
  serializeManifestJson,
  validateExternalDependenciesBounds,
  verifyExternalDependenciesAsync,
  verifyExternalDependenciesSync,
  type BackupBoundsOverrides,
  type ExternalDependencyInspector,
  type ResolvedBackupBounds
} from './backup-dependency-collector';
import {
  assertPathAndSidecarsAbsent,
  computeFileDigestSync,
  fingerprintsMatch,
  manifestFileNameFor,
  SAFE_BACKUP_FILENAME_PATTERN,
  SAFE_BACKUP_ID_PATTERN,
  SQLITE_SIDECAR_SUFFIXES,
  statFileFingerprintSync,
  validateBackupPathBeforeOpen,
  type FileStatFingerprint
} from './backup-manifest-store';
import {
  computeFileDigestAsync,
  executeAttachedRestoreAsync,
  executeAttachedRestoreSync,
  getMainTableColumns,
  yieldToEventLoop,
  type RestoreFenceCallbacks,
  type RestoreValidationOutcome,
  type SyncRestoreFenceCallbacks,
  type ValidatedBackupImage,
  type ValidatedBackupTableMeta
} from './backup-restore-executor';
import { parseStrictSchemaMetaVersion } from './operational-entity-schema';
import { BUILTIN_SCHEMA_MIGRATIONS, SchemaBootstrapService } from './schema-bootstrap';
import { NodeSqliteConnection } from './sqlite-driver';

export type { ListedBackupEntry } from './backup-manifest-store';
export {
  listBackupsInRoot,
  manifestFileNameFor,
  parseAndValidateBackupManifest
} from './backup-manifest-store';
export type {
  ArtifactDependencyDisposition,
  BackupBoundsOverrides,
  BackupCreationBounds,
  ClassifiedExternalDependency,
  ExternalDependencyInspectOptions,
  ExternalDependencyInspector,
  ExternalDependencyState,
  ResolvedBackupBounds
} from './backup-dependency-collector';
export {
  classifyArtifactAvailabilityDisposition,
  classifyExternalArtifactDependencies,
  collectExternalDependenciesFromConn,
  DEFAULT_BACKUP_CREATION_BOUNDS,
  resolveBackupBounds
} from './backup-dependency-collector';
export type {
  RestoreFenceCallbacks,
  RestoreOutcomeKind,
  RestoredOperationalCounts,
  RestoreValidationOutcome,
  SyncRestoreFenceCallbacks
} from './backup-restore-executor';
export { computeFileDigestAsync } from './backup-restore-executor';

export interface CreateOnlineBackupRequest extends BackupBoundsOverrides {
  readonly backupId: string;
  readonly scopeId: string;
  readonly trustedRootDir: string;
  readonly relativeBackupDirSegments: readonly string[];
  readonly backupFileName?: string | undefined;
  readonly auditLogDependencies?: readonly BackupExternalDependency[] | undefined;
  /** Persist companion `<backupFileName>.manifest.json` (`0o600`). Defaults to `true`. */
  readonly writeManifestFile?: boolean | undefined;
}

export interface VerifyBackupRequest extends BackupBoundsOverrides {
  readonly backupDatabasePath: string;
  readonly manifest: BackupDependencyManifest;
  readonly trustedRootDir?: string | undefined;
  readonly maxSupportedSchemaVersion?: number | undefined;
  readonly inspectExternalDependency?: ExternalDependencyInspector | undefined;
  /** Optional test hook to simulate quick_check failure on backup image. */
  readonly simulateQuickCheckFailure?: boolean | undefined;
}

export interface ValidateAndRestoreRequest extends VerifyBackupRequest {
  readonly fences?: SyncRestoreFenceCallbacks | undefined;
}

export interface ValidateAndRestoreAsyncRequest extends VerifyBackupRequest {
  readonly fences?: RestoreFenceCallbacks | undefined;
}

export type VerifyBackupOutcome =
  | {
      readonly status: 'verified';
      readonly backupId: string;
      readonly schemaVersion: number;
      readonly databaseBytes: number;
      readonly databaseSha256: string;
      readonly verifiedExternalDependencies: number;
      readonly authoritativeTableCount: number;
    }
  | {
      readonly status: 'rejected';
      readonly reasonCode: BackupRestoreRejectionCode;
      readonly message: string;
    };

function validateBackupSchema(
  backupConn: NodeSqliteConnection,
  schemaVersion: number,
  backupTables: ReadonlySet<string>
): string | undefined {
  const migrations = BUILTIN_SCHEMA_MIGRATIONS.filter(
    (migration) => migration.version <= schemaVersion
  );
  const expected = new NodeSqliteConnection({ databasePath: ':memory:' });
  try {
    SchemaBootstrapService.bootstrapAndMigrate(expected, () => 0, migrations);
    for (const table of [...SCHEMA_CONTROL_TABLES, ...AUTHORITATIVE_RESTORE_TABLES]) {
      if (!hasTableInConn(expected, table)) continue;
      if (!backupTables.has(table)) {
        return `Backup schema v${schemaVersion} is missing table '${table}'`;
      }
      const backupColumns = new Set(getMainTableColumns(backupConn, table));
      for (const column of getMainTableColumns(expected, table)) {
        if (!backupColumns.has(column)) {
          return `Backup schema v${schemaVersion} is missing column '${table}.${column}'`;
        }
      }
    }
    const applied = backupConn.all<{ version: number; checksum_sha256: string }>(
      'SELECT version, checksum_sha256 FROM schema_migrations ORDER BY version LIMIT ?',
      migrations.length + 1
    );
    if (
      applied.length !== migrations.length ||
      migrations.some(
        (migration, i) =>
          applied[i]?.version !== migration.version ||
          applied[i]?.checksum_sha256 !== SchemaBootstrapService.computeMigrationChecksum(migration)
      )
    ) {
      return `Backup schema v${schemaVersion} has an inconsistent migration ledger`;
    }
    return undefined;
  } finally {
    expected.close();
  }
}

function runValidationPreflight(
  request: VerifyBackupRequest
):
  | {
      readonly ok: true;
      readonly bounds: ResolvedBackupBounds;
      readonly maxSchemaVersion: number;
      readonly resolvedPath: string;
    }
  | { readonly ok: false; readonly reasonCode: BackupRestoreRejectionCode; readonly message: string } {
  const maxSchemaVersion = boundedVerificationLimit(
    request.maxSupportedSchemaVersion,
    SQLITE_SCHEMA_CURRENT_VERSION
  );
  const bounds = resolveBackupBounds(request);

  if (
    !Number.isSafeInteger(request.manifest.schemaVersion) ||
    request.manifest.schemaVersion < 1 ||
    request.manifest.schemaVersion > maxSchemaVersion
  ) {
    return {
      ok: false,
      reasonCode: 'UNSUPPORTED_SCHEMA_VERSION',
      message: `Backup manifest schemaVersion is invalid or exceeds supported maximum ${maxSchemaVersion}`
    };
  }
  if (
    !Number.isSafeInteger(request.manifest.databaseBytes) ||
    request.manifest.databaseBytes <= 0 ||
    request.manifest.databaseBytes > bounds.maxDatabaseBytes
  ) {
    return {
      ok: false,
      reasonCode: 'RESTORE_IMAGE_BOUND_EXCEEDED',
      message: `Backup manifest databaseBytes (${request.manifest.databaseBytes}) exceeds maximum limit (${bounds.maxDatabaseBytes} bytes)`
    };
  }

  const validatedPath = validateBackupPathBeforeOpen(
    request.backupDatabasePath,
    request.trustedRootDir,
    bounds.maxDatabaseBytes,
    bounds.maxManifestBytes
  );
  if (!validatedPath.ok) {
    return {
      ok: false,
      reasonCode: validatedPath.reasonCode ?? 'BACKUP_OPEN_FAILED',
      message: validatedPath.error
    };
  }

  const depBounds = validateExternalDependenciesBounds(
    request.manifest.externalDependencies,
    bounds
  );
  if (!depBounds.ok) {
    return { ok: false, reasonCode: depBounds.reasonCode, message: depBounds.message };
  }

  const manifestByteLength =
    validatedPath.companionManifestBytes !== undefined
      ? Math.max(
          validatedPath.companionManifestBytes,
          Buffer.byteLength(JSON.stringify(request.manifest), 'utf8')
        )
      : Buffer.byteLength(serializeManifestJson(request.manifest), 'utf8');
  if (manifestByteLength > bounds.maxManifestBytes) {
    return {
      ok: false,
      reasonCode: 'BACKUP_MANIFEST_BOUND_EXCEEDED',
      message: `Backup manifest size (${manifestByteLength} bytes) exceeds maximum limit (${bounds.maxManifestBytes} bytes)`
    };
  }

  return { ok: true, bounds, maxSchemaVersion, resolvedPath: validatedPath.resolvedPath };
}

function validateOpenedSqliteBackup(
  request: VerifyBackupRequest,
  bounds: ResolvedBackupBounds,
  maxSchemaVersion: number,
  resolvedPath: string,
  fileBytes: number,
  fileSha256: string,
  verifiedExternalDependencies: number,
  fingerprint: FileStatFingerprint | null
): ValidatedBackupImage {
  let backupConn: NodeSqliteConnection;
  try {
    backupConn = new NodeSqliteConnection({ databasePath: resolvedPath, readOnly: true });
  } catch {
    return {
      ok: false,
      reasonCode: 'BACKUP_OPEN_FAILED',
      message: 'Backup database could not be opened in read-only mode'
    };
  }

  try {
    backupConn.exec('BEGIN');
    try {
      const quickCheckResults = request.simulateQuickCheckFailure
        ? ['*** in database main ***\ncorrupt page 2']
        : backupConn.runQuickCheck();
      if (quickCheckResults.length !== 1 || quickCheckResults[0] !== 'ok') {
        return {
          ok: false,
          reasonCode: 'QUICK_CHECK_FAILED',
          message: `Backup failed PRAGMA quick_check: ${quickCheckResults.join('; ')}`
        };
      }

      const fkViolations = backupConn.runForeignKeyCheck();
      if (fkViolations.length > 0) {
        return {
          ok: false,
          reasonCode: 'FOREIGN_KEY_CHECK_FAILED',
          message: `Backup failed PRAGMA foreign_key_check with ${fkViolations.length} violation(s)`
        };
      }

      if (!hasTableInConn(backupConn, 'schema_meta') || !hasTableInConn(backupConn, 'runs')) {
        return {
          ok: false,
          reasonCode: 'BACKUP_OPEN_FAILED',
          message: 'Backup database is missing required schema_meta or runs tables'
        };
      }

      const minReaderRow = backupConn.get<{ meta_value: string }>(
        `SELECT meta_value FROM schema_meta WHERE meta_key = 'min_reader_version'`
      );
      const dbVersionRow = backupConn.get<{ meta_value: string }>(
        `SELECT meta_value FROM schema_meta WHERE meta_key = 'schema_version'`
      );
      const parsedDbVersion =
        dbVersionRow === undefined ? null : parseStrictSchemaMetaVersion(dbVersionRow.meta_value);
      if (parsedDbVersion === null || parsedDbVersion > maxSchemaVersion) {
        return {
          ok: false,
          reasonCode: 'UNSUPPORTED_SCHEMA_VERSION',
          message: `Backup database schema_version is invalid or exceeds supported max=${maxSchemaVersion}`
        };
      }
      if (parsedDbVersion !== request.manifest.schemaVersion) {
        return {
          ok: false,
          reasonCode: 'DATABASE_DIGEST_MISMATCH',
          message: 'Backup database schema_version does not match manifest'
        };
      }

      const requiredReaderFloor = BUILTIN_SCHEMA_MIGRATIONS.reduce(
        (floor, migration) =>
          migration.version <= parsedDbVersion
            ? Math.max(floor, migration.minReaderVersion ?? 1)
            : floor,
        1
      );
      const minReaderVersion =
        minReaderRow === undefined ? 1 : parseStrictSchemaMetaVersion(minReaderRow.meta_value);
      if (
        minReaderVersion === null ||
        minReaderVersion < requiredReaderFloor ||
        minReaderVersion > maxSchemaVersion
      ) {
        return {
          ok: false,
          reasonCode: 'UNSUPPORTED_SCHEMA_VERSION',
          message: `Backup database min_reader_version is invalid for schema v${parsedDbVersion} or exceeds supported max=${maxSchemaVersion}`
        };
      }

      const backupTables = new Set(
        backupConn
          .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
          .map(({ name }) => name)
      );
      const schemaError = validateBackupSchema(backupConn, parsedDbVersion, backupTables);
      if (schemaError !== undefined) {
        return { ok: false, reasonCode: 'BACKUP_OPEN_FAILED', message: schemaError };
      }

      const hasQueueMeta = backupTables.has('operational_queue_meta');
      const hasTasks = backupTables.has('operational_tasks');
      const hasOperationalRuns = backupTables.has('operational_runs');
      const backupHasAllEntityTables = hasQueueMeta && hasTasks && hasOperationalRuns;
      const backupHasAnyEntityTable = hasQueueMeta || hasTasks || hasOperationalRuns;
      if (
        (parsedDbVersion >= 9 && !backupHasAllEntityTables) ||
        (backupHasAnyEntityTable && !backupHasAllEntityTables)
      ) {
        return {
          ok: false,
          reasonCode: 'BACKUP_OPEN_FAILED',
          message: 'Backup database has an incomplete schema-9 per-entity table set'
        };
      }

      const indexedDependencies = collectExternalDependenciesFromConn(
        backupConn,
        [],
        bounds.maxExternalDependencies + 1
      );
      const indexedBounds = validateExternalDependenciesBounds(indexedDependencies, bounds);
      if (!indexedBounds.ok) {
        return { ok: false, reasonCode: indexedBounds.reasonCode, message: indexedBounds.message };
      }
      const declaredDependencyKeys = new Set(
        request.manifest.externalDependencies.map(externalDependencyKey)
      );
      if (indexedDependencies.some((dep) => !declaredDependencyKeys.has(externalDependencyKey(dep)))) {
        return {
          ok: false,
          reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT',
          message:
            'Backup manifest is missing a dependency recorded in the database or its metadata differs'
        };
      }

      const tables = new Map<AuthoritativeRestoreTableName, ValidatedBackupTableMeta>();
      for (const table of AUTHORITATIVE_RESTORE_TABLES) {
        if (!backupTables.has(table)) continue;
        tables.set(table, { table, columns: getMainTableColumns(backupConn, table) });
      }

      const postFingerprint = statFileFingerprintSync(resolvedPath);
      if (
        postFingerprint === null ||
        (fingerprint !== null && !fingerprintsMatch(fingerprint, postFingerprint))
      ) {
        return {
          ok: false,
          reasonCode: 'DATABASE_DIGEST_MISMATCH',
          message: 'Backup database file changed during validation; restore aborted'
        };
      }

      return {
        ok: true,
        resolvedPath,
        trustedRootDir: request.trustedRootDir,
        bounds,
        dbSchemaVersion: parsedDbVersion,
        fileBytes,
        fileSha256,
        verifiedExternalDependencies,
        tables,
        backupHasAllEntityTables,
        fingerprint: postFingerprint
      };
    } finally {
      try {
        backupConn.exec('COMMIT');
      } catch {
        // Ignore read-transaction close error.
      }
    }
  } catch {
    return {
      ok: false,
      reasonCode: 'BACKUP_OPEN_FAILED',
      message: 'Backup database structure is invalid or unreadable'
    };
  } finally {
    backupConn.close();
  }
}

function validateBackupImageReadOnly(request: VerifyBackupRequest): ValidatedBackupImage {
  const preflight = runValidationPreflight(request);
  if (!preflight.ok) return preflight;
  const { bounds, maxSchemaVersion, resolvedPath } = preflight;

  const preFingerprint = statFileFingerprintSync(resolvedPath);
  const fileDigest = computeFileDigestSync(resolvedPath, bounds.maxDatabaseBytes);
  if (!fileDigest.ok) {
    return {
      ok: false,
      reasonCode: fileDigest.reasonCode ?? 'BACKUP_OPEN_FAILED',
      message: fileDigest.error
    };
  }
  if (
    fileDigest.byteLength !== request.manifest.databaseBytes ||
    fileDigest.sha256 !== request.manifest.databaseSha256
  ) {
    return {
      ok: false,
      reasonCode: 'DATABASE_DIGEST_MISMATCH',
      message: 'Backup database file SHA-256 digest or byte size does not match manifest'
    };
  }

  const depCheck = verifyExternalDependenciesSync(
    request.manifest.externalDependencies,
    request.inspectExternalDependency,
    bounds.maxExternalDependencyBytes
  );
  if (!depCheck.ok) return depCheck;

  return validateOpenedSqliteBackup(
    request,
    bounds,
    maxSchemaVersion,
    resolvedPath,
    fileDigest.byteLength,
    fileDigest.sha256,
    depCheck.verifiedCount,
    preFingerprint
  );
}

async function validateBackupImageReadOnlyAsync(
  request: VerifyBackupRequest
): Promise<ValidatedBackupImage> {
  const preflight = runValidationPreflight(request);
  if (!preflight.ok) return preflight;
  const { bounds, maxSchemaVersion, resolvedPath } = preflight;

  const fileDigest = await computeFileDigestAsync(
    resolvedPath,
    bounds.maxDatabaseBytes,
    request.trustedRootDir
  );
  if (!fileDigest.ok) {
    return {
      ok: false,
      reasonCode: fileDigest.reasonCode ?? 'BACKUP_OPEN_FAILED',
      message: fileDigest.error
    };
  }
  if (
    fileDigest.byteLength !== request.manifest.databaseBytes ||
    fileDigest.sha256 !== request.manifest.databaseSha256
  ) {
    return {
      ok: false,
      reasonCode: 'DATABASE_DIGEST_MISMATCH',
      message: 'Backup database file SHA-256 digest or byte size does not match manifest'
    };
  }

  const depCheck = await verifyExternalDependenciesAsync(
    request.manifest.externalDependencies,
    request.inspectExternalDependency,
    bounds.maxExternalDependencyBytes
  );
  if (!depCheck.ok) return depCheck;

  await yieldToEventLoop();
  const validated = validateOpenedSqliteBackup(
    request,
    bounds,
    maxSchemaVersion,
    resolvedPath,
    fileDigest.byteLength,
    fileDigest.sha256,
    depCheck.verifiedCount,
    fileDigest.fingerprint
  );
  await yieldToEventLoop();
  return validated;
}

async function cleanupPartialBackupFiles(
  backupDatabasePath: string,
  manifestPath?: string,
  tempPath?: string
): Promise<void> {
  const candidates: string[] = [];
  if (tempPath !== undefined) candidates.push(tempPath);
  if (manifestPath !== undefined) candidates.push(manifestPath);
  candidates.push(backupDatabasePath);
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    candidates.push(`${backupDatabasePath}${suffix}`);
  }
  for (const candidate of candidates) {
    await unlink(candidate).catch(() => undefined);
  }
}

function toVerifyOutcome(backupId: string, validated: ValidatedBackupImage): VerifyBackupOutcome {
  if (!validated.ok) {
    return { status: 'rejected', reasonCode: validated.reasonCode, message: validated.message };
  }
  return {
    status: 'verified',
    backupId,
    schemaVersion: validated.dbSchemaVersion,
    databaseBytes: validated.fileBytes,
    databaseSha256: validated.fileSha256,
    verifiedExternalDependencies: validated.verifiedExternalDependencies,
    authoritativeTableCount: validated.tables.size
  };
}

/**
 * Verifies a backup image and its manifest synchronously in read-only isolation without
 * requiring an open target database connection (usable both online and during offline rollback).
 */
export function verifyBackupStandalone(request: VerifyBackupRequest): VerifyBackupOutcome {
  return toVerifyOutcome(request.manifest.backupId, validateBackupImageReadOnly(request));
}

/**
 * Verifies a backup image and its manifest asynchronously in read-only isolation using
 * chunked SHA-256 hashing and event-loop yields so large backups never stall timers.
 */
export async function verifyBackupStandaloneAsync(
  request: VerifyBackupRequest
): Promise<VerifyBackupOutcome> {
  return toVerifyOutcome(request.manifest.backupId, await validateBackupImageReadOnlyAsync(request));
}

export class BackupRestoreService {
  private readonly conn: NodeSqliteConnection;
  private readonly nowMs: () => number;

  public constructor(conn: NodeSqliteConnection, nowMs: () => number = () => Date.now()) {
    this.conn = conn;
    this.nowMs = nowMs;
  }

  /**
   * Collects required-live external artifact (`cas_blob` / `workspace_file`) and `log_segments`
   * dependencies from the relational index while excluding lifecycle-deleted/expired and
   * fallback-evicted tombstones so deletion history survives backup, verify, and restore.
   */
  public collectExternalDependencies(
    auditLogDependencies: readonly BackupExternalDependency[] = [],
    limit = MAX_BACKUP_EXTERNAL_DEPENDENCIES + 1
  ): readonly BackupExternalDependency[] {
    return collectExternalDependenciesFromConn(this.conn, auditLogDependencies, limit);
  }

  /**
   * Produces a consistent online backup using SQLite's `VACUUM INTO` while the
   * store is active in `WAL` mode, enforcing symmetric verification bounds pre-flight
   * and post-snapshot, computing async chunked SHA-256, persisting the companion manifest
   * (`0600`), and unlinking all partial artifacts on any creation failure.
   */
  public async createOnlineBackup(
    request: CreateOnlineBackupRequest
  ): Promise<{
    readonly backupDatabasePath: string;
    readonly manifestPath: string;
    readonly manifest: BackupDependencyManifest;
  }> {
    if (!path.isAbsolute(request.trustedRootDir) || request.trustedRootDir.includes('\0')) {
      throw new Error('BACKUP_PATH_REFUSED: trustedRootDir must be an absolute path');
    }
    if (!SAFE_BACKUP_ID_PATTERN.test(request.backupId) || request.backupId.includes('..')) {
      throw new Error('INVALID_BACKUP_ID: backupId must match [A-Za-z0-9._-] without ".."');
    }

    const fileName = request.backupFileName ?? `${request.backupId}.db`;
    if (
      !SAFE_BACKUP_FILENAME_PATTERN.test(fileName) ||
      fileName.includes('/') ||
      fileName.includes('\\') ||
      fileName.includes('..') ||
      fileName.includes('\0')
    ) {
      throw new Error(
        'INVALID_BACKUP_FILENAME: backup filename must be a plain *.db or *.sqlite leaf name'
      );
    }

    const bounds = resolveBackupBounds(request);
    const preflightDeps = collectExternalDependenciesFromConn(
      this.conn,
      request.auditLogDependencies,
      bounds.maxExternalDependencies + 1
    );
    const preflightBounds = validateExternalDependenciesBounds(preflightDeps, bounds);
    if (!preflightBounds.ok) {
      throw new Error(`${preflightBounds.reasonCode}: ${preflightBounds.message}`);
    }

    const anchorRes = await ensureAnchorWithinRoot(
      request.trustedRootDir,
      request.relativeBackupDirSegments,
      0o700
    );
    if (anchorRes.outcome === 'refused') {
      throw new Error(`BACKUP_PATH_REFUSED: ${anchorRes.reason}`);
    }

    const dirNarrow = await narrowMode(anchorRes.anchor, 0o700);
    if (dirNarrow.outcome === 'refused-symlink') {
      throw new Error('BACKUP_PATH_REFUSED: backup directory is a symlink');
    }
    if (process.platform !== 'win32' && dirNarrow.outcome === 'unsupported') {
      throw new Error(
        `BACKUP_MODE_NARROWING_FAILED: directory mode narrowing failed (${dirNarrow.code})`
      );
    }

    const backupDatabasePath = path.join(anchorRes.anchor, fileName);
    const manifestFileName = manifestFileNameFor(fileName);
    const manifestPath = path.join(anchorRes.anchor, manifestFileName);
    const writeManifestFile = request.writeManifestFile ?? true;

    const leafJudgement = await judgeLeafRedirect(
      backupDatabasePath,
      ['ENOENT'],
      platformLacksNoFollow()
    );
    if (leafJudgement.outcome === 'refused') {
      throw new Error(`BACKUP_PATH_REFUSED: ${leafJudgement.reason}`);
    }
    assertPathAndSidecarsAbsent(
      backupDatabasePath,
      true,
      writeManifestFile ? manifestPath : undefined
    );

    const destination = await openWithinRoot(
      request.trustedRootDir,
      [...request.relativeBackupDirSegments, fileName],
      { flags: 'wx', createDirs: false, fileMode: 0o600 }
    );
    if (destination.outcome === 'refused') {
      throw new Error(`BACKUP_PATH_REFUSED: ${destination.reason}`);
    }

    let activeTempPath: string | undefined;
    try {
      await destination.handle.close();
      assertPathAndSidecarsAbsent(backupDatabasePath, false);
      this.conn.run('VACUUM INTO ?', backupDatabasePath);

      const fileNarrow = await narrowMode(backupDatabasePath, 0o600);
      if (fileNarrow.outcome === 'refused-symlink') {
        throw new Error('BACKUP_PATH_REFUSED: backup output resolved to a symlink');
      }
      if (process.platform !== 'win32' && fileNarrow.outcome === 'unsupported') {
        throw new Error(
          `BACKUP_MODE_NARROWING_FAILED: backup file mode narrowing failed (${fileNarrow.code})`
        );
      }
      assertPathAndSidecarsAbsent(backupDatabasePath, false);

      const runtimeMeta = this.conn.inspectRuntimeMetadata();
      const snapshotConn = new NodeSqliteConnection({
        databasePath: backupDatabasePath,
        readOnly: true
      });
      let schemaVersion: number;
      let cutoverAuthority: StorageAuthority;
      let externalDependencies: readonly BackupExternalDependency[];
      try {
        snapshotConn.exec('BEGIN');
        try {
          const schemaVersionRow = snapshotConn.get<{ meta_value: string }>(
            `SELECT meta_value FROM schema_meta WHERE meta_key = 'schema_version'`
          );
          const parsedSchemaVersion =
            schemaVersionRow !== undefined
              ? parseStrictSchemaMetaVersion(schemaVersionRow.meta_value)
              : null;
          if (parsedSchemaVersion === null) {
            throw new Error(
              'BACKUP_SCHEMA_VERSION_INVALID: snapshot records an unreadable schema_version'
            );
          }
          schemaVersion = parsedSchemaVersion;

          const sentinelRow = snapshotConn.get<{ authority: StorageAuthority }>(
            `SELECT authority FROM cutover_sentinel WHERE scope_id = ?`,
            request.scopeId
          );
          cutoverAuthority = sentinelRow?.authority ?? 'sqlite';
          externalDependencies = collectExternalDependenciesFromConn(
            snapshotConn,
            request.auditLogDependencies,
            bounds.maxExternalDependencies + 1
          );
        } finally {
          try {
            snapshotConn.exec('COMMIT');
          } catch {
            // Ignore read-transaction close error.
          }
        }
      } finally {
        snapshotConn.close();
      }

      const snapshotDepBounds = validateExternalDependenciesBounds(externalDependencies, bounds);
      if (!snapshotDepBounds.ok) {
        throw new Error(`${snapshotDepBounds.reasonCode}: ${snapshotDepBounds.message}`);
      }

      assertPathAndSidecarsAbsent(backupDatabasePath, false);
      const fileDigest = await computeFileDigestAsync(
        backupDatabasePath,
        bounds.maxDatabaseBytes,
        request.trustedRootDir
      );
      if (!fileDigest.ok) {
        const prefix =
          fileDigest.reasonCode === 'RESTORE_IMAGE_BOUND_EXCEEDED'
            ? 'RESTORE_IMAGE_BOUND_EXCEEDED'
            : 'BACKUP_DIGEST_FAILED';
        throw new Error(`${prefix}: ${fileDigest.error}`);
      }

      const manifest: BackupDependencyManifest = {
        backupId: request.backupId,
        createdAtMs: this.nowMs(),
        schemaVersion,
        sqliteVersion: runtimeMeta.sqliteVersion,
        databaseSha256: fileDigest.sha256,
        databaseBytes: fileDigest.byteLength,
        cutoverAuthority,
        externalDependencies
      };

      const manifestJson = serializeManifestJson(manifest);
      const manifestBytes = Buffer.byteLength(manifestJson, 'utf8');
      if (manifestBytes > bounds.maxManifestBytes) {
        throw new Error(
          `BACKUP_MANIFEST_BOUND_EXCEEDED: Backup manifest size (${manifestBytes} bytes) exceeds maximum limit (${bounds.maxManifestBytes} bytes)`
        );
      }

      if (writeManifestFile) {
        const tempName = `.${manifestFileName}.${randomUUID()}.tmp`;
        const tempPath = path.join(anchorRes.anchor, tempName);
        activeTempPath = tempPath;
        const opened = await openWithinRoot(
          request.trustedRootDir,
          [...request.relativeBackupDirSegments, tempName],
          { flags: 'wx', createDirs: false, fileMode: 0o600 }
        );
        if (opened.outcome === 'refused') {
          throw new Error(`BACKUP_MANIFEST_WRITE_REFUSED: ${opened.reason}`);
        }
        try {
          try {
            await opened.handle.writeFile(manifestJson, 'utf8');
            await opened.handle.sync();
          } finally {
            await opened.handle.close();
          }
          await link(tempPath, manifestPath);
        } catch {
          throw new Error('BACKUP_MANIFEST_WRITE_REFUSED: unable to publish backup manifest');
        } finally {
          await unlink(tempPath).catch(() => undefined);
          activeTempPath = undefined;
        }
      }

      return { backupDatabasePath, manifestPath, manifest };
    } catch (err) {
      await cleanupPartialBackupFiles(
        backupDatabasePath,
        writeManifestFile ? manifestPath : undefined,
        activeTempPath
      );
      throw err;
    }
  }

  public verifyBackup(request: VerifyBackupRequest): VerifyBackupOutcome {
    return verifyBackupStandalone(request);
  }

  public verifyBackupAsync(request: VerifyBackupRequest): Promise<VerifyBackupOutcome> {
    return verifyBackupStandaloneAsync(request);
  }

  public validateAndRestoreBackup(request: ValidateAndRestoreRequest): RestoreValidationOutcome {
    const validated = validateBackupImageReadOnly(request);
    if (!validated.ok) {
      return {
        status: 'rejected',
        outcome: 'refused_pre_commit',
        reasonCode: validated.reasonCode,
        message: validated.message
      };
    }
    return executeAttachedRestoreSync(this.conn, this.nowMs, validated, request.fences);
  }

  public async validateAndRestoreBackupAsync(
    request: ValidateAndRestoreAsyncRequest
  ): Promise<RestoreValidationOutcome> {
    const validated = await validateBackupImageReadOnlyAsync(request);
    if (!validated.ok) {
      return {
        status: 'rejected',
        outcome: 'refused_pre_commit',
        reasonCode: validated.reasonCode,
        message: validated.message
      };
    }
    return executeAttachedRestoreAsync(this.conn, this.nowMs, validated, request.fences);
  }
}
