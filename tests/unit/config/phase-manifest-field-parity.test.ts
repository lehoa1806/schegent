// The host's two Phase field sets describe the same closed set, and must agree
// on it.
//
// Feature 099 (T496f, FR-042) — this file used to compare those sets against
// `contributes.configuration.properties["schegent.phases"].items`, because that
// manifest schema carried `additionalProperties: false` and so was a real
// settings-editor rejection: a field the host accepted but the manifest omitted
// was red-squiggled while working, and a field the manifest advertised but the
// host stripped was offered, accepted, and then never checked.
//
// `schegent.phases` is deleted. Phase rows live in the catalog store, so there is
// no manifest schema to drift against and no settings editor to disagree with —
// the closed set is now enforced host-side only. Two things replace the parity
// claims rather than dropping them:
//
//   - The deletion itself is asserted. A `schegent.phases` property reappearing
//     in `package.json` would be a second, unvalidated source of Phase rows, and
//     nothing else in the suite would notice it. This is the one direction the
//     drift can still run, so it is the one this file guards.
//   - The manifest-vs-host comparison becomes the comparison between the two
//     host sets, stated as the subtraction it is. `AUTHORED_PHASE_FIELDS` is what
//     both the save path and the import path hold a definition to;
//     `ALLOWED_PHASE_FIELDS` is the filter `validateCatalog` applies before it
//     validates a stored row, and it is the authored set less `phaseId`, the YAML
//     spelling of `id` that a stored row never carries.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AUTHORED_PHASE_FIELDS } from '../../../src/config/process-definition-validator';
import { ALLOWED_PHASE_FIELDS } from '../../../src/config/pipeline-config';

const PACKAGE_JSON_PATH = path.resolve(__dirname, '..', '..', '..', 'package.json');

/** The YAML-only spelling of `id`; a stored row never carries it. */
const YAML_ONLY_FIELDS: readonly string[] = ['phaseId'];

/** The three configuration keys the catalog store replaced (FR-042, FR-047). */
const DELETED_KEYS: readonly string[] = ['schegent.phases', 'schegent.pipelines', 'schegent.workflows'];

function manifestProperties(): Record<string, unknown> {
  const parsed = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
    contributes?: { configuration?: { properties?: Record<string, unknown> } };
  };
  const properties = parsed.contributes?.configuration?.properties;
  if (!properties) throw new Error('package.json: missing contributes.configuration.properties');
  return properties;
}

describe('the manifest declares no catalog setting the store now owns', () => {
  it('declares none of the three deleted definition keys', () => {
    const properties = Object.keys(manifestProperties());
    const present = DELETED_KEYS.filter((key) => properties.includes(key));
    expect(
      present,
      `package.json still offers a settings source for: ${present.join(', ')}`
    ).toEqual([]);
  });

  it('still declares the settings the store did not replace (sanity)', () => {
    // Without this the case above would pass just as well on a manifest whose
    // configuration block had been emptied by accident.
    const properties = Object.keys(manifestProperties());
    expect(properties.length).toBeGreaterThan(0);
    expect(properties).toContain('schegent.trust.allowCustomPhases');
  });
});

describe('the two host Phase field sets agree', () => {
  const authored = Array.from(AUTHORED_PHASE_FIELDS).sort();
  const stored = Array.from(ALLOWED_PHASE_FIELDS).sort();

  it('declares at least the required id/name pair (sanity)', () => {
    expect(authored).toContain('id');
    expect(authored).toContain('name');
  });

  it('validateCatalog strips nothing an authored row is allowed to carry', () => {
    // `ALLOWED_PHASE_FIELDS` is the filter `validateCatalog` applies before it
    // calls `validatePhaseRaw`. Any authored field absent from it is a field the
    // validator is structurally unable to see, however good its checks are.
    const expectedStored = authored.filter((field) => !YAML_ONLY_FIELDS.includes(field));
    const stripped = expectedStored.filter((field) => !ALLOWED_PHASE_FIELDS.has(field));
    expect(
      stripped,
      `authored fields validateCatalog discards before validating: ${stripped.join(', ')}`
    ).toEqual([]);
  });

  it('validateCatalog admits no field outside the authored set', () => {
    const unauthorized = stored.filter((field) => !AUTHORED_PHASE_FIELDS.has(field));
    expect(unauthorized, `unauthorized: ${unauthorized.join(', ')}`).toEqual([]);
  });

  it('subtracts exactly the YAML-only spelling, and nothing else', () => {
    // The two directions above bound the difference from either side; this names
    // it. A future field that belonged to one set and not the other would satisfy
    // neither, but stating the subtraction is what makes the intent readable.
    for (const field of YAML_ONLY_FIELDS) {
      expect(AUTHORED_PHASE_FIELDS.has(field), `${field} is accepted on import`).toBe(true);
      expect(ALLOWED_PHASE_FIELDS.has(field), `${field} has no place in a stored row`).toBe(false);
    }
    expect(stored).toEqual(authored.filter((field) => !YAML_ONLY_FIELDS.includes(field)));
  });
});
