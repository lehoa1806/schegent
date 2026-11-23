/**
 * FR-R7-14 (14-03) — Async chunked SHA-256 verification, SQLite-native
 * `ATTACH DATABASE` + `INSERT INTO ... SELECT` atomic restore execution,
 * and post-validation / immediate pre-`COMMIT` primacy & idle fencing.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * Read-only file opens go through `safe-open` (`O_NOFOLLOW`, docs/hard-rules.md rule 69).
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { BackupRestoreRejectionCode } from '../../contracts/sqlite-store/schema-types';
import { openWithinRoot, openWithinRootByPath } from '../../lib/safe-open';
import {
  AUTHORITATIVE_RESTORE_TABLES,
  type AuthoritativeRestoreTableName
} from './authoritative-restore-tables';
import type { ResolvedBackupBounds } from './backup-dependency-collector';
import {
  fingerprintsMatch,
  isOwnerOnlyFileMode,
  statFileFingerprintSync,
  validateBackupPathBeforeOpen,
  type FileStatFingerprint
} from './backup-manifest-store';
import { backfillOperationalEntitiesInTx } from './operational-entity-schema';
import { NodeSqliteConnection } from './sqlite-driver';

const memoryRestoreLocks = new WeakMap<NodeSqliteConnection, Promise<void>>();

async function withMemoryRestoreLock<T>(
  conn: NodeSqliteConnection,
  fn: () => Promise<T>
): Promise<T> {
  const prev = memoryRestoreLocks.get(conn) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => gate);
  memoryRestoreLocks.set(conn, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (memoryRestoreLocks.get(conn) === chained) {
      memoryRestoreLocks.delete(conn);
    }
  }
}

const SAFE_SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const AUTHORITATIVE_TABLE_SET = new Set<string>(AUTHORITATIVE_RESTORE_TABLES);
const ASYNC_DIGEST_CHUNK_BYTES = 256 * 1024;
const ASYNC_DIGEST_YIELD_EVERY_CHUNKS = 4; // Yield every 1 MiB hashed so timers/heartbeats never stall

export type RestoreOutcomeKind =
  | 'restored'
  | 'refused_pre_commit'
  | 'committed_refresh_failed';

export interface RestoreFenceCallbacks {
  readonly hasPrimacy?: (() => boolean | Promise<boolean>) | undefined;
  readonly hasInFlightRun?: (() => boolean) | undefined;
  readonly beforeCommitFence?: (() => boolean | Promise<boolean>) | undefined;
}

export interface SyncRestoreFenceCallbacks {
  readonly hasInFlightRun?: (() => boolean) | undefined;
  readonly beforeCommitFence?: (() => boolean) | undefined;
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
      readonly outcome?: 'restored' | undefined;
      readonly restoredRunCount: number;
      readonly restoredTableCount: number;
      readonly restoredRowCount: number;
      readonly restoredOperational?: RestoredOperationalCounts | undefined;
      readonly verifiedExternalDependencies: number;
      readonly schemaVersion: number;
    }
  | {
      readonly status: 'rejected';
      readonly outcome?: 'refused_pre_commit' | undefined;
      readonly reasonCode: BackupRestoreRejectionCode;
      readonly message: string;
    };

export interface ValidatedBackupTableMeta {
  readonly table: AuthoritativeRestoreTableName;
  readonly columns: readonly string[];
}

export type ValidatedBackupImage =
  | {
      readonly ok: true;
      readonly resolvedPath: string;
      readonly trustedRootDir?: string | undefined;
      readonly bounds: ResolvedBackupBounds;
      readonly dbSchemaVersion: number;
      readonly fileBytes: number;
      readonly fileSha256: string;
      readonly verifiedExternalDependencies: number;
      readonly tables: ReadonlyMap<AuthoritativeRestoreTableName, ValidatedBackupTableMeta>;
      readonly backupHasAllEntityTables: boolean;
      readonly fingerprint: FileStatFingerprint | null;
    }
  | {
      readonly ok: false;
      readonly reasonCode: BackupRestoreRejectionCode;
      readonly message: string;
    };

export type AsyncFileDigestResult =
  | {
      readonly ok: true;
      readonly byteLength: number;
      readonly sha256: string;
      readonly fingerprint: FileStatFingerprint;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly reasonCode?: BackupRestoreRejectionCode | undefined;
    };

export const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

export function assertSafeSqlIdentifier(identifier: string, label: string): string {
  if (!SAFE_SQL_IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`BACKUP_INVALID_SQL_IDENTIFIER: unsafe ${label}`);
  }
  return identifier;
}

export function getMainTableColumns(conn: NodeSqliteConnection, table: string): readonly string[] {
  const safeTable = assertSafeSqlIdentifier(table, 'table');
  return conn
    .all<{ name: string }>(`PRAGMA main.table_info("${safeTable}")`)
    .map((c) => assertSafeSqlIdentifier(c.name, 'column'));
}

function hasMainTableInConn(conn: NodeSqliteConnection, table: string): boolean {
  return (
    conn.get<{ name: string }>(
      `SELECT name FROM main.sqlite_master WHERE type = 'table' AND name = ?`,
      table
    ) !== undefined
  );
}

function hasAttachedTableInConn(conn: NodeSqliteConnection, table: string): boolean {
  return (
    conn.get<{ name: string }>(
      `SELECT name FROM backup_src.sqlite_master WHERE type = 'table' AND name = ?`,
      table
    ) !== undefined
  );
}

/**
 * Computes file byte length, SHA-256 digest, and stat identity fingerprint
 * asynchronously in bounded chunks (`256 KiB`), yielding to the event loop
 * every `1 MiB` so timers, lock heartbeats, and loggers remain responsive.
 * Uses `safe-open` (`O_NOFOLLOW`) to prevent leaf symlink redirection.
 */
