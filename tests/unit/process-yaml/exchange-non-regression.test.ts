// Feature 084 T064 — SC-013 / QS-39: the exchange feature ships no behavior
// change to the Phase catalog it exchanges.
//
// The suite-passing half of SC-013 is verified by running the pre-existing
// catalog suites unchanged, which the finalize gate does. What that run cannot
// tell anyone six months from now is which suites were the claim. This file
// names them, asserts they are still present, and pins the two facts a
// regression would move first: that the exchange reaches the persisted state
// schema from nowhere, and that it added no state key at all.
//
// The state schema is the sharper of the two. A Phase lives in configuration,
// not in workspace state, so an exchange that reached the state schema would
// mean it had reached somewhere it has no business being — and a version it
// moved would force every operator through a migration for a feature that
// stores nothing.

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/**
 * The catalog suites SC-013 is a claim about, by the five concerns the criterion
 * names: authoring, resolution, precedence, revision, and save semantics. Paths
 * rather than imports, because the assertion is that they still exist and still
 * run — importing them here would run them twice.
 *
 * Feature 099 (T496f, FR-042/FR-043) — `precedence` was the question "two rows
 * claim one id; which one is effective?", and with one layer the answer changed
 * from "the higher scope" to "neither, both are invalid". The question survives,
 * so the concern survives under the name the answer now has; only its suite
 * moved, from the deleted `phase-precedence.test.ts` to the resolver suites that
 * assert the invalidation. Deleting the row here instead would have let the
 * contention rule go unguarded while SC-013 still claimed it was covered.
 */
const CATALOG_SUITES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  authoring: ['webview-ui/src/components/__tests__/PhaseCatalogEditor.test.ts'],
  resolution: [
    'tests/unit/config/process-catalog.test.ts',
    'tests/integration/phase-catalog-run-snapshot.test.ts'
  ],
  contention: [
    'tests/unit/config/pipeline-config.test.ts',
    'tests/unit/config/process-catalog.test.ts'
  ],
  // Feature 100 (T509, FR-036/FR-024) — the same substitution feature 099 made
  // for `precedence`, for the same reason. `revision` was the question "did the
  // layer move under me between read and write?" and the layer save that asked
  // it is gone; the question is now asked per definition, by the draft token, so
  // it moves to the suites that assert the token gate and its ordering against
  // trust. `save-semantics` splits the same way: validation is what the publish
  // gate runs, identity and removal are what deactivation and its reversal
  // assert, and the primary-window gate suite carries over unchanged. Dropping
  // either row would leave SC-013 claiming coverage of a concern nothing checks.
  revision: [
    'tests/unit/catalog/lifecycle-concurrency.test.ts',
    'tests/unit/ui/sidebar/commands/lifecycle-staleness-before-trust.test.ts'
  ],
  'save-semantics': [
    'tests/unit/catalog/lifecycle-publish-gate.test.ts',
    'tests/unit/catalog/lifecycle-deactivate-reversible.test.ts',
    'tests/unit/ui/sidebar/save-commands-primary-gate.test.ts'
  ]
});

