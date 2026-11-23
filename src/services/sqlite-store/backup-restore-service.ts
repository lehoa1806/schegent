/**
 * FR-R6-F04 (F04-A, FR-009, SC-009) & FR-R7-03 (FR-001, FR-002, FR-005, FR-009, FR-010) —
 * Consistent online backup in `WAL` mode, file-byte SHA-256 `BackupDependencyManifest`
 * generation and persistence (`0700` dir / `0600` files), read-only listing and
 * verification, bounded external dependency checks, and full-authority atomic restore
 * across every table in `AUTHORITATIVE_RESTORE_TABLES`.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * File creation through safe-open (docs/hard-rules.md rule 69).
 */

import { randomUUID } from 'node:crypto';
import { link, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import {
  MAX_BACKUP_EXTERNAL_DEPENDENCIES,
  MAX_BACKUP_EXTERNAL_DEPENDENCY_BYTES,
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
  assertPathAndSidecarsAbsent,
  computeFileDigestSync,
  manifestFileNameFor,
  MAX_BACKUP_DATABASE_BYTES,
  SAFE_BACKUP_FILENAME_PATTERN,
  SAFE_BACKUP_ID_PATTERN,
  validateBackupPathBeforeOpen
} from './backup-manifest-store';
import {
  backfillOperationalEntitiesInTx,
  parseStrictSchemaMetaVersion
} from './operational-entity-schema';
import { BUILTIN_SCHEMA_MIGRATIONS, SchemaBootstrapService } from './schema-bootstrap';
import { NodeSqliteConnection } from './sqlite-driver';

const SAFE_SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const AUTHORITATIVE_TABLE_SET = new Set<string>(AUTHORITATIVE_RESTORE_TABLES);

interface CapturedTableData {
  readonly table: AuthoritativeRestoreTableName;
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
}

interface CapturedBackupSnapshot {
  readonly schemaVersion: number;
  readonly hasQueueMeta: boolean;
  readonly hasTasks: boolean;
  readonly hasOperationalRuns: boolean;
  readonly tables: ReadonlyMap<AuthoritativeRestoreTableName, CapturedTableData>;
  readonly sqliteSequence: ReadonlyArray<{ readonly name: string; readonly seq: number }>;
}

function assertSafeSqlIdentifier(identifier: string, label: string): string {
  if (!SAFE_SQL_IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`BACKUP_INVALID_SQL_IDENTIFIER: unsafe ${label}`);
  }
  return identifier;
}

function hasTableInConn(conn: NodeSqliteConnection, table: string): boolean {
  return (
    conn.get<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      table
    ) !== undefined
  );
}

function getTableColumns(conn: NodeSqliteConnection, table: string): readonly string[] {
  const safeTable = assertSafeSqlIdentifier(table, 'table');
  const cols = conn
    .all<{ name: string }>(`PRAGMA table_info("${safeTable}")`)
    .map((c) => assertSafeSqlIdentifier(c.name, 'column'));
  return cols;
}

function validateBackupSchema(
  backupConn: NodeSqliteConnection,
  schemaVersion: number,
  backupTables: ReadonlySet<string>
): string | undefined {
  const migrations = BUILTIN_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= schemaVersion);
  const expected = new NodeSqliteConnection({ databasePath: ':memory:' });
  try {
    SchemaBootstrapService.bootstrapAndMigrate(expected, () => 0, migrations);
    for (const table of [...SCHEMA_CONTROL_TABLES, ...AUTHORITATIVE_RESTORE_TABLES]) {
      if (!hasTableInConn(expected, table)) continue;
      if (!backupTables.has(table)) return `Backup schema v${schemaVersion} is missing table '${table}'`;
      const backupColumns = new Set(getTableColumns(backupConn, table));
      for (const column of getTableColumns(expected, table)) {
        if (!backupColumns.has(column)) {
          return `Backup schema v${schemaVersion} is missing column '${table}.${column}'`;
        }
      }
    }
    // An offline rollback reopens the entire image, including the bootstrap ledger.
    const applied = backupConn.all<{ version: number; checksum_sha256: string }>(
      'SELECT version, checksum_sha256 FROM schema_migrations ORDER BY version LIMIT ?',
      migrations.length + 1
    );
    if (applied.length !== migrations.length || migrations.some((migration, i) =>
      applied[i]?.version !== migration.version ||
      applied[i]?.checksum_sha256 !== SchemaBootstrapService.computeMigrationChecksum(migration)
    )) {
      return `Backup schema v${schemaVersion} has an inconsistent migration ledger`;
    }
    return undefined;
  } finally {
    expected.close();
  }
}

