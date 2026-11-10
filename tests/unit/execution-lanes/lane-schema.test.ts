// FR-R6-F10 T003 — migration 6, the execution lanes store.
//
// WHAT THIS PINS:
//   - migration 6 applies after 1 to 5, once, and upgrades a version 5 store alone;
//   - a store at a newer version than this build refuses to open;
//   - eight STRICT tables whose CHECK lists still equal the contract constants;
//   - no table has a foreign key at all, so none points to `runs`;
//   - the partial unique index admits one verifying or landing request per repository (FR-009);
//   - shared column rules: hex identifiers, relative root references, bounded profile JSON;
//   - the state census names the new surface.

import { describe, expect, it } from 'vitest';
import {
  DEPENDENCY_RECIPES,
  INTEGRATION_STATES,
  JOURNAL_KINDS,
  JOURNAL_OUTCOMES,
  LANDING_METHODS,
  LANE_OPERATION_KINDS,
  LANE_OPERATION_STATUSES,
  LANE_STATES,
  RECEIPT_OUTCOMES,
  VERIFICATION_LIMITS
} from '../../../src/contracts/execution-lanes';
import { SQLITE_SCHEMA_CURRENT_VERSION } from '../../../src/contracts/sqlite-store/schema-types';
import { STRUCTURED_STATE_CENSUS } from '../../../src/contracts/sqlite-store/state-census';
import {
  F10_LANES_MIGRATION_NAME,
  F10_LANES_MIGRATION_VERSION,
  F10_LANES_TABLE_NAMES
} from '../../../src/services/execution-lanes/lane-schema';
import {
  BUILTIN_SCHEMA_MIGRATIONS,
  NodeSqliteConnection,
  SchemaBootstrapService
} from '../../../src/services/sqlite-store';

const NOW = 1_800_000_000_000;
const TS = '2026-11-10T10:00:00.000Z';
const LANE_ID = 'a'.repeat(32);
const REPO_ID = 'b'.repeat(64);
const COMMIT = 'c'.repeat(40);

function openMigrated(): NodeSqliteConnection {
  const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
  return conn;
}

function withConn(body: (conn: NodeSqliteConnection) => void): void {
  const conn = openMigrated();
  try {
    body(conn);
  } finally {
    conn.close();
  }
}

function tableSql(conn: NodeSqliteConnection, name: string): string {
  const row = conn.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, name);
  return row?.sql ?? '';
}

