/**
 * FR-R7-07 — `state/`-owned SQLite persistence ports for `SqliteOperationalBacking`
 * and `sqlite-operational-rows.ts`.
 *
 * `SqliteApplicationStore` and `NodeSqliteConnection` (in `src/services/sqlite-store/`)
 * satisfy these structural interfaces without `src/state/` value-importing `src/services/`.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * Zero raw `node:fs` write primitives (docs/hard-rules.md rule 69).
 */

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { SQLITE_BUSY_TIMEOUT_MS } from '../contracts/sqlite-store/schema-types';
import {
  openZeroMutationReadOnlySqliteSync,
  toImmutableSqliteUri,
  verifyRegularDbAndSidecarsSync,
  withZeroMutationReadOnlySqlite,
  type ZeroMutationInspectResult
} from '../lib/sqlite-readonly-inspect';

export interface StrictReadOnlyContainment {
  readonly rootDir: string;
  readonly relativeDirSegments: readonly string[];
  readonly dbFileName: string;
}

export interface SqliteConnectionPort {
  exec(sql: string): void;
  run(
    sql: string,
    ...params: SQLInputValue[]
  ): { readonly changes: number | bigint; readonly lastInsertRowid: number | bigint };
  get<T extends Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T | undefined;
  all<T extends Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T[];
  close(): void;
}

export interface LegacyRunRecordInputPort {
  readonly recordKey: string;
  readonly rawJson: string;
}

export interface OperationalMigrationOutcomePort {
  readonly completed: boolean;
  readonly currentStage: string;
  readonly quarantinedRecords: number;
}

export interface SqliteCutoverSentinelPort {
  readonly authority: string;
}

export interface SqliteOperationalStorePort {
  readonly writerConnection: SqliteConnectionPort;
  readonly cutoverGuard: {
    getSentinel(scopeId: string): SqliteCutoverSentinelPort | null | undefined;
  };
  readonly migration: {
    runMigrationThroughRetainSource(input: {
      readonly migrationId: string;
      readonly scopeId: string;
      readonly runRecords: readonly LegacyRunRecordInputPort[];
      readonly importOperationalDocuments: (conn: SqliteConnectionPort) => void;
    }): OperationalMigrationOutcomePort;
  };
  close(): void;
}

export interface DetachedSqliteWriterConfig {
  readonly databasePath: string;
  readonly scopeId: string;
  readonly canWrite: () => boolean;
  readonly openStore: (databasePath: string) => SqliteOperationalStorePort;
}

function readPragmaNumber(db: DatabaseSync, pragmaSql: string, fallback: number): number {
  const row = db.prepare(pragmaSql).get() as Record<string, unknown> | undefined;
  if (!row) return fallback;
  for (const value of Object.values(row)) {
    return Number(value);
  }
  return fallback;
}

function assertReadOnlyPragma(pragmaName: string, expected: number, actual: number): void {
  if (actual !== expected) {
    throw new Error(
      `SQLite read-only pragma verification failed for ${pragmaName}: expected ${String(expected)}, got ${String(actual)}`
    );
  }
}

function applyAndVerifyReadOnlyPragmas(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA trusted_schema = OFF');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA query_only = ON');

  assertReadOnlyPragma('foreign_keys', 1, readPragmaNumber(db, 'PRAGMA foreign_keys', 0));
  assertReadOnlyPragma(
    'busy_timeout',
    SQLITE_BUSY_TIMEOUT_MS,
    readPragmaNumber(db, 'PRAGMA busy_timeout', -1)
  );
  assertReadOnlyPragma('trusted_schema', 0, readPragmaNumber(db, 'PRAGMA trusted_schema', 1));
  assertReadOnlyPragma('temp_store', 2, readPragmaNumber(db, 'PRAGMA temp_store', 0));
  assertReadOnlyPragma('query_only', 1, readPragmaNumber(db, 'PRAGMA query_only', 0));
}

function createSqliteConnectionPort(db: DatabaseSync, ownsLifecycle: boolean): SqliteConnectionPort {
  let closed = false;
  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    run(sql: string, ...params: SQLInputValue[]): { readonly changes: number; readonly lastInsertRowid: number } {
      const result = db.prepare(sql).run(...params);
      return {
        changes: Number(result.changes),
        lastInsertRowid: Number(result.lastInsertRowid)
      };
    },
    get<T extends Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T | undefined {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    all<T extends Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T[] {
      return db.prepare(sql).all(...params) as T[];
    },
    close(): void {
      if (ownsLifecycle && !closed) {
        closed = true;
        db.close();
      }
    }
  };
}

/**
 * Opens an existing SQLite database strictly in read-only mode (`readOnly: true`,
 * `query_only = ON`, `trusted_schema = OFF`) with mandatory PRAGMA read-back verification
 * and symlink-refusing, zero-mutation semantics (`file://...?immutable=1` when `-wal` is
 * absent) so non-primary / untrusted windows can inspect snapshots without creating
 * `-wal`/`-shm` sidecars or importing `src/services/sqlite-store/`.
 */
export function openReadOnlySqliteConnection(
  databasePath: string,
  containment?: StrictReadOnlyContainment
): SqliteConnectionPort {
  let db: DatabaseSync;
  if (containment !== undefined) {
    const opened = openZeroMutationReadOnlySqliteSync(
      containment.rootDir,
      containment.relativeDirSegments,
      containment.dbFileName
    );
    if (opened.kind === 'opened') {
      db = opened.db;
    } else if (opened.kind === 'wal-present') {
      throw new Error('SQLITE_READONLY_WAL_PRESENT_REQUIRES_ASYNC');
    } else {
      throw new Error(
        `SQLITE_READONLY_CONTAINMENT_${opened.kind.toUpperCase()}${
          'reason' in opened ? `:${opened.reason}:${opened.errno}` : ''
        }`
      );
    }
  } else if (databasePath === ':memory:') {
    db = new DatabaseSync(databasePath, {
      open: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      readOnly: true
    });
  } else {
    const sidecars = verifyRegularDbAndSidecarsSync(databasePath);
    const target = sidecars.walPresent ? databasePath : toImmutableSqliteUri(databasePath);
    db = new DatabaseSync(target, {
      open: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      readOnly: true
    });
  }

  try {
    applyAndVerifyReadOnlyPragmas(db);
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the original open/pragma verification error if close also fails.
    }
    throw error;
  }

  return createSqliteConnectionPort(db, true);
}

/**
 * FR-R7-11 (FR-018) — Async strict-contained, zero-mutation read-only SQLite connection
 * helper for passive inspection (including WAL-present databases via private staged copy).
 */
export async function withZeroMutationReadOnlySqliteConnection<T>(
  rootDir: string,
  relativeDirSegments: readonly string[],
  dbFileName: string,
  fn: (conn: SqliteConnectionPort) => T | Promise<T>
): Promise<ZeroMutationInspectResult<T>> {
  return await withZeroMutationReadOnlySqlite(
    rootDir,
    relativeDirSegments,
    dbFileName,
    async (db) => {
      applyAndVerifyReadOnlyPragmas(db);
      return await fn(createSqliteConnectionPort(db, false));
    },
    { queryOnly: true, busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS }
  );
}
