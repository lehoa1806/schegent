import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_STORE_KINDS,
  F05_REFERENCE_PURPOSES,
  REFERENCE_OWNER_TYPES
} from '../../../src/contracts/artifact-lifecycle/lifecycle-types';
import { ARTIFACT_AVAILABILITY_STATES } from '../../../src/contracts/shared-memory-storage/identity-and-observations';
import { RETENTION_CLASS_IDS } from '../../../src/contracts/shared-memory-storage/consumer-and-retention-inventories';
import {
  F04_INITIAL_STRICT_TABLE_COUNT,
  SQLITE_SCHEMA_CURRENT_VERSION
} from '../../../src/contracts/sqlite-store/schema-types';
import {
  F05_LIFECYCLE_DDL,
  F05_LIFECYCLE_TABLE_NAMES
} from '../../../src/services/artifact-lifecycle/lifecycle-schema';
import { F06_ACCOUNTING_TABLE_NAMES } from '../../../src/services/usage-accounting/accounting-schema';
import { F07_LIVE_LOG_TABLE_NAMES } from '../../../src/services/phase-log/live-log-index-schema';
import { F08_HANDOFF_TABLE_NAMES } from '../../../src/services/recovery-handoff/handoff-schema';
import { F10_LANES_TABLE_NAMES } from '../../../src/services/execution-lanes/lane-schema';
import {
  BUILTIN_SCHEMA_MIGRATIONS,
  NodeSqliteConnection,
  SchemaBootstrapService
} from '../../../src/services/sqlite-store';

const NOW = 1_800_000_000_000;
const DIGEST = 'a'.repeat(64);

function openMemory(): NodeSqliteConnection {
  return new NodeSqliteConnection({ databasePath: ':memory:' });
}

function insertF04Artifact(conn: NodeSqliteConnection, artifactId: string, state: string): void {
  conn.run(
    `INSERT INTO artifacts (artifact_id, content_sha256, byte_length, media_type, kind, created_at_ms)
     VALUES (?, ?, 3, 'text/plain', 'transcript', ?)`,
    artifactId,
    DIGEST,
    NOW
  );
  conn.run(
    `INSERT INTO artifact_availability (artifact_id, state, last_verified_at_ms, detail_json) VALUES (?, ?, ?, '{}')`,
    artifactId,
    state,
    NOW
  );
}

function insertLifecycleRow(conn: NodeSqliteConnection, artifactId: string): void {
  conn.run(
    `INSERT INTO artifact_lifecycle (
      artifact_id, lifecycle_revision, sensitivity, retention_class, store_kind, immutability,
      digest_algorithm, digest_value, byte_size, availability, producer_identity, display_name,
      created_at_ms, updated_at_ms
    ) VALUES (?, 1, 'content', 'transcripts-diagnostics-checkpoints-audit-catalog', 'transcript',
      'immutable', 'sha256', ?, 3, 'present', 'writer-1', 'name', ?, ?)`,
    artifactId,
    DIGEST,
    NOW,
    NOW
  );
}

function tableSql(conn: NodeSqliteConnection, name: string): string {
  const row = conn.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, name);
  return row?.sql ?? '';
}

