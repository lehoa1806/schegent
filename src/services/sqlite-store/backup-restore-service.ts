/**
 * FR-R6-F04 (F04-A, FR-009, SC-009) — Consistent online backup in `WAL` mode,
 * `BackupDependencyManifest` generation for external content-addressed blobs /
 * log segments / audit JSONL files, and validated restore with `PRAGMA quick_check`,
 * `PRAGMA foreign_key_check`, schema compatibility, and external dependency verification.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * Zero raw `node:fs` write primitives (docs/hard-rules.md rule 69).
 */

import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import * as path from 'node:path';
import {
  SQLITE_SCHEMA_CURRENT_VERSION,
  type BackupDependencyManifest,
  type BackupExternalDependency,
  type StorageAuthority
} from '../../contracts/sqlite-store/schema-types';
import { narrowMode } from '../../lib/narrow-mode';
import { ensureAnchorWithinRoot, judgeLeafRedirect, platformLacksNoFollow } from '../../lib/safe-open';
import {
  backfillOperationalEntitiesInTx,
  parseStrictSchemaMetaVersion
} from './operational-entity-schema';
import { NodeSqliteConnection } from './sqlite-driver';

const SAFE_BACKUP_FILENAME_PATTERN = /^[A-Za-z0-9._-]+\.(?:db|sqlite|sqlite3)$/;
const MAX_BACKUP_DATABASE_BYTES = 512 * 1024 * 1024;
const SQLITE_SIDECAR_SUFFIXES = Object.freeze(['-wal', '-shm', '-journal'] as const);

interface BackupSnapshotTables {
  readonly hasQueueMeta: boolean;
  readonly hasTasks: boolean;
  readonly hasOperationalRuns: boolean;
  readonly hasKvDocs: boolean;
  readonly hasSentinels: boolean;
  readonly runs: ReadonlyArray<{
    readonly run_id: string;
    readonly workspace_id: string;
    readonly workflow_id: string;
    readonly frozen_closure_id: string | null;
    readonly status: string;
    readonly revision: number;
    readonly current_step_id: string | null;
    readonly started_at_ms: number | null;
    readonly completed_at_ms: number | null;
    readonly terminal_reason: string | null;
    readonly created_at_ms: number;
    readonly updated_at_ms: number;
    readonly queue_id?: string | null;
    readonly backend_kind?: string | null;
    readonly model_id?: string | null;
    readonly profile_id?: string | null;
    readonly lane_id?: string | null;
    readonly invocation_count?: number;
  }>;
  readonly queueMeta: ReadonlyArray<{
    readonly scope_id: string;
    readonly queue_id: string;
    readonly revision: number;
    readonly in_flight_id: string | null;
    readonly queue_lifecycle: string;
    readonly pause_source: string | null;
    readonly paused_reason: string | null;
    readonly scheduled_start_at_ms: number | null;
    readonly scheduled_start_source: string | null;
    readonly failure_policy: string | null;
    readonly updated_at_ms: number;
    readonly remainder_json: string;
  }>;
  readonly tasks: ReadonlyArray<{
    readonly scope_id: string;
    readonly queue_id: string;
    readonly task_id: string;
    readonly revision: number;
    readonly position: number;
    readonly status: string;
    readonly run_id: string | null;
    readonly enqueued_at_ms: number;
    readonly updated_at_ms: number;
    readonly payload_json: string;
  }>;
  readonly operationalRuns: ReadonlyArray<{
    readonly scope_id: string;
    readonly queue_id: string;
    readonly run_id: string;
    readonly revision: number;
    readonly feature_id: string;
    readonly status: string;
    readonly current_phase: string;
    readonly started_at_ms: number;
    readonly last_transition_at_ms: number;
    readonly failure_cause: string | null;
    readonly payload_json: string;
  }>;
  readonly kvDocs: ReadonlyArray<{
    readonly doc_namespace: string;
    readonly doc_key: string;
    readonly revision: number;
    readonly schema_version: number;
    readonly payload_json: string;
    readonly payload_bytes: number;
    readonly is_terminal: number;
    readonly updated_at_ms: number;
  }>;
  readonly sentinels: ReadonlyArray<{
    readonly scope_id: string;
    readonly authority: string;
    readonly stage: string;
    readonly cutover_epoch: number;
    readonly legacy_digest_sha256: string;
    readonly sqlite_digest_sha256: string;
    readonly updated_at_ms: number;
  }>;
}

