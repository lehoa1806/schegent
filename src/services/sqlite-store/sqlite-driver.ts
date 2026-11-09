/**
 * FR-R6-F04 (F04-A) — SQLite driver wrapper (`node:sqlite` `DatabaseSync`),
 * pragma profile enforcement with mandatory read-back verification, and bounded
 * read-only connection pool (`maxReadConnections = 2`, `query_only = ON`).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * Zero raw `node:fs` write primitives (docs/hard-rules.md rule 69).
 */

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_MAX_READ_CONNECTIONS,
  type VerifiedPragmaState
} from '../../contracts/sqlite-store/schema-types';

export interface SqliteOpenOptions {
  readonly databasePath: string;
  readonly journalMode?: 'wal' | 'delete' | 'memory' | undefined;
  readonly busyTimeoutMs?: number | undefined;
  readonly readOnly?: boolean | undefined;
  /** Optional test hook to simulate pragma read-back mismatch. */
  readonly pragmaReadbackOverride?: Partial<VerifiedPragmaState> | undefined;
}

export interface SqliteRuntimeMetadata {
  readonly sqliteVersion: string;
  readonly sqliteSourceId: string;
  readonly compileOptions: readonly string[];
}

export class SqlitePragmaVerificationError extends Error {
  public readonly code = 'PRAGMA_VERIFICATION_FAILED' as const;
  public readonly pragmaName: string;
  public readonly expected: string | number;
  public readonly actual: string | number | undefined;

  public constructor(pragmaName: string, expected: string | number, actual: string | number | undefined) {
    super(
      `SQLite pragma verification failed for ${pragmaName}: expected ${String(expected)}, got ${String(actual)}`
    );
    this.name = 'SqlitePragmaVerificationError';
    this.pragmaName = pragmaName;
    this.expected = expected;
    this.actual = actual;
  }
}

export class NodeSqliteConnection {
  public readonly db: DatabaseSync;
  public readonly databasePath: string;
  public readonly isReadOnly: boolean;
  public readonly verifiedPragmas: VerifiedPragmaState;
  private closed = false;

