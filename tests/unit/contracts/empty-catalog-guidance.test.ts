// Feature 102 (T042, US5) — the two things a section with nothing to list can say.
//
// FR-028 is the whole point: "no definitions of that kind at all" and "definitions,
// of which none are Active" produce the identical empty list and are not the
// identical situation. A workspace holding unpublished drafts told to import is
// being sent to fix something that is not broken, past the one action that would
// actually work.
//
// So this file pins two arms and the gap between them. It pins the second's
// content positively (it must name publishing, and where publishing happens) and
// negatively (it must never say "import" — that is the other arm's word, and it is
// the specific wrong answer FR-028 exists to rule out). And it pins the first's
// text verbatim, because FR-029 requires the no-definitions wording to stay the
// wording the other surfaces already use: a feature adding an arm has no business
// rephrasing the arm beside it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EMPTY_CATALOG_GUIDANCE,
  EMPTY_CATALOG_REFUSAL,
  EXAMPLES_DIRECTORY,
  NONE_ACTIVE_GUIDANCE,
  emptyCatalogGuidance
} from '../../../src/contracts/empty-catalog-guidance';

const MODULE_SOURCE = resolve(__dirname, '../../../src/contracts/empty-catalog-guidance.ts');

// ---------------------------------------------------------------------------
// FR-029 — the existing arm is left exactly as it is
// ---------------------------------------------------------------------------

describe('the no-definitions guidance is unchanged (FR-029)', () => {
  it('keeps its headline and body verbatim', () => {
    // Verbatim, not "contains" — three surfaces render this string and feature 098
    // made its sameness the contract. A test that only checked for keywords would
    // let a rewrite through, and a rewrite here is a silent change to what the
    // Builder and the scheduled-start refusal say.
    expect(EMPTY_CATALOG_GUIDANCE.headline).toBe('No process definitions yet');
    expect(EMPTY_CATALOG_GUIDANCE.body).toBe(
      'Import a process document to get started. The extension ships examples in ' +
        'examples/ — import one of those, or a YAML document of your own.'
    );
  });

  it('still names where the examples are, through the one interpolated constant', () => {
    expect(EXAMPLES_DIRECTORY).toBe('examples/');
    expect(EMPTY_CATALOG_GUIDANCE.body).toContain(EXAMPLES_DIRECTORY);
  });

  it('still builds the host refusal out of the same body', () => {
    expect(EMPTY_CATALOG_REFUSAL).toContain(EMPTY_CATALOG_GUIDANCE.body);
  });

  it('keeps `emptyCatalogGuidance(count)` meaning exactly "nothing at all"', () => {
    // Unchanged and uncalled by the new arm. The helper answers a count question,
    // and none-Active is not a count question — both empty arms have a count of
    // zero, which is precisely why the section cannot pick between them by length.
    expect(emptyCatalogGuidance(0)).toBe(EMPTY_CATALOG_GUIDANCE);
    expect(emptyCatalogGuidance(1)).toBeNull();
    expect(emptyCatalogGuidance(7)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FR-030 — the new arm names publishing, and where publishing happens
// ---------------------------------------------------------------------------

describe('the none-Active guidance directs the operator to publish (FR-030)', () => {
  it('names the action by the label the Builder puts on it', () => {
    // "Publish", capitalised, because that is the button. Guidance that named a
    // different action than the one on screen would be a second vocabulary for the
    // same act, which FR-036 spends a whole assertion block ruling out.
    expect(NONE_ACTIVE_GUIDANCE.body).toContain('Publish');
  });

  it('names where publishing happens', () => {
    expect(NONE_ACTIVE_GUIDANCE.body).toContain('Builder');
  });

  it('says the definitions exist, rather than that there are none', () => {
    const combined = `${NONE_ACTIVE_GUIDANCE.headline} ${NONE_ACTIVE_GUIDANCE.body}`;

    // The failure being ruled out is the tidy one: reusing "No process definitions
    // yet" for a workspace that has several. Whatever the headline says, it must
    // not be that one.
    expect(NONE_ACTIVE_GUIDANCE.headline).not.toBe(EMPTY_CATALOG_GUIDANCE.headline);
    expect(combined).not.toBe(
      `${EMPTY_CATALOG_GUIDANCE.headline} ${EMPTY_CATALOG_GUIDANCE.body}`
    );
  });

  it('never says "import"', () => {
    // The specific wrong answer. Importing is what the *other* arm asks for, and an
    // operator whose drafts are all unpublished can import all day without a single
    // entry appearing on Runs.
    const combined = `${NONE_ACTIVE_GUIDANCE.headline} ${NONE_ACTIVE_GUIDANCE.body}`.toLowerCase();

    expect(combined).not.toContain('import');
    expect(combined).not.toContain(EXAMPLES_DIRECTORY);
  });

  it('differs from the other arm in what it instructs, not in a single token', () => {
    // FR-028's distinction has to survive being read. Two messages differing by one
    // word are two messages an operator reads as the same one.
    const words = (text: string) => new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);
    const mine = words(NONE_ACTIVE_GUIDANCE.body);
    const theirs = words(EMPTY_CATALOG_GUIDANCE.body);
    const shared = [...mine].filter((word) => theirs.has(word));

    expect(shared.length).toBeLessThan(Math.min(mine.size, theirs.size) / 2);
  });

  it('is frozen, like the arm beside it', () => {
    // Shared by reference across surfaces that render at different times.
    expect(Object.isFrozen(NONE_ACTIVE_GUIDANCE)).toBe(true);
    expect(Object.isFrozen(EMPTY_CATALOG_GUIDANCE)).toBe(true);
  });

  it('carries no path the operator has to resolve and no absolute location', () => {
    const combined = `${NONE_ACTIVE_GUIDANCE.headline} ${NONE_ACTIVE_GUIDANCE.body}`;

    expect(combined).not.toMatch(/[A-Za-z]:\\|\/(Users|home|var|tmp)\//);
  });
});

// ---------------------------------------------------------------------------
// The module stays a leaf
// ---------------------------------------------------------------------------

describe('the shared source imports nothing', () => {
  it('has no import statement at all', () => {
    // Two webview components value-import this module. A value import pulls the
    // imported module's whole graph into the bundle, and everything adjacent to it
    // under `src/` reaches `vscode` within a hop or two. Adding an arm is exactly
    // the kind of edit that reaches for a helper.
    const source = readFileSync(MODULE_SOURCE, 'utf8');

    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });
});
