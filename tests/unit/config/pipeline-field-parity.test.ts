// The host's two Pipeline field sets describe the same closed set, and must agree
// on it.
//
// The Phase half of this claim is `phase-manifest-field-parity.test.ts`, and it
// exists because the Phase filter had been a hand-kept copy that fell two fields
// behind: feature 098 added `sideEffects` and `evidencePolicy` to the authored set,
// and the filter discarded both before `validatePhaseRaw` could apply its enum
// checks — the one oracle whose job is to catch a bad containment class could not
// see the field. `ALLOWED_PHASE_FIELDS` was derived from the authored set in
// response, and gated there.
//
// `ALLOWED_PIPELINE_FIELDS` was left as the hand-written literal the Phase set used
// to be. It was not wrong: the two names it omitted, `pipelineId` and `phaseIds`,
// are the portable spellings of `id` and `phases`, and `validateCatalog` only ever
// sees rows that `pipelineDefinitionToPipelineDef` has already normalized to the
// resolved spelling. It was correct by coincidence of what had been added so far,
// with nothing to hold it there — the thirteenth authored Pipeline field would have
// reproduced the Phase bug exactly, silently, in a filter no test could see.

import { describe, it, expect } from 'vitest';
import { AUTHORED_PIPELINE_FIELDS } from '../../../src/config/pipeline-definition-validator';
import { ALLOWED_PIPELINE_FIELDS, PORTABLE_ONLY_PIPELINE_FIELDS } from '../../../src/config/pipeline-config';

describe('the two host Pipeline field sets agree', () => {
  const authored = Array.from(AUTHORED_PIPELINE_FIELDS).sort();
  const stored = Array.from(ALLOWED_PIPELINE_FIELDS).sort();

  it('declares at least the id/name/phases trio (sanity)', () => {
    // Without this, every case below would pass just as well on two empty sets.
    expect(authored).toContain('id');
    expect(authored).toContain('name');
    expect(authored).toContain('phases');
    expect(stored.length).toBeGreaterThan(0);
  });

  it('validateCatalog strips nothing an authored row is allowed to carry', () => {
    // The direction that was the Phase bug. Any authored field absent from the
    // filter is a field `validatePipelineRaw` is structurally unable to see,
    // however good its checks are.
    const expectedStored = authored.filter((field) => !PORTABLE_ONLY_PIPELINE_FIELDS.has(field));
    const stripped = expectedStored.filter((field) => !ALLOWED_PIPELINE_FIELDS.has(field));
    expect(
      stripped,
      `authored fields validateCatalog discards before validating: ${stripped.join(', ')}`
    ).toEqual([]);
  });

  it('validateCatalog admits no field outside the authored set', () => {
    const unauthorized = stored.filter((field) => !AUTHORED_PIPELINE_FIELDS.has(field));
    expect(unauthorized, `unauthorized: ${unauthorized.join(', ')}`).toEqual([]);
  });

  it('subtracts exactly the portable spellings, and nothing else', () => {
    // The two directions above bound the difference from either side; this names
    // it, so that a future field added to one set and not the other reads as the
    // omission it is rather than as an unexplained gap.
    for (const field of PORTABLE_ONLY_PIPELINE_FIELDS) {
      expect(AUTHORED_PIPELINE_FIELDS.has(field), `${field} is accepted on import`).toBe(true);
      expect(
        ALLOWED_PIPELINE_FIELDS.has(field),
        `${field} is normalized away before a stored row reaches validateCatalog`
      ).toBe(false);
    }
    expect(stored).toEqual(authored.filter((field) => !PORTABLE_ONLY_PIPELINE_FIELDS.has(field)));
  });

  it('names both portable spellings, and only those', () => {
    // The subtraction is the whole reason this filter may differ from the authored
    // set. Growing it is how a field starts being discarded again, so the list is
    // pinned rather than merely explained.
    expect(Array.from(PORTABLE_ONLY_PIPELINE_FIELDS).sort()).toEqual(['phaseIds', 'pipelineId']);
  });
});
