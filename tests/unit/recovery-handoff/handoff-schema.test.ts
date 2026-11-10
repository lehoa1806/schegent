// FR-R6-F08 T004 — migration 5, the recovery handoff store.
//
// WHAT THIS PINS:
//   - migration 5 applies after 1 to 4, once, before 6, and a second bootstrap applies nothing;
//   - five STRICT tables whose CHECK lists still equal the contract constants;
//   - no table has a foreign key to `runs`: keys point only among the five tables;
//   - a manifest over 16,384 bytes cannot be stored, whatever the caller does;
//   - the state census names the new surface.

import { describe, expect, it } from 'vitest';
import {
  DECISION_OUTCOMES,
  DELIVERY_OUTCOMES,
  DELIVERY_OUTCOME_REASONS,
  DELIVERY_TRANSPORTS,
  HANDOFF_CLOSED_REASONS,
  HANDOFF_DECISIONS,
  HANDOFF_PIN_PURPOSES,
  HANDOFF_PIN_STATES,
  HANDOFF_REFERENCE_ROLES,
  HANDOFF_RESOLUTIONS,
  HANDOFF_REVISION_STATUSES,
  HANDOFF_STATES,
  MAX_HANDOFF_MANIFEST_BYTES,
  SESSION_PLANS
} from '../../../src/contracts/recovery-handoff/handoff-types';
import {
  RECOVERY_EFFECT_CERTAINTY_VALUES,
  RECOVERY_WORKSPACE_COVERAGE_VALUES
} from '../../../src/contracts/recovery-envelope';
import { SQLITE_SCHEMA_CURRENT_VERSION } from '../../../src/contracts/sqlite-store/schema-types';
import { STRUCTURED_STATE_CENSUS } from '../../../src/contracts/sqlite-store/state-census';
import {
  F08_HANDOFF_MIGRATION_NAME,
  F08_HANDOFF_MIGRATION_VERSION,
  F08_HANDOFF_TABLE_NAMES
} from '../../../src/services/recovery-handoff/handoff-schema';
import {
  BUILTIN_SCHEMA_MIGRATIONS,
  NodeSqliteConnection,
  SchemaBootstrapService
} from '../../../src/services/sqlite-store';

const NOW = 1_800_000_000_000;
const HANDOFF_ID = 'f'.repeat(64);

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

function insertHandoff(conn: NodeSqliteConnection): void {
  conn.run(
    `INSERT INTO recovery_handoffs (handoff_id, workspace_id, root_execution_id, invocation_id,
       source_attempt_id, state, paused, created_at_ms, updated_at_ms)
     VALUES (?, 'ws-1', 'root-1', 'inv-1', 'att-1', 'preparing', 0, ?, ?)`,
    HANDOFF_ID,
    NOW,
    NOW
  );
}

function insertRevision(conn: NodeSqliteConnection, manifestJson: string): void {
  conn.run(
    `INSERT INTO recovery_handoff_revisions (handoff_id, revision_no, status, cutoff_key,
       execution_revision, usage_revision, fact_cutoff_ms, manifest_version, manifest_json,
       manifest_digest, certainty, coverage)
     VALUES (?, 1, 'draft', ?, 'exec-1', 0, ?, 1, ?, ?, 'uncertain', 'partial')`,
    HANDOFF_ID,
    'c'.repeat(64),
    NOW,
    manifestJson,
    'd'.repeat(64)
  );
}

