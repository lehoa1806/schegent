// FR-R6-F11 T005 — migration 7, the reporting store.
//
// WHAT THIS PINS:
//   - migration 7 applies after 1 to 6, once, and upgrades a version 6 store alone;
//   - two STRICT tables and four indexes, with CHECK lists equal to the contract constants;
//   - the partial unique index admits one pending export per workspace (NFR-003);
//   - deleting a saved report sets `rerun_of` to NULL in the reports that name it;
//   - the capture statements use the migration 7 indexes (FR-023);
//   - the state census names the new surface.

import { describe, expect, it } from 'vitest';
import { REPORT_VIEWS } from '../../../src/contracts/reporting/report-query';
import { SQLITE_SCHEMA_CURRENT_VERSION } from '../../../src/contracts/sqlite-store/schema-types';
import { STRUCTURED_STATE_CENSUS } from '../../../src/contracts/sqlite-store/state-census';
import {
  F11_REPORTING_INDEX_NAMES,
  F11_REPORTING_MIGRATION_NAME,
  F11_REPORTING_MIGRATION_VERSION,
  F11_REPORTING_TABLE_NAMES
} from '../../../src/services/reporting/reporting-schema';
import { CAPTURE_ATTEMPTS_SQL, CAPTURE_ROOTS_SQL } from '../../../src/services/reporting/snapshot-capture';
import {
  BUILTIN_SCHEMA_MIGRATIONS,
  NodeSqliteConnection,
  SchemaBootstrapService
} from '../../../src/services/sqlite-store';

const NOW = 1_800_000_000_000;

function withConn(body: (conn: NodeSqliteConnection) => void): void {
  const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  try {
    SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
    body(conn);
  } finally {
    conn.close();
  }
}

function tableSql(conn: NodeSqliteConnection, name: string): string {
  const row = conn.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, name);
  return row?.sql ?? '';
}

function checkList(sql: string, column: string): readonly string[] {
  const start = sql.indexOf(`${column} IN (`);
  expect(start, `CHECK list for ${column}`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf(')', start);
  return [...sql.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match.at(1) ?? '');
}

function insertExport(conn: NodeSqliteConnection, exportId: string, state: string): void {
  conn.run(
    `INSERT INTO report_exports (export_id, workspace_id, report_id, format, state, staging_dir, final_name,
       data_partial_name, manifest_partial_name, overwrite, created_at_ms)
     VALUES (?, 'ws-1', ?, 'json', ?, 'anchor', 'r.json', '.r.json.x.data.partial', '.r.json.x.manifest.partial', 0, ?)`,
    exportId,
    'b'.repeat(32),
    state,
    NOW
  );
}

function insertSaved(conn: NodeSqliteConnection, reportId: string, rerunOf: string | null): void {
  conn.run(
    `INSERT INTO report_saved (report_id, workspace_id, rerun_of, view, query_json, manifest_json, manifest_sha256,
       calculation_version, accounting_revision, source_cutoff_ms, population_digest, created_at_ms)
     VALUES (?, 'ws-1', ?, 'usage', '{}', '{}', ?, 1, NULL, ?, ?, ?)`,
    reportId,
    rerunOf,
    'c'.repeat(64),
    NOW,
    'd'.repeat(64),
    NOW
  );
}

function planDetails(conn: NodeSqliteConnection, sql: string, params: readonly (string | number)[]): string {
  const rows = conn.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params);
  return rows.map((row) => row.detail).join('\n');
}