export async function computeFileDigestAsync(
  resolvedPath: string,
  expectedMaxBytes: number,
  trustedRootDir?: string
): Promise<AsyncFileDigestResult> {
  const opened =
    trustedRootDir !== undefined
      ? await openWithinRootByPath(trustedRootDir, resolvedPath, { flags: 'r' })
      : await openWithinRoot(path.dirname(resolvedPath), [path.basename(resolvedPath)], {
          flags: 'r'
        });

  if (opened.outcome === 'refused') {
    // Residual openat / reparse-point-leaf boundary: see docs/architecture/native-binding-decision.md.
    if (
      opened.reason === 'symlink-leaf' ||
      opened.reason === 'reparse-point-leaf' ||
      opened.reason === 'symlink-component'
    ) {
      return { ok: false, error: 'Backup database path must not be a symbolic link' };
    }
    if (opened.reason === 'not-a-regular-file') {
      return { ok: false, error: 'Backup database path must be a regular file' };
    }
    if (opened.reason === 'escapes-root') {
      return { ok: false, error: 'Backup database path escapes trusted root directory' };
    }
    return {
      ok: false,
      error: 'Backup database file could not be read for digest verification'
    };
  }

  try {
    const preStat = await opened.handle.stat({ bigint: true });
    if (!preStat.isFile()) {
      return { ok: false, error: 'Backup database path must be a regular file' };
    }
    if (!isOwnerOnlyFileMode(Number(preStat.mode))) {
      return { ok: false, error: 'Backup database file permissions must be owner-only (0600)' };
    }
    const maxBigInt = BigInt(Math.max(0, Math.floor(expectedMaxBytes)));
    if (preStat.size > maxBigInt) {
      return {
        ok: false,
        reasonCode: 'RESTORE_IMAGE_BOUND_EXCEEDED',
        error: `Backup database size (${preStat.size.toString()} bytes) exceeds maximum limit (${expectedMaxBytes} bytes)`
      };
    }

    const hash = createHash('sha256');
    let totalRead = 0;
    let chunksRead = 0;
    if (expectedMaxBytes > 0) {
      const buf = Buffer.allocUnsafe(Math.min(ASYNC_DIGEST_CHUNK_BYTES, expectedMaxBytes));
      while (totalRead < expectedMaxBytes) {
        const toRead = Math.min(buf.byteLength, expectedMaxBytes - totalRead);
        const { bytesRead } = await opened.handle.read(buf, 0, toRead, null);
        if (bytesRead === 0) break;
        hash.update(buf.subarray(0, bytesRead));
        totalRead += bytesRead;
        chunksRead += 1;
        if (chunksRead % ASYNC_DIGEST_YIELD_EVERY_CHUNKS === 0) {
          await yieldToEventLoop();
        }
      }
    }

    const postStat = await opened.handle.stat({ bigint: true });
    if (!postStat.isFile() || !isOwnerOnlyFileMode(Number(postStat.mode))) {
      return { ok: false, error: 'Backup database file changed during digest verification' };
    }
    if (postStat.size > maxBigInt) {
      return {
        ok: false,
        reasonCode: 'RESTORE_IMAGE_BOUND_EXCEEDED',
        error: `Backup database size (${postStat.size.toString()} bytes) exceeds maximum limit (${expectedMaxBytes} bytes)`
      };
    }
    if (
      BigInt(totalRead) !== postStat.size ||
      postStat.dev !== preStat.dev ||
      postStat.ino !== preStat.ino ||
      postStat.mtimeNs !== preStat.mtimeNs
    ) {
      return { ok: false, error: 'Backup database file changed during digest verification' };
    }

    return {
      ok: true,
      byteLength: totalRead,
      sha256: hash.digest('hex'),
      fingerprint: {
        dev: postStat.dev,
        ino: postStat.ino,
        size: postStat.size,
        mtimeNs: postStat.mtimeNs,
        ctimeNs: postStat.ctimeNs
      }
    };
  } catch {
    return {
      ok: false,
      error: 'Backup database file could not be read for digest verification'
    };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

type TargetCompatibilityResult =
  | {
      readonly ok: true;
      readonly targetTables: readonly AuthoritativeRestoreTableName[];
      readonly targetHasEntityTables: boolean;
    }
  | {
      readonly ok: false;
      readonly reasonCode: BackupRestoreRejectionCode;
      readonly message: string;
    };

function verifyTargetCompatibility(
  conn: NodeSqliteConnection,
  validated: Extract<ValidatedBackupImage, { readonly ok: true }>
): TargetCompatibilityResult {
  const targetHasEntityTables =
    hasMainTableInConn(conn, 'operational_queue_meta') &&
    hasMainTableInConn(conn, 'operational_tasks') &&
    hasMainTableInConn(conn, 'operational_runs');

  if (validated.backupHasAllEntityTables && !targetHasEntityTables) {
    return {
      ok: false,
      reasonCode: 'UNSUPPORTED_SCHEMA_VERSION',
      message: 'Target database lacks schema-9 per-entity operational tables required by backup'
    };
  }

  const targetTables = AUTHORITATIVE_RESTORE_TABLES.filter((table) =>
    hasMainTableInConn(conn, table)
  );
  const targetTableSet = new Set(targetTables);
  for (const [table, meta] of validated.tables) {
    if (!targetTableSet.has(table)) {
      return {
        ok: false,
        reasonCode: 'BACKUP_OPEN_FAILED',
        message: `Target database is missing required table '${table}'`
      };
    }
    const targetColumns = new Set(getMainTableColumns(conn, table));
    const missingColumn = meta.columns.find((column) => !targetColumns.has(column));
    if (missingColumn !== undefined) {
      return {
        ok: false,
        reasonCode: 'BACKUP_OPEN_FAILED',
        message: `Target database is missing required column '${table}.${missingColumn}'`
      };
    }
  }
  return { ok: true, targetTables, targetHasEntityTables };
}

function verifyBackupUnchangedBeforeAttach(
  validated: Extract<ValidatedBackupImage, { readonly ok: true }>
):
  | { readonly ok: true }
  | { readonly ok: false; readonly reasonCode: BackupRestoreRejectionCode; readonly message: string } {
  const pathCheck = validateBackupPathBeforeOpen(
    validated.resolvedPath,
    validated.trustedRootDir,
    validated.bounds.maxDatabaseBytes,
    validated.bounds.maxManifestBytes
  );
  if (!pathCheck.ok) {
    return {
      ok: false,
      reasonCode: pathCheck.reasonCode ?? 'BACKUP_OPEN_FAILED',
      message: pathCheck.error
    };
  }
  const currentFingerprint = statFileFingerprintSync(validated.resolvedPath);
  if (
    currentFingerprint === null ||
    (validated.fingerprint !== null && !fingerprintsMatch(validated.fingerprint, currentFingerprint))
  ) {
    return {
      ok: false,
      reasonCode: 'DATABASE_DIGEST_MISMATCH',
      message: 'Backup database file changed before attach; restore aborted'
    };
  }
  return { ok: true };
}

interface AttachedCopyStats {
  readonly restoredRunCount: number;
  readonly restoredTableCount: number;
  readonly restoredRowCount: number;
  readonly restoredOperational: RestoredOperationalCounts;
}

type AttachedCopyInTxResult =
  | { readonly ok: true; readonly stats: AttachedCopyStats }
  | {
      readonly ok: false;
      readonly reasonCode: BackupRestoreRejectionCode;
      readonly message: string;
    };

/**
 * Executes SQLite-native `DELETE` + `INSERT INTO main."T" SELECT ... FROM backup_src."T"`
 * across `AUTHORITATIVE_RESTORE_TABLES`, restores `sqlite_sequence`, performs optional
 * schema-8 operational backfill, recreates triggers, and runs `PRAGMA main.foreign_key_check`
 * inside an open `BEGIN IMMEDIATE` transaction. Caller owns `COMMIT`/`ROLLBACK`.
 */
function copyAttachedTablesInTx(
  conn: NodeSqliteConnection,
  nowMs: () => number,
  targetTables: readonly AuthoritativeRestoreTableName[],
  validated: Extract<ValidatedBackupImage, { readonly ok: true }>,
  targetHasEntityTables: boolean
): AttachedCopyInTxResult {
  conn.exec('PRAGMA defer_foreign_keys = ON');

  const savedTriggers = conn.all<{ name: string; sql: string }>(
    `SELECT name, sql FROM main.sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL ORDER BY name ASC`
  );
  for (const trig of savedTriggers) {
    const safeTrigName = assertSafeSqlIdentifier(trig.name, 'trigger');
    conn.exec(`DROP TRIGGER main."${safeTrigName}"`);
  }

  let restoredTableCount = 0;
  let restoredRowCount = 0;

  // Remove stale parents before inserting replacement children (ON DELETE fires immediately).
  for (const table of targetTables) {
    const safeTable = assertSafeSqlIdentifier(table, 'table');
    conn.run(`DELETE FROM main."${safeTable}"`);
    restoredTableCount += 1;
  }

  for (const table of targetTables) {
    const meta = validated.tables.get(table);
    if (!meta || meta.columns.length === 0) continue;
    const safeTable = assertSafeSqlIdentifier(table, 'table');
    const quotedCols = meta.columns.map((c) => `"${c}"`).join(', ');
    const res = conn.run(
      `INSERT INTO main."${safeTable}" (${quotedCols}) SELECT ${quotedCols} FROM backup_src."${safeTable}"`
    );
    restoredRowCount += res.changes;
  }

  if (hasMainTableInConn(conn, 'sqlite_sequence')) {
    for (const { name } of conn.all<{ name: string }>(`SELECT name FROM main.sqlite_sequence`)) {
      if (AUTHORITATIVE_TABLE_SET.has(name)) {
        conn.run(`DELETE FROM main.sqlite_sequence WHERE name = ?`, name);
      }
    }
    if (hasAttachedTableInConn(conn, 'sqlite_sequence')) {
      const backupSeqRows = conn.all<{ name: string; seq: number }>(
        `SELECT name, seq FROM backup_src.sqlite_sequence`
      );
      for (const seqEntry of backupSeqRows) {
        if (AUTHORITATIVE_TABLE_SET.has(seqEntry.name) && Number.isSafeInteger(seqEntry.seq)) {
          conn.run(
            `INSERT INTO main.sqlite_sequence (name, seq) VALUES (?, ?)`,
            seqEntry.name,
            seqEntry.seq
          );
        }
      }
    }
  }

  if (targetHasEntityTables && !validated.backupHasAllEntityTables) {
    try {
      backfillOperationalEntitiesInTx(conn, nowMs());
    } catch {
      return {
        ok: false,
        reasonCode: 'BACKUP_OPEN_FAILED',
        message: 'Failed to backfill legacy operational documents into schema-9 tables'
      };
    }
  }

  for (const trig of savedTriggers) {
    conn.exec(trig.sql);
  }

  const postFkViolations = conn.all<Record<string, unknown>>('PRAGMA main.foreign_key_check');
  if (postFkViolations.length > 0) {
    return {
      ok: false,
      reasonCode: 'FOREIGN_KEY_CHECK_FAILED',
      message: `Restored state failed PRAGMA foreign_key_check with ${postFkViolations.length} violation(s)`
    };
  }

  const restoredOperational: RestoredOperationalCounts = {
    queueMetaCount: targetHasEntityTables
      ? Number(conn.scalar(`SELECT COUNT(*) FROM main.operational_queue_meta`) ?? 0)
      : 0,
    taskCount: targetHasEntityTables
      ? Number(conn.scalar(`SELECT COUNT(*) FROM main.operational_tasks`) ?? 0)
      : 0,
    operationalRunCount: targetHasEntityTables
      ? Number(conn.scalar(`SELECT COUNT(*) FROM main.operational_runs`) ?? 0)
      : 0,
    kvDocumentCount: hasMainTableInConn(conn, 'operational_kv_documents')
      ? Number(conn.scalar(`SELECT COUNT(*) FROM main.operational_kv_documents`) ?? 0)
      : 0,
    cutoverSentinelCount: hasMainTableInConn(conn, 'cutover_sentinel')
      ? Number(conn.scalar(`SELECT COUNT(*) FROM main.cutover_sentinel`) ?? 0)
      : 0
  };
  const restoredRunCount = Number(conn.scalar(`SELECT COUNT(*) FROM main.runs`) ?? 0);

  return {
    ok: true,
    stats: {
      restoredRunCount,
      restoredTableCount,
      restoredRowCount,
      restoredOperational
    }
  };
}

function rollbackQuietly(conn: NodeSqliteConnection): void {
  try {
    conn.exec('ROLLBACK');
  } catch {
    // Ignore rollback error when transaction is already rolled back or closed.
  }
}

function detachBackupSrcQuietly(conn: NodeSqliteConnection): void {
  try {
    conn.exec('DETACH DATABASE backup_src');
  } catch {
    // Ignore detach failure when connection is closed or alias is already detached.
  }
}

function rejectPreCommit(
  reasonCode: BackupRestoreRejectionCode,
  message: string
): Extract<RestoreValidationOutcome, { readonly status: 'rejected' }> {
  return { status: 'rejected', outcome: 'refused_pre_commit', reasonCode, message };
}

async function checkAsyncFences(
  fences: RestoreFenceCallbacks | undefined,
  stage: 'post_validation' | 'pre_commit'
): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly reasonCode: 'RESTORE_OWNERSHIP_LOST' | 'RESTORE_BUSY'; readonly message: string }
> {
  if (!fences) return { ok: true };
  if (fences.hasPrimacy) {
    let owns = false;
    try {
      owns = Boolean(await fences.hasPrimacy());
    } catch {
      // Fail closed when primacy probe cannot answer.
      owns = false;
    }
    if (!owns) {
      return {
        ok: false,
        reasonCode: 'RESTORE_OWNERSHIP_LOST',
        message:
          stage === 'pre_commit'
            ? 'Workspace ownership was lost immediately before restore commit; transaction rolled back cleanly'
            : 'Workspace ownership was lost during backup validation; restore refused before mutating store'
      };
    }
  }
  if (fences.hasInFlightRun?.()) {
    return {
      ok: false,
      reasonCode: 'RESTORE_BUSY',
      message:
        stage === 'pre_commit'
          ? 'An in-flight Run started before restore commit; transaction rolled back cleanly'
          : 'An in-flight Run started during backup validation; restore refused before mutating store'
    };
  }
  if (stage === 'pre_commit' && fences.beforeCommitFence) {
    let allowed = false;
    try {
      allowed = Boolean(await fences.beforeCommitFence());
    } catch {
      // Fail closed when pre-commit fence probe throws.
      allowed = false;
    }
    if (!allowed) {
      return {
        ok: false,
        reasonCode: 'RESTORE_OWNERSHIP_LOST',
        message:
          'Pre-commit ownership fence failed immediately before restore commit; transaction rolled back cleanly'
      };
    }
  }
  return { ok: true };
}

/**
 * Synchronous SQLite-native `ATTACH` + `INSERT INTO ... SELECT` atomic restore.
 */
export function executeAttachedRestoreSync(
  conn: NodeSqliteConnection,
  nowMs: () => number,
  validated: Extract<ValidatedBackupImage, { readonly ok: true }>,
  fences?: SyncRestoreFenceCallbacks
): RestoreValidationOutcome {
  const compat = verifyTargetCompatibility(conn, validated);
  if (!compat.ok) return rejectPreCommit(compat.reasonCode, compat.message);
  if (fences?.hasInFlightRun?.()) {
    return rejectPreCommit('RESTORE_BUSY', 'An in-flight Run is active; restore refused before mutating store');
  }
  const unchanged = verifyBackupUnchangedBeforeAttach(validated);
  if (!unchanged.ok) return rejectPreCommit(unchanged.reasonCode, unchanged.message);

  conn.run('ATTACH DATABASE ? AS backup_src', validated.resolvedPath);
  try {
    let txOpen = false;
    conn.exec('BEGIN IMMEDIATE');
    txOpen = true;
    try {
      const copied = copyAttachedTablesInTx(
        conn,
        nowMs,
        compat.targetTables,
        validated,
        compat.targetHasEntityTables
      );
      if (!copied.ok) {
        rollbackQuietly(conn);
        txOpen = false;
        return rejectPreCommit(copied.reasonCode, copied.message);
      }
      if (fences?.hasInFlightRun?.()) {
        rollbackQuietly(conn);
        txOpen = false;
        return rejectPreCommit(
          'RESTORE_BUSY',
          'An in-flight Run started before restore commit; transaction rolled back cleanly'
        );
      }
      if (fences?.beforeCommitFence) {
        let allowed = false;
        try {
          allowed = Boolean(fences.beforeCommitFence());
        } catch {
          // Fail closed when pre-commit fence probe throws.
          allowed = false;
        }
        if (!allowed) {
          rollbackQuietly(conn);
          txOpen = false;
          return rejectPreCommit(
            'RESTORE_OWNERSHIP_LOST',
            'Pre-commit ownership fence failed immediately before restore commit; transaction rolled back cleanly'
          );
        }
      }
      conn.exec('COMMIT');
      txOpen = false;
      return {
        status: 'restored',
        outcome: 'restored',
        restoredRunCount: copied.stats.restoredRunCount,
        restoredTableCount: copied.stats.restoredTableCount,
        restoredRowCount: copied.stats.restoredRowCount,
        restoredOperational: copied.stats.restoredOperational,
        verifiedExternalDependencies: validated.verifiedExternalDependencies,
        schemaVersion: validated.dbSchemaVersion
      };
    } catch (err) {
      if (txOpen) rollbackQuietly(conn);
      throw err;
    }
  } finally {
    detachBackupSrcQuietly(conn);
  }
}

/**
 * Asynchronous SQLite-native `ATTACH` + `INSERT INTO ... SELECT` atomic restore with
 * post-validation and immediate pre-`COMMIT` ownership/idle fencing.
 */
export async function executeAttachedRestoreAsync(
  conn: NodeSqliteConnection,
  nowMs: () => number,
  validated: Extract<ValidatedBackupImage, { readonly ok: true }>,
  fences?: RestoreFenceCallbacks
): Promise<RestoreValidationOutcome> {
  const compat = verifyTargetCompatibility(conn, validated);
  if (!compat.ok) return rejectPreCommit(compat.reasonCode, compat.message);

  const postValFence = await checkAsyncFences(fences, 'post_validation');
  if (!postValFence.ok) return rejectPreCommit(postValFence.reasonCode, postValFence.message);

  const unchanged = verifyBackupUnchangedBeforeAttach(validated);
  if (!unchanged.ok) return rejectPreCommit(unchanged.reasonCode, unchanged.message);

  const runOnConnection = async (
    restoreConn: NodeSqliteConnection
  ): Promise<RestoreValidationOutcome> => {
    restoreConn.run('ATTACH DATABASE ? AS backup_src', validated.resolvedPath);
    try {
      let txOpen = false;
      restoreConn.exec('BEGIN IMMEDIATE');
      txOpen = true;
      try {
        const copied = copyAttachedTablesInTx(
          restoreConn,
          nowMs,
          compat.targetTables,
          validated,
          compat.targetHasEntityTables
        );
        if (!copied.ok) {
          rollbackQuietly(restoreConn);
          txOpen = false;
          return rejectPreCommit(copied.reasonCode, copied.message);
        }
        const preCommitFence = await checkAsyncFences(fences, 'pre_commit');
        if (!preCommitFence.ok) {
          rollbackQuietly(restoreConn);
          txOpen = false;
          return rejectPreCommit(preCommitFence.reasonCode, preCommitFence.message);
        }
        restoreConn.exec('COMMIT');
        txOpen = false;
        return {
          status: 'restored',
          outcome: 'restored',
          restoredRunCount: copied.stats.restoredRunCount,
          restoredTableCount: copied.stats.restoredTableCount,
          restoredRowCount: copied.stats.restoredRowCount,
          restoredOperational: copied.stats.restoredOperational,
          verifiedExternalDependencies: validated.verifiedExternalDependencies,
          schemaVersion: validated.dbSchemaVersion
        };
      } catch (err) {
        if (txOpen) rollbackQuietly(restoreConn);
        throw err;
      }
    } finally {
      detachBackupSrcQuietly(restoreConn);
    }
  };

  // Run disk-backed async restores on a dedicated short-lived connection so awaiting the
  // immediate pre-COMMIT primacy/idle fence never leaves `BEGIN IMMEDIATE` or `ATTACH` open
  // on the shared `writerConnection` and never exposes uncommitted restored rows to readers.
  const canOpenDedicatedConn =
    typeof conn.databasePath === 'string' &&
    conn.databasePath.length > 0 &&
    conn.databasePath !== ':memory:';
  if (canOpenDedicatedConn) {
    const dedicated = new NodeSqliteConnection({
      databasePath: conn.databasePath,
      readOnly: false,
      journalMode: conn.verifiedPragmas.journalMode,
      busyTimeoutMs: conn.verifiedPragmas.busyTimeoutMs
    });
    try {
      return await runOnConnection(dedicated);
    } finally {
      dedicated.close();
    }
  }
  return await withMemoryRestoreLock(conn, () => runOnConnection(conn));
}