function hasTableInConn(conn: NodeSqliteConnection, table: string): boolean {
  return (
    conn.get<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      table
    ) !== undefined
  );
}

function computeDatabaseBytes(conn: NodeSqliteConnection): number {
  const pageCount = Number(conn.scalar('PRAGMA page_count') ?? 0);
  const pageSize = Number(conn.scalar('PRAGMA page_size') ?? 4096);
  return pageCount * pageSize;
}

function readSnapshotTablesOnce(conn: NodeSqliteConnection): BackupSnapshotTables {
  const hasQueueMeta = hasTableInConn(conn, 'operational_queue_meta');
  const hasTasks = hasTableInConn(conn, 'operational_tasks');
  const hasOperationalRuns = hasTableInConn(conn, 'operational_runs');
  const hasKvDocs = hasTableInConn(conn, 'operational_kv_documents');
  const hasSentinels = hasTableInConn(conn, 'cutover_sentinel');
  return {
    hasQueueMeta,
    hasTasks,
    hasOperationalRuns,
    hasKvDocs,
    hasSentinels,
    runs: conn.all(`SELECT * FROM runs ORDER BY run_id ASC`),
    queueMeta: hasQueueMeta
      ? conn.all(`SELECT * FROM operational_queue_meta ORDER BY scope_id ASC, queue_id ASC`)
      : [],
    tasks: hasTasks
      ? conn.all(`SELECT * FROM operational_tasks ORDER BY scope_id ASC, queue_id ASC, position ASC, task_id ASC`)
      : [],
    operationalRuns: hasOperationalRuns
      ? conn.all(`SELECT * FROM operational_runs ORDER BY scope_id ASC, queue_id ASC`)
      : [],
    kvDocs: hasKvDocs
      ? conn.all(`SELECT * FROM operational_kv_documents ORDER BY doc_namespace ASC, doc_key ASC`)
      : [],
    sentinels: hasSentinels
      ? conn.all(`SELECT * FROM cutover_sentinel ORDER BY scope_id ASC`)
      : []
  };
}

/**
 * Deterministic full-row SHA-256 digest over a single-read `BackupSnapshotTables` object,
 * covering every restored column including `payload_json` and `remainder_json`.
 */
function hashSnapshotTables(schemaVersion: number, snapshot: BackupSnapshotTables): string {
  const hasher = createHash('sha256').update(`v:${schemaVersion}`);
  hasher.update(`|runs:${JSON.stringify(snapshot.runs)}`);
  if (snapshot.hasQueueMeta) hasher.update(`|q:${JSON.stringify(snapshot.queueMeta)}`);
  if (snapshot.hasTasks) hasher.update(`|t:${JSON.stringify(snapshot.tasks)}`);
  if (snapshot.hasOperationalRuns) hasher.update(`|or:${JSON.stringify(snapshot.operationalRuns)}`);
  if (snapshot.hasKvDocs) hasher.update(`|kv:${JSON.stringify(snapshot.kvDocs)}`);
  if (snapshot.hasSentinels) hasher.update(`|cs:${JSON.stringify(snapshot.sentinels)}`);
  return hasher.digest('hex');
}

