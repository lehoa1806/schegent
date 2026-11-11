/**
 * FR-R6-F06 (T007, FR-014, NFR-004) — migration 3 creates the accounting tables, every one
 * STRICT, and its spelled-out CHECK lists still equal the contract constants.
 */
import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_OUTCOMES,
  CACHE_RELATIONS,
  COMPLETENESS_VALUES,
  CORRECTION_ACTORS,
  COUNTER_SCOPES,
  DISPOSITIONS,
  EPOCH_STATES,
  GAP_KINDS,
  INTENT_STATES,
  MEASURES,
  PROVENANCE_VALUES,
  RECONCILIATIONS,
  REVISION_CAUSES,
  ROOT_OUTCOMES,
  SOURCE_KINDS
} from '../../../src/contracts/usage-accounting/accounting-types';
import { SQLITE_SCHEMA_CURRENT_VERSION } from '../../../src/contracts/sqlite-store/schema-types';
import { STRUCTURED_STATE_CENSUS } from '../../../src/contracts/sqlite-store/state-census';
import {
  F06_ACCOUNTING_MIGRATION_NAME,
  F06_ACCOUNTING_MIGRATION_VERSION,
  F06_ACCOUNTING_TABLE_NAMES
} from '../../../src/services/usage-accounting/accounting-schema';
import {
  BUILTIN_SCHEMA_MIGRATIONS,
  NodeSqliteConnection,
  SchemaBootstrapService
} from '../../../src/services/sqlite-store';

const NOW = 1_800_000_000_000;
const DIGEST = 'b'.repeat(64);
const F04_RUN_TABLE_PATTERN = /REFERENCES\s+(?!accounting_)/;