describe('FR-R6-F08 T004 — migration 5, the recovery handoff store', () => {
  it('is registered as version 5 and applies after 1 to 4, once', () => {
    expect(F08_HANDOFF_MIGRATION_VERSION).toBe(5);
    expect(F08_HANDOFF_MIGRATION_NAME).toBe('005_f08_recovery_handoff');
    expect(SQLITE_SCHEMA_CURRENT_VERSION).toBeGreaterThanOrEqual(F08_HANDOFF_MIGRATION_VERSION);
    expect(BUILTIN_SCHEMA_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6]);
    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      const first = SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
      expect(first.schemaVersion).toBe(6);
      expect(first.appliedMigrations).toEqual([1, 2, 3, 4, 5, 6]);
      const second = SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW + 1);
      expect(second.appliedMigrations).toEqual([]);
      expect(second.schemaVersion).toBe(6);
    } finally {
      conn.close();
    }
  });

  it('upgrades a version 4 store by applying migrations 5 and 6', () => {
    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      const upToFour = BUILTIN_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 4);
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW, upToFour);
      const result = SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW + 1);
      expect(result.appliedMigrations).toEqual([5, 6]);
      expect(result.schemaVersion).toBe(6);
    } finally {
      conn.close();
    }
  });

  it('creates five STRICT tables whose CHECK lists equal the contract constants', () => {
    withConn((conn) => {
      for (const name of F08_HANDOFF_TABLE_NAMES) {
        expect(tableSql(conn, name), name).toMatch(/\)\s*STRICT$/);
      }
      const handoffs = tableSql(conn, 'recovery_handoffs');
      expect(checkList(handoffs, 'state')).toEqual([...HANDOFF_STATES]);
      expect(checkList(handoffs, 'closed_reason')).toEqual([...HANDOFF_CLOSED_REASONS]);
      expect(checkList(handoffs, 'pin_purpose')).toEqual([...HANDOFF_PIN_PURPOSES]);
      expect(checkList(handoffs, 'pin_purpose_target')).toEqual([...HANDOFF_PIN_PURPOSES]);

      const revisions = tableSql(conn, 'recovery_handoff_revisions');
      expect(checkList(revisions, 'status')).toEqual([...HANDOFF_REVISION_STATUSES]);
      expect(checkList(revisions, 'certainty')).toEqual([...RECOVERY_EFFECT_CERTAINTY_VALUES]);
      expect(checkList(revisions, 'coverage')).toEqual([...RECOVERY_WORKSPACE_COVERAGE_VALUES]);

      const references = tableSql(conn, 'recovery_handoff_references');
      expect(checkList(references, 'role')).toEqual([...HANDOFF_REFERENCE_ROLES]);
      expect(checkList(references, 'pin_state')).toEqual([...HANDOFF_PIN_STATES]);
      expect(checkList(references, 'last_resolution')).toEqual([...HANDOFF_RESOLUTIONS]);

      const deliveries = tableSql(conn, 'recovery_handoff_deliveries');
      expect(checkList(deliveries, 'transport')).toEqual([...DELIVERY_TRANSPORTS]);
      expect(checkList(deliveries, 'session_plan')).toEqual([...SESSION_PLANS]);
      expect(checkList(deliveries, 'outcome')).toEqual([...DELIVERY_OUTCOMES]);
      expect(checkList(deliveries, 'outcome_reason')).toEqual([...DELIVERY_OUTCOME_REASONS]);

      const decisions = tableSql(conn, 'recovery_handoff_decisions');
      expect(checkList(decisions, 'decision')).toEqual([...HANDOFF_DECISIONS]);
      expect(checkList(decisions, 'outcome')).toEqual([...DECISION_OUTCOMES]);
    });
  });

  it('has no foreign key to runs; keys point only among the five tables', () => {
    withConn((conn) => {
      const own = new Set<string>(F08_HANDOFF_TABLE_NAMES);
      for (const name of F08_HANDOFF_TABLE_NAMES) {
        const keys = conn.all<{ table: string }>(`SELECT "table" FROM pragma_foreign_key_list(?)`, name);
        for (const key of keys) {
          expect(own.has(key.table), `${name} -> ${key.table}`).toBe(true);
        }
      }
    });
  });

  it('refuses a manifest over the byte bound at the store', () => {
    withConn((conn) => {
      insertHandoff(conn);
      expect(() => insertRevision(conn, 'x'.repeat(MAX_HANDOFF_MANIFEST_BYTES + 1))).toThrow(/CHECK/);
      insertRevision(conn, 'x'.repeat(MAX_HANDOFF_MANIFEST_BYTES));
      expect(conn.get<{ n: number }>(`SELECT count(*) AS n FROM recovery_handoff_revisions`)?.n).toBe(1);
    });
  });

  it('allows one handoff per lineage', () => {
    withConn((conn) => {
      insertHandoff(conn);
      expect(() =>
        conn.run(
          `INSERT INTO recovery_handoffs (handoff_id, workspace_id, root_execution_id, invocation_id,
             source_attempt_id, state, paused, created_at_ms, updated_at_ms)
           VALUES (?, 'ws-1', 'root-1', 'inv-1', 'att-1', 'preparing', 0, ?, ?)`,
          'e'.repeat(64),
          NOW,
          NOW
        )
      ).toThrow(/UNIQUE/);
    });
  });

  it('names the recovery-handoffs surface in the state census', () => {
    const row = STRUCTURED_STATE_CENSUS.find((entry) => entry.surfaceId === 'recovery-handoffs');
    expect(row?.classification).toBe('sqlite-authoritative');
    expect(row?.owningFeature).toBe('F08');
    expect(row?.executionAffecting).toBe(true);
    expect([...(row?.targetTables ?? [])].sort()).toEqual([...F08_HANDOFF_TABLE_NAMES].sort());
  });
});
