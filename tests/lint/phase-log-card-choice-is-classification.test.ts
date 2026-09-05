// Feature 203 (T009-T011, D10, FR-014, FR-026, FR-027, FR-029, SC-004, SC-013)
// — the feed must CHOOSE a card from a classification the host already made,
// never RE-DERIVE the situation from the shape of what it received.
//
// The defect this gate is written against: `showEmptyCard` decided whether to
// show a card by re-inspecting `state.entries` and the banner, which is the
// same question the host had already answered and thrown away. Four of the
// five reachable empty situations produced a byte-identical manifest, so the
// re-derivation could not tell them apart and showed nothing at all (measured
// at T006: 4 of 5 rendered zero cards).
//
// The rule, therefore: inside the `showEmptyCard` derivation, the four signals
// below are forbidden. Each of them is a way of asking the manifest's SHAPE
// what kind of nothing this is, and the shape cannot answer.
//
// RULE 67 (AGENTS.md:985-992 at HEAD) — A gate that only asserts an absence
// passes identically when its extraction silently matches nothing, and reports
// green about a block it never read. Two narrowings answer that here:
//
//   1. The extraction throws rather than returns empty when its anchor is
//      gone, and refuses a second occurrence of the anchor. A renamed or
//      duplicated derivation stops this gate rather than passing it.
//   2. The negative controls below prove the search terms are terms that DO
//      occur — three of them elsewhere in this very file, and the fourth where
//      the manifest declares it. A term that can never match anywhere would
//      make the absence assertion true and meaningless.
//
// ON THE FOURTH TERM. `isInFlight` does not appear in `PhaseLogFeed.svelte` at
// all, so it has no in-file control and is anchored at its declaration site
// instead. It stays on the forbidden list regardless: it is on the manifest,
// it is the most tempting of the four to reach for, and the list is what the
// card choice must not do — not a list of what it currently does.
//
// HERMETIC — `node:fs` only. Spawns nothing, imports nothing from
// `node:child_process` (`lint-gates-are-hermetic.test.ts`).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FEED_FILE = resolve(
  REPO_ROOT,
  'webview-ui/src/components/PhaseLogFeed/PhaseLogFeed.svelte'
);
const MANIFEST_TYPES_FILE = resolve(REPO_ROOT, 'src/services/phase-log/types.ts');

const DERIVATION_ANCHOR = 'const showEmptyCard = $derived(';

/**
 * The four re-derivations the card choice must not perform. Each asks the
 * manifest's shape a question only its classification can answer.
 */
const FORBIDDEN_INSIDE_DERIVATION = [
  'entries.length',
  'iterations.length',
  'isInFlight',
  'hasNoEntries'
] as const;

/**
 * The in-file negative control. These three occur elsewhere in the feed today,
 * so their absence INSIDE the derivation is a fact about the derivation rather
 * than a fact about the file. If one genuinely leaves the file, remove it from
 * this list in the same change and say why — do not loosen the assertion.
 */
const PRESENT_ELSEWHERE_IN_FEED = [
  'entries.length',
  'iterations.length',
  'hasNoEntries'
] as const;

/**
 * The out-of-file control for the fourth term, anchored where the manifest
 * declares it. Proves the spelling is real code and not a term that could
 * never match.
 */
const DECLARED_IN_MANIFEST = 'isInFlight';

/**
 * A floor under the extracted block. The derivation is a multi-line condition;
 * anything shorter than this is a sign the extraction found a fragment rather
 * than the block, and every absence assertion below would be vacuous.
 */
const MIN_DERIVATION_LENGTH = 40;

function readFeed(): string {
  return readFileSync(FEED_FILE, 'utf8');
}

/**
 * The `showEmptyCard` derivation, from its anchor to the parenthesis that
 * balances `$derived(`.
 *
 * Throws rather than returning empty on every failure to locate it. A gate
 * that returned `''` here would report green about nothing.
 */
function showEmptyCardDerivation(source: string): string {
  const start = source.indexOf(DERIVATION_ANCHOR);
  if (start === -1) {
    throw new Error(
      `${FEED_FILE} no longer contains ${JSON.stringify(DERIVATION_ANCHOR)}. ` +
        'If the card choice was renamed or moved, update this gate in the same change ' +
        'rather than letting it pass on a block it cannot find.'
    );
  }
  if (source.indexOf(DERIVATION_ANCHOR, start + 1) !== -1) {
    throw new Error(
      `${FEED_FILE} contains ${JSON.stringify(DERIVATION_ANCHOR)} more than once. ` +
        'This gate reads exactly one card-choice derivation; two means it would ' +
        'report on whichever came first and stay silent about the other.'
    );
  }
  const open = start + DERIVATION_ANCHOR.length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(
    `${FEED_FILE}: the ${JSON.stringify(DERIVATION_ANCHOR)} parenthesis is never balanced.`
  );
}

describe('feature 203 — the empty-card choice is a classification, not a re-derivation', () => {
  it('the derivation is found exactly once and is a whole block, not a fragment', () => {
    const derivation = showEmptyCardDerivation(readFeed());
    expect(
      derivation.length,
      'the extracted card-choice derivation is too short to be the real block, which would ' +
        'make every absence assertion in this file vacuous'
    ).toBeGreaterThan(MIN_DERIVATION_LENGTH);
  });

  it('re-derives none of the four signals the host has already classified', () => {
    const derivation = showEmptyCardDerivation(readFeed());
    const offending = FORBIDDEN_INSIDE_DERIVATION.filter((term) => derivation.includes(term));
    expect(
      offending,
      'FR-014 / SC-004: the card choice must read the kind of nothing the host reported, not ' +
        're-derive it from the shape of the manifest. Each term named here is a re-derivation ' +
        'that cannot distinguish the empty situations the host can.'
    ).toEqual([]);
  });

  it('negative control: three of the four terms do occur elsewhere in the same file', () => {
    const source = readFeed();
    const derivation = showEmptyCardDerivation(source);
    const outside = source.split(derivation).join('');
    const missing = PRESENT_ELSEWHERE_IN_FEED.filter((term) => !outside.includes(term));
    expect(
      missing,
      'the assertion above is only meaningful if these terms are the kind of thing that occurs ' +
        'in this file. A term missing here means the absence check passed because nothing could ' +
        'ever match it, which is rule 67 inside a single gate.'
    ).toEqual([]);
  });

  it('negative control: the fourth term is a real spelling, declared on the manifest', () => {
    const types = readFileSync(MANIFEST_TYPES_FILE, 'utf8');
    expect(
      types.includes(DECLARED_IN_MANIFEST),
      `${MANIFEST_TYPES_FILE} no longer declares ${DECLARED_IN_MANIFEST}. Either the field was ` +
        'renamed — in which case the forbidden term above is now unmatchable and must be ' +
        'renamed with it — or it is gone and the entry should be removed deliberately.'
    ).toBe(true);
  });
});
