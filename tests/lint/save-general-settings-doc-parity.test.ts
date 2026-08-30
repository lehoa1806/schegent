// FR-R3-143 (T048) — the page that says it lists every `CMD_SAVE_GENERAL_SETTINGS`
// payload key, against the set the host actually accepts.
//
// THE FINDING. `docs/reference/api-and-cli.md` named 22 keys under "accepts only
// these unprefixed keys" while `ALLOWED_KEYS` held 28. The six it omitted —
// `cli.inheritEnvironment`, `cli.environmentMode`, `cli.environmentAllowlist`,
// `backend.probeTimeoutSeconds`, `ui.confirmations.enable`,
// `multiRoot.suppressWarning` — were added to `KEY_SPECS` by this same feature.
// This is not old rot: the change that widened the command left the page behind on
// the day it landed, and **the item's blast-radius table did not name the file**.
// It was found by measurement, which is the part worth gating: the next widening
// will have the same blast-radius table.
//
// WHY THIS PAGE IS HELD IN BOTH DIRECTIONS. A document naming a key that does not
// exist is a defect anywhere; a document omitting one is normally not, and
// asserting completeness generally would turn every page into a documentation
// mandate. This sentence is different because it claims completeness in its own
// words — "accepts ONLY these" — so an omission makes the page's own claim false.
// `tests/lint/documented-commands-exist.test.ts` reaches the same conclusion about
// the command list on this same page, for the same reason.
//
// The count in the sentence is checked too. A number in prose about a set the code
// owns is the one documentation defect that arrives with nobody editing the
// sentence, and the command half of this page had already been caught reading 19
// against a manifest of 20.
//
// An unmatched sentence FAILS. If the paragraph is reworded, this gate must be
// updated in the same change rather than quietly passing over a page it can no
// longer find.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ALLOWED_KEYS } from '../../src/config/general-settings';

const REPO_ROOT = resolve(__dirname, '..', '..');
const PAGE = 'docs/reference/api-and-cli.md';

/** The sentence's opening, up to and including the colon the list follows. */
const CLAIM =
  /`CMD_SAVE_GENERAL_SETTINGS\.updates` accepts only these (\d+) unprefixed keys, and validates the entire batch before writing:([^\n]*)/;

interface Claim {
  readonly count: number;
  readonly keys: readonly string[];
}

/**
 * The count and the key list the page asserts, or `null` if the sentence is gone.
 *
 * Scoped to the remainder of that one line rather than to a sentence terminator,
 * because every key contains a `.` — a naive "read to the first period" would stop
 * inside `cli.path`. The paragraph is a single line, so the line IS the list.
 */
function documentedClaim(body: string): Claim | null {
  const match = CLAIM.exec(body);
  if (match === null) return null;
  return {
    count: Number(match[1]),
    keys: [...match[2].matchAll(/`([^`]+)`/g)].map((backticked) => backticked[1])
  };
}

describe('CMD_SAVE_GENERAL_SETTINGS payload keys are documented as the host accepts them', () => {
  const accepted = [...ALLOWED_KEYS].sort();
  const claim = documentedClaim(readFileSync(resolve(REPO_ROOT, PAGE), 'utf8'));

  it('the page still carries the sentence this gate reads', () => {
    expect(
      claim,
      `${PAGE} no longer carries the "accepts only these N unprefixed keys" sentence. If it was ` +
        'reworded deliberately, update the pattern in this gate in the same change — a gate that ' +
        'silently matches nothing is worse than no gate.'
    ).not.toBeNull();
  });

  it('the host accepts a non-empty set of keys', () => {
    // The floor. `ALLOWED_KEYS` is derived from `KEY_SPECS`; if that derivation
    // ever yields nothing, both comparisons below would agree on emptiness.
    expect(accepted.length).toBeGreaterThan(20);
  });

  it('names every key the host accepts', () => {
    const omitted = accepted.filter((key) => !claim!.keys.includes(key));
    expect(
      omitted,
      `${PAGE} says it lists every key CMD_SAVE_GENERAL_SETTINGS accepts and does not. A reader ` +
        'building a payload against this page concludes these keys are rejected, when the host ' +
        'takes them.'
    ).toEqual([]);
  });

  it('names no key the host would reject', () => {
    const invented = claim!.keys.filter((key) => !ALLOWED_KEYS.has(key));
    expect(
      invented,
      `${PAGE} names a key that is not in ALLOWED_KEYS. A batch containing it is rejected as ` +
        '`unknown-key:<key>`, and the whole batch fails with it.'
    ).toEqual([]);
  });

  it('asserts the count the code declares', () => {
    expect(
      claim!.count,
      `the count in ${PAGE} is not the size of ALLOWED_KEYS. This is the failure mode that needs ` +
        'no editor: someone widens the command, and the number on the page a reviewer trusts is ' +
        'silently wrong.'
    ).toBe(ALLOWED_KEYS.size);
  });

  // The five checks above pass on the tree as it stands, which says nothing about
  // whether they can fail. These drive the parser with synthetic input so each
  // verdict is observed in both directions.
  describe('the gate detects what it claims to', () => {
    const sentence = (count: number, keys: readonly string[]): string =>
      '`CMD_SAVE_GENERAL_SETTINGS.updates` accepts only these ' +
      `${count} unprefixed keys, and validates the entire batch before writing: ` +
      `${keys.map((key) => `\`${key}\``).join(', ')}.\n\nnext paragraph\n`;

    it('reads the count and the keys off the sentence', () => {
      expect(documentedClaim(sentence(2, ['cli.path', 'logging.verbose']))).toEqual({
        count: 2,
        keys: ['cli.path', 'logging.verbose']
      });
    });

    it('stops at the end of the sentence line', () => {
      // The following paragraph is prose with backticks of its own; a parser that
      // ran past the newline would collect them as payload keys.
      const body = sentence(1, ['cli.path']).replace('next paragraph', '`queue.defaultQueueId`');
      expect(documentedClaim(body)!.keys).toEqual(['cli.path']);
    });

    it('returns null when the sentence is gone', () => {
      expect(documentedClaim('`CMD_SAVE_GENERAL_SETTINGS.updates` takes some keys.')).toBeNull();
    });
  });
});
