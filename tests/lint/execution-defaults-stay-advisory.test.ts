// Feature 254 (FR-R4-F07, N7; contract D5; FR-023) — a Pipeline's authored `executionDefaults` are
// advisory: nothing that runs a Phase, or that tells the operator what a Run will use, reads them.
//
// `executionDefaults` (runner, model, effort, timeout) is authored data. It is validated, stored,
// frozen into a Run's plan as a copy, exported and imported (FR-024). It has never been applied: no
// execution code resolves a Phase's model, effort or bound from it. The Runs launcher used to present
// it as the settings the Run would use, which was false, and the fix is to show what execution
// resolves (`LaunchRunSettings`, resolved from the Phase and the host's limits) and to label the
// authored values advisory. That fix holds only while nothing starts reading the field.
//
// A gate rather than a test of behavior because the failure it prevents is silent in both directions:
// a read added to the runner would make the old preview true by accident, and a read added to the
// launch projection would put an authored value back among the settings the host calls effective. The
// gate names the four places where either would happen:
//
//   * `src/controller`                         — what runs a Phase
//   * `src/services/workflow-execution`        — what advances a Workflow
//   * `src/runner`                             — what spawns a backend
//   * `src/ui/sidebar/launch-projection.ts`    — what the launcher is told
//
// The scan reads code and not comments: the new projection code says "advisory" in a comment, and
// that is the point. The control must hit: `src/config/pipeline-snapshot.ts` copies the field into the
// frozen plan, and a scan that could not find it there would be reading nothing.
//
// This is a new lint file: `docs/development/lint-gate-census.md` carries its row (feature 254, G8).

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FIELD = 'executionDefaults';

/** The places that must never read the field. */
const GUARDED_DIRECTORIES = ['src/controller', 'src/services/workflow-execution', 'src/runner'];
const GUARDED_FILES = ['src/ui/sidebar/launch-projection.ts'];

/** The control: a file known to touch the field, so a scan that finds nothing is not trusted. */
const CONTROL_FILE = 'src/config/pipeline-snapshot.ts';

/** The code of a TypeScript source, with block and line comments removed. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function readersIn(paths: readonly string[]): string[] {
  return paths
    .filter((path) => codeOf(readFileSync(path, 'utf8')).includes(FIELD))
    .map((path) => relative(REPO_ROOT, path))
    .sort();
}

function guardedPaths(): string[] {
  const directories = GUARDED_DIRECTORIES.flatMap((directory) =>
    filesUnder(resolve(REPO_ROOT, directory), { extensions: ['.ts'] })
  );
  return [...directories, ...GUARDED_FILES.map((file) => resolve(REPO_ROOT, file))];
}

describe('FR-R4-F07 N7 — execution defaults stay advisory', () => {
  it('strips comments but not code (control for the scan itself)', () => {
    expect(codeOf('// executionDefaults is advisory\nconst x = 1;')).not.toContain(FIELD);
    expect(codeOf('/* executionDefaults */ const x = 1;')).not.toContain(FIELD);
    expect(codeOf('const m = pipeline.executionDefaults?.model;')).toContain(FIELD);
  });

  it('finds the field where the freeze copies it (the control must hit)', () => {
    expect(readersIn([resolve(REPO_ROOT, CONTROL_FILE)])).toEqual([CONTROL_FILE]);
  });

  it('scans a non-empty set of guarded files', () => {
    const paths = guardedPaths();
    expect(paths.length).toBeGreaterThan(20);
    expect(paths.map((path) => relative(REPO_ROOT, path))).toContain(GUARDED_FILES[0]);
  });

  it('reads executionDefaults nowhere that runs a Phase or states what a Run will use', () => {
    expect(readersIn(guardedPaths())).toEqual([]);
  });
});
