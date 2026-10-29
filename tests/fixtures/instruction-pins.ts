// FR-R4-F18 (feature 246, T006; contract F4; research R10) — the pin helpers the
// authority tests share, moved here unchanged.
//
// Two test files pin what the new-feature example's Phase instructions say, each by
// named phrases and by mutation controls that remove one clause in memory:
//
//   - `speckit-new-feature-authority.test.ts` pins the delegated authority (feature 241)
//     and the tag request (FR-R4-F15).
//   - `speckit-review-scope-authority.test.ts` pins the review scope block (FR-R4-F18).
//
// The helpers were the first file's own until the second reader appeared; they are
// moved here byte for byte apart from `export`, so the two cannot drift. A pin names a
// clause by one phrase that carries it, and a control proves a pin is live by showing it
// fails when its clause is gone.

import { expect } from 'vitest';

export type Pin = readonly [label: string, pattern: RegExp];

export function expectPins(text: string, pins: readonly Pin[]): void {
  for (const [label, pattern] of pins) {
    expect(text, label).toMatch(pattern);
  }
}

/**
 * A mutation control: one clause removed from the real text, in memory only
 * (nothing is written to disk). A control that proves nothing must fail here,
 * never pass as a false kill, so it asserts three things in order:
 *
 * 1. applied: every removal occurs in the real text, and the mutated text differs;
 * 2. live: every pin that should catch it matches the real text;
 * 3. killed: at least one of those pins does not match the mutated text.
 */
export interface Mutant {
  readonly id: string;
  readonly removals: readonly string[];
  readonly killedBy: readonly Pin[];
}

export function mutate(text: string, removals: readonly string[]): string {
  return removals.reduce((mutated, removal) => mutated.split(removal).join(''), text);
}

export function expectMutantKilled(real: string, mutant: Mutant): void {
  const mutated = mutate(real, mutant.removals);
  for (const removal of mutant.removals) {
    expect(real, `${mutant.id}: the removal occurs in the real text`).toContain(removal);
  }
  expect(mutated, `${mutant.id}: the removal changed the text`).not.toBe(real);

  expectPins(real, mutant.killedBy);

  const missed = mutant.killedBy.filter(([, pattern]) => !pattern.test(mutated));
  expect(missed.length, `${mutant.id}: a pin fails on the mutated text`).toBeGreaterThan(0);
}
