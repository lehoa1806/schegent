import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';
import { SQLITE_MIN_SUPPORTED_ENGINE_VERSION } from '../../src/contracts/sqlite-store/schema-types';

// The operational store uses the Node and SQLite bundled in the extension host.
// Check both against their declared minimums on the editor the integration harness launches.
const EXTENSION_ID = 'schegent.schegent';
const semver = createRequire(__filename)('semver') as { satisfies(version: string, range: string): boolean };

function declaredNodeRange(): string {
  const manifest = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as
    | { readonly engines?: { readonly node?: unknown } }
    | undefined;
  const range = manifest?.engines?.node;
  assert.ok(typeof range === 'string', `${EXTENSION_ID} declares no engines.node`);
  return range.trim();
}

export async function run(): Promise<void> {
  const nodeVersion = process.versions.node;
  const electronVersion = process.versions.electron ?? 'none';

  // Printed before any assertion, so a failing host still leaves the versions in the log.
  console.log(`runtime-floor: vscode=${vscode.version} electron=${electronVersion} node=${nodeVersion}`);

  const range = declaredNodeRange();
  assert.ok(
    semver.satisfies(nodeVersion, range),
    `extension host Node ${nodeVersion} is outside engines.node (${range})`
  );

  // Imported the way `src/services/sqlite-store/sqlite-driver.ts` imports it: a host without the
  // module fails to load this file, and the harness counts that as this module failing.
  // A file, not `:memory:`: the store runs in WAL mode, and an in-memory database reports `memory`
  // for every journal mode, so it would prove nothing about WAL.
  const dir = mkdtempSync(join(tmpdir(), 'schegent-runtime-floor-'));
  try {
    const db = new DatabaseSync(join(dir, 'floor.db'));
    try {
      const engine = db.prepare('SELECT sqlite_version() AS version, sqlite_source_id() AS source').get();
      assert.ok(engine && typeof engine.version === 'string');
      console.log(`runtime-floor: sqlite=${engine.version} source=${engine.source}`);
      assert.ok(
        semver.satisfies(engine.version, `>=${SQLITE_MIN_SUPPORTED_ENGINE_VERSION}`),
        `extension host SQLite ${engine.version} is below the store minimum ${SQLITE_MIN_SUPPORTED_ENGINE_VERSION}`
      );
      const mode = db.prepare('PRAGMA journal_mode = WAL').get() as { readonly journal_mode?: unknown } | undefined;
      assert.equal(mode?.journal_mode, 'wal');
      db.exec('CREATE TABLE floor (value TEXT NOT NULL) STRICT;');
      assert.equal(db.isTransaction, false);
      db.exec('BEGIN IMMEDIATE');
      assert.equal(db.isTransaction, true);
      db.exec("INSERT INTO floor (value) VALUES ('ok'); COMMIT;");
      assert.equal(db.isTransaction, false);
      const row = db.prepare('SELECT value FROM floor').get() as { readonly value?: unknown } | undefined;
      assert.equal(row?.value, 'ok');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('runtime-floor: node:sqlite DatabaseSync opened a WAL file database, wrote and read in the extension host');
}
