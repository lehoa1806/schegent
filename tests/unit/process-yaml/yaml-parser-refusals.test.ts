// Feature 084 T005 — every refusal the normative grammar names (test-first).
//
// specs/084-phase-yaml-exchange/contracts/phase-yaml-grammar.ebnf lists the
// constructs that are NOT in the language. Each one gets a case here, and each
// case asserts two things:
//
//   1. the document is refused, and
//   2. no value the document declares survives into the result — the refusal
//      landed at the token rather than after construction (FR-003a).
//
// (2) is what separates this design from "parse with a general YAML library,
// then reject what we do not like": alias expansion, merge resolution and tag
// construction would already have run by then.
//
// FR-003, FR-003a, FR-029, QS-9, QS-10, QS-21.

import { describe, it, expect } from 'vitest';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';

const PAYLOAD = 'CONSTRUCTED-PAYLOAD';

function refuse(text: string): { code: string; message: string } {
  const result = parseDocumentText(text);
  if (result.ok) {
    throw new Error('expected the document to be refused');
  }
  expect(result).not.toHaveProperty('node');
  expect(JSON.stringify(result)).not.toContain(PAYLOAD);
  return result.refusal;
}

const DISALLOWED: ReadonlyArray<readonly [string, string]> = [
  ['anchor', `metadata: &base\n  name: ${PAYLOAD}\n`],
  ['alias', `metadata:\n  name: A\nspec: *base\n`],
  ['merge key', `spec:\n  <<: *base\n  skill: ${PAYLOAD}\n`],
  ['explicit tag', `metadata:\n  name: !!str ${PAYLOAD}\n`],
  ['verbatim tag', `metadata:\n  name: !<tag:x> ${PAYLOAD}\n`],
  ['%YAML directive', `%YAML 1.2\n---\nkind: Phase\n`],
  ['%TAG directive', `%TAG ! tag:x\n---\nkind: Phase\n`],
  ['flow mapping', `metadata: { name: ${PAYLOAD} }\n`],
  ['flow sequence', `metadata: [ ${PAYLOAD} ]\n`],
  // Feature 085 widened the subset by exactly one production, so `spec:\n  - x`
  // is now ACCEPTED (see yaml-scanner.test.ts / yaml-parser.test.ts). What
  // replaced it here are the narrowings that keep that production bounded —
  // specs/085-pipeline-package-exchange/contracts/yaml-grammar.md, "New, all of
  // them narrowings". Each still refuses at the token, so none can echo PAYLOAD.
  ['bare dash', `spec:\n  -\n`],
  ['dash followed by two spaces', `spec:\n  -  ${PAYLOAD}\n`],
  ['nested block sequence', `spec:\n  - - ${PAYLOAD}\n`],
  ['a level mixing items and entries', `spec:\n  - ${PAYLOAD}\n  name: A\n`],
  ['an item where a mapping key belongs', `spec:\n  name: A\n  - ${PAYLOAD}\n`],
  ['top-level block sequence', `- kind: Phase\n`],
  ['complex key', `? ${PAYLOAD}\n: value\n`],
  ['single-quoted scalar', `name: '${PAYLOAD}'\n`],
  ['folded scalar', `instruction: >-\n  ${PAYLOAD}\n`]
];

describe('yaml-parser — constructs outside the closed subset', () => {
  it.each(DISALLOWED)('refuses %s at the token', (_label, text) => {
    expect(refuse(text).code).toBe('disallowed-syntax');
  });

  it('refuses a tab in the indentation', () => {
    expect(refuse(`metadata:\n\tname: ${PAYLOAD}\n`).code).toBe('disallowed-syntax');
  });
});

describe('yaml-parser — multi-document streams', () => {
  it('refuses a second document start', () => {
    const r = refuse(`kind: Phase\n---\nkind: Phase\n`);
    expect(r.code).toBe('multi-document');
  });

  it('refuses a document end marker', () => {
    expect(refuse(`kind: Phase\n...\n`).code).toBe('multi-document');
  });

  it('accepts a single leading document start', () => {
    const result = parseDocumentText('---\nkind: Phase\n');
    expect(result.ok).toBe(true);
  });
});

describe('yaml-parser — duplicate keys (FR-029)', () => {
  it('refuses a repeated key rather than resolving first- or last-wins', () => {
    const r = refuse(`metadata:\n  phaseId: first\n  phaseId: ${PAYLOAD}\n`);
    expect(r.code).toBe('disallowed-syntax');
    expect(r.message).toMatch(/duplicate/i);
  });

  it('refuses a repeated key at the top level', () => {
    expect(refuse(`kind: Phase\nkind: ${PAYLOAD}\n`).message).toMatch(/duplicate/i);
  });

  it('allows the same key name in two different mappings', () => {
    const result = parseDocumentText('metadata:\n  name: A\nspec:\n  name: B\n');
    expect(result.ok).toBe(true);
  });
});

describe('yaml-parser — empty input', () => {
  it.each([['nothing', ''], ['only comments', '# just a comment\n'], ['only blank lines', '\n\n']])(
    'refuses a document declaring %s',
    (_label, text) => {
      const result = parseDocumentText(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal.code).toBe('empty');
    }
  );
});