describe('FR-R6-F11 T005 — migration 7, the reporting store', () => {
  it('is registered as version 7 and applies after 1 to 6, once', () => {
    expect(F11_REPORTING_MIGRATION_VERSION).toBe(7);
    expect(F11_REPORTING_MIGRATION_NAME).toBe('007_f11_reporting');
    expect(SQLITE_SCHEMA_CURRENT_VERSION).toBeGreaterThanOrEqual(F11_REPORTING_MIGRATION_VERSION);
    expect(BUILTIN_SCHEMA_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      const first = SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
      expect(first.schemaVersion).toBe(8);
      expect(first.appliedMigrations).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      const second = SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW + 1);
      expect(second.appliedMigrations).toEqual([]);
    } finally {
      conn.close();
    }
  });

  it('upgrades a version 6 store by applying migration 7 and the later ones', () => {
    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      const upToSix = BUILTIN_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 6);
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW, upToSix);
      const result = SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW + 1);
      expect(result.appliedMigrations).toEqual([7, 8]);
      expect(result.schemaVersion).toBe(8);
    } finally {
      conn.close();
    }
  });

  it('creates two STRICT tables and four indexes, with CHECK lists equal to the contract', () => {
    withConn((conn) => {
      for (const name of F11_REPORTING_TABLE_NAMES) {
        expect(tableSql(conn, name), name).toMatch(/\)\s*STRICT$/);
      }
      expect(checkList(tableSql(conn, 'report_saved'), 'view')).toEqual([...REPORT_VIEWS]);
      const exportsSql = tableSql(conn, 'report_exports');
      expect(checkList(exportsSql, 'format')).toEqual(['json', 'csv']);
      expect(checkList(exportsSql, 'state')).toEqual(['pending', 'completed', 'failed', 'cancelled', 'limited']);
      const indexes = conn
        .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?, ?, ?)`,
          ...F11_REPORTING_INDEX_NAMES)
        .map((row) => row.name)
        .sort();
      expect(indexes).toEqual([...F11_REPORTING_INDEX_NAMES].sort());
      expect(F11_REPORTING_INDEX_NAMES).toHaveLength(4);
    });
  });

  it('admits one pending export per workspace, and another once the first leaves pending', () => {
    withConn((conn) => {
      insertExport(conn, '1'.repeat(32), 'pending');
      expect(() => insertExport(conn, '2'.repeat(32), 'pending')).toThrow(/UNIQUE/);
      conn.run(`UPDATE report_exports SET state = 'completed' WHERE export_id = ?`, '1'.repeat(32));
      insertExport(conn, '2'.repeat(32), 'pending');
      expect(() => insertExport(conn, '3'.repeat(32), 'bogus')).toThrow(/CHECK/);
    });
  });

  it('sets rerun_of to NULL when the saved report it names is deleted', () => {
    withConn((conn) => {
      conn.run('PRAGMA foreign_keys = ON');
      insertSaved(conn, 'e'.repeat(32), null);
      insertSaved(conn, 'f'.repeat(32), 'e'.repeat(32));
      conn.run('DELETE FROM report_saved WHERE report_id = ?', 'e'.repeat(32));
      const row = conn.get<{ rerun_of: string | null }>(
        'SELECT rerun_of FROM report_saved WHERE report_id = ?',
        'f'.repeat(32)
      );
      expect(row?.rerun_of).toBeNull();
    });
  });

  it('reads roots and attempts through the migration 7 indexes', () => {
    withConn((conn) => {
      const roots = planDetails(conn, CAPTURE_ROOTS_SQL, ['ws-1', 0, NOW, 10]);
      expect(roots).toContain('idx_runs_workspace_created');
      const attempts = planDetails(conn, CAPTURE_ATTEMPTS_SQL, ['ws-1', 0, NOW, 10]);
      expect(attempts).toContain('idx_runs_workspace_created');
      expect(attempts).toContain('idx_attempts_run');
    });
  });

  it('names the historical-reports surface in the state census', () => {
    const row = STRUCTURED_STATE_CENSUS.find((entry) => entry.surfaceId === 'historical-reports');
    expect(row?.classification).toBe('sqlite-authoritative');
    expect(row?.owningFeature).toBe('F11');
    expect(row?.executionAffecting).toBe(false);
    expect([...(row?.targetTables ?? [])].sort()).toEqual([...F11_REPORTING_TABLE_NAMES].sort());
  });
});