describe('Feature 084 T064 — the Phase catalog is unchanged by the exchange (SC-013, QS-39)', () => {
  it('reaches the persisted state schema from nowhere in the exchange', () => {
    // A Phase is configuration. Nothing in export or import writes workspace
    // state, so nothing here may force a migration.
    //
    // Scanned rather than pinned to a number. The pin read `=== 8` until feature
    // 088 moved the runtime to v9 for the connected-run aggregate, which is a
    // feature that does store state and did write its migration — and the pin
    // failed on it, which is a false alarm on someone else's correct work rather
    // than a defect in the exchange. What SC-013 actually claims is that the
    // exchange never reaches the state schema at all; that is what is checked.
    const tree = resolve(REPO_ROOT, 'src', 'services', 'process-yaml');
    for (const entry of readdirSync(tree)) {
      const source = readFileSync(resolve(tree, entry), 'utf8');
      for (const term of ['STATE_SCHEMA_VERSION', 'state-schema', 'workspace-state']) {
        expect(
          source.includes(term),
          `process-yaml/${entry} must not reach workspace state (found "${term}")`
        ).toBe(false);
      }
    }
  });

  it('adds no workspace-state key for the exchange', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'src', 'state', 'workspace-state.ts'), 'utf8');
    for (const term of ['processYaml', 'process-yaml', 'importPlan', 'lastExport']) {
      expect(
        source.includes(term),
        `workspace-state.ts must not persist exchange data (found "${term}")`
      ).toBe(false);
    }
  });

  it('keeps every catalog suite SC-013 names on disk and named', () => {
    const missing: string[] = [];
    for (const [concern, suites] of Object.entries(CATALOG_SUITES)) {
      for (const suite of suites) {
        if (!existsSync(resolve(REPO_ROOT, suite))) missing.push(`${concern}: ${suite}`);
      }
    }
    expect(
      missing,
      `SC-013 names these suites as the non-regression claim; they are gone or moved:\n${missing.join('\n')}`
    ).toEqual([]);
  });

  it('leaves the catalog write path without a second command for imports', () => {
    // Import commits through the same command the Builder commits through
    // (research R2). A second, import-only write command is how the gates would
    // silently diverge — one of them would grow a check the other never got.
    //
    // Feature 100 (T509) — the command changed name and shape: the commit is now
    // `CMD_PUBLISH_PACKAGE`, one document under one confirmation, and the layer
    // save the pin used to name is gone. The claim is unchanged and is pinned
    // twice over: no write command mentions importing at all, and the set of
    // commands that write a definition is exactly the lifecycle's six. A seventh
    // appearing is the divergence this test exists to catch.
    //
    // Feature 101 (T082) — the claim is about commands that *write* a definition,
    // and the name-shaped scan below could not tell a write from a read until
    // there was a read to tell it from. `CMD_READ_DEFINITION_VERSION` is that
    // read. Appending it to the list would have been the wrong repair: the list
    // would then mean "constants whose name contains DEFINITION", and a genuinely
    // writing seventh command could be waved through by the same reflex. So the
    // scan excludes `CMD_READ_*` and the exclusion is itself pinned below —
    // widening it needs a second edit, in a test that says why.
    const contracts = readFileSync(
      resolve(REPO_ROOT, 'src', 'contracts', 'sidebar-ipc.ts'),
      'utf8'
    );
    const literals = (pattern: RegExp): string[] =>
      [...contracts.matchAll(pattern)].map((match) => match[1]!);

    expect(literals(/export const (CMD_[A-Z_]*(?:IMPORT|EXCHANGE)[A-Z_]*)\b/g)).toEqual([]);
    expect(literals(/export const (CMD_(?!READ_)[A-Z_]*(?:DEFINITION|PACKAGE)[A-Z_]*)\b/g)).toEqual([
      'CMD_SAVE_DEFINITION_DRAFT',
      'CMD_PUBLISH_DEFINITION',
      'CMD_DEACTIVATE_DEFINITION',
      'CMD_RESTORE_DEFINITION_VERSION',
      'CMD_DISCARD_DEFINITION_DRAFT',
      'CMD_PUBLISH_PACKAGE'
    ]);

    // Everything the `CMD_READ_*` guard hides, and the proof each one is a read.
    // A command is a write iff it carries a reason in the mutation metadata —
    // that registry, not this file's regex, is what the router gates on.
    const excluded = literals(/export const (CMD_READ_[A-Z_]*(?:DEFINITION|PACKAGE)[A-Z_]*)\b/g);
    expect(excluded).toEqual(['CMD_READ_DEFINITION_VERSION']);
    const metadata = readFileSync(
      resolve(REPO_ROOT, 'src', 'contracts', 'sidebar-command-metadata.ts'),
      'utf8'
    );
    for (const command of excluded) {
      expect(metadata.includes(command), `${command} is excluded as a read but mutates`).toBe(false);
    }
  });
});
