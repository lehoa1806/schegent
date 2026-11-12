/**
 * Review gap GC-09 (2026-11-12) — `min_reader_version` was written on every bootstrap and read by
 * nothing, so a later build could not tell an older one to stay out with a precise reason.
 */
import { describe, expect, it } from 'vitest';

import {
  SQLITE_MIN_READER_VERSION,
  SQLITE_SCHEMA_CURRENT_VERSION
} from '../../../src/contracts/sqlite-store/schema-types';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';

const NOW = 1_700_000_000_000;

function readMinReader(conn: NodeSqliteConnection): string | undefined {
  return conn.get<{ meta_value: string }>(
    `SELECT meta_value FROM schema_meta WHERE meta_key = 'min_reader_version'`
  )?.meta_value;
}

function withBootstrapped(body: (conn: NodeSqliteConnection) => void): void {
  const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  try {
    SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
    body(conn);
  } finally {
    conn.close();
  }
}

describe('GC-09 — min_reader_version is enforced at open', () => {
  it('records the build floor on a fresh database', () => {
    withBootstrapped((conn) => {
      expect(readMinReader(conn)).toBe(String(SQLITE_MIN_READER_VERSION));
    });
  });

  it('refuses a database whose recorded reader floor this build is below, naming both versions', () => {
    withBootstrapped((conn) => {
      const floor = SQLITE_SCHEMA_CURRENT_VERSION + 1;
      conn.run(`UPDATE schema_meta SET meta_value = ? WHERE meta_key = 'min_reader_version'`, String(floor));

      expect(() => SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW)).toThrow(
        `UNSUPPORTED_MIN_READER_VERSION: database requires a reader of schema ${floor} or later; this build reads up to ${SQLITE_SCHEMA_CURRENT_VERSION}`
      );
    });
  });

  it('gives the reader-floor reason before the future-schema reason when both apply', () => {
    withBootstrapped((conn) => {
      conn.run(`UPDATE schema_meta SET meta_value = '99' WHERE meta_key IN ('schema_version', 'min_reader_version')`);

      expect(() => SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW)).toThrow(
        /^UNSUPPORTED_MIN_READER_VERSION/
      );
    });
  });

  it('refuses an unreadable reader floor rather than treating it as no floor', () => {
    withBootstrapped((conn) => {
      conn.run(`UPDATE schema_meta SET meta_value = 'two' WHERE meta_key = 'min_reader_version'`);

      expect(() => SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW)).toThrow(
        /^UNSUPPORTED_MIN_READER_VERSION: database records an unreadable reader floor/
      );
    });
  });

  it('never lowers a floor a build at or below this one recorded', () => {
    withBootstrapped((conn) => {
      const raised = SQLITE_MIN_READER_VERSION + 1;
      expect(raised).toBeLessThanOrEqual(SQLITE_SCHEMA_CURRENT_VERSION);
      conn.run(`UPDATE schema_meta SET meta_value = ? WHERE meta_key = 'min_reader_version'`, String(raised));

      SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW + 1);

      expect(readMinReader(conn)).toBe(String(raised));
    });
  });
});
