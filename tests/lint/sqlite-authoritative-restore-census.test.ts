/**
 * FR-R7-03 (FR-001, SC-005) — Authoritative SQLite restore table census gate.
 *
 * Ensures every SQLite table declared in `repo/src/` and materialized by
 * `SchemaBootstrapService.bootstrapAndMigrate(...)` is classified in
 * `AUTHORITATIVE_RESTORE_TABLES` or `SCHEMA_CONTROL_TABLES` with zero gaps,
 * zero unknown entries, and zero overlap — so a newly added schema table
 * cannot be silently omitted from full-authority backup restore.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesUnder } from './source-scan';
import {
  ALL_CLASSIFIED_SQLITE_TABLES,
  AUTHORITATIVE_RESTORE_TABLES,
  SCHEMA_CONTROL_TABLES
} from '../../src/services/sqlite-store/authoritative-restore-tables';
import { SchemaBootstrapService } from '../../src/services/sqlite-store/schema-bootstrap';
import { NodeSqliteConnection } from '../../src/services/sqlite-store/sqlite-driver';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC_ROOT = resolve(REPO_ROOT, 'src');

const CREATE_TABLE_RE = /CREATE TABLE(?: IF NOT EXISTS)?\s+([a-zA-Z0-9_]+)/gi;

function extractStaticSchemaTables(): string[] {
  const found = new Set<string>();
  for (const abs of filesUnder(SRC_ROOT, { extensions: ['.ts'] })) {
    const content = readFileSync(abs, 'utf8');
    CREATE_TABLE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CREATE_TABLE_RE.exec(content)) !== null) {
      if (match[1]) {
        found.add(match[1]);
      }
    }
  }
  return [...found].sort();
}

describe('SQLite authoritative restore table census (FR-R7-03 FR-001)', () => {
  it('keeps AUTHORITATIVE_RESTORE_TABLES and SCHEMA_CONTROL_TABLES sorted, unique, and disjoint', () => {
    const auth = [...AUTHORITATIVE_RESTORE_TABLES];
    const control = [...SCHEMA_CONTROL_TABLES];

    expect(auth).toEqual([...new Set(auth)].sort());
    expect(control).toEqual([...new Set(control)].sort());

    const overlap = auth.filter((table) => (control as readonly string[]).includes(table));
    expect(overlap, 'tables must not appear in both authoritative and schema-control lists').toEqual([]);
  });

  it('matches every static CREATE TABLE declaration across repo/src/', () => {
    const staticTables = extractStaticSchemaTables();
    // Prove the scan walked real schema files and found the authoritative core tables.
    expect(staticTables.length).toBeGreaterThanOrEqual(100);
    expect(staticTables).toContain('runs');
    expect(staticTables).toContain('operational_tasks');
    const classified = [...ALL_CLASSIFIED_SQLITE_TABLES];

    const missingFromRegistry = staticTables.filter((t) => !classified.includes(t));
    const missingFromSource = classified.filter((t) => !staticTables.includes(t));

    expect(
      missingFromRegistry,
      'New SQLite table(s) detected in repo/src/ that are absent from AUTHORITATIVE_RESTORE_TABLES ' +
        'or SCHEMA_CONTROL_TABLES. Add every authoritative table to ' +
        'src/services/sqlite-store/authoritative-restore-tables.ts so restore covers it.'
    ).toEqual([]);
    expect(
      missingFromSource,
      'Table(s) listed in authoritative-restore-tables.ts no longer have a CREATE TABLE in repo/src/.'
    ).toEqual([]);
  });

  it('matches every non-internal table materialized by SchemaBootstrapService.bootstrapAndMigrate', () => {
    const conn = new NodeSqliteConnection({
      databasePath: ':memory:',
      journalMode: 'memory'
    });
    try {
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => 1_700_000_000_000);
      const runtimeTables = conn
        .all<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC`
        )
        .map((row) => row.name);

      expect(runtimeTables).toEqual([...ALL_CLASSIFIED_SQLITE_TABLES]);
    } finally {
      conn.close();
    }
  });
});
