// Every authored Phase field an operator can write is documented where an
// operator would look for it.
//
// WHY. `capabilities` shipped as a security control an operator could set and
// could not discover: it was in the contract, the validator, the snapshot, the
// exchange format and the threat model, and it was absent from
// `docs/features/custom-phases.md` — the one page that tells an operator what a
// custom Phase may declare. `hostVerification` had been missing the same way
// since FR-R3-058. A control nobody can find is not a control that is off; it is
// a control that is on by default in its widest setting and unreachable.
//
// This is the OPERATOR half of the parity family. `phase-manifest-field-parity`
// already checks the two host field sets against each other, and
// `capability-text-contract-parity` checks that operator prose cites a declared
// event. Neither notices a field that no prose mentions at all — the absence of
// a claim passes every check that inspects claims.
//
// The field set is derived from `AUTHORED_PHASE_FIELDS`, so a new authored field
// lands here with no edit to this file.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTHORED_PHASE_FIELDS } from '../../src/config/process-definition-validator';

const DOC = resolve(__dirname, '..', '..', 'docs', 'features', 'custom-phases.md');

/**
 * Fields an operator never writes, with the reason each is exempt. An exemption
 * is a claim about the field, so it is stated rather than merely listed.
 */
const NOT_OPERATOR_AUTHORED: Readonly<Record<string, string>> = {
  id: 'the storage key; the document describes it as the Phase id under its own heading',
  phaseId: 'the YAML spelling of `id`, documented by the exchange-format guide rather than here',
  name: 'documented above the table as one of the two required identity fields',
  version: 'assigned by the catalog lifecycle, not written by hand',
  description: 'free text with no validation rule to document'
};

describe('every authored Phase field reaches the operator documentation', () => {
  const doc = readFileSync(DOC, 'utf8');
  const tableRows = doc.split('\n').filter((line) => line.startsWith('|'));

  it('documents each field an operator can declare', () => {
    const undocumented = [...AUTHORED_PHASE_FIELDS]
      .filter((field) => !(field in NOT_OPERATOR_AUTHORED))
      // Backticked inside a TABLE ROW, not merely somewhere in the prose: the
      // table is what an operator scans, and a passing mention in a paragraph is
      // not the reference they would find. A row rather than a cell start,
      // because two fields legitimately share one cell — `instruction` / `skill`
      // is the alternation, and pinning the cell start would report the second
      // of the pair as undocumented when it is sitting right there.
      .filter((field) => !tableRows.some((row) => row.includes(`\`${field}\``)));
    expect(
      undocumented,
      `authored Phase fields absent from docs/features/custom-phases.md: ${undocumented.join(', ')}. ` +
        'Add a row to the field table, or add the field to NOT_OPERATOR_AUTHORED with the reason it is not operator-authored.'
    ).toEqual([]);
  });

  it('exempts nothing that is not an authored field', () => {
    // An exemption for a field that no longer exists is a stale claim, and it
    // would silently excuse a real field if the name were ever reused.
    const stale = Object.keys(NOT_OPERATOR_AUTHORED).filter(
      (field) => !AUTHORED_PHASE_FIELDS.has(field)
    );
    expect(stale, `exemptions naming fields that are not authored: ${stale.join(', ')}`).toEqual([]);
  });

  it('finds the table it is reading (sanity)', () => {
    // Without this, a renamed or emptied document would report full coverage.
    expect(doc).toContain('| `timeoutSeconds`');
    expect(doc).toContain('| `capabilities`');
    expect(tableRows.length).toBeGreaterThan(10);
  });
});
