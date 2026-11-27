// FR-R4-F16 (feature 244), contract P5.1 — the completion-provenance vocabulary guard.
//
// One module decides what "attested" means for the audit projection and for the census, so its
// spelling and its membership check are pinned here. The check is identity: a near miss, a
// non-string and `null` are all refused, so a reader that meets a value it does not know reads the
// provenance as absent (contract P1.3).
import { describe, expect, it } from 'vitest';
import {
  COMPLETION_PROVENANCES,
  isCompletionProvenance
} from '../../../src/contracts/completion-provenance';

describe('the completion-provenance vocabulary (FR-003, D1; contract P1)', () => {
  it('has exactly one member, spelled as the queue row spells it', () => {
    expect([...COMPLETION_PROVENANCES]).toEqual(['operator-attested']);
  });

  it('admits the member', () => {
    expect(isCompletionProvenance('operator-attested')).toBe(true);
  });

  it.each([
    ['a different case', 'Operator-Attested'],
    ['a leading space', ' operator-attested'],
    ['a trailing space', 'operator-attested '],
    ['the empty string', ''],
    ['true', true],
    ['a number', 1],
    ['an object', {}],
    ['an array', []],
    ['undefined', undefined],
    ['null', null]
  ])('refuses %s', (_label, value) => {
    expect(isCompletionProvenance(value)).toBe(false);
  });
});