function readAllAuthoritativeTablesOnce(
  conn: NodeSqliteConnection,
  schemaVersion: number
): CapturedBackupSnapshot {
  const tables = new Map<AuthoritativeRestoreTableName, CapturedTableData>();
  for (const table of AUTHORITATIVE_RESTORE_TABLES) {
    if (!hasTableInConn(conn, table)) continue;
    const safeTable = assertSafeSqlIdentifier(table, 'table');
    const columns = getTableColumns(conn, safeTable);
    const rows = conn.all<Record<string, unknown>>(`SELECT * FROM "${safeTable}"`);
    tables.set(table, { table, columns, rows });
  }

  let sqliteSequence: Array<{ readonly name: string; readonly seq: number }> = [];
  if (hasTableInConn(conn, 'sqlite_sequence')) {
    sqliteSequence = conn
      .all<{ name: string; seq: number }>(`SELECT name, seq FROM sqlite_sequence`)
      .filter((row) => AUTHORITATIVE_TABLE_SET.has(row.name) && Number.isSafeInteger(row.seq));
  }

  return {
    schemaVersion,
    hasQueueMeta: tables.has('operational_queue_meta'),
    hasTasks: tables.has('operational_tasks'),
    hasOperationalRuns: tables.has('operational_runs'),
    tables,
    sqliteSequence
  };
}

function collectExternalDependenciesFromConn(
  conn: NodeSqliteConnection,
  auditLogDependencies: readonly BackupExternalDependency[] = [],
  limit = -1
): readonly BackupExternalDependency[] {
  const deps: BackupExternalDependency[] = [];

  if (hasTableInConn(conn, 'artifacts') && hasTableInConn(conn, 'artifact_locations')) {
    const artifactRows = conn.all<{
      artifact_id: string;
      content_sha256: string;
      byte_length: number;
      uri_or_relpath: string;
    }>(
      `SELECT a.artifact_id, a.content_sha256, a.byte_length, loc.uri_or_relpath
       FROM artifacts a
       INNER JOIN artifact_locations loc ON loc.artifact_id = a.artifact_id
       WHERE loc.storage_tier IN ('cas_blob', 'workspace_file')
       ORDER BY a.artifact_id ASC LIMIT ?`,
      limit
    );

    for (const row of artifactRows) {
      deps.push({
        dependencyKind: 'artifact_blob',
        referenceId: row.artifact_id,
        relativePath: row.uri_or_relpath,
        byteLength: row.byte_length,
        sha256Digest: row.content_sha256
      });
    }
  }

  if (hasTableInConn(conn, 'log_segments') && (limit < 0 || deps.length < limit)) {
    const segmentRows = conn.all<{
      segment_id: string;
      start_byte_offset: number;
      end_byte_offset: number;
      content_sha256: string;
      relative_path: string;
    }>(
      `SELECT segment_id, start_byte_offset, end_byte_offset, content_sha256, relative_path
       FROM log_segments ORDER BY segment_id ASC LIMIT ?`,
      limit < 0 ? limit : limit - deps.length
    );

    for (const seg of segmentRows) {
      deps.push({
        dependencyKind: 'log_segment',
        referenceId: seg.segment_id,
        relativePath: seg.relative_path,
        byteLength: Math.max(0, seg.end_byte_offset - seg.start_byte_offset),
        sha256Digest: seg.content_sha256
      });
    }
  }

  deps.push(...auditLogDependencies);
  return deps;
}

function externalDependencyKey(dep: BackupExternalDependency): string {
  return JSON.stringify([
    dep.dependencyKind, dep.referenceId, dep.relativePath, dep.byteLength, dep.sha256Digest
  ]);
}

export type { ListedBackupEntry } from './backup-manifest-store';
export {
  listBackupsInRoot,
  manifestFileNameFor,
  parseAndValidateBackupManifest
} from './backup-manifest-store';

export interface ExternalDependencyState {
  readonly exists: boolean;
  readonly byteLength: number;
  readonly sha256Digest: string;
  readonly exceededByteBudget?: boolean | undefined;
}