function openMigrated(): NodeSqliteConnection {
  const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
  return conn;
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

function insertObservation(conn: NodeSqliteConnection, id: string, seq: number): void {
  conn.run(
    `INSERT INTO accounting_observations (
      observation_id, ingest_seq, dedup_key, content_digest, producer_namespace, source_kind,
      source_identity, observation_revision, workspace_id, root_id, attempt_id, counter_scope,
      adapter_version, normalization_version, event_utc, observed_utc, ingested_utc,
      ingested_monotonic_ms, clock_anomaly, disposition
    ) VALUES (?, ?, ?, ?, 'schegent.phase-end/1', 'phase-end', 'run-1/p1/a1/0', 1, 'ws', 'run-1',
      'att-1', 'invocation-delta', 'claude/1', 1, '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z',
      '2026-11-10T00:00:00Z', 1, 0, 'accepted')`,
    id,
    seq,
    `dedup-${id}`,
    DIGEST
  );
}

function insertAttempt(conn: NodeSqliteConnection): void {
  conn.run(
    `INSERT INTO accounting_attempts (attempt_id, root_id, workspace_id, first_event_utc, last_event_utc)
     VALUES ('att-1', 'run-1', 'ws', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z')`
  );
}

function insertContribution(
  conn: NodeSqliteConnection,
  fromRevision: number,
  toRevision: number | null,
  invocationOrdinal: number | null = null
): void {
  conn.run(
    `INSERT INTO accounting_contributions (
      attempt_id, invocation_ordinal, measure, unit, quantity, completeness, provenance, from_revision, to_revision
    ) VALUES ('att-1', ?, 'input_tokens', 'count', 10, 'known', 'provider-reported', ?, ?)`,
    invocationOrdinal,
    fromRevision,
    toRevision
  );
}

describe('FR-R6-F06 migration 3 (T007)', () => {
  it('is registered as version 3 and applies after 1 and 2 on a fresh store', () => {
    expect(F06_ACCOUNTING_MIGRATION_VERSION).toBe(3);
    expect(F06_ACCOUNTING_MIGRATION_NAME).toBe('003_f06_usage_accounting');
    // FR-R6-F07, F08 and F10 added migrations 4 to 6 after this one.
    expect(SQLITE_SCHEMA_CURRENT_VERSION).toBe(8);
    expect(BUILTIN_SCHEMA_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      const result = SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
      expect(result.schemaVersion).toBe(8);
      expect(result.appliedMigrations).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    } finally {
      conn.close();
    }
  });

  it('upgrades a version 2 store by applying migration 3 and the later ones', () => {
    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      const upToTwo = BUILTIN_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 2);
      expect(SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW, upToTwo).appliedMigrations).toEqual([1, 2]);
      const result = SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW + 1);
      expect(result.appliedMigrations).toEqual([3, 4, 5, 6, 7, 8]);
      expect(result.schemaVersion).toBe(8);
    } finally {
      conn.close();
    }
  });

  it('creates eleven tables, every one STRICT, with no foreign key into a non-accounting table', () => {
    const conn = openMigrated();
    try {
      expect(F06_ACCOUNTING_TABLE_NAMES).toHaveLength(11);
      for (const name of F06_ACCOUNTING_TABLE_NAMES) {
        const sql = tableSql(conn, name);
        expect(sql, name).toMatch(/\)\s*STRICT$/);
        expect(F04_RUN_TABLE_PATTERN.test(sql), `${name} references a non-accounting table`).toBe(false);
      }
    } finally {
      conn.close();
    }
  });

  it('keeps every spelled-out CHECK list equal to its contract constant', () => {
    const conn = openMigrated();
    try {
      const observations = tableSql(conn, 'accounting_observations');
      expect(checkList(observations, 'source_kind')).toEqual([...SOURCE_KINDS]);
      expect(checkList(observations, 'counter_scope')).toEqual([...COUNTER_SCOPES]);
      expect(checkList(observations, 'disposition')).toEqual([...DISPOSITIONS]);
      expect(checkList(observations, 'uncertainty_reason')).toEqual([...GAP_KINDS]);

      const measures = tableSql(conn, 'accounting_observation_measures');
      expect(checkList(measures, 'measure')).toEqual([...MEASURES]);
      expect(checkList(measures, 'provenance')).toEqual([...PROVENANCE_VALUES]);
      expect(checkList(measures, 'cache_relation')).toEqual([...CACHE_RELATIONS]);
      // An observation is never `conflicting`; that completeness belongs to a contribution.
      expect(checkList(measures, 'completeness')).toEqual(COMPLETENESS_VALUES.filter((v) => v !== 'conflicting'));

      const contributions = tableSql(conn, 'accounting_contributions');
      expect(checkList(contributions, 'measure')).toEqual([...MEASURES]);
      expect(checkList(contributions, 'completeness')).toEqual([...COMPLETENESS_VALUES]);

      expect(checkList(tableSql(conn, 'accounting_corrections'), 'measure')).toEqual([...MEASURES]);
      expect(checkList(tableSql(conn, 'accounting_corrections'), 'actor')).toEqual([...CORRECTION_ACTORS]);
      expect(checkList(tableSql(conn, 'accounting_attempts'), 'outcome')).toEqual([...ATTEMPT_OUTCOMES]);
      expect(checkList(tableSql(conn, 'accounting_root_outcomes'), 'outcome')).toEqual([...ROOT_OUTCOMES]);
      expect(checkList(tableSql(conn, 'accounting_revisions'), 'cause')).toEqual([...REVISION_CAUSES]);
      expect(checkList(tableSql(conn, 'accounting_projection_intents'), 'state')).toEqual([...INTENT_STATES]);
      expect(checkList(tableSql(conn, 'accounting_gaps'), 'gap_kind')).toEqual([...GAP_KINDS]);
      expect(checkList(tableSql(conn, 'accounting_legacy_epoch'), 'state')).toEqual([...EPOCH_STATES]);
      expect(checkList(tableSql(conn, 'accounting_legacy_epoch'), 'reconciliation')).toEqual([...RECONCILIATIONS]);
    } finally {
      conn.close();
    }
  });

  it('refuses a negative quantity and an unknown measure', () => {
    const conn = openMigrated();
    try {
      insertObservation(conn, 'obs-1', 1);
      expect(() =>
        conn.run(
          `INSERT INTO accounting_observation_measures (observation_id, measure, quantity, unit, completeness, provenance)
           VALUES ('obs-1', 'input_tokens', -1, 'count', 'known', 'provider-reported')`
        )
      ).toThrow(/CHECK/);
      expect(() =>
        conn.run(
          `INSERT INTO accounting_observation_measures (observation_id, measure, quantity, unit, completeness, provenance)
           VALUES ('obs-1', 'reasoning_tokens', 1, 'count', 'known', 'provider-reported')`
        )
      ).toThrow(/CHECK/);
    } finally {
      conn.close();
    }
  });

  it('ties a NULL quantity to unknown completeness and a reason', () => {
    const conn = openMigrated();
    try {
      insertObservation(conn, 'obs-1', 1);
      expect(() =>
        conn.run(
          `INSERT INTO accounting_observation_measures (observation_id, measure, quantity, unit, completeness, provenance)
           VALUES ('obs-1', 'output_tokens', NULL, 'count', 'known', 'provider-reported')`
        )
      ).toThrow(/CHECK/);
      conn.run(
        `INSERT INTO accounting_observation_measures (observation_id, measure, quantity, unit, completeness, provenance, unknown_reason)
         VALUES ('obs-1', 'output_tokens', NULL, 'count', 'unknown', 'provider-reported', 'invalid-counter')`
      );
      expect(conn.scalar(`SELECT count(*) FROM accounting_observation_measures`)).toBe(1);
    } finally {
      conn.close();
    }
  });

  it('refuses a lowercase currency and a cost with a count unit', () => {
    const conn = openMigrated();
    try {
      insertObservation(conn, 'obs-1', 1);
      for (const unit of ['usd', 'count', 'US']) {
        expect(
          () =>
            conn.run(
              `INSERT INTO accounting_observation_measures (observation_id, measure, quantity, unit, reported_scale, completeness, provenance)
               VALUES ('obs-1', 'cost', 1, ?, 6, 'known', 'provider-reported')`,
              unit
            ),
          unit
        ).toThrow(/CHECK/);
      }
      conn.run(
        `INSERT INTO accounting_observation_measures (observation_id, measure, quantity, unit, reported_scale, completeness, provenance)
         VALUES ('obs-1', 'cost', 1, 'USD', 6, 'known', 'provider-reported')`
      );
    } finally {
      conn.close();
    }
  });

  it('refuses an attributed disposition without a root and an attempt', () => {
    const conn = openMigrated();
    try {
      expect(() =>
        conn.run(
          `INSERT INTO accounting_observations (
            observation_id, ingest_seq, content_digest, producer_namespace, source_kind, observation_revision,
            workspace_id, counter_scope, adapter_version, normalization_version, event_utc, observed_utc,
            ingested_utc, ingested_monotonic_ms, clock_anomaly, disposition
          ) VALUES ('obs-x', 1, ?, 'ns', 'phase-end', 1, 'ws', 'invocation-delta', 'v', 1, 't', 't', 't', 1, 0, 'accepted')`,
          DIGEST
        )
      ).toThrow(/CHECK/);
    } finally {
      conn.close();
    }
  });

  it('allows one open contribution per attempt, measure and unit', () => {
    const conn = openMigrated();
    try {
      insertAttempt(conn);
      insertContribution(conn, 1, null);
      expect(() => insertContribution(conn, 2, null)).toThrow(/UNIQUE/);
      conn.run(`UPDATE accounting_contributions SET to_revision = 2 WHERE to_revision IS NULL`);
      insertContribution(conn, 2, null);
      expect(conn.scalar(`SELECT count(*) FROM accounting_contributions`)).toBe(2);
      expect(() => insertContribution(conn, 3, 3)).toThrow(/CHECK/);
    } finally {
      conn.close();
    }
  });

  it('keys an open contribution by invocation too, so two invocations of one attempt both stay open', () => {
    const conn = openMigrated();
    try {
      insertAttempt(conn);
      insertContribution(conn, 1, null, 0);
      insertContribution(conn, 1, null, 1);
      expect(() => insertContribution(conn, 2, null, 1)).toThrow(/UNIQUE/);
      expect(() => insertContribution(conn, 2, null, -1)).toThrow(/CHECK/);
      expect(conn.scalar(`SELECT count(*) FROM accounting_contributions WHERE to_revision IS NULL`)).toBe(2);
    } finally {
      conn.close();
    }
  });

  it('holds at most one legacy epoch row', () => {
    const conn = openMigrated();
    try {
      const insertEpoch = (id: number): void => {
        conn.run(
          `INSERT INTO accounting_legacy_epoch (epoch_id, state, imported_runs, legacy_cost_micros, started_utc)
           VALUES (?, 'importing', 0, 0, '2026-11-10T00:00:00Z')`,
          id
        );
      };
      insertEpoch(1);
      expect(() => insertEpoch(2)).toThrow(/CHECK/);
    } finally {
      conn.close();
    }
  });

  it('cascades measure rows when an observation is deleted', () => {
    const conn = openMigrated();
    try {
      insertObservation(conn, 'obs-1', 1);
      conn.run(
        `INSERT INTO accounting_observation_measures (observation_id, measure, quantity, unit, completeness, provenance)
         VALUES ('obs-1', 'input_tokens', 5, 'count', 'known', 'provider-reported')`
      );
      conn.run(`DELETE FROM accounting_observations WHERE observation_id = 'obs-1'`);
      expect(conn.scalar(`SELECT count(*) FROM accounting_observation_measures`)).toBe(0);
    } finally {
      conn.close();
    }
  });
});

describe('structured-state census (T050, research R14)', () => {
  it('points the usage-and-cost-ledger row at exactly the accounting tables', () => {
    const row = STRUCTURED_STATE_CENSUS.find((entry) => entry.surfaceId === 'usage-and-cost-ledger');
    expect(row?.targetTables).toStrictEqual([...F06_ACCOUNTING_TABLE_NAMES]);
    expect(row?.owningFeature).toBe('F06');
  });
});
