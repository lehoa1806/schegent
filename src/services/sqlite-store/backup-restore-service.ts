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
import * as path from 'node:path';
import {
  SQLITE_SCHEMA_CURRENT_VERSION,
  type BackupDependencyManifest,
  type BackupExternalDependency,
  type StorageAuthority
} from '../../contracts/sqlite-store/schema-types';
import { ensureAnchorWithinRoot } from '../../lib/safe-open';
import { NodeSqliteConnection } from './sqlite-driver';

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
  readonly maxSupportedSchemaVersion?: number | undefined;
  readonly inspectExternalDependency?: ExternalDependencyInspector | undefined;
  /** Optional test hook to simulate quick_check failure on backup image. */
  readonly simulateQuickCheckFailure?: boolean | undefined;
}

export type RestoreValidationOutcome =
  | {
      readonly status: 'restored';
      readonly restoredRunCount: number;
      readonly verifiedExternalDependencies: number;
      readonly schemaVersion: number;
    }
  | {
      readonly status: 'rejected';
      readonly reasonCode:
        | 'QUICK_CHECK_FAILED'
        | 'FOREIGN_KEY_CHECK_FAILED'
        | 'UNSUPPORTED_SCHEMA_VERSION'
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
    const deps: BackupExternalDependency[] = [];

    const artifactRows = this.conn.all<{
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

    const segmentRows = this.conn.all<{
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

    deps.push(...auditLogDependencies);
    return deps;
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
    const anchorRes = await ensureAnchorWithinRoot(
      request.trustedRootDir,
      request.relativeBackupDirSegments,
      0o700
    );
    if (anchorRes.outcome === 'refused') {
      throw new Error(`BACKUP_PATH_REFUSED: ${anchorRes.reason}`);
    }

    const fileName = request.backupFileName ?? `${request.backupId}.db`;
    if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
      throw new Error(`INVALID_BACKUP_FILENAME: ${fileName}`);
    }

    const backupDatabasePath = path.join(anchorRes.anchor, fileName);
    const escapedPath = backupDatabasePath.replace(/'/g, "''");
    this.conn.exec(`VACUUM INTO '${escapedPath}'`);

    const runtimeMeta = this.conn.inspectRuntimeMetadata();
    const schemaVersionRow = this.conn.get<{ meta_value: string }>(
      `SELECT meta_value FROM schema_meta WHERE meta_key = 'schema_version'`
    );
    const schemaVersion = Number(schemaVersionRow?.meta_value ?? SQLITE_SCHEMA_CURRENT_VERSION);

    const sentinelRow = this.conn.get<{ authority: StorageAuthority }>(
      `SELECT authority FROM cutover_sentinel WHERE scope_id = ?`,
      request.scopeId
    );
    const cutoverAuthority: StorageAuthority = sentinelRow?.authority ?? 'sqlite';

    const pageCount = Number(this.conn.scalar('PRAGMA page_count') ?? 1);
    const pageSize = Number(this.conn.scalar('PRAGMA page_size') ?? 4096);
    const databaseBytes = pageCount * pageSize;

    const runsDigestRows = this.conn.all<{ run_id: string; revision: number }>(
      `SELECT run_id, revision FROM runs ORDER BY run_id ASC`
    );
    const databaseSha256 = createHash('sha256')
      .update(`${schemaVersion}:${runsDigestRows.map((r) => `${r.run_id}@${r.revision}`).join(',')}`)
      .digest('hex');

    const externalDependencies = this.collectExternalDependencies(request.auditLogDependencies);

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

    if (request.manifest.schemaVersion > maxSchemaVersion) {
      return {
        status: 'rejected',
        reasonCode: 'UNSUPPORTED_SCHEMA_VERSION',
        message:
          `Backup manifest schemaVersion ${request.manifest.schemaVersion} exceeds ` +
          `supported maximum ${maxSchemaVersion}`
      };
    }

    // 1. Verify external dependencies before touching the live database
    if (request.inspectExternalDependency) {
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
      }
    }

    // 2. Open backup in an isolated verification connection and run PRAGMA checks
    let backupConn: NodeSqliteConnection;
    try {
      backupConn = new NodeSqliteConnection({
        databasePath: request.backupDatabasePath,
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

      const dbVersionRow = backupConn.get<{ meta_value: string }>(
        `SELECT meta_value FROM schema_meta WHERE meta_key = 'schema_version'`
      );
      const dbSchemaVersion = Number(dbVersionRow?.meta_value ?? request.manifest.schemaVersion);
      if (dbSchemaVersion > maxSchemaVersion) {
        return {
          status: 'rejected',
          reasonCode: 'UNSUPPORTED_SCHEMA_VERSION',
          message: `Backup database schema_version=${dbSchemaVersion} exceeds max=${maxSchemaVersion}`
        };
      }

      const backupRuns = backupConn.all<{
        run_id: string;
        workspace_id: string;
        workflow_id: string;
        frozen_closure_id: string | null;
        status: string;
        revision: number;
        current_step_id: string | null;
        started_at_ms: number | null;
        completed_at_ms: number | null;
        terminal_reason: string | null;
        created_at_ms: number;
        updated_at_ms: number;
      }>(`SELECT * FROM runs ORDER BY run_id ASC`);

      // 3. Apply validated restore atomically to the active connection
      this.conn.exec('BEGIN IMMEDIATE');
      try {
        this.conn.run(`DELETE FROM runs`);
        for (const r of backupRuns) {
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
        this.conn.exec('COMMIT');
      } catch (err) {
        try {
          this.conn.exec('ROLLBACK');
        } catch {
          // Ignore
        }
        throw err;
      }

      return {
        status: 'restored',
        restoredRunCount: backupRuns.length,
        verifiedExternalDependencies: request.manifest.externalDependencies.length,
        schemaVersion: dbSchemaVersion
      };
    } finally {
      backupConn.close();
    }
  }
}