function collectExternalDependenciesFromConn(
  conn: NodeSqliteConnection,
  auditLogDependencies: readonly BackupExternalDependency[] = []
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
       ORDER BY a.artifact_id ASC`
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

  if (hasTableInConn(conn, 'log_segments')) {
    const segmentRows = conn.all<{
      segment_id: string;
      start_byte_offset: number;
      end_byte_offset: number;
      content_sha256: string;
      relative_path: string;
    }>(
      `SELECT segment_id, start_byte_offset, end_byte_offset, content_sha256, relative_path
       FROM log_segments ORDER BY segment_id ASC`
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

function validateBackupPathBeforeOpen(
  backupDatabasePath: string,
  trustedRootDir?: string
): { readonly ok: true; readonly resolvedPath: string } | { readonly ok: false; readonly error: string } {
  if (backupDatabasePath.length === 0 || backupDatabasePath.includes('\0')) {
    return { ok: false, error: 'Backup database path is empty or contains a NUL byte' };
  }
  const rawSegments = backupDatabasePath.split(/[\\/]/);
  if (rawSegments.some((seg) => seg === '.' || seg === '..')) {
    return { ok: false, error: 'Backup database path must not contain relative "." or ".." segments' };
  }
  const resolvedTarget = path.resolve(backupDatabasePath);
  const leafName = path.basename(resolvedTarget);
  if (!SAFE_BACKUP_FILENAME_PATTERN.test(leafName) || leafName.includes('..')) {
    return { ok: false, error: 'Backup database filename must be a plain *.db or *.sqlite leaf name' };
  }
  if (trustedRootDir !== undefined) {
    if (!path.isAbsolute(trustedRootDir) || trustedRootDir.includes('\0')) {
      return { ok: false, error: 'Trusted backup root directory must be an absolute path' };
    }
    if (!path.isAbsolute(backupDatabasePath)) {
      return { ok: false, error: 'Backup database path must be an absolute path under trusted root' };
    }
    const resolvedRoot = path.resolve(trustedRootDir);
    const rel = path.relative(resolvedRoot, resolvedTarget);
    if (rel.length === 0 || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return { ok: false, error: 'Backup database path escapes trusted root directory' };
    }
    const parts = rel.split(path.sep);
    let current = resolvedRoot;
    for (let i = 0; i < parts.length - 1; i += 1) {
      current = path.join(current, parts[i]!);
      try {
        const dirStat = lstatSync(current);
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
          return { ok: false, error: 'Backup path traverses a symlink or non-directory component' };
        }
      } catch {
        return { ok: false, error: 'Backup parent directory is unreadable' };
      }
    }
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(resolvedTarget);
  } catch {
    return { ok: false, error: 'Backup database file does not exist or is unreadable' };
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, error: 'Backup database path must not be a symbolic link' };
  }
  if (!stat.isFile()) {
    return { ok: false, error: 'Backup database path must be a regular file' };
  }
  let totalBytes = stat.size;
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    try {
      const sidecarStat = lstatSync(`${resolvedTarget}${suffix}`);
      if (sidecarStat.isSymbolicLink() || !sidecarStat.isFile()) {
        return { ok: false, error: `Backup SQLite sidecar (${suffix}) must not be a symlink or non-regular file` };
      }
      totalBytes += sidecarStat.size;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code !== 'ENOENT') {
        return { ok: false, error: `Backup SQLite sidecar (${suffix}) could not be verified` };
      }
    }
  }
  if (totalBytes > MAX_BACKUP_DATABASE_BYTES) {
    return {
      ok: false,
      error: `Backup database size (${totalBytes} bytes) exceeds maximum limit (${MAX_BACKUP_DATABASE_BYTES} bytes)`
    };
  }
  return { ok: true, resolvedPath: resolvedTarget };
}

function assertPathAndSidecarsAbsent(backupDatabasePath: string, includeLeaf: boolean): void {
  const targets = includeLeaf
    ? [backupDatabasePath, ...SQLITE_SIDECAR_SUFFIXES.map((s) => `${backupDatabasePath}${s}`)]
    : SQLITE_SIDECAR_SUFFIXES.map((s) => `${backupDatabasePath}${s}`);
  for (const target of targets) {
    let exists = false;
    try {
      lstatSync(target);
      exists = true;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code !== 'ENOENT') {
        throw new Error('BACKUP_PATH_REFUSED: unable to verify backup output path absence');
      }
    }
    if (exists) {
      throw new Error('BACKUP_PATH_REFUSED: backup output file or SQLite sidecar already exists');
    }
  }
}

export interface ExternalDependencyState {
  readonly exists: boolean;
  readonly byteLength: number;
  readonly sha256Digest: string;
}

export type ExternalDependencyInspector = (
  relativePath: string
) => ExternalDependencyState | undefined;

export interface CreateOnlineBackupRequest {
  readonly backupId: string;
  readonly scopeId: string;
  readonly trustedRootDir: string;
  readonly relativeBackupDirSegments: readonly string[];
  readonly backupFileName?: string | undefined;
  readonly auditLogDependencies?: readonly BackupExternalDependency[] | undefined;
}

export interface ValidateAndRestoreRequest {
  readonly backupDatabasePath: string;
  readonly manifest: BackupDependencyManifest;
  readonly trustedRootDir?: string | undefined;
  readonly maxSupportedSchemaVersion?: number | undefined;
  readonly inspectExternalDependency?: ExternalDependencyInspector | undefined;
  /** Optional test hook to simulate quick_check failure on backup image. */
  readonly simulateQuickCheckFailure?: boolean | undefined;
}

export interface RestoredOperationalCounts {
  readonly queueMetaCount: number;
  readonly taskCount: number;
  readonly operationalRunCount: number;
  readonly kvDocumentCount: number;
  readonly cutoverSentinelCount: number;
}

export type RestoreValidationOutcome =
  | {
      readonly status: 'restored';
      readonly restoredRunCount: number;
      readonly restoredOperational?: RestoredOperationalCounts | undefined;
      readonly verifiedExternalDependencies: number;
      readonly schemaVersion: number;
    }
  | {
      readonly status: 'rejected';
      readonly reasonCode:
        | 'QUICK_CHECK_FAILED'
        | 'FOREIGN_KEY_CHECK_FAILED'
        | 'UNSUPPORTED_SCHEMA_VERSION'
        | 'DATABASE_DIGEST_MISMATCH'
        | 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT'
        | 'BACKUP_OPEN_FAILED';
      readonly message: string;
    };

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
   * `ensureAnchorWithinRoot` (Hard Rule 69).
   */
  public async createOnlineBackup(
    request: CreateOnlineBackupRequest
  ): Promise<{
    readonly backupDatabasePath: string;
    readonly manifest: BackupDependencyManifest;
  }> {
    if (!path.isAbsolute(request.trustedRootDir) || request.trustedRootDir.includes('\0')) {
      throw new Error('BACKUP_PATH_REFUSED: trustedRootDir must be an absolute path');
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
    const leafJudgement = await judgeLeafRedirect(
      backupDatabasePath,
      ['ENOENT'],
      platformLacksNoFollow()
    );
    if (leafJudgement.outcome === 'refused') {
      throw new Error(`BACKUP_PATH_REFUSED: ${leafJudgement.reason}`);
    }
    assertPathAndSidecarsAbsent(backupDatabasePath, true);

    this.conn.run('VACUUM INTO ?', backupDatabasePath);

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
    let databaseBytes: number;
    let databaseSha256: string;
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
            : SQLITE_SCHEMA_CURRENT_VERSION;
        if (parsedSchemaVersion === null) {
          throw new Error('BACKUP_SCHEMA_VERSION_INVALID: snapshot records an unreadable schema_version');
        }
        schemaVersion = parsedSchemaVersion;

        const sentinelRow = snapshotConn.get<{ authority: StorageAuthority }>(
          `SELECT authority FROM cutover_sentinel WHERE scope_id = ?`,
          request.scopeId
        );
        cutoverAuthority = sentinelRow?.authority ?? 'sqlite';
        databaseBytes = computeDatabaseBytes(snapshotConn);
        const snapshot = readSnapshotTablesOnce(snapshotConn);
        databaseSha256 = hashSnapshotTables(schemaVersion, snapshot);
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

    const manifest: BackupDependencyManifest = {
      backupId: request.backupId,
      createdAtMs: this.nowMs(),
      schemaVersion,
      sqliteVersion: runtimeMeta.sqliteVersion,
      databaseSha256,
      databaseBytes,
      cutoverAuthority,
      externalDependencies
    };

    return {
      backupDatabasePath,
      manifest
    };
  }

  /**
   * Validates a backup image and its `BackupDependencyManifest` in an isolated
   * connection BEFORE modifying the active store (`SC-009`).
   * If any integrity, foreign-key, schema-version, or external-file digest check
   * fails, the active store remains completely untouched.
   */
  public validateAndRestoreBackup(
    request: ValidateAndRestoreRequest
  ): RestoreValidationOutcome {
    const maxSchemaVersion = request.maxSupportedSchemaVersion ?? SQLITE_SCHEMA_CURRENT_VERSION;

    if (
      !Number.isSafeInteger(request.manifest.schemaVersion) ||
      request.manifest.schemaVersion < 1 ||
      request.manifest.schemaVersion > maxSchemaVersion
    ) {
      return {
        status: 'rejected',
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
        status: 'rejected',
        reasonCode: 'BACKUP_OPEN_FAILED',
        message: validatedPath.error
      };
    }

    // 1. Verify external dependencies before touching the live database (fail closed if inspector omitted)
    let verifiedExternalDependencies = 0;
    if (request.manifest.externalDependencies.length > 0) {
      if (!request.inspectExternalDependency) {
        return {
          status: 'rejected',
          reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT',
          message:
            `Backup manifest declares ${request.manifest.externalDependencies.length} external ` +
            'dependency(ies) but no external dependency inspector was provided'
        };
      }
      for (const dep of request.manifest.externalDependencies) {
        const state = request.inspectExternalDependency(dep.relativePath);
        if (
          !state ||
          !state.exists ||
          state.byteLength !== dep.byteLength ||
          state.sha256Digest !== dep.sha256Digest
        ) {
          return {
            status: 'rejected',
            reasonCode: 'EXTERNAL_DEPENDENCY_MISSING_OR_CORRUPT',
            message:
              `External dependency verification failed for ${dep.dependencyKind} ` +
              `'${dep.referenceId}' (${dep.relativePath})`
          };
        }
        verifiedExternalDependencies += 1;
      }
    }

    // 2. Open verified canonical backup path in an isolated connection and validate in ONE read snapshot
    let backupConn: NodeSqliteConnection;
    try {
      backupConn = new NodeSqliteConnection({
        databasePath: validatedPath.resolvedPath,
        readOnly: true
      });
    } catch (err) {
      return {
        status: 'rejected',
        reasonCode: 'BACKUP_OPEN_FAILED',
        message: err instanceof Error ? err.message : String(err)
      };
    }

    try {
      let dbSchemaVersion: number;
      let backupHasAllEntityTables: boolean;
      let targetHasEntityTables: boolean;
      let snapshot: BackupSnapshotTables;

      try {
        backupConn.exec('BEGIN');
        try {
          const quickCheckResults = request.simulateQuickCheckFailure
            ? ['*** in database main ***\ncorrupt page 2']
            : backupConn.runQuickCheck();

          if (quickCheckResults.length !== 1 || quickCheckResults[0] !== 'ok') {
            return {
              status: 'rejected',
              reasonCode: 'QUICK_CHECK_FAILED',
              message: `Backup failed PRAGMA quick_check: ${quickCheckResults.join('; ')}`
            };
          }

          const fkViolations = backupConn.runForeignKeyCheck();
          if (fkViolations.length > 0) {
            return {
              status: 'rejected',
              reasonCode: 'FOREIGN_KEY_CHECK_FAILED',
              message: `Backup failed PRAGMA foreign_key_check with ${fkViolations.length} violation(s)`
            };
          }

          if (!hasTableInConn(backupConn, 'schema_meta') || !hasTableInConn(backupConn, 'runs')) {
            return {
              status: 'rejected',
              reasonCode: 'BACKUP_OPEN_FAILED',
              message: 'Backup database is missing required schema_meta or runs tables'
            };
          }

          const minReaderRow = backupConn.get<{ meta_value: string }>(
            `SELECT meta_value FROM schema_meta WHERE meta_key = 'min_reader_version'`
          );
          if (minReaderRow !== undefined) {
            const minReaderVersion = parseStrictSchemaMetaVersion(minReaderRow.meta_value);
            if (minReaderVersion === null) {
              return {
                status: 'rejected',
                reasonCode: 'UNSUPPORTED_SCHEMA_VERSION',
                message: 'Backup database records an unreadable min_reader_version'
              };
            }
            if (minReaderVersion > maxSchemaVersion) {
              return {
                status: 'rejected',
                reasonCode: 'UNSUPPORTED_SCHEMA_VERSION',
                message: `Backup database min_reader_version=${minReaderVersion} exceeds supported max=${maxSchemaVersion}`
              };
            }
          }

          const dbVersionRow = backupConn.get<{ meta_value: string }>(
            `SELECT meta_value FROM schema_meta WHERE meta_key = 'schema_version'`
          );
          const parsedDbVersion =
            dbVersionRow !== undefined
              ? parseStrictSchemaMetaVersion(dbVersionRow.meta_value)
              : request.manifest.schemaVersion;
          if (parsedDbVersion === null || parsedDbVersion > maxSchemaVersion) {
            return {
              status: 'rejected',
              reasonCode: 'UNSUPPORTED_SCHEMA_VERSION',
              message: `Backup database schema_version is invalid or exceeds supported max=${maxSchemaVersion}`
            };
          }
          dbSchemaVersion = parsedDbVersion;
          if (dbSchemaVersion !== request.manifest.schemaVersion) {
            return {
              status: 'rejected',
              reasonCode: 'DATABASE_DIGEST_MISMATCH',
              message: 'Backup database schema_version does not match manifest'
            };
          }

          const actualBytes = computeDatabaseBytes(backupConn);
          snapshot = readSnapshotTablesOnce(backupConn);
          const actualSha256 = hashSnapshotTables(dbSchemaVersion, snapshot);
          if (
            actualBytes !== request.manifest.databaseBytes ||
            actualSha256 !== request.manifest.databaseSha256
          ) {
            return {
              status: 'rejected',
              reasonCode: 'DATABASE_DIGEST_MISMATCH',
              message: 'Backup database digest or byte size does not match manifest'
            };
          }

          backupHasAllEntityTables =
            snapshot.hasQueueMeta && snapshot.hasTasks && snapshot.hasOperationalRuns;
          const backupHasAnyEntityTable =
            snapshot.hasQueueMeta || snapshot.hasTasks || snapshot.hasOperationalRuns;
          if (
            (dbSchemaVersion >= 9 && !backupHasAllEntityTables) ||
            (backupHasAnyEntityTable && !backupHasAllEntityTables)
          ) {
            return {
              status: 'rejected',
              reasonCode: 'BACKUP_OPEN_FAILED',
              message: 'Backup database has an incomplete schema-9 per-entity table set'
            };
          }

          targetHasEntityTables =
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
        } finally {
          try {
            backupConn.exec('COMMIT');
          } catch {
            // Ignore read-transaction close error
          }
        }
      } catch {
        return {
          status: 'rejected',
          reasonCode: 'BACKUP_OPEN_FAILED',
          message: 'Backup database structure is invalid or unreadable'
        };
      }

      const backupRuns = snapshot.runs;
      const backupQueueMeta = snapshot.queueMeta;
      const backupTasks = snapshot.tasks;
      const backupOperationalRuns = snapshot.operationalRuns;
      const backupKvDocs = snapshot.kvDocs;
      const backupSentinels = snapshot.sentinels;

      const hasTargetTable = (table: string): boolean => hasTableInConn(this.conn, table);

      const targetRunColumns = new Set(
        this.conn.all<{ name: string }>(`PRAGMA table_info(runs)`).map((c) => c.name)
      );
      const targetHasExtendedRunCols = targetRunColumns.has('queue_id');

      // 3. Apply validated restore atomically to the active connection
      let restoredOperational: RestoredOperationalCounts;
      let inBackfill = false;
      this.conn.exec('BEGIN IMMEDIATE');
      try {
        this.conn.run(`DELETE FROM runs`);
        for (const r of backupRuns) {
          if (targetHasExtendedRunCols) {
            this.conn.run(
              `INSERT INTO runs (
                run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
                current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms,
                queue_id, backend_kind, model_id, profile_id, lane_id, invocation_count
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              r.run_id,
              r.workspace_id,
              r.workflow_id,
              r.frozen_closure_id,
              r.status,
              r.revision,
              r.current_step_id,
              r.started_at_ms,
              r.completed_at_ms,
              r.terminal_reason,
              r.created_at_ms,
              r.updated_at_ms,
              r.queue_id ?? null,
              r.backend_kind ?? null,
              r.model_id ?? null,
              r.profile_id ?? null,
              r.lane_id ?? null,
              typeof r.invocation_count === 'number' ? r.invocation_count : 0
            );
          } else {
            this.conn.run(
              `INSERT INTO runs (
                run_id, workspace_id, workflow_id, frozen_closure_id, status, revision,
                current_step_id, started_at_ms, completed_at_ms, terminal_reason, created_at_ms, updated_at_ms
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              r.run_id,
              r.workspace_id,
              r.workflow_id,
              r.frozen_closure_id,
              r.status,
              r.revision,
              r.current_step_id,
              r.started_at_ms,
              r.completed_at_ms,
              r.terminal_reason,
              r.created_at_ms,
              r.updated_at_ms
            );
          }
        }

        if (hasTargetTable('operational_tasks')) {
          this.conn.run(`DELETE FROM operational_tasks`);
          for (const t of backupTasks) {
            this.conn.run(
              `INSERT INTO operational_tasks (
                scope_id, queue_id, task_id, revision, position, status, run_id,
                enqueued_at_ms, updated_at_ms, payload_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              t.scope_id,
              t.queue_id,
              t.task_id,
              t.revision,
              t.position,
              t.status,
              t.run_id,
              t.enqueued_at_ms,
              t.updated_at_ms,
              t.payload_json
            );
          }
        }

        if (hasTargetTable('operational_queue_meta')) {
          this.conn.run(`DELETE FROM operational_queue_meta`);
          for (const q of backupQueueMeta) {
            this.conn.run(
              `INSERT INTO operational_queue_meta (
                scope_id, queue_id, revision, in_flight_id, queue_lifecycle,
                pause_source, paused_reason, scheduled_start_at_ms, scheduled_start_source,
                failure_policy, updated_at_ms, remainder_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              q.scope_id,
              q.queue_id,
              q.revision,
              q.in_flight_id,
              q.queue_lifecycle,
              q.pause_source,
              q.paused_reason,
              q.scheduled_start_at_ms,
              q.scheduled_start_source,
              q.failure_policy,
              q.updated_at_ms,
              q.remainder_json
            );
          }
        }

        if (hasTargetTable('operational_runs')) {
          this.conn.run(`DELETE FROM operational_runs`);
          for (const orRow of backupOperationalRuns) {
            this.conn.run(
              `INSERT INTO operational_runs (
                scope_id, queue_id, run_id, revision, feature_id, status, current_phase,
                started_at_ms, last_transition_at_ms, failure_cause, payload_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              orRow.scope_id,
              orRow.queue_id,
              orRow.run_id,
              orRow.revision,
              orRow.feature_id,
              orRow.status,
              orRow.current_phase,
              orRow.started_at_ms,
              orRow.last_transition_at_ms,
              orRow.failure_cause,
              orRow.payload_json
            );
          }
        }

        if (hasTargetTable('operational_kv_documents')) {
          this.conn.run(`DELETE FROM operational_kv_documents`);
          for (const kv of backupKvDocs) {
            this.conn.run(
              `INSERT INTO operational_kv_documents (
                doc_namespace, doc_key, revision, schema_version, payload_json,
                payload_bytes, is_terminal, updated_at_ms
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              kv.doc_namespace,
              kv.doc_key,
              kv.revision,
              kv.schema_version,
              kv.payload_json,
              kv.payload_bytes,
              kv.is_terminal,
              kv.updated_at_ms
            );
          }
        }

        if (hasTargetTable('cutover_sentinel')) {
          this.conn.run(`DELETE FROM cutover_sentinel`);
          for (const s of backupSentinels) {
            this.conn.run(
              `INSERT INTO cutover_sentinel (
                scope_id, authority, stage, cutover_epoch, legacy_digest_sha256,
                sqlite_digest_sha256, updated_at_ms
              ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
              s.scope_id,
              s.authority,
              s.stage,
              s.cutover_epoch,
              s.legacy_digest_sha256,
              s.sqlite_digest_sha256,
              s.updated_at_ms
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
            cutoverSentinelCount: backupSentinels.length
          };
        } else {
          restoredOperational = {
            queueMetaCount: backupQueueMeta.length,
            taskCount: backupTasks.length,
            operationalRunCount: backupOperationalRuns.length,
            kvDocumentCount: backupKvDocs.length,
            cutoverSentinelCount: backupSentinels.length
          };
        }
        this.conn.exec('COMMIT');
      } catch (err) {
        try {
          this.conn.exec('ROLLBACK');
        } catch {
          // Ignore
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
        restoredRunCount: backupRuns.length,
        restoredOperational,
        verifiedExternalDependencies,
        schemaVersion: dbSchemaVersion
      };
    } finally {
      backupConn.close();
    }
  }
}