  public constructor(options: SqliteOpenOptions) {
    this.databasePath = options.databasePath;
    this.isReadOnly = options.readOnly === true;
    const isMemory = options.databasePath === ':memory:';
    const requestedJournalMode = isMemory ? 'memory' : (options.journalMode ?? 'wal');
    const busyTimeoutMs = options.busyTimeoutMs ?? SQLITE_BUSY_TIMEOUT_MS;

    this.db = new DatabaseSync(options.databasePath, {
      open: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      readOnly: this.isReadOnly
    });

    try {
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      this.db.exec('PRAGMA trusted_schema = OFF');
      this.db.exec('PRAGMA temp_store = MEMORY');

      if (!this.isReadOnly) {
        this.db.exec(`PRAGMA journal_mode = ${requestedJournalMode.toUpperCase()}`);
        this.db.exec('PRAGMA synchronous = FULL');
      } else {
        this.db.exec('PRAGMA query_only = ON');
      }

      this.verifiedPragmas = this.verifyPragmas(
        requestedJournalMode,
        busyTimeoutMs,
        options.pragmaReadbackOverride
      );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private verifyPragmas(
    expectedJournalMode: 'wal' | 'delete' | 'memory',
    expectedBusyTimeoutMs: number,
    override?: Partial<VerifiedPragmaState>
  ): VerifiedPragmaState {
    const rawJournal = String(this.scalar('PRAGMA journal_mode') ?? '').toLowerCase();
    const rawSync = Number(this.scalar('PRAGMA synchronous') ?? -1);
    const rawFk = Number(this.scalar('PRAGMA foreign_keys') ?? 0);
    const rawTimeout = Number(this.scalar('PRAGMA busy_timeout') ?? -1);
    const rawTrusted = Number(this.scalar('PRAGMA trusted_schema') ?? 1);
    const rawTempStore = Number(this.scalar('PRAGMA temp_store') ?? 0);
    const rawQueryOnly = Number(this.scalar('PRAGMA query_only') ?? 0);

    const journalMode = (override?.journalMode ?? rawJournal) as 'wal' | 'memory' | 'delete';
    const synchronous: number = override?.synchronous ?? rawSync;
    const foreignKeys: number = override?.foreignKeys ?? rawFk;
    const busyTimeoutMs: number = override?.busyTimeoutMs ?? rawTimeout;
    const trustedSchema: number = override?.trustedSchema ?? rawTrusted;
    const tempStore: number = override?.tempStore ?? rawTempStore;
    const queryOnly: number = override?.queryOnly ?? rawQueryOnly;

    if (!this.isReadOnly && journalMode !== expectedJournalMode) {
      throw new SqlitePragmaVerificationError('journal_mode', expectedJournalMode, journalMode);
    }
    if (!this.isReadOnly && synchronous !== 2) {
      throw new SqlitePragmaVerificationError('synchronous', 2, synchronous);
    }
    if (foreignKeys !== 1) {
      throw new SqlitePragmaVerificationError('foreign_keys', 1, foreignKeys);
    }
    if (busyTimeoutMs !== expectedBusyTimeoutMs) {
      throw new SqlitePragmaVerificationError('busy_timeout', expectedBusyTimeoutMs, busyTimeoutMs);
    }
    if (trustedSchema !== 0) {
      throw new SqlitePragmaVerificationError('trusted_schema', 0, trustedSchema);
    }
    if (tempStore !== 2) {
      throw new SqlitePragmaVerificationError('temp_store', 2, tempStore);
    }
    const expectedQueryOnly = this.isReadOnly ? 1 : 0;
    if (queryOnly !== expectedQueryOnly) {
      throw new SqlitePragmaVerificationError('query_only', expectedQueryOnly, queryOnly);
    }

    return {
      journalMode,
      synchronous,
      foreignKeys: 1,
      busyTimeoutMs,
      trustedSchema: 0,
      tempStore,
      queryOnly: expectedQueryOnly
    };
  }

  public scalar<T = unknown>(sql: string, ...params: SQLInputValue[]): T | undefined {
    const row = this.db.prepare(sql).get(...params) as Record<string, T> | undefined;
    if (!row) return undefined;
    const keys = Object.keys(row);
    return keys.length > 0 ? row[keys[0]!] : undefined;
  }

  public get<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  public all<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  public run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number | bigint } {
    const res = this.db.prepare(sql).run(...params);
    return {
      changes: Number(res.changes),
      lastInsertRowid: res.lastInsertRowid
    };
  }

  public exec(sql: string): void {
    this.db.exec(sql);
  }

  public inspectRuntimeMetadata(): SqliteRuntimeMetadata {
    const sqliteVersion = String(this.scalar('SELECT sqlite_version()') ?? '');
    const sqliteSourceId = String(this.scalar('SELECT sqlite_source_id()') ?? '');
    const compileRows = this.all<{ compile_option: string }>('PRAGMA compile_options');
    return {
      sqliteVersion,
      sqliteSourceId,
      compileOptions: compileRows.map((r) => r.compile_option)
    };
  }

  public runQuickCheck(): readonly string[] {
    const rows = this.all<{ quick_check: string }>('PRAGMA quick_check');
    return rows.map((r) => r.quick_check);
  }

  public runForeignKeyCheck(): ReadonlyArray<Record<string, unknown>> {
    return this.all<Record<string, unknown>>('PRAGMA foreign_key_check');
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  public isClosed(): boolean {
    return this.closed;
  }
}

export class BoundedReadConnectionPool {
  private readonly databasePath: string;
  private readonly maxConnections: number;
  private readonly connections: Array<NodeSqliteConnection | undefined> = [];
  private activeLeases = 0;

  public constructor(databasePath: string, maxConnections: number = SQLITE_MAX_READ_CONNECTIONS) {
    if (maxConnections < 1 || maxConnections > SQLITE_MAX_READ_CONNECTIONS) {
      throw new Error(`Read connection pool maxConnections must be between 1 and ${SQLITE_MAX_READ_CONNECTIONS}`);
    }
    this.databasePath = databasePath;
    this.maxConnections = maxConnections;
  }

  public getActiveLeaseCount(): number {
    return this.activeLeases;
  }

  public getConnectionCount(): number {
    return this.connections.length;
  }

  /**
   * Executes a synchronous bounded read callback without holding any cursor
   * across async I/O or IPC boundaries (FR-006).
   */
  public withReadConnection<T>(
    fallbackWriterConn: NodeSqliteConnection,
    fn: (conn: NodeSqliteConnection) => T
  ): T {
    if (this.activeLeases >= this.maxConnections) {
      throw new Error(`READ_POOL_EXHAUSTED: active read leases reached cap (${this.maxConnections})`);
    }
    this.activeLeases += 1;
    try {
      if (this.databasePath === ':memory:') {
        return fn(fallbackWriterConn);
      }
      let conn: NodeSqliteConnection | undefined = this.connections[this.activeLeases - 1];
      if (!conn || conn.isClosed()) {
        conn = new NodeSqliteConnection({
          databasePath: this.databasePath,
          readOnly: true
        });
        this.connections[this.activeLeases - 1] = conn;
      }
      return fn(conn);
    } finally {
      this.activeLeases -= 1;
    }
  }

  public closeAll(): void {
    for (const conn of this.connections) {
      conn?.close();
    }
    this.connections.length = 0;
  }
}
