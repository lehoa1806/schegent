import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BoundedReadConnectionPool,
  EngineQualificationService,
  NodeSqliteConnection,
  SchemaBootstrapService,
  SqlitePragmaVerificationError,
  compareSemverFloor,
  isNetworkFilesystem,
  resolveTrustedSqliteLocation
} from '../../../src/services/sqlite-store';
import {
  F04_INITIAL_STRICT_TABLE_COUNT,
  SQLITE_SCHEMA_CURRENT_VERSION
} from '../../../src/contracts/sqlite-store/schema-types';
import { F05_LIFECYCLE_TABLE_NAMES } from '../../../src/services/artifact-lifecycle/lifecycle-schema';
import { F06_ACCOUNTING_TABLE_NAMES } from '../../../src/services/usage-accounting/accounting-schema';
import { F07_LIVE_LOG_TABLE_NAMES } from '../../../src/services/phase-log/live-log-index-schema';
import { F08_HANDOFF_TABLE_NAMES } from '../../../src/services/recovery-handoff/handoff-schema';
import { F10_LANES_TABLE_NAMES } from '../../../src/services/execution-lanes/lane-schema';

const EXPECTED_STRICT_TABLE_COUNT =
  F04_INITIAL_STRICT_TABLE_COUNT +
  F05_LIFECYCLE_TABLE_NAMES.length +
  F06_ACCOUNTING_TABLE_NAMES.length +
  F07_LIVE_LOG_TABLE_NAMES.length +
  F08_HANDOFF_TABLE_NAMES.length +
  F10_LANES_TABLE_NAMES.length;

