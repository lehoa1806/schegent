/**
 * Feature 098 (T065, FR-018, SC-013) — the built-in Phase and Pipeline layers
 * hold no rows, and gaining one fails the build.
 *
 * The layers used to carry seventeen Phases and three Pipelines, and
 * `import-planner.ts` scans every layer including this one before writing. A row
 * here is therefore not a harmless default: it claims an id, and the shipped
 * example document that declares the same id resolves to a skip row instead of a
 * write. That is the whole of the defect this feature exists to fix, and it is
 * reachable again from a single `push` — which is why the invariant is pinned
 * rather than left to the emptiness happening to persist.
 *
 * Two checks, because they fail on different mistakes:
 *
 *   1. the resolved arrays are empty — catches a row added anywhere, including
 *      through a helper this file has never heard of;
 *   2. the declarations are literally `Object.freeze([])` — catches a
 *      `Object.freeze([...SOMETHING])` whose contents happen to be empty today.
 *      Check 1 passes on that, and it is the shape a reintroduction takes.
 *
 * `BUILT_IN_WORKFLOWS` is deliberately not asserted here. It has been empty
 * since feature 086 for a different reason (FR-026: a Workflow composes an
 * operator's own Pipelines, so there is no useful default graph to ship), and it
 * is not what FR-018 pins.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { BUILT_IN_PHASES, BUILT_IN_PIPELINES } from '../../src/config/pipeline-config';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CATALOG_MODULE = 'src/config/pipeline-config.ts';

/**
 * The initialiser expression for a top-level `export const`, with the type
 * annotation and the trailing semicolon stripped. Returns `undefined` when the
 * declaration is not found at all, which is itself a failure: the constant this
 * lint is about would have been renamed out from under it.
 */
function initialiserOf(source: string, name: string): string | undefined {
  const match = new RegExp(`export const ${name}[^=]*=\\s*([^;]+);`).exec(source);
  return match?.[1]?.trim();
}

describe('the built-in Phase and Pipeline layers ship empty', () => {
  it('resolves no rows in either layer', () => {
    expect(
      BUILT_IN_PHASES,
      'a built-in Phase claims its id against every import, so the example document ' +
        'declaring that id plans a skip row and writes nothing (FR-018)'
    ).toEqual([]);
    expect(
      BUILT_IN_PIPELINES,
      'same for a built-in Pipeline: the id is claimed before the operator can import it'
    ).toEqual([]);
  });

  it('declares both layers as an empty literal, not an empty-today expression', () => {
    const source = readFileSync(resolve(REPO_ROOT, CATALOG_MODULE), 'utf8');
    for (const name of ['BUILT_IN_PHASES', 'BUILT_IN_PIPELINES']) {
      expect(
        initialiserOf(source, name),
        `${CATALOG_MODULE} must initialise ${name} to a frozen empty literal; anything ` +
          'else can acquire rows without this file noticing, and a missing match means ' +
          'the constant was renamed'
      ).toBe('Object.freeze([])');
    }
  });
});