function quotedValues(sql: string, column: string): readonly string[] {
  const start = sql.indexOf(`${column} IN (`);
  expect(start, `CHECK list for ${column}`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf(')', start);
  return [...sql.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match.at(1) ?? '');
}

describe('FR-R6-F05 migration 2 (NFR-006)', () => {
  it('applies on a fresh store with every new table STRICT', () => {
    const conn = openMemory();
    try {
      const result = SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
      expect(SQLITE_SCHEMA_CURRENT_VERSION).toBe(6);
      expect(result.schemaVersion).toBe(6);
      expect(result.appliedMigrations).toEqual([1, 2, 3, 4, 5, 6]);
      expect(result.strictTableCount).toBe(
        F04_INITIAL_STRICT_TABLE_COUNT +
          F05_LIFECYCLE_TABLE_NAMES.length +
          F06_ACCOUNTING_TABLE_NAMES.length +
          F07_LIVE_LOG_TABLE_NAMES.length +
          F08_HANDOFF_TABLE_NAMES.length +
          F10_LANES_TABLE_NAMES.length
      );
      for (const name of F05_LIFECYCLE_TABLE_NAMES) {
        expect(tableSql(conn, name), name).toMatch(/\)\s*STRICT$/);
      }
    } finally {
      conn.close();
    }
  });

  it('applies on a v1 store holding F04 rows and leaves those rows byte-identical', () => {
    const conn = openMemory();
    try {
      const v1Only = BUILTIN_SCHEMA_MIGRATIONS.filter((migration) => migration.version === 1);
      expect(SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW, v1Only).appliedMigrations).toEqual([1]);
      insertF04Artifact(conn, 'art-1', 'available');
      insertF04Artifact(conn, 'art-2', 'quarantined');
      const before = conn.all<Record<string, unknown>>(`SELECT * FROM artifact_availability ORDER BY artifact_id`);
      const artifactsBefore = conn.all<Record<string, unknown>>(`SELECT * FROM artifacts ORDER BY artifact_id`);

      const result = SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW + 1);
      expect(result.appliedMigrations).toEqual([2, 3, 4, 5, 6]);
      expect(result.schemaVersion).toBe(6);
      expect(conn.all(`SELECT * FROM artifact_availability ORDER BY artifact_id`)).toEqual(before);
      expect(conn.all(`SELECT * FROM artifacts ORDER BY artifact_id`)).toEqual(artifactsBefore);
      expect(tableSql(conn, 'artifact_availability')).toContain(`'available', 'quarantined', 'evicted', 'missing'`);
    } finally {
      conn.close();
    }
  });

  it('is a no-op when re-run', () => {
    const conn = openMemory();
    try {
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
      const second = SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW + 1);
      expect(second.appliedMigrations).toEqual([]);
      expect(second.schemaVersion).toBe(6);
    } finally {
      conn.close();
    }
  });

  it('refuses a database written by a newer schema version', () => {
    const conn = openMemory();
    try {
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
      conn.run(
        `UPDATE schema_meta SET meta_value = ? WHERE meta_key = 'schema_version'`,
        String(SQLITE_SCHEMA_CURRENT_VERSION + 1)
      );
      expect(() => SchemaBootstrapService.bootstrapAndMigrate(conn)).toThrow(/UNSUPPORTED_FUTURE_SCHEMA_VERSION/);
    } finally {
      conn.close();
    }
  });

  it('restricts deleting an artifacts row a lifecycle row references', () => {
    const conn = openMemory();
    try {
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
      insertF04Artifact(conn, 'art-1', 'available');
      insertLifecycleRow(conn, 'art-1');
      expect(() => conn.run(`DELETE FROM artifacts WHERE artifact_id = 'art-1'`)).toThrow(/FOREIGN KEY/);
      expect(conn.get<{ n: number }>(`SELECT count(*) AS n FROM artifact_lifecycle`)?.n).toBe(1);
    } finally {
      conn.close();
    }
  });

  it('rejects an immutable row without a digest and a growing row with one', () => {
    const conn = openMemory();
    try {
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
      insertF04Artifact(conn, 'art-1', 'available');
      const insert = (immutability: string, digest: string | null, generation: number | null): void => {
        conn.run(
          `INSERT INTO artifact_lifecycle (
            artifact_id, lifecycle_revision, sensitivity, retention_class, store_kind, immutability,
            digest_algorithm, digest_value, generation, extent_bytes, byte_size, availability,
            producer_identity, display_name, created_at_ms, updated_at_ms
          ) VALUES ('art-1', 1, 'content', 'aggregate-history', 'live-log-segment', ?, ?, ?, ?, ?, 3,
            'present', 'w', 'n', 0, 0)`,
          immutability,
          digest === null ? null : 'sha256',
          digest,
          generation,
          generation
        );
      };
      expect(() => insert('immutable', null, null)).toThrow(/CHECK/);
      expect(() => insert('growing', DIGEST, 1)).toThrow(/CHECK/);
      expect(() => insert('immutable', 'not-hex', null)).toThrow(/CHECK/);
    } finally {
      conn.close();
    }
  });

  it('keeps the frozen CHECK lists equal to the contract constants', () => {
    const conn = openMemory();
    try {
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
      const lifecycle = tableSql(conn, 'artifact_lifecycle');
      expect(quotedValues(lifecycle, 'retention_class')).toEqual([...RETENTION_CLASS_IDS]);
      expect(quotedValues(lifecycle, 'store_kind')).toEqual([...ARTIFACT_STORE_KINDS]);
      expect(quotedValues(lifecycle, 'availability')).toEqual([...ARTIFACT_AVAILABILITY_STATES]);
      const references = tableSql(conn, 'artifact_references');
      expect(quotedValues(references, 'owner_type')).toEqual([...REFERENCE_OWNER_TYPES]);
      expect(quotedValues(references, 'purpose')).toEqual([...F05_REFERENCE_PURPOSES]);
      expect(F05_LIFECYCLE_DDL.length).toBeGreaterThan(F05_LIFECYCLE_TABLE_NAMES.length);
    } finally {
      conn.close();
    }
  });
});