export interface ExternalDependencyInspectOptions {
  readonly remainingBudgetBytes?: number | undefined;
}

export type ExternalDependencyInspector = (
  relativePath: string,
  options?: ExternalDependencyInspectOptions
) => ExternalDependencyState | undefined;

export interface CreateOnlineBackupRequest {
  readonly backupId: string;
  readonly scopeId: string;
  readonly trustedRootDir: string;
  readonly relativeBackupDirSegments: readonly string[];
  readonly backupFileName?: string | undefined;
  readonly auditLogDependencies?: readonly BackupExternalDependency[] | undefined;
  /** Persist companion `<backupFileName>.manifest.json` (`0o600`). Defaults to `true`. */
  readonly writeManifestFile?: boolean | undefined;
}

export interface VerifyBackupRequest {
  readonly backupDatabasePath: string;
  readonly manifest: BackupDependencyManifest;
  readonly trustedRootDir?: string | undefined;
  readonly maxSupportedSchemaVersion?: number | undefined;
  readonly maxExternalDependencies?: number | undefined;
  readonly maxExternalDependencyBytes?: number | undefined;
  readonly inspectExternalDependency?: ExternalDependencyInspector | undefined;
  /** Optional test hook to simulate quick_check failure on backup image. */
  readonly simulateQuickCheckFailure?: boolean | undefined;
}

export type ValidateAndRestoreRequest = VerifyBackupRequest;