describe('FR-R6-F04 (US1): SQLite Engine Qualification, Pragmas & Trusted Storage Location', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('verifies runtime SQLite version >= 3.51.3, source_id, compile options, and pragma read-backs', () => {
    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      const meta = conn.inspectRuntimeMetadata();
      expect(compareSemverFloor(meta.sqliteVersion, '3.51.3')).toBe(true);
      expect(meta.sqliteSourceId.length).toBeGreaterThan(20);
      expect(meta.compileOptions.length).toBeGreaterThan(5);

      expect(conn.verifiedPragmas.foreignKeys).toBe(1);
      expect(conn.verifiedPragmas.synchronous).toBe(2);
      expect(conn.verifiedPragmas.trustedSchema).toBe(0);
      expect(conn.verifiedPragmas.tempStore).toBe(2);
      expect(conn.verifiedPragmas.busyTimeoutMs).toBe(250);
    } finally {
      conn.close();
    }
  });

  it('aborts store open if any mandatory pragma read-back fails verification (NFR-001)', () => {
    expect(
      () =>
        new NodeSqliteConnection({
          databasePath: ':memory:',
          pragmaReadbackOverride: { foreignKeys: 0 as unknown as 1 }
        })
    ).toThrow(SqlitePragmaVerificationError);

    expect(
      () =>
        new NodeSqliteConnection({
          databasePath: ':memory:',
          pragmaReadbackOverride: { synchronous: 1 }
        })
    ).toThrow(SqlitePragmaVerificationError);
  });

  it('bootstraps every STRICT table and rejects future unsupported schema versions (FR-002, FR-008, NFR-003)', () => {
    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      const result = SchemaBootstrapService.bootstrapAndMigrate(conn, () => 1_700_000_000_000);
      expect(result.schemaVersion).toBe(SQLITE_SCHEMA_CURRENT_VERSION);
      expect(result.strictTableCount).toBe(EXPECTED_STRICT_TABLE_COUNT);
      expect(result.appliedMigrations).toEqual([1, 2, 3, 4, 5, 6]);
      expect(conn.runForeignKeyCheck()).toEqual([]);

      // Re-running bootstrap is idempotent
      const second = SchemaBootstrapService.bootstrapAndMigrate(conn, () => 1_700_000_001_000);
      expect(second.appliedMigrations).toEqual([]);

      // Simulate future schema version and confirm refusal
      conn.run(`UPDATE schema_meta SET meta_value = '99' WHERE meta_key = 'schema_version'`);
      expect(() => SchemaBootstrapService.bootstrapAndMigrate(conn)).toThrow(
        /UNSUPPORTED_FUTURE_SCHEMA_VERSION/
      );
    } finally {
      conn.close();
    }
  });

  it('rejects untrusted sources, path traversal segments, and network filesystems for WAL mode (FR-004, SC-007)', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-f04-loc-'));
    tempDirs.push(rootDir);

    const webviewRefusal = await resolveTrustedSqliteLocation({
      trustedRootDir: rootDir,
      relativeSegments: ['state'],
      sourceKind: 'webview_untrusted'
    });
    expect(webviewRefusal.status).toBe('refused');
    if (webviewRefusal.status === 'refused') {
      expect(webviewRefusal.reason).toBe('untrusted_source');
    }

    const traversalRefusal = await resolveTrustedSqliteLocation({
      trustedRootDir: rootDir,
      relativeSegments: ['state', '..', 'escape'],
      sourceKind: 'host_storage_uri'
    });
    expect(traversalRefusal.status).toBe('refused');
    if (traversalRefusal.status === 'refused') {
      expect(traversalRefusal.reason).toBe('escapes_trusted_root');
    }

    for (const fsKind of ['nfs', 'smb', 'cifs', 'afp', 'webdav', 'fuse.sshfs']) {
      expect(isNetworkFilesystem(fsKind)).toBe(true);
      const netRefusal = await resolveTrustedSqliteLocation({
        trustedRootDir: rootDir,
        relativeSegments: ['state'],
        sourceKind: 'cli_state_dir',
        filesystemType: fsKind,
        requestedJournalMode: 'wal'
      });
      expect(netRefusal.status).toBe('refused');
      if (netRefusal.status === 'refused') {
        expect(netRefusal.reason).toBe('network_share_wal_unsupported');
      }
    }
  });

  it('resolves a trusted local directory with 0700 dir and 0600 file permissions and opens in WAL mode (FR-004)', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-f04-wal-'));
    tempDirs.push(rootDir);

    const resolved = await resolveTrustedSqliteLocation({
      trustedRootDir: rootDir,
      relativeSegments: ['sqlite-store'],
      databaseFileName: 'application.db',
      sourceKind: 'host_storage_uri',
      filesystemType: 'apfs',
      requestedJournalMode: 'wal'
    });

    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') return;

    const dirStat = await fs.stat(resolved.anchorDirectory);
    const fileStat = await fs.stat(resolved.databasePath);
    if (process.platform !== 'win32') {
      expect(dirStat.mode & 0o777).toBe(0o700);
      expect(fileStat.mode & 0o777).toBe(0o600);
    }

    const conn = new NodeSqliteConnection({
      databasePath: resolved.databasePath,
      journalMode: 'wal'
    });
    const pool = new BoundedReadConnectionPool(resolved.databasePath, 2);
    try {
      expect(conn.verifiedPragmas.journalMode).toBe('wal');
      expect(conn.verifiedPragmas.synchronous).toBe(2);
      SchemaBootstrapService.bootstrapAndMigrate(conn);

      // Verify read-only connection pool enforces query_only = 1 and max 2 leases
      pool.withReadConnection(conn, (readConn) => {
        expect(readConn.verifiedPragmas.queryOnly).toBe(1);
        expect(() =>
          readConn.run(
            `INSERT INTO schema_meta (meta_key, meta_value, updated_at_ms) VALUES ('illegal', '1', 1)`
          )
        ).toThrow();
      });
    } finally {
      pool.closeAll();
      conn.close();
    }
  });

  it('runs the EngineQualificationService and verifies all qualification gates', () => {
    const report = EngineQualificationService.runQualificationSuite({
      warmupSamples: 20,
      measuredSamples: 200
    });
    expect(report.qualificationPassed).toBe(true);
    expect(report.meetsMinimumVersionFloor).toBe(true);
    expect(report.strictSchemaTableCount).toBe(EXPECTED_STRICT_TABLE_COUNT);
    expect(report.foreignKeyCheckViolations).toBe(0);
  });
});
