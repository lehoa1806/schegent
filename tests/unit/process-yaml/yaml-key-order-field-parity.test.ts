// The portable format admits every authored Phase field, and only those.
//
// WHY THIS EXISTS. `SPEC_KEY_ORDER` is the second enumeration of the Phase
// authored set in the host, and the only one that had nothing holding it to the
// first. Its own comment states the claim: "`sideEffects` and `evidencePolicy` are
// admitted HERE and only here. `phase-yaml-validator.ts` derives its admitted-key
// set from this constant and `phase-yaml-mapper.ts` derives its portable-field set
// from it, so one edit opens the reader, the writer, and the portability check
// together and there is no way to admit a field in one of the three and forget the
// others."
//
// All of that is true and it is the right design — three readers from one
// declaration. What it does not do is tie that declaration to
// `AUTHORED_PHASE_FIELDS`, which is where a Phase field is actually born. A
// twenty-second authored field added there and not here would be:
//
//   - dropped by the writer, silently, from every exported document;
//   - refused by the reader on import, because it derives from this same constant;
//   - and reported by nothing, because the derivation makes the writer and the
//     reader agree with each other while both disagree with the host.
//
// That is a portable round trip that loses an authored declaration — the same
// failure as the four-way fork of `AUTHORED_PHASE_FIELDS` this suite's siblings
// were written for, arriving through the one path still open.
//
// The Pipeline and stored-row halves of the same claim live in
// `tests/unit/config/pipeline-field-parity.test.ts` and
// `tests/unit/config/phase-manifest-field-parity.test.ts`.

import { describe, it, expect } from 'vitest';
import { AUTHORED_PHASE_FIELDS } from '../../../src/config/process-definition-validator';
import {
  METADATA_KEY_ORDER,
  SPEC_KEY_ORDER
} from '../../../src/services/process-yaml/yaml-serializer';

/**
 * The one authored spelling with no place in a document: the format writes identity
 * as `phaseId` in `metadata`. Exactly mirrors `ALLOWED_PHASE_FIELDS` dropping
 * `phaseId`, in the other direction.
 */
const DOCUMENT_OMITS: readonly string[] = ['id'];

const admitted: readonly string[] = [...METADATA_KEY_ORDER, ...SPEC_KEY_ORDER];

describe('the portable Phase format and the authored Phase set agree', () => {
  it('enumerates a real key order in both constants (sanity)', () => {
    // Without this, every case below would pass on two empty arrays.
    expect(METADATA_KEY_ORDER.length).toBeGreaterThan(0);
    expect(SPEC_KEY_ORDER.length).toBeGreaterThan(0);
    expect(admitted).toContain('instruction');
    expect(admitted).toContain('phaseId');
  });

  it('admits every authored field the format is meant to carry', () => {
    // The direction that loses data. A field missing here is unwritable and
    // unreadable at once, because the reader and the mapper both derive from it.
    const expected = Array.from(AUTHORED_PHASE_FIELDS).filter(
      (field) => !DOCUMENT_OMITS.includes(field)
    );
    const unwritable = expected.filter((field) => !admitted.includes(field));
    expect(
      unwritable,
      `authored fields no exported document can carry: ${unwritable.join(', ')}`
    ).toEqual([]);
  });

  it('admits no key outside the authored set', () => {
    // The other direction: a key the format offers that the host does not accept
    // is a document an operator can write, export, and then fail to import.
    const unauthorized = admitted.filter((field) => !AUTHORED_PHASE_FIELDS.has(field));
    expect(unauthorized, `unauthorized: ${unauthorized.join(', ')}`).toEqual([]);
  });

  it('omits exactly the non-portable spelling of identity, and nothing else', () => {
    for (const field of DOCUMENT_OMITS) {
      expect(AUTHORED_PHASE_FIELDS.has(field), `${field} is authored`).toBe(true);
      expect(admitted.includes(field), `${field} has no place in a document`).toBe(false);
    }
    expect(Array.from(admitted).sort()).toEqual(
      Array.from(AUTHORED_PHASE_FIELDS)
        .filter((field) => !DOCUMENT_OMITS.includes(field))
        .sort()
    );
  });

  it('names each admitted key once across the two orders', () => {
    // A key in both `metadata` and `spec` would be emitted twice and read back
    // from whichever block the reader reached last.
    const duplicated = admitted.filter((field, index) => admitted.indexOf(field) !== index);
    expect(duplicated, `emitted in both blocks: ${duplicated.join(', ')}`).toEqual([]);
  });
});
