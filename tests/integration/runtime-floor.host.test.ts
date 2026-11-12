import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';

// Review gap GC-19 (2026-11-12) — the SQLite authority store runs on the `node:sqlite` built into
// the extension host's Node, which is Electron's, not the Node in `.nvmrc`. The Node 22 floor
// record ran plain Node before the store existed, and nothing recorded which Node VS Code 1.107
// ships. This module runs in that host, so it answers both: `node:sqlite` opens a database and
// commits a write here, and the versions it ran on are printed for the floor record.
//
// The `engines.node` range is the declared support surface; a host whose Node falls outside it
// fails here rather than at an operator's activation. The range is read from the installed
// extension's own manifest, so this check follows `package.json` instead of a copy of it.
const EXTENSION_ID = 'schegent.schegent';
const DECIMAL_RADIX = 10;
// The only shape the manifest uses: caret majors joined by `||`, e.g. `^22 || ^24`.
const CARET_MAJORS_RANGE = /^\^\d+(\s*\|\|\s*\^\d+)*$/;
const CARET_MAJOR = /\^(\d+)/g;

function declaredNodeRange(): string {
  const manifest = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as
    | { readonly engines?: { readonly node?: unknown } }
    | undefined;
  const range = manifest?.engines?.node;
  assert.ok(typeof range === 'string', `${EXTENSION_ID} declares no engines.node`);
  return range.trim();
}

function caretMajors(range: string): readonly number[] {
  // A range of any other shape fails loudly rather than being half-read.
  assert.match(range, CARET_MAJORS_RANGE, `engines.node ${JSON.stringify(range)} is not a list of ^N majors`);
  return Array.from(range.matchAll(CARET_MAJOR), (m) => Number.parseInt(m.at(1) ?? '', DECIMAL_RADIX));
}

export async function run(): Promise<void> {
  const nodeVersion = process.versions.node;
  const electronVersion = process.versions.electron ?? 'none';
  const major = Number.parseInt(nodeVersion.split('.').at(0) ?? '', DECIMAL_RADIX);

  // Printed before any assertion, so a failing host still leaves the versions in the log.
  console.log(`runtime-floor: vscode=${vscode.version} electron=${electronVersion} node=${nodeVersion}`);

  const range = declaredNodeRange();
  assert.ok(
    caretMajors(range).includes(major),
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
      const mode = db.prepare('PRAGMA journal_mode = WAL').get() as { readonly journal_mode?: unknown } | undefined;
      assert.equal(mode?.journal_mode, 'wal');
      db.exec('CREATE TABLE floor (value TEXT NOT NULL) STRICT;');
      db.exec("BEGIN IMMEDIATE; INSERT INTO floor (value) VALUES ('ok'); COMMIT;");
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
