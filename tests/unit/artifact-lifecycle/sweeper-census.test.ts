// FR-R6-F05 (T017) — the sweeper census names real code.
//
// Each row cites a source file and a symbol in it; a rename or a move without a
// census edit fails here instead of leaving the operator guide wrong. Exactly
// one sweeper is wired to F05 recovery pins in this feature.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DENY_ALL_ACCESS_POLICY, createArtifactLifecycleService } from '../../../src/services/artifact-lifecycle';
import { SWEEPER_CENSUS } from '../../../src/contracts/artifact-lifecycle/sweeper-census';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

describe('FR-R6-F05 sweeper census (clarification 1)', () => {
  it('cites a source file that exists and contains the named symbol, for every row', () => {
    const broken: string[] = [];
    for (const entry of SWEEPER_CENSUS) {
      const file = resolve(REPO_ROOT, entry.source);
      if (!existsSync(file)) {
        broken.push(`${entry.sweeper}: missing ${entry.source}`);
        continue;
      }
      if (!readFileSync(file, 'utf8').includes(entry.symbol)) broken.push(`${entry.sweeper}: no ${entry.symbol}`);
    }
    expect(broken).toEqual([]);
  });

  it('assigns exactly one sweeper to F05', () => {
    const owned = SWEEPER_CENSUS.filter((entry) => entry.liveCutoverOwner === 'F05').map((entry) => entry.sweeper);
    expect(owned).toEqual(['RunCheckpointRetentionService.sweep']);
  });

  it('is served unchanged by the lifecycle service', () => {
    const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    try {
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => 0);
      const service = createArtifactLifecycleService({
        conn,
        nowMs: () => 0,
        fs: {
          lstat: () => Promise.resolve(null),
          readdir: () => Promise.resolve([]),
          realpath: (p) => Promise.resolve(p),
          unlink: () => Promise.resolve()
        },
        probe: {
          observe: () => Promise.resolve({ exists: false, sizeBytes: 0, producerIdentity: null, generation: null }),
          digestSha256: () => Promise.resolve(null)
        },
        audit: { recordLifecycleMutation: () => undefined },
        scanRoots: [],
        accessPolicy: DENY_ALL_ACCESS_POLICY,
        resolveOwner: () => 'live'
      });
      expect(service.listSweeperCensus()).toBe(SWEEPER_CENSUS);
    } finally {
      conn.close();
    }
  });
});
