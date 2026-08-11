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
 */
const CATALOG_SUITES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  authoring: ['webview-ui/src/components/__tests__/PhaseCatalogEditor.test.ts'],
  resolution: [
    'tests/unit/config/process-catalog.test.ts',
    'tests/integration/phase-catalog-run-snapshot.test.ts'
  ],
  precedence: ['tests/unit/config/phase-precedence.test.ts'],
  revision: ['tests/unit/ui/sidebar/commands/cmd-save-phases.test.ts'],
  'save-semantics': [
    'tests/unit/ui/sidebar/commands/cmd-save-phases-validation.test.ts',
    'tests/unit/ui/sidebar/commands/cmd-save-phases-identity.test.ts',
    'tests/unit/ui/sidebar/commands/cmd-save-phases-removal.test.ts',
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

  it('leaves the Phase save path with one write command, not a second for imports', () => {
    // Import commits through the existing CMD_SAVE_PHASES (research R2). A second
    // write command is how the gates would silently diverge.
    const contracts = readFileSync(
      resolve(REPO_ROOT, 'src', 'contracts', 'sidebar-ipc.ts'),
      'utf8'
    );
    const phaseWriteCommands = [
      ...contracts.matchAll(/export const (CMD_[A-Z_]*(?:SAVE|WRITE|IMPORT)[A-Z_]*PHASES?)\b/g)
    ].map((match) => match[1]!);
    expect(phaseWriteCommands).toEqual(['CMD_SAVE_PHASES']);
  });
});