export interface RestoredOperationalCounts {
  readonly queueMetaCount: number;
  readonly taskCount: number;
  readonly operationalRunCount: number;
  readonly kvDocumentCount: number;
  readonly cutoverSentinelCount: number;
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

export type RestoreValidationOutcome =
  | {
      readonly status: 'restored';
      readonly restoredRunCount: number;
      readonly restoredTableCount: number;
      readonly restoredRowCount: number;
      readonly restoredOperational?: RestoredOperationalCounts | undefined;
      readonly verifiedExternalDependencies: number;
      readonly schemaVersion: number;
    }
  | {
      readonly status: 'rejected';
      readonly reasonCode: BackupRestoreRejectionCode;
      readonly message: string;
    };

type ValidatedBackupInternal =
  | {
      readonly ok: true;
      readonly dbSchemaVersion: number;
      readonly fileBytes: number;
      readonly fileSha256: string;
      readonly verifiedExternalDependencies: number;
      readonly snapshot: CapturedBackupSnapshot;
      readonly backupHasAllEntityTables: boolean;
    }
  | {
      readonly ok: false;
      readonly reasonCode: BackupRestoreRejectionCode;
      readonly message: string;
    };

function boundedVerificationLimit(requested: number | undefined, maximum: number): number {
  return requested === undefined || !Number.isFinite(requested)
    ? maximum
    : Math.max(0, Math.min(Math.floor(requested), maximum));
}

function validateBackupImageReadOnly(
  request: VerifyBackupRequest,
  captureRows: boolean
): ValidatedBackupInternal {
  const maxSchemaVersion = boundedVerificationLimit(
    request.maxSupportedSchemaVersion,
    SQLITE_SCHEMA_CURRENT_VERSION
  );
  const maxExternalDeps = boundedVerificationLimit(
    request.maxExternalDependencies,
    MAX_BACKUP_EXTERNAL_DEPENDENCIES
  );
  const maxExternalBytes = boundedVerificationLimit(
    request.maxExternalDependencyBytes,
    MAX_BACKUP_EXTERNAL_DEPENDENCY_BYTES
  );

  if (
    !Number.isSafeInteger(request.manifest.schemaVersion) ||
    request.manifest.schemaVersion < 1 ||
    request.manifest.schemaVersion > maxSchemaVersion
  ) {
    return {
      ok: false,
      reasonCode: 'UNSUPPORTED_SCHEMA_VERSION',
      message:
        `Backup manifest schemaVersion is invalid or exceeds supported maximum ${maxSchemaVersion}`
    };
  }

  const validatedPath = validateBackupPathBeforeOpen(
    request.backupDatabasePath,
    request.trustedRootDir
  );
  if (!validatedPath.ok) {
    return {
      ok: false,
      reasonCode: 'BACKUP_OPEN_FAILED',
      message: validatedPath.error
    };
  }

  // 1. Verify raw database file byte size and SHA-256 digest BEFORE opening SQLite (FR-002, SC-002).
  const fileDigest = computeFileDigestSync(validatedPath.resolvedPath, MAX_BACKUP_DATABASE_BYTES);
  if (!fileDigest.ok) {
    return {
      ok: false,
      reasonCode: 'BACKUP_OPEN_FAILED',
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

  // 2. Verify external dependencies with deterministic count & cumulative byte bounds (FR-009).
  const deps = request.manifest.externalDependencies;
  if (deps.length > maxExternalDeps) {
    return {
      ok: false,
      reasonCode: 'EXTERNAL_DEPENDENCY_BOUND_EXCEEDED',
      message: `Backup manifest declares ${deps.length} external dependencies, exceeding limit ${maxExternalDeps}`
    };
  }
  let declaredBytesTotal = 0;
  for (const dep of deps) {
    if (!Number.isSafeInteger(dep.byteLength) || dep.byteLength < 0) {
      return {
        ok: false,
        reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT',
        message: `External dependency '${dep.referenceId}' has an invalid byteLength`
      };
    }
    declaredBytesTotal += dep.byteLength;
    if (declaredBytesTotal > maxExternalBytes) {
      return {
        ok: false,
        reasonCode: 'EXTERNAL_DEPENDENCY_BOUND_EXCEEDED',
        message: `Backup external dependencies exceed cumulative byte ceiling (${maxExternalBytes} bytes)`
      };
    }
  }

  let verifiedExternalDependencies = 0;
  if (deps.length > 0) {
    if (!request.inspectExternalDependency) {
      return {
        ok: false,
        reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT',
        message:
          `Backup manifest declares ${deps.length} external ` +
          'dependency(ies) but no external dependency inspector was provided'
      };
    }
    let inspectedBytesTotal = 0;
    for (const dep of deps) {
      const remainingBudgetBytes = Math.max(0, maxExternalBytes - inspectedBytesTotal);
      let state: ExternalDependencyState | undefined;
      try {
        state = request.inspectExternalDependency(dep.relativePath, { remainingBudgetBytes });
      } catch {
        // A failing programmatic inspector is the same refusal as an unreadable dependency.
      }
      if (state?.exceededByteBudget) {
        return {
          ok: false,
          reasonCode: 'EXTERNAL_DEPENDENCY_BOUND_EXCEEDED',
          message: `Inspected external dependencies exceed cumulative byte ceiling (${maxExternalBytes} bytes)`
        };
      }
      if (
        !state ||
        !state.exists ||
        !Number.isSafeInteger(state.byteLength) ||
        state.byteLength < 0
      ) {
        return {
          ok: false,
          reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT',
          message:
            `External dependency verification failed for ${dep.dependencyKind} ` +
            `'${dep.referenceId}'`
        };
      }
      inspectedBytesTotal += state.byteLength;
      if (inspectedBytesTotal > maxExternalBytes) {
        return {
          ok: false,
          reasonCode: 'EXTERNAL_DEPENDENCY_BOUND_EXCEEDED',
          message: `Inspected external dependencies exceed cumulative byte ceiling (${maxExternalBytes} bytes)`
        };
      }
      if (state.byteLength !== dep.byteLength || state.sha256Digest !== dep.sha256Digest) {
        return {
          ok: false,
          reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT',
          message:
            `External dependency digest or size mismatch for ${dep.dependencyKind} ` +
            `'${dep.referenceId}'`
        };
      }
      verifiedExternalDependencies += 1;
    }
  }

  // 3. Open verified canonical backup path in an isolated read-only connection and validate in ONE snapshot.
  let backupConn: NodeSqliteConnection;
  try {
    backupConn = new NodeSqliteConnection({
      databasePath: validatedPath.resolvedPath,
      readOnly: true
    });
  } catch (err) {
    return {
      ok: false,
      reasonCode: 'BACKUP_OPEN_FAILED',
      message: err instanceof Error ? err.message : String(err)
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
      const parsedDbVersion = dbVersionRow === undefined
        ? null : parseStrictSchemaMetaVersion(dbVersionRow.meta_value);
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

      const requiredReaderFloor = BUILTIN_SCHEMA_MIGRATIONS.reduce((floor, migration) =>
        migration.version <= parsedDbVersion ? Math.max(floor, migration.minReaderVersion ?? 1) : floor,
        1
      );
      // Pre-floor images are compatible with the original reader floor of 1.
      const minReaderVersion = minReaderRow === undefined
        ? 1 : parseStrictSchemaMetaVersion(minReaderRow.meta_value);
      if (minReaderVersion === null || minReaderVersion < requiredReaderFloor || minReaderVersion > maxSchemaVersion) {
        return {
          ok: false,
          reasonCode: 'UNSUPPORTED_SCHEMA_VERSION',
          message: `Backup database min_reader_version is invalid for schema v${parsedDbVersion} or exceeds supported max=${maxSchemaVersion}`
        };
      }

      const backupTables = new Set(
        backupConn.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
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

      const indexedDependencies = collectExternalDependenciesFromConn(backupConn, [], maxExternalDeps + 1);
      if (indexedDependencies.length > maxExternalDeps) {
        return {
          ok: false,
          reasonCode: 'EXTERNAL_DEPENDENCY_BOUND_EXCEEDED',
          message: `Backup database references more than ${maxExternalDeps} external dependencies`
        };
      }
      const declaredDependencyKeys = new Set(deps.map(externalDependencyKey));
      if (indexedDependencies.some((dep) => !declaredDependencyKeys.has(externalDependencyKey(dep)))) {
        return {
          ok: false,
          reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT',
          message: 'Backup manifest is missing a dependency recorded in the database or its metadata differs'
        };
      }

      const snapshot: CapturedBackupSnapshot = captureRows
        ? readAllAuthoritativeTablesOnce(backupConn, parsedDbVersion)
        : {
            schemaVersion: parsedDbVersion,
            hasQueueMeta,
            hasTasks,
            hasOperationalRuns,
            tables: new Map(
              AUTHORITATIVE_RESTORE_TABLES.filter((t) => backupTables.has(t)).map(
                (t) => [t, { table: t, columns: [], rows: [] }]
              )
            ),
            sqliteSequence: []
          };

      // Re-verify file digest after snapshot read (TOCTOU defense against mid-read file replacement).
      const postReadDigest = computeFileDigestSync(
        validatedPath.resolvedPath,
        MAX_BACKUP_DATABASE_BYTES
      );
      if (
        !postReadDigest.ok ||
        postReadDigest.byteLength !== fileDigest.byteLength ||
        postReadDigest.sha256 !== fileDigest.sha256
      ) {
        return {
          ok: false,
          reasonCode: 'DATABASE_DIGEST_MISMATCH',
          message: 'Backup database file changed during validation; restore aborted'
        };
      }

      return {
        ok: true,
        dbSchemaVersion: parsedDbVersion,
        fileBytes: fileDigest.byteLength,
        fileSha256: fileDigest.sha256,
        verifiedExternalDependencies,
        snapshot,
        backupHasAllEntityTables
      };
    } finally {
      try {
        backupConn.exec('COMMIT');
      } catch {
        // Ignore read-transaction close error
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

/**
 * Verifies a backup image and its manifest in read-only isolation without requiring
 * an open target database connection (usable both online and during offline rollback).
 */
export function verifyBackupStandalone(request: VerifyBackupRequest): VerifyBackupOutcome {
  const validated = validateBackupImageReadOnly(request, false);
  if (!validated.ok) {
    return {
      status: 'rejected',
      reasonCode: validated.reasonCode,
      message: validated.message
    };
  }
  return {
    status: 'verified',
    backupId: request.manifest.backupId,
    schemaVersion: validated.dbSchemaVersion,
    databaseBytes: validated.fileBytes,
    databaseSha256: validated.fileSha256,
    verifiedExternalDependencies: validated.verifiedExternalDependencies,
    authoritativeTableCount: validated.snapshot.tables.size
  };
}

export class BackupRestoreService {
  private readonly conn: NodeSqliteConnection;
  private readonly nowMs: () => number;

  public constructor(conn: NodeSqliteConnection, nowMs: () => number = () => Date.now()) {
    this.conn = conn;
    this.nowMs = nowMs;
  }

  /**
   * Collects external artifact (`cas_blob` / `workspace_file`) and `log_segments`
   * dependencies from the relational index so backup and restore verify external
   * file consistency alongside relational integrity.
   */
  public collectExternalDependencies(
    auditLogDependencies: readonly BackupExternalDependency[] = []
  ): readonly BackupExternalDependency[] {
    return collectExternalDependenciesFromConn(this.conn, auditLogDependencies);
  }

  /**
   * Produces a consistent online backup using SQLite's `VACUUM INTO` while the
   * store is active in `WAL` mode, inside a `0700` directory verified via
   * `ensureAnchorWithinRoot` (Hard Rule 69), computing file-byte SHA-256 and
   * persisting the companion manifest (`0600`).
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

    const anchorRes = await ensureAnchorWithinRoot(
      request.trustedRootDir,
      request.relativeBackupDirSegments,
      0o700
    );
    if (anchorRes.outcome === 'refused') {
      throw new Error(`BACKUP_PATH_REFUSED: ${anchorRes.reason}`);
    }

    const fileName = request.backupFileName ?? `${request.backupId}.db`;
    if (
      !SAFE_BACKUP_FILENAME_PATTERN.test(fileName) ||
      fileName.includes('/') ||
      fileName.includes('\\') ||
      fileName.includes('..') ||
      fileName.includes('\0')
    ) {
      throw new Error('INVALID_BACKUP_FILENAME: backup filename must be a plain *.db or *.sqlite leaf name');
    }

    const dirNarrow = await narrowMode(anchorRes.anchor, 0o700);
    if (dirNarrow.outcome === 'refused-symlink') {
      throw new Error('BACKUP_PATH_REFUSED: backup directory is a symlink');
    }
    if (process.platform !== 'win32' && dirNarrow.outcome === 'unsupported') {
      throw new Error(`BACKUP_MODE_NARROWING_FAILED: directory mode narrowing failed (${dirNarrow.code})`);
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

    // SQLite accepts an empty destination. Reserve it at 0600 before it writes any bytes.
    const destination = await openWithinRoot(
      request.trustedRootDir,
      [...request.relativeBackupDirSegments, fileName],
      { flags: 'wx', createDirs: false, fileMode: 0o600 }
    );
    if (destination.outcome === 'refused') {
      throw new Error(`BACKUP_PATH_REFUSED: ${destination.reason}`);
    }
    try {
      await destination.handle.close();
      assertPathAndSidecarsAbsent(backupDatabasePath, false);
      this.conn.run('VACUUM INTO ?', backupDatabasePath);
    } catch (err) {
      await unlink(backupDatabasePath).catch(() => undefined);
      throw err;
    }

    const fileNarrow = await narrowMode(backupDatabasePath, 0o600);
    if (fileNarrow.outcome === 'refused-symlink') {
      throw new Error('BACKUP_PATH_REFUSED: backup output resolved to a symlink');
    }
    if (process.platform !== 'win32' && fileNarrow.outcome === 'unsupported') {
      throw new Error(`BACKUP_MODE_NARROWING_FAILED: backup file mode narrowing failed (${fileNarrow.code})`);
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
          throw new Error('BACKUP_SCHEMA_VERSION_INVALID: snapshot records an unreadable schema_version');
        }
        schemaVersion = parsedSchemaVersion;

        const sentinelRow = snapshotConn.get<{ authority: StorageAuthority }>(
          `SELECT authority FROM cutover_sentinel WHERE scope_id = ?`,
          request.scopeId
        );
        cutoverAuthority = sentinelRow?.authority ?? 'sqlite';
        externalDependencies = collectExternalDependenciesFromConn(
          snapshotConn,
          request.auditLogDependencies
        );
      } finally {
        try {
          snapshotConn.exec('COMMIT');
        } catch {
          // Ignore read-transaction close error
        }
      }
    } finally {
      snapshotConn.close();
    }

    assertPathAndSidecarsAbsent(backupDatabasePath, false);
    const fileDigest = computeFileDigestSync(backupDatabasePath, MAX_BACKUP_DATABASE_BYTES);
    if (!fileDigest.ok) {
      throw new Error(`BACKUP_DIGEST_FAILED: ${fileDigest.error}`);
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

    if (writeManifestFile) {
      const tempName = `.${manifestFileName}.${randomUUID()}.tmp`;
      const tempPath = path.join(anchorRes.anchor, tempName);
      const opened = await openWithinRoot(
        request.trustedRootDir,
        [...request.relativeBackupDirSegments, tempName],
        {
          flags: 'wx',
          createDirs: false,
          fileMode: 0o600
        }
      );
      if (opened.outcome === 'refused') {
        throw new Error(`BACKUP_MANIFEST_WRITE_REFUSED: ${opened.reason}`);
      }
      try {
        try {
          await opened.handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
          await opened.handle.sync();
        } finally {
          await opened.handle.close();
        }
        // Publish the complete file atomically, with exclusive destination semantics.
        await link(tempPath, manifestPath);
      } catch {
        throw new Error('BACKUP_MANIFEST_WRITE_REFUSED: unable to publish backup manifest');
      } finally {
        await unlink(tempPath).catch(() => undefined);
      }
    }

    return {
      backupDatabasePath,
      manifestPath,
      manifest
    };
  }

  /**
   * Read-only verification of a backup image and manifest without touching the live store.
   */
  public verifyBackup(request: VerifyBackupRequest): VerifyBackupOutcome {
    return verifyBackupStandalone(request);
  }

  /**
   * Validates a backup image and its `BackupDependencyManifest` in an isolated
   * connection BEFORE modifying the active store (`SC-009`, `FR-R7-03`), then
   * replaces every authoritative table in `AUTHORITATIVE_RESTORE_TABLES` atomically
   * inside one `BEGIN IMMEDIATE ... COMMIT` transaction with FK and trigger preservation.
   */
  public validateAndRestoreBackup(
    request: ValidateAndRestoreRequest
  ): RestoreValidationOutcome {
    const validated = validateBackupImageReadOnly(request, true);
    if (!validated.ok) {
      return {
        status: 'rejected',
        reasonCode: validated.reasonCode,
        message: validated.message
      };
    }

    const { dbSchemaVersion, verifiedExternalDependencies, snapshot, backupHasAllEntityTables } =
      validated;

    const targetHasEntityTables =
      hasTableInConn(this.conn, 'operational_queue_meta') &&
      hasTableInConn(this.conn, 'operational_tasks') &&
      hasTableInConn(this.conn, 'operational_runs');

    if (backupHasAllEntityTables && !targetHasEntityTables) {
      return {
        status: 'rejected',
        reasonCode: 'UNSUPPORTED_SCHEMA_VERSION',
        message: 'Target database lacks schema-9 per-entity operational tables required by backup'
      };
    }

    const hasTargetTable = (table: string): boolean => hasTableInConn(this.conn, table);
    const targetTables = AUTHORITATIVE_RESTORE_TABLES.filter(hasTargetTable);
    const targetTableSet = new Set(targetTables);
    for (const [table, captured] of snapshot.tables) {
      if (!targetTableSet.has(table)) {
        return {
          status: 'rejected',
          reasonCode: 'BACKUP_OPEN_FAILED',
          message: `Target database is missing required table '${table}'`
        };
      }
      const targetColumns = new Set(getTableColumns(this.conn, table));
      const missingColumn = captured.columns.find((column) => !targetColumns.has(column));
      if (missingColumn !== undefined) {
        return {
          status: 'rejected',
          reasonCode: 'BACKUP_OPEN_FAILED',
          message: `Target database is missing required column '${table}.${missingColumn}'`
        };
      }
    }

    let restoredTableCount = 0;
    let restoredRowCount = 0;
    let restoredOperational: RestoredOperationalCounts;
    let inBackfill = false;

    this.conn.exec('BEGIN IMMEDIATE');
    try {
      this.conn.exec('PRAGMA defer_foreign_keys = ON');

      // Preserve triggers (e.g., recovery_handoff_revisions immutability triggers) transactionally:
      // drop before bulk replacement, recreate verbatim before COMMIT; ROLLBACK restores them on failure.
      const savedTriggers = this.conn.all<{ name: string; sql: string }>(
        `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL ORDER BY name ASC`
      );
      for (const trig of savedTriggers) {
        const safeTrigName = assertSafeSqlIdentifier(trig.name, 'trigger');
        this.conn.exec(`DROP TRIGGER "${safeTrigName}"`);
      }

      // SQLite performs ON DELETE actions immediately even with deferred foreign
      // keys. Remove all stale parents before inserting any replacement children.
      for (const table of targetTables) {
        const safeTable = assertSafeSqlIdentifier(table, 'table');
        this.conn.run(`DELETE FROM "${safeTable}"`);
        restoredTableCount += 1;
      }

      for (const table of targetTables) {
        const captured = snapshot.tables.get(table);
        if (!captured || captured.rows.length === 0) continue;

        const safeTable = assertSafeSqlIdentifier(table, 'table');
        const quotedCols = captured.columns.map((c) => `"${c}"`).join(', ');
        const placeholders = captured.columns.map(() => '?').join(', ');
        const insertSql = `INSERT INTO "${safeTable}" (${quotedCols}) VALUES (${placeholders})`;

        for (const row of captured.rows) {
          const params = captured.columns.map((col) => {
            const val = row[col];
            return (val === undefined ? null : val) as SQLInputValue;
          });
          this.conn.run(insertSql, ...params);
          restoredRowCount += 1;
        }
      }

      // Restore AUTOINCREMENT sequence numbers for authoritative tables (e.g. state_change_outbox).
      if (hasTargetTable('sqlite_sequence')) {
        for (const { name } of this.conn.all<{ name: string }>(`SELECT name FROM sqlite_sequence`)) {
          if (AUTHORITATIVE_TABLE_SET.has(name)) {
            this.conn.run(`DELETE FROM sqlite_sequence WHERE name = ?`, name);
          }
        }
        for (const seqEntry of snapshot.sqliteSequence) {
          this.conn.run(
            `INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`,
            seqEntry.name,
            seqEntry.seq
          );
        }
      }

      // Materialize pre-Migration-9 operational KV documents into schema-9 per-entity tables
      // atomically before COMMIT so a restored schema-8 backup is immediately coherent on schema 9.
      if (targetHasEntityTables && !backupHasAllEntityTables) {
        inBackfill = true;
        backfillOperationalEntitiesInTx(this.conn, this.nowMs());
        inBackfill = false;
        restoredOperational = {
          queueMetaCount: Number(
            this.conn.scalar(`SELECT COUNT(*) FROM operational_queue_meta`) ?? 0
          ),
          taskCount: Number(this.conn.scalar(`SELECT COUNT(*) FROM operational_tasks`) ?? 0),
          operationalRunCount: Number(
            this.conn.scalar(`SELECT COUNT(*) FROM operational_runs`) ?? 0
          ),
          kvDocumentCount: Number(
            this.conn.scalar(`SELECT COUNT(*) FROM operational_kv_documents`) ?? 0
          ),
          cutoverSentinelCount: snapshot.tables.get('cutover_sentinel')?.rows.length ?? 0
        };
      } else {
        restoredOperational = {
          queueMetaCount: snapshot.tables.get('operational_queue_meta')?.rows.length ?? 0,
          taskCount: snapshot.tables.get('operational_tasks')?.rows.length ?? 0,
          operationalRunCount: snapshot.tables.get('operational_runs')?.rows.length ?? 0,
          kvDocumentCount: snapshot.tables.get('operational_kv_documents')?.rows.length ?? 0,
          cutoverSentinelCount: snapshot.tables.get('cutover_sentinel')?.rows.length ?? 0
        };
      }

      for (const trig of savedTriggers) {
        this.conn.exec(trig.sql);
      }

      const postFkViolations = this.conn.runForeignKeyCheck();
      if (postFkViolations.length > 0) {
        this.conn.exec('ROLLBACK');
        return {
          status: 'rejected',
          reasonCode: 'FOREIGN_KEY_CHECK_FAILED',
          message: `Restored state failed PRAGMA foreign_key_check with ${postFkViolations.length} violation(s)`
        };
      }

      this.conn.exec('COMMIT');
    } catch (err) {
      try {
        this.conn.exec('ROLLBACK');
      } catch {
        // Ignore rollback error
      }
      if (inBackfill) {
        return {
          status: 'rejected',
          reasonCode: 'BACKUP_OPEN_FAILED',
          message: 'Failed to backfill legacy operational documents into schema-9 tables'
        };
      }
      throw err;
    }

    return {
      status: 'restored',
      restoredRunCount: snapshot.tables.get('runs')?.rows.length ?? 0,
      restoredTableCount,
      restoredRowCount,
      restoredOperational,
      verifiedExternalDependencies,
      schemaVersion: dbSchemaVersion
    };
  }
}