/** The quoted values of the first `<column> IN (...)` list in `sql`. */
function checkList(sql: string, column: string): readonly string[] {
  const start = sql.indexOf(`${column} IN (`);
  expect(start, `CHECK list for ${column}`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf(')', start);
  return [...sql.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match.at(1) ?? '');
}

function insertLane(conn: NodeSqliteConnection, overrides: Readonly<Record<string, string>> = {}): void {
  const laneId = overrides['laneId'] ?? LANE_ID;
  conn.run(
    `INSERT INTO execution_lanes (lane_id, workspace_id, repository_id, root_execution_id, source_commit,
       base_ref, candidate_ref, root_ref, dependency_recipe, state, state_reason, pinned,
       owner_generation, created_at, updated_at)
     VALUES (?, 'ws-1', ?, 'root-1', ?, ?, ?, ?, 'none', 'preparing', NULL, 0, 1, ?, ?)`,
    laneId,
    REPO_ID,
    COMMIT,
    `refs/schegent/lanes/${laneId}/base`,
    `refs/schegent/lanes/${laneId}/candidate`,
    overrides['rootRef'] ?? `lanes/ws-1/${laneId}`,
    TS,
    TS
  );
}

function insertRequest(conn: NodeSqliteConnection, requestId: string, state: string, profileJson = '{}'): void {
  conn.run(
    `INSERT INTO lane_integration_requests (request_id, lane_id, workspace_id, repository_id, candidate_id,
       candidate_commit, target_ref, expected_target_commit, profile_id, profile_revision, profile_digest,
       profile_json, state, reason, verification_attempt, owner_generation, created_at, updated_at)
     VALUES (?, ?, 'ws-1', ?, ?, ?, 'refs/heads/main', ?, 'p1', 1, ?, ?, ?, NULL, 0, 1, ?, ?)`,
    requestId,
    LANE_ID,
    REPO_ID,
    'd'.repeat(32),
    COMMIT,
    'e'.repeat(40),
    'f'.repeat(64),
    profileJson,
    state,
    TS,
    TS
  );
}

describe('FR-R6-F10 T003 — migration 6, the execution lanes store', () => {
  it('is registered as version 6 and applies after 1 to 5, once', () => {
    expect(F10_LANES_MIGRATION_VERSION).toBe(6);
    expect(F10_LANES_MIGRATION_NAME).toBe('006_f10_execution_lanes');
    expect(SQLITE_SCHEMA_CURRENT_VERSION).toBe(F10_LANES_MIGRATION_VERSION);
    expect(BUILTIN_SCHEMA_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6]);
    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      const first = SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
      expect(first.schemaVersion).toBe(6);
      expect(first.appliedMigrations).toEqual([1, 2, 3, 4, 5, 6]);
      const second = SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW + 1);
      expect(second.appliedMigrations).toEqual([]);
    } finally {
      conn.close();
    }
  });

  it('upgrades a version 5 store by applying only migration 6', () => {
    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      const upToFive = BUILTIN_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 5);
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW, upToFive);
      const result = SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW + 1);
      expect(result.appliedMigrations).toEqual([6]);
      expect(result.schemaVersion).toBe(6);
    } finally {
      conn.close();
    }
  });

  it('refuses a store at version 7', () => {
    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      const withSeven = [
        ...BUILTIN_SCHEMA_MIGRATIONS,
        { version: 7, name: '007_future', ddlStatements: ['CREATE TABLE IF NOT EXISTS future_t (x INTEGER) STRICT'] }
      ];
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW, withSeven);
      expect(() => SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW + 1)).toThrow();
    } finally {
      conn.close();
    }
  });

  it('creates eight STRICT tables whose CHECK lists equal the contract constants', () => {
    withConn((conn) => {
      expect(F10_LANES_TABLE_NAMES).toHaveLength(8);
      for (const name of F10_LANES_TABLE_NAMES) {
        expect(tableSql(conn, name), name).toMatch(/\)\s*STRICT$/);
      }
      const lanes = tableSql(conn, 'execution_lanes');
      expect(checkList(lanes, 'dependency_recipe')).toEqual([...DEPENDENCY_RECIPES]);
      expect(checkList(lanes, 'state')).toEqual([...LANE_STATES]);

      const operations = tableSql(conn, 'lane_operations');
      expect(checkList(operations, 'kind')).toEqual([...LANE_OPERATION_KINDS]);
      expect(checkList(operations, 'status')).toEqual([...LANE_OPERATION_STATUSES]);

      expect(checkList(tableSql(conn, 'lane_integration_requests'), 'state')).toEqual([...INTEGRATION_STATES]);
      expect(checkList(tableSql(conn, 'lane_review_receipts'), 'outcome')).toEqual([...RECEIPT_OUTCOMES]);

      const journal = tableSql(conn, 'lane_integration_journal');
      expect(checkList(journal, 'kind')).toEqual([...JOURNAL_KINDS]);
      expect(checkList(journal, 'method')).toEqual([...LANDING_METHODS]);
      expect(checkList(journal, 'outcome')).toEqual([...JOURNAL_OUTCOMES]);
    });
  });

  it('has no foreign key in any of the eight tables', () => {
    withConn((conn) => {
      for (const name of F10_LANES_TABLE_NAMES) {
        const keys = conn.all<{ table: string }>(`SELECT "table" FROM pragma_foreign_key_list(?)`, name);
        expect(keys, name).toEqual([]);
      }
    });
  });

  it('admits one verifying or landing request per repository (FR-009)', () => {
    withConn((conn) => {
      insertLane(conn);
      insertRequest(conn, '1'.repeat(32), 'verifying');
      expect(() => insertRequest(conn, '2'.repeat(32), 'landing')).toThrow(/UNIQUE/);
      insertRequest(conn, '3'.repeat(32), 'queued');
      insertRequest(conn, '4'.repeat(32), 'awaiting-review');
      expect(conn.get<{ n: number }>(`SELECT count(*) AS n FROM lane_integration_requests`)?.n).toBe(3);
    });
  });

  it('refuses non-hex identifiers and absolute root references', () => {
    withConn((conn) => {
      expect(() => insertLane(conn, { laneId: 'A'.repeat(32) })).toThrow(/CHECK/);
      expect(() => insertLane(conn, { laneId: 'g'.repeat(32) })).toThrow(/CHECK/);
      expect(() => insertLane(conn, { rootRef: `/tmp/lanes/ws-1/${LANE_ID}` })).toThrow(/CHECK/);
      insertLane(conn);
      expect(conn.get<{ n: number }>(`SELECT count(*) AS n FROM execution_lanes`)?.n).toBe(1);
    });
  });

  it('refuses a profile over the byte bound at the store', () => {
    withConn((conn) => {
      insertLane(conn);
      const over = 'x'.repeat(VERIFICATION_LIMITS.maxProfileJsonBytes + 1);
      expect(() => insertRequest(conn, '5'.repeat(32), 'queued', over)).toThrow(/CHECK/);
      insertRequest(conn, '6'.repeat(32), 'queued', 'x'.repeat(VERIFICATION_LIMITS.maxProfileJsonBytes));
    });
  });

  it('names the execution-lanes surface in the state census', () => {
    const row = STRUCTURED_STATE_CENSUS.find((entry) => entry.surfaceId === 'execution-lanes');
    expect(row?.classification).toBe('sqlite-authoritative');
    expect(row?.owningFeature).toBe('F10');
    expect(row?.executionAffecting).toBe(true);
    expect([...(row?.targetTables ?? [])].sort()).toEqual([...F10_LANES_TABLE_NAMES].sort());
  });
});
