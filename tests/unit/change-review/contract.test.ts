// FR-R6-F12 T002 (FR-003, FR-015, NFR-001; contracts/change-review.md sections 2 to 5 and 7) —
// the change review contract.
//
// WHAT THIS PINS:
//   - every closed list is frozen and holds no duplicate;
//   - the bounds hold the values the contract states;
//   - every availability phrase is labelled and holds no digit, so no availability value can read
//     as a count or a success;
//   - every placeholder sentence is fixed text that no renderer can turn into markup, an icon or a
//     link.

import { describe, expect, it } from 'vitest';
import {
  APPROVAL_INELIGIBLE_REASONS,
  AVAILABILITY_VALUES,
  CHANGE_KINDS,
  CHANGE_REVIEW_LIMITS,
  LANDING_INELIGIBLE_REASONS,
  PLACEHOLDER_REASONS,
  PLACEHOLDER_SENTENCES,
  REVIEW_REFUSAL_REASONS,
  REVIEW_STATES,
  STALE_REASONS,
  UNAVAILABLE_REASONS,
  UNCERTAIN_REASONS,
  availabilityPhrase,
  reviewOk,
  reviewRefused
} from '../../../src/contracts/change-review';

const CLOSED_LISTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['CHANGE_KINDS', CHANGE_KINDS],
  ['REVIEW_STATES', REVIEW_STATES],
  ['STALE_REASONS', STALE_REASONS],
  ['UNCERTAIN_REASONS', UNCERTAIN_REASONS],
  ['UNAVAILABLE_REASONS', UNAVAILABLE_REASONS],
  ['REVIEW_REFUSAL_REASONS', REVIEW_REFUSAL_REASONS],
  ['APPROVAL_INELIGIBLE_REASONS', APPROVAL_INELIGIBLE_REASONS],
  ['LANDING_INELIGIBLE_REASONS', LANDING_INELIGIBLE_REASONS],
  ['PLACEHOLDER_REASONS', PLACEHOLDER_REASONS],
  ['AVAILABILITY_VALUES', AVAILABILITY_VALUES]
];

const MARKUP_NEEDLES = ['{', '$(', '[', '://', '<'];

describe('change review contract', () => {
  it.each(CLOSED_LISTS)('%s is frozen and has no duplicate', (_name, list) => {
    expect(Object.isFrozen(list)).toBe(true);
    expect(new Set(list).size).toBe(list.length);
    expect(list.length).toBeGreaterThan(0);
  });

  it('lists the six change kinds and the four review states', () => {
    expect([...CHANGE_KINDS]).toEqual(['added', 'modified', 'deleted', 'renamed', 'type-changed', 'submodule']);
    expect([...REVIEW_STATES]).toEqual(['current', 'stale', 'uncertain', 'unavailable']);
  });

  it('holds the stated bounds', () => {
    expect(Object.isFrozen(CHANGE_REVIEW_LIMITS)).toBe(true);
    expect(CHANGE_REVIEW_LIMITS).toEqual({
      pageEntriesMax: 200,
      loadedEntriesMax: 1000,
      sideBytesMax: 1_048_576,
      liveReviewsMax: 8,
      inventoryOutputBytesMax: 16_777_216,
      gitTimeoutMs: 10_000,
      displayNameCharsMax: 120,
      cursorCharsMax: 128
    });
  });

  it.each(AVAILABILITY_VALUES.map((value) => [value]))('the %s phrase is labelled and holds no digit', (value) => {
    const phrase = availabilityPhrase(value);
    expect(phrase.length).toBeGreaterThan(0);
    expect(phrase).not.toMatch(/[0-9]/);
    expect(phrase.toLowerCase().startsWith(value)).toBe(true);
  });

  it('gives each availability value its own phrase', () => {
    const phrases = AVAILABILITY_VALUES.map((value) => availabilityPhrase(value));
    expect(new Set(phrases).size).toBe(AVAILABILITY_VALUES.length);
  });

  it('gives every placeholder reason one fixed sentence with no markup', () => {
    expect(Object.isFrozen(PLACEHOLDER_SENTENCES)).toBe(true);
    expect(Object.keys(PLACEHOLDER_SENTENCES).sort()).toEqual([...PLACEHOLDER_REASONS].sort());
    for (const reason of PLACEHOLDER_REASONS) {
      const sentence = PLACEHOLDER_SENTENCES[reason];
      expect(sentence.endsWith('.')).toBe(true);
      for (const needle of MARKUP_NEEDLES) expect(sentence.includes(needle)).toBe(false);
    }
  });

  it('builds the two result shapes', () => {
    expect(reviewOk(3)).toEqual({ ok: true, value: 3 });
    expect(reviewRefused('cursor-invalid')).toEqual({ ok: false, reason: 'cursor-invalid' });
  });
});
