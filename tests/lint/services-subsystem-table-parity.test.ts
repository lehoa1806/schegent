// Review gap GC-21 (2026-11-12) — every `src/services/` subsystem has a row in ARCHITECTURE.md.
//
// WHAT THIS PINS:
//   - ARCHITECTURE.md's "Services subsystems" table is the map a reader uses to find a subsystem.
//     Before it existed, the twelve Round 6 subsystems (SQLite store, ACP runtime, lanes,
//     reporting, telemetry export and others) appeared nowhere in it, and the doc gates that
//     existed checked that cited paths resolve, not that every subsystem was covered;
//   - both directions: a subdirectory needs a row, and a row needs a subdirectory that still
//     exists, so a removed subsystem cannot linger;
//   - a row is a table line whose first cell is exactly the backticked `src/services/<name>/`.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ARCHITECTURE = resolve(REPO_ROOT, 'ARCHITECTURE.md');
const SERVICES_DIR = resolve(REPO_ROOT, 'src', 'services');

/** A subsystem table row: the first cell is one backticked `src/services/<name>/` path. */
const ROW_DIR = /^\| `src\/services\/([a-z0-9-]+)\/` \|/;

function subsystemDirectories(): string[] {
  return readdirSync(SERVICES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function documentedSubsystems(): string[] {
  const names = new Set<string>();
  for (const line of readFileSync(ARCHITECTURE, 'utf8').split('\n')) {
    const name = ROW_DIR.exec(line)?.at(1);
    if (name !== undefined) names.add(name);
  }
  return [...names].sort();
}

describe('GC-21 — ARCHITECTURE.md lists exactly the services subsystems', () => {
  it('reads subsystems from both sides before comparing them', () => {
    expect(subsystemDirectories().length).toBeGreaterThan(20);
    expect(documentedSubsystems().length).toBeGreaterThan(20);
  });

  it('has a row for every src/services subdirectory', () => {
    const documented = new Set(documentedSubsystems());

    expect(
      subsystemDirectories().filter((name) => !documented.has(name)),
      'these subsystems have no row in the ARCHITECTURE.md "Services subsystems" table'
    ).toEqual([]);
  });

  it('has no row for a subdirectory that no longer exists', () => {
    const present = new Set(subsystemDirectories());

    expect(
      documentedSubsystems().filter((name) => !present.has(name)),
      'these rows name src/services subdirectories that do not exist'
    ).toEqual([]);
  });
});
